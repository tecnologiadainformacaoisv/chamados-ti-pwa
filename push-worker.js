// =====================================================================
// CHAMADOS TI – PUSH NOTIFICATION WORKER
// Cloudflare Worker — cola este arquivo no editor do dashboard
//
// Variáveis de ambiente (Settings → Variables → Add):
//   VAPID_PUBLIC_KEY  → chave pública gerada (PUBLIC_KEY)
//   VAPID_PRIVATE_JWK → chave privada em JSON (PRIVATE_JWK)
//   CLICKUP_API_KEY   → chave da API do ClickUp (marcar como secret) — Fase M5 (2026-08-13,
//                        migração de saída da ClickUp): NENHUMA rota usa mais isso, o D1/R2 são
//                        a fonte de verdade em tudo. Deixada configurada de propósito por
//                        enquanto (não é preciso remover pra terminar a migração — só reduz
//                        superfície se um dia alguém rodar `wrangler secret delete
//                        CLICKUP_API_KEY`; a conta da ClickUp em si continua intacta como
//                        arquivo, decisão já tomada, ver CLAUDE.md).
//   SUBSCRIBE_SECRET  → mesmo valor de APP_SHARED_SECRET no app.js (marcar como secret) —
//                        valida /subscribe e /api/* (header X-App-Secret) e /auth/* (mesmo header)
//   ADMIN_SECRET      → segredo só seu (marcar como secret) — gere um valor aleatório
//                        qualquer, NUNCA o mesmo do SUBSCRIBE_SECRET. Não fica em nenhum
//                        lugar do app.js/navegador. Usado nas rotas /admin/* (header
//                        X-Admin-Secret): GET /admin/users (quem já tem senha cadastrada),
//                        GET /admin/tasks (todos os chamados, com filtros), GET /admin/metrics
//                        (agregados de SLA/volume/tempo de atendimento) e POST /admin/tasks/:id
//                        (muta status/solução/operador — direto no D1 desde a Fase M4,
//                        2026-08-13; é o que substitui a ClickUp como interface de trabalho da TI).
//
// KV Namespace (Settings → KV Namespace Bindings → Add):
//   Nome da variável: SUBSCRIPTIONS — reaproveitado também pra login (sem KV novo):
//     auth_<nome>       → { algo, iterations, salt, hash, createdAt, lastLoginAt } (senha,
//                          nunca expira sozinha — dado exposto em /admin/users é só nome/datas)
//     session_<token>   → { name } (expira em SESSION_TTL_SECONDS)
//     loginfail_<nome>  → contador de tentativas erradas de senha de usuário (expira em 15min)
//     adminfail_<ip>    → contador de tentativas erradas de ADMIN_SECRET, por IP (expira em 15min)
// =====================================================================

// TIPO/SETOR/SOLUCAO_FIELD_ID continuam em uso — são os ids que d1RowToTaskShape usa
// pra montar `custom_fields` no mesmo shape de sempre (contrato que o frontend já
// espera) e que handleCreateTask lê do payload que o formulário manda.
// LIST_ID/EMAIL_FIELD_ID/SOLICITANTE_FIELD_ID ficaram vestigiais desde a Fase M5
// (2026-08-13, migração de saída da ClickUp) — só documentam qual lista/campo da
// ClickUp arquivada essas rotas costumavam ler; nenhum código usa mais nenhum dos
// três (D1 guarda `solicitante` como nome puro, sem field_id nem orderindex).
const LIST_ID               = '901324490220';
const SOLICITANTE_FIELD_ID  = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const TIPO_FIELD_ID         = '47e475fe-e911-40cd-b4a2-23625fbf57f1';
const SETOR_FIELD_ID        = 'c1ca88de-4b01-4933-93ff-24494bed59e2';
const SOLUCAO_FIELD_ID      = '16144175-845e-4e3c-baaa-a2517325cd43';
const EMAIL_FIELD_ID        = '2d8d4780-1d48-44dc-b605-0b5dd76c9d0f';
const VAPID_SUBJECT         = 'mailto:henrique.krvalho@gmail.com';

// Nome da prioridade (como a ClickUp devolve em task.priority.priority) -> número usado
// no schema D1 (mesma escala de CATEGORIA_PRIORIDADE/PRIORITY em app.js: 1 Urgente, 2 Alta,
// 3 Normal). "low" nunca deveria aparecer (regra de negócio: prioridade "Baixa" não existe
// nesse fluxo) — mapeado mesmo assim por segurança, caso algum chamado antigo/manual na
// ClickUp tenha escapado da regra antes dela existir.
const PRIORITY_NAME_TO_NUM = { urgent: 1, high: 2, normal: 3, low: 3 };

// ⚠️ Mantenha sincronizado com as chaves de STATUS_MAP em app.js (que por sua vez precisam
// ficar iguais a NOTIFY_STATUSES, ver abaixo) — usado por handleAdminUpdateTask pra validar
// o status recebido do painel de admin antes de mandar pra ClickUp.
const VALID_STATUSES = ['aberto', 'em atendimento', 'pendente', 'encerrado'];

// Fase M2 (2026-08-13, migração de saída da ClickUp) — mesmo limite de sempre
// (MAX_ANEXO_MB em frontend/src/lib/constants.ts), mas agora TAMBÉM aplicado no
// servidor. Achado ao construir esta fase: o limite de 10MB sempre existiu só no
// cliente — nada no Worker jamais impediu um upload maior (a ClickUp que aceitava ou
// rejeitava por conta própria). Com o upload indo pro R2 agora, o Worker passa a ser
// quem decide, então precisa aplicar a regra ele mesmo.
const MAX_ANEXO_BYTES = 10 * 1024 * 1024;

// ⚠️ Mantenha sincronizado com CATEGORIA_PRIORIDADE/PRIORITY em app.js — "prioridade é sempre
// automática, nunca manual" é regra de negócio do projeto (ver CLAUDE.md); recalculada aqui de
// novo (não só na UI) pra ninguém conseguir abrir chamado com prioridade/prazo forjados mandando
// direto pro proxy.
const CATEGORIA_PRIORIDADE = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3, 7: 2 };
const PRIORITY_SLA_MS = {
  1: 1  * 3600000, // Urgente: 1h
  2: 4  * 3600000, // Alta: 4h
  3: 24 * 3600000, // Normal: 24h
};

// ⚠️ As chaves de status devem ficar sincronizadas com STATUS_MAP em app.js
const NOTIFY_STATUSES = {
  'em atendimento': 'Em Atendimento',
  'pendente':       'Pendente',
  'encerrado':      'Encerrado'
};

// Prazo de finalização por prioridade (contado a partir de "Em Atendimento", não da criação).
// Usado só quando a task NÃO tem time_estimate manual definido — se alguém preencher a
// estimativa na ClickUp, ela sempre tem prioridade sobre este padrão. "low" não tem padrão
// porque a prioridade "Baixa" nunca é usada pelo app (CATEGORIA_PRIORIDADE nunca mapeia pra ela).
const DEFAULT_TIME_ESTIMATE_MS = {
  urgent: 15 * 60000, // 15min
  high:   30 * 60000, // 30min
  normal: 60 * 60000, // 1h
};

// Mesmos valores de DEFAULT_TIME_ESTIMATE_MS, mas indexados pelo número de priority do
// D1 (1/2/3) em vez do nome que só existe do lado ClickUp — usado por d1TransitionStatus
// (Fase B5). Sem entrada pra "Baixa" pelo mesmo motivo do original.
const DEFAULT_TIME_ESTIMATE_MS_BY_PRIORITY = { 1: DEFAULT_TIME_ESTIMATE_MS.urgent, 2: DEFAULT_TIME_ESTIMATE_MS.high, 3: DEFAULT_TIME_ESTIMATE_MS.normal };

// Só o app publicado pode chamar o Worker via navegador — '*' permitia qualquer site
// embutir uma chamada pro proxy usando o navegador de quem estivesse com a aba aberta.
// Duas origens válidas durante a migração pro domínio próprio (2026-10-16): o GitHub
// Pages original e o subdomínio do instituto. A origem da requisição é refletida
// (withCors) só se estiver nesta lista — nunca '*'. Pode remover a do github.io
// quando o domínio novo for o único em uso.
const ALLOWED_ORIGINS = [
  'https://tecnologiadainformacaoisv.github.io',
  'https://chamados.institutosaovicente.com.br',
];
const ALLOWED_ORIGIN = ALLOWED_ORIGINS[0]; // padrão quando não há Origin (ex.: curl, testes)
const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret, X-Session-Token, X-Admin-Secret',
};

// Login: sessão de 90 dias, senha com PBKDF2 (formato autodescritivo — dá pra trocar de
// algoritmo/parâmetros no futuro sem invalidar senha de ninguém, ver auth_<nome> no KV).
const SESSION_TTL_SECONDS = 90 * 24 * 3600;
const PBKDF2_ITERATIONS   = 100000;
const MAX_LOGIN_FAILURES  = 5;
const LOGIN_LOCKOUT_SECONDS = 15 * 60;
// Rate-limit de POST /auth/register-externo por IP (2026-09-21, achado do revisor) —
// ver comentário em handleRegisterExterno.
const MAX_REGISTER_EXTERNO_PER_IP = 5;
const REGISTER_EXTERNO_WINDOW_SECONDS = 60 * 60;
// Lockout de login por nome+IP (2026-11-11): travar só por nome deixava qualquer pessoa
// bloquear a conta de um colega errando a senha dele de propósito. Agora o limite de 5
// vale por (nome, IP) — o dono, de outro IP, continua entrando — e um teto maior por nome
// (backstop) barra ataque distribuído.
const MAX_LOGIN_FAILURES_NAME_BACKSTOP = 30;
// Tentativas de primeiro acesso com e-mail desconhecido, por IP/hora. Generoso de propósito:
// o escritório inteiro (48 pessoas) sai por um IP só, e todo mundo se cadastra no mesmo dia.
const MAX_REGISTER_FAIL_PER_IP = 40;
const REGISTER_FAIL_WINDOW_SECONDS = 60 * 60;
// Limites de entrada do chamado e de anexos por chamado
const MAX_CHAMADO_NAME_LEN = 200;
const MAX_CHAMADO_DESC_LEN = 5000;
const MAX_CHAMADO_ASSIGNEES = 5;
const MAX_ANEXOS_POR_CHAMADO = 5;
// Tipos que o navegador pode mostrar na própria tela sem risco; o resto só baixa.
const ANEXO_TIPOS_INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

// =====================================================================
// ROUTER
//
// /api/* — rotas autenticadas pelo header X-App-Secret (mesmo valor de
// APP_SHARED_SECRET no frontend / env.SUBSCRIBE_SECRET aqui). Até a Fase M5
// (2026-08-13, migração de saída da ClickUp), esse header liberava um proxy pra API
// da ClickUp (o frontend nunca recebia a chave dela); hoje o D1/R2 já são a fonte de
// verdade em toda rota — o header continua existindo com a mesma função de sempre
// (só libera quem pode falar com o Worker), só não é mais "proxy" de nada externo.
// =====================================================================
// Reflete a origem do chamador no Access-Control-Allow-Origin quando ela está na lista
// (o header é fixo em CORS/ALLOWED_ORIGIN pra rota sem Origin). Vary: Origin evita que
// cache intermediário sirva a resposta de uma origem pra outra.
function withCors(response, request) {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.includes(origin) || origin === ALLOWED_ORIGIN) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    let resposta;
    try {
      resposta = await routeRequest(request, env, ctx);
    } catch (err) {
      // Antes, uma exceção solta virava a página de erro 1101 da Cloudflare, SEM cabeçalho de CORS: o
      // navegador só enxergava "falha de rede" e a tela não conseguia dizer o que aconteceu.
      console.error(`erro não tratado em ${request.method} ${new URL(request.url).pathname}: ${(err && (err.stack || err.message)) || err}`);
      resposta = jsonRes({ error: 'erro interno do servidor' }, 500);
    }
    return withCors(resposta, request);
  },
  // Cron Trigger (wrangler.toml): alerta de SLA.
  async scheduled(event, env, ctx) {
    try {
      await alertarSla(env, event?.scheduledTime ?? Date.now());
    } catch (err) {
      console.error(`alertarSla falhou: ${(err && (err.stack || err.message)) || err}`);
    }
  },
};

async function routeRequest(request, env, ctx) {
  {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const { pathname } = new URL(request.url);

    // Agente de leitura de toners (2026-11-23): programa na rede interna que consulta as impressoras
    // pelo IP e manda o nível para cá. Segredo PRÓPRIO (TONER_AGENT_SECRET), nunca o de admin.
    if (pathname === '/agente/impressoras' && request.method === 'GET') return handleAgenteListaImpressoras(request, env);
    if (pathname === '/agente/leituras' && request.method === 'POST') return handleAgenteLeituras(request, env);
    if (pathname === '/agente/descobertas' && request.method === 'POST') return handleAgenteDescobertas(request, env);

    if (request.method === 'POST') {
      if (pathname === '/auth/register') return handleRegister(request, env, ctx);
      if (pathname === '/auth/register-externo') return handleRegisterExterno(request, env, ctx);
      if (pathname === '/auth/login')    return handleLogin(request, env);
      if (pathname === '/auth/logout')   return handleLogout(request, env);
      if (pathname === '/subscribe')     return handleSubscribe(request, env);
      if (pathname === '/api/presence')  return handlePresence(request, env);
      if (pathname === '/api/avaliacao-mensal') return handlePostAvaliacaoMensal(request, env);
      if (pathname === '/api/solicitacoes') return handleCriarSolicitacao(request, env);
      const solicStatusMatch = pathname.match(/^\/admin\/solicitacoes\/([^/]+)\/status$/);
      if (solicStatusMatch) return handleAdminMudarStatusSolicitacao(request, env, solicStatusMatch[1]);
      // Fase M4 (2026-08-13): rota /webhook removida — ver comentário perto de onde
      // handleWebhook/runStatusAutomation viviam (antes de "WEB PUSH" no arquivo).
      if (pathname === '/api/tasks')     return handleCreateTask(request, env);
      const attachMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/attachment$/);
      if (attachMatch) return handleUploadAttachment(request, env, attachMatch[1]);
      const notaMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/nota$/);
      if (notaMatch) return handleSetNota(request, env, notaMatch[1]);
      // Fase B do roadmap pós-MVP-visual (2026-08-14) — checados ANTES do match
      // genérico de single-id logo abaixo, senão "/admin/tasks/bulk" seria confundido
      // com um chamado de id literal "bulk", e "/admin/tasks/:id/eventos" bateria com
      // o regex de single-segment (que não tem essa sub-rota).
      if (pathname === '/admin/tasks/bulk') return handleAdminBulkUpdateTasks(request, env);
      const eventoPostMatch = pathname.match(/^\/admin\/tasks\/([^/]+)\/eventos$/);
      if (eventoPostMatch) return handleAdminCreateEvento(request, env, eventoPostMatch[1]);
      // Exclusão (2026-08-17) — checado ANTES do match genérico de single-id logo
      // abaixo, mesmo motivo do /eventos acima (senão bateria com o regex de
      // single-segment, que não tem essa sub-rota). POST (não DELETE) por convenção:
      // esta API nunca usou o verbo DELETE em lugar nenhum (CORS só libera GET/POST/
      // OPTIONS, ver const CORS) — toda mutação aqui é POST num path específico.
      const adminDeleteMatch = pathname.match(/^\/admin\/tasks\/([^/]+)\/delete$/);
      if (adminDeleteMatch) return handleAdminDeleteTask(request, env, adminDeleteMatch[1]);
      if (pathname === '/admin/migrate-schema-chamado-eventos') return handleAdminMigrateSchemaChamadoEventos(request, env);
      const adminUpdateMatch = pathname.match(/^\/admin\/tasks\/([^/]+)$/);
      if (adminUpdateMatch) return handleAdminUpdateTask(request, env, adminUpdateMatch[1]);
      // Fase M5 (2026-08-13): rotas de migração de uso único que liam da ClickUp
      // (/admin/migrate-d1, /admin/migrate-solicitantes, /admin/migrate-anexos) foram
      // removidas — já rodaram em produção, seus dados já estão no D1/R2, e mantê-las
      // vivas exigiria manter fetchAllTasks/getSolicitanteMaps/CLICKUP_API_KEY só por
      // causa delas. Rotas de migração de SCHEMA (abaixo) continuam — são D1-only, sem
      // ligação nenhuma com a ClickUp.
      if (pathname === '/admin/migrate-schema-nullable-tipo-setor') return handleAdminMigrateSchemaNullableTipoSetor(request, env);
      if (pathname === '/admin/migrate-schema-chamado-assignees') return handleAdminMigrateSchemaChamadoAssignees(request, env);
      if (pathname === '/admin/migrate-schema-solicitantes') return handleAdminMigrateSchemaSolicitantes(request, env);
      if (pathname === '/admin/migrate-schema-solicitantes-email') return handleAdminMigrateSchemaSolicitantesEmail(request, env);
      if (pathname === '/admin/migrate-schema-solicitantes-origem') return handleAdminMigrateSchemaSolicitantesOrigem(request, env);
      if (pathname === '/admin/migrate-schema-chamados-nota') return handleAdminMigrateSchemaChamadosNota(request, env);
      if (pathname === '/admin/migrate-schema-chamados-numero') return handleAdminMigrateSchemaChamadosNumero(request, env);
      if (pathname === '/admin/migrate-schema-equipamentos') return handleAdminMigrateSchemaEquipamentos(request, env);
      if (pathname === '/admin/migrate-schema-toners') return handleAdminMigrateSchemaToners(request, env);
      if (pathname === '/admin/toners') return handleAdminSaveToner(request, env, null);
      const tonerRecargaMatch = pathname.match(/^\/admin\/toners\/([^/]+)\/recarga$/);
      if (tonerRecargaMatch) return handleAdminRegistrarRecarga(request, env, tonerRecargaMatch[1]);
      const tonerDesfazerMatch = pathname.match(/^\/admin\/toners\/([^/]+)\/recarga\/desfazer$/);
      if (tonerDesfazerMatch) return handleAdminDesfazerRecarga(request, env, tonerDesfazerMatch[1]);
      const tonerSaveMatch = pathname.match(/^\/admin\/toners\/([^/]+)$/);
      if (tonerSaveMatch) return handleAdminSaveToner(request, env, tonerSaveMatch[1]);
      if (pathname === '/admin/equipamentos') return handleAdminSaveEquipamento(request, env, null);
      const equipSaveMatch = pathname.match(/^\/admin\/equipamentos\/([^/]+)$/);
      if (equipSaveMatch) return handleAdminSaveEquipamento(request, env, equipSaveMatch[1]);
      if (pathname === '/admin/solicitantes') return handleAdminCreateSolicitante(request, env);
      if (pathname === '/admin/solicitantes/emails/bulk') return handleAdminBulkSetSolicitanteEmails(request, env);
      const solAtivoMatch = pathname.match(/^\/admin\/solicitantes\/([^/]+)\/ativo$/);
      if (solAtivoMatch) return handleAdminSetSolicitanteAtivo(request, env, solAtivoMatch[1]);
      const solExcluirMatch = pathname.match(/^\/admin\/solicitantes\/([^/]+)\/excluir$/);
      if (solExcluirMatch) return handleAdminExcluirSolicitante(request, env, solExcluirMatch[1]);
      const solRenomearMatch = pathname.match(/^\/admin\/solicitantes\/([^/]+)\/renomear$/);
      if (solRenomearMatch) return handleAdminRenomearSolicitante(request, env, solRenomearMatch[1]);
      const solTransfMatch = pathname.match(/^\/admin\/solicitantes\/([^/]+)\/transferir-chamados$/);
      if (solTransfMatch) return handleAdminTransferirChamados(request, env, solTransfMatch[1]);
      const solEmailMatch = pathname.match(/^\/admin\/solicitantes\/([^/]+)\/email$/);
      if (solEmailMatch) return handleAdminSetSolicitanteEmail(request, env, solEmailMatch[1]);
      const resetSenhaMatch = pathname.match(/^\/admin\/users\/([^/]+)\/reset-senha$/);
      if (resetSenhaMatch) return handleAdminResetSenha(request, env, resetSenhaMatch[1]);
      if (pathname === '/admin/migrate-schema-anexos') return handleAdminMigrateSchemaAnexos(request, env);
      if (pathname === '/admin/import-anexo-url') return handleAdminImportAnexoUrl(request, env);
      if (pathname === '/admin/subscribe/test') return handleAdminSubscribeTest(request, env);
      if (pathname === '/admin/subscribe') return handleAdminSubscribe(request, env);
      if (pathname === '/admin/tasks') return handleAdminCreateTask(request, env);
    }

    if (request.method === 'GET') {
      // Fase M5 (2026-08-13): rota /api/field removida — GET /api/solicitantes (D1,
      // Fase M1) já tinha substituído por completo o único consumidor dela (a tela de
      // login do app), e nada mais no frontend chamava /api/field.
      if (pathname === '/api/solicitantes')  return handleListSolicitantes(request, env);
      if (pathname === '/api/my-tasks')      return handleGetMyTasks(request, env);
      if (pathname === '/api/avaliacao-mensal') return handleGetAvaliacaoMensal(request, env);
      if (pathname === '/api/solicitacoes') return handleMinhasSolicitacoes(request, env);
      if (pathname === '/admin/solicitacoes') return handleAdminListSolicitacoes(request, env);
      if (pathname === '/admin/avaliacoes-mensais') return handleAdminAvaliacoesMensais(request, env);
      if (pathname === '/admin/me')          return handleAdminMe(request, env);
      if (pathname === '/admin/users')       return handleAdminListUsers(request, env);
      if (pathname === '/admin/tasks')       return handleAdminListTasks(request, env);
      if (pathname === '/admin/metrics')     return handleAdminMetrics(request, env);
      if (pathname === '/admin/solicitantes') return handleAdminListSolicitantes(request, env);
      if (pathname === '/admin/presenca')    return handleAdminPresenca(request, env);
      if (pathname === '/admin/equipamentos') return handleAdminListEquipamentos(request, env);
      if (pathname === '/admin/toners')      return handleAdminListToners(request, env);
      if (pathname === '/api/equipamentos')  return handleListEquipamentosSolicitante(request, env);
      const eventosGetMatch = pathname.match(/^\/admin\/tasks\/([^/]+)\/eventos$/);
      if (eventosGetMatch) return handleAdminListEventos(request, env, eventosGetMatch[1]);
      const anexoMatch = pathname.match(/^\/api\/anexos\/([^/]+)$/);
      if (anexoMatch) return handleGetAnexo(request, env, anexoMatch[1]);
      const adminAnexoMatch = pathname.match(/^\/admin\/anexos\/([^/]+)$/);
      if (adminAnexoMatch) return handleAdminGetAnexo(request, env, adminAnexoMatch[1]);
      const adminAnexosListMatch = pathname.match(/^\/admin\/tasks\/([^/]+)\/anexos$/);
      if (adminAnexosListMatch) return handleAdminListAnexos(request, env, adminAnexosListMatch[1]);
      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) return handleGetTask(request, env, taskMatch[1]);
      return new Response('Chamados TI – Push Worker OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// =====================================================================
// AUTENTICAÇÃO DE APP (/api/*, /subscribe) — X-App-Secret
// =====================================================================
function hasValidSecret(request, env) {
  // Falha FECHADA se o Worker não tiver SUBSCRIBE_SECRET configurado (deploy é manual, colado
  // no dashboard — esquecer de setar a env var não pode virar "proxy fica aberto pra qualquer um").
  if (!env.SUBSCRIBE_SECRET) return false;
  return request.headers.get('X-App-Secret') === env.SUBSCRIBE_SECRET;
}

function unauthorized(msg = 'não autorizado') {
  return jsonRes({ error: msg }, 403);
}

function sessionInvalid() {
  return jsonRes({ error: 'sessão inválida ou expirada, faça login novamente' }, 401);
}

// Quem está autenticado nesta requisição, segundo o token de sessão — nunca segundo o que
// o cliente alega no corpo/query. Base de tudo que protege um solicitante ver dado de outro.
async function requireSession(request, env) {
  const token = request.headers.get('X-Session-Token');
  if (!token) return null;
  const raw = await env.SUBSCRIPTIONS.get(`session_${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  // Revogação em massa (2026-11-11): reset de senha e desativação gravam `sessver_<nome>`
  // (momento da revogação); sessão criada antes (ou sem `createdAt`, as antigas) morre.
  const ver = await env.SUBSCRIPTIONS.get(`sessver_${session.name}`);
  if (ver && (session.createdAt ?? 0) <= Number(ver)) return null;
  return session;
}

// Invalida todas as sessões abertas de alguém (reset de senha, desativação).
async function revokeSessions(env, name) {
  await env.SUBSCRIPTIONS.put(`sessver_${name}`, String(Date.now()), { expirationTtl: SESSION_TTL_SECONDS });
}

// Fase B7 (2026-08-12): lê do D1 em vez de paginar a ClickUp — é a rota mais chamada
// do Worker (poll de 60s de cada solicitante logado), então é onde o corte pro D1
// rende mais (sem round-trip pra API externa a cada poll). D1 guarda `solicitante`
// como o nome já resolvido (não um orderindex), então nem precisa mais do fallback
// que existia aqui pra quando o nome não resolvia no campo customizado atual da
// ClickUp — essa ambiguidade simplesmente não existe mais neste caminho.
async function handleGetMyTasks(request, env) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const rows = await d1ListChamados(env, { solicitante: session.name });
  return jsonRes({ tasks: rows.map(d1RowToTaskShape) });
}

// Fase M5 (2026-08-13, migração de saída da ClickUp): passou a ler do D1 por completo
// (`d1GetChamado` + `d1ListAnexos`) — antes era a última rota que ainda dependia da
// ClickUp pra qualquer coisa além de migração/push (a Fase M2 já tinha tirado os
// anexos de lá, mas o corpo da task em si continuava vindo de um GET direto). Checagem
// de dono ficou bem mais simples: compara `chamado.solicitante` com `session.name`
// direto, sem precisar resolver orderindex nenhum (D1 nunca guardou isso).
async function handleGetTask(request, env, taskId) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const chamado = await d1GetChamado(env, taskId);
  if (!chamado) return jsonRes({ error: 'chamado não encontrado' }, 404);

  // Dono do chamado tem que bater com quem está logado — sem isso, dava pra ver qualquer
  // chamado só sabendo/adivinhando o ID.
  if (chamado.solicitante !== session.name) return unauthorized('sem permissão pra ver esse chamado');

  const anexos = await d1ListAnexos(env, taskId);
  const origin = new URL(request.url).origin;
  const task = d1RowToTaskShape(chamado);
  task.attachments = anexos.map(a => ({
    url: `${origin}/api/anexos/${a.id}`,
    title: a.filename,
    name: a.filename,
    extension: (a.filename || '').includes('.') ? a.filename.split('.').pop() : null,
  }));

  return jsonRes(task);
}

// Fase M3 (2026-08-13, migração de saída da ClickUp): grava direto no D1
// (`d1CreateChamado`, Fase B2 — dormente até agora), não mais na ClickUp. `id` passa a
// ser `crypto.randomUUID()` (gerado pela aplicação, ver d1CreateChamado) em vez do
// `task_id` que a ClickUp sempre gerou (formato tipo `86ajzr6x0`) — mudança visível
// (quem olhar o id de um chamado novo repara), sem impacto funcional conhecido; o
// contrato HTTP de resposta continua o mesmo `Task` shape de sempre (via
// `d1RowToTaskShape`, já usado por GET /api/my-tasks/GET /admin/tasks), então o
// frontend não precisou mudar nada aqui.
async function handleCreateTask(request, env) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  let payload;
  try { payload = JSON.parse(await request.text()); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  // Prioridade e prazo nunca vêm do cliente — "prioridade é sempre automática, nunca
  // manual" é regra do projeto, e o due_date define a fila de SLA. Recalculados a
  // partir do TIPO só pra garantir que quem chamar o proxy direto (sabendo o
  // APP_SHARED_SECRET, que é público por design) não consiga abrir chamado como
  // Urgente com prazo já vencido.
  const tipoIdx  = (payload.custom_fields || []).find(f => f.id === TIPO_FIELD_ID)?.value;
  const setorIdx = (payload.custom_fields || []).find(f => f.id === SETOR_FIELD_ID)?.value;
  const prio     = CATEGORIA_PRIORIDADE[tipoIdx] ?? 3;
  const dueDate  = Date.now() + (PRIORITY_SLA_MS[prio] ?? PRIORITY_SLA_MS[3]);

  // Throttle simples: no máximo 1 chamado a cada 60s por pessoa logada — evita duplo-clique
  // acidental virando 2 tickets, e freia flood sem precisar de infra nova (reaproveita o
  // mesmo KV já usado pro dedup da automação).
  // ⚠️ expirationTtl mínimo aceito pelo Cloudflare KV é 60 — qualquer valor menor faz o PUT
  // falhar com 400, e essa falha não tratada derrubava handleCreateTask inteiro ANTES de
  // chegar a criar o chamado (incidente 2026-08-10: "Abrir Chamado" não funcionava pra
  // ninguém, sempre por essa exceção, não por CORS/rede como os erros do navegador sugeriam).
  const throttleKey = `throttle_create_${session.name}`;
  if (await env.SUBSCRIPTIONS.get(throttleKey)) {
    return jsonRes({ error: 'Aguarde alguns segundos antes de abrir outro chamado' }, 429);
  }

  // Validação de entrada (2026-11-11): antes, qualquer corpo virava chamado (título
  // vazio, descrição gigante, assignees lixo). Validado ANTES de gravar o throttle, pra
  // um pedido inválido não travar a pessoa por 60 s sem ter criado nada.
  if (!payload || typeof payload !== 'object') return jsonRes({ error: 'corpo inválido' }, 400);
  if (typeof payload.name !== 'string' || !payload.name.trim()) {
    return jsonRes({ error: 'o título do chamado é obrigatório' }, 400);
  }
  if (payload.name.length > MAX_CHAMADO_NAME_LEN) {
    return jsonRes({ error: `título muito longo (máximo ${MAX_CHAMADO_NAME_LEN} caracteres)` }, 400);
  }
  if (payload.description != null && (typeof payload.description !== 'string' || payload.description.length > MAX_CHAMADO_DESC_LEN)) {
    return jsonRes({ error: `descrição inválida ou muito longa (máximo ${MAX_CHAMADO_DESC_LEN} caracteres)` }, 400);
  }
  if (payload.assignees != null && (!Array.isArray(payload.assignees) || payload.assignees.length > MAX_CHAMADO_ASSIGNEES)) {
    return jsonRes({ error: 'lista de atendentes inválida' }, 400);
  }
  const assigneeIds = (payload.assignees || []).map(Number);
  if (assigneeIds.some(n => !Number.isInteger(n) || n <= 0)) {
    return jsonRes({ error: 'lista de atendentes inválida' }, 400);
  }
  // Regra (2026-11-24): escolher quem atende é obrigatório, e é um só (Everson OU Henrique).
  if (assigneeIds.length !== 1 || !OPERADOR_IDS.includes(assigneeIds[0])) {
    return jsonRes({ error: 'escolha um atendente: Everson ou Henrique' }, 400);
  }
  // Equipamento (opcional, 2026-11-23): se vier, tem que existir e estar em uso.
  const equip = await resolveEquipamentoId(env, payload.equipamento_id, { restrito: true, solicitante: session.name });
  if (equip.erro) return jsonRes({ error: equip.erro }, 400);
  // Marca o throttle antes de gravar (cobre o duplo-clique concorrente); desfeito se falhar.
  await env.SUBSCRIPTIONS.put(throttleKey, '1', { expirationTtl: 60 });
  let row;
  try {
    row = await d1CreateChamado(env, {
      name: payload.name.trim(),
      description: payload.description ?? null,
      status: 'aberto',
      priority: prio,
      tipo: tipoIdx != null ? Number(tipoIdx) : null,
      setor: setorIdx != null ? Number(setorIdx) : null,
      // Nunca confia no que o cliente mandou pra SOLICITANTE (nem manda nada, na
      // verdade) — sempre o nome da sessão autenticada. É isso que impede alguém de
      // abrir um chamado "como" outra pessoa.
      solicitante: session.name,
      due_date: dueDate,
      assignee_id: assigneeIds[0] ?? null,
      assignee_ids: assigneeIds,
      equipamento_id: equip.id,
    });
  } catch (err) {
    // Falha de gravação não pode travar a pessoa por 60 s: desfaz o throttle.
    await env.SUBSCRIPTIONS.delete(throttleKey);
    return jsonRes({ error: `não foi possível criar o chamado: ${err.message}` }, 400);
  }

  // Alerta de chamado novo pro admin (2026-08-13) — nunca derruba a resposta pro
  // solicitante se o push falhar (mesmo espírito de d1TransitionStatus): o chamado já
  // foi criado com sucesso, avisar a TI é best-effort.
  try {
    await notifyAdminsNovoChamado(env, row);
  } catch (err) {
    console.error(`handleCreateTask: falha ao notificar admins do chamado ${row.id}: ${err.message}`);
  }

  return jsonRes(d1RowToTaskShape(row));
}

// Fase M2 (2026-08-13, migração de saída da ClickUp): o anexo em si passou a ir pro R2
// (`r2UploadAnexo`, Fase B4 — dormente até agora) + um registro em `chamado_anexos` no
// D1, não mais pra ClickUp. Checagem de dono também passou a usar o D1
// (`d1GetChamado`/`chamados.solicitante`, já resolvido por nome) em vez de bater na
// ClickUp de novo — o chamado já foi espelhado no D1 na criação (Fase B7), então o
// dado já está lá; não tem motivo pra continuar pagando o round-trip extra.
async function handleUploadAttachment(request, env, taskId) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const chamado = await d1GetChamado(env, taskId);
  if (!chamado) return jsonRes({ error: 'chamado não encontrado' }, 404);
  if (chamado.solicitante !== session.name) return unauthorized('sem permissão pra anexar nesse chamado');

  let formData;
  try { formData = await request.formData(); } catch { return jsonRes({ error: 'corpo inválido (esperado multipart/form-data)' }, 400); }
  const file = formData.get('attachment');
  if (!(file instanceof File)) return jsonRes({ error: 'nenhum arquivo enviado (campo "attachment")' }, 400);
  if (file.size > MAX_ANEXO_BYTES) {
    return jsonRes({ error: `arquivo muito grande — limite de ${MAX_ANEXO_BYTES / 1024 / 1024}MB` }, 413);
  }

  const existentes = await d1ListAnexos(env, taskId);
  if (existentes.length >= MAX_ANEXOS_POR_CHAMADO) {
    return jsonRes({ error: `limite de ${MAX_ANEXOS_POR_CHAMADO} anexos por chamado` }, 400);
  }

  const { key, size, contentType } = await r2UploadAnexo(env, taskId, file.name, file.type, file.stream());
  const anexoId = crypto.randomUUID();
  try {
    await env.CHAMADOS_DB.prepare(
      'INSERT INTO chamado_anexos (id, chamado_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(anexoId, taskId, key, file.name, contentType, size, Date.now()).run();
  } catch (err) {
    // Sem o registro no D1 o arquivo ficaria órfão no R2 — apaga antes de falhar.
    await r2DeleteAnexo(env, key).catch(() => {});
    return jsonRes({ error: 'não foi possível salvar o anexo' }, 500);
  }

  return jsonRes({ ok: true, id: anexoId });
}

// =====================================================================
// POST /api/tasks/:id/nota — nota de satisfação (1-5) que o solicitante dá ao próprio
// chamado depois de encerrado (2026-09-21, pedido do usuário: "julgo essencial" — ver
// CLAUDE.md, sugerido desde a auditoria inicial e nunca implementado até agora).
// Mesmo padrão de dono de handleUploadAttachment/handleGetTask — autenticado por
// sessão, 403 se o chamado não for de quem está pedindo. Só aceita nota pra chamado
// já "encerrado" (não faz sentido avaliar antes disso); permite reenviar (sobrescreve
// a nota anterior) — deliberado, mais simples que travar depois do primeiro envio, e
// deixa a pessoa corrigir se errou o clique.
// =====================================================================
async function handleSetNota(request, env, taskId) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const chamado = await d1GetChamado(env, taskId);
  if (!chamado) return jsonRes({ error: 'chamado não encontrado' }, 404);
  if (chamado.solicitante !== session.name) return unauthorized('sem permissão pra avaliar esse chamado');
  if (chamado.status !== 'encerrado') {
    return jsonRes({ error: 'só é possível avaliar um chamado já encerrado' }, 400);
  }

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (!body || typeof body !== 'object') return jsonRes({ error: 'corpo inválido' }, 400);
  const nota = body.nota;
  if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
    return jsonRes({ error: 'nota precisa ser um número inteiro de 1 a 5' }, 400);
  }

  const atualizado = await d1UpdateChamado(env, taskId, { nota });
  return jsonRes(d1RowToTaskShape(atualizado));
}

// =====================================================================
// AUTENTICAÇÃO — hash de senha (PBKDF2-SHA256, formato autodescritivo em auth_<nome>)
// e sessão (token opaco em session_<token>, TTL de SESSION_TTL_SECONDS).
// =====================================================================
async function pbkdf2Hash(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return bytesToUrlB64(new Uint8Array(bits));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function setAuthRecord(name, password, env) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const record = {
    algo: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToUrlB64(saltBytes),
    hash: await pbkdf2Hash(password, saltBytes, PBKDF2_ITERATIONS),
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
  };
  await env.SUBSCRIPTIONS.put(`auth_${name}`, JSON.stringify(record));
}

async function verifyPassword(password, record) {
  const hash = await pbkdf2Hash(password, urlB64ToBytes(record.salt), record.iterations);
  return timingSafeEqual(hash, record.hash);
}

async function createSession(name, env) {
  const token = bytesToUrlB64(crypto.getRandomValues(new Uint8Array(32)));
  await env.SUBSCRIPTIONS.put(`session_${token}`, JSON.stringify({ name, createdAt: Date.now() }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

// =====================================================================
// /auth/register — cria a senha de alguém que ainda não tem uma (primeiro acesso).
// Body: { name, password, secret }
// =====================================================================
// Login por e-mail (2026-09-16, pedido da diretoria) — substitui por completo o
// login por nome-escolhido-numa-lista. `name` continua sendo a identidade interna
// de verdade (chave de `chamados.solicitante`, sessão, `auth_<nome>` no KV) — só o
// PONTO DE ENTRADA mudou; resolvido aqui via d1GetSolicitanteByEmail antes de cair
// no mesmo fluxo de sempre. E-mail normalizado (trim + minúsculas) tanto na escrita
// (aqui, handleAdminCreateSolicitante, handleAdminSetSolicitanteEmail) quanto na
// leitura — login não depende de bater maiúsculas/minúsculas.
function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// Domínio institucional obrigatório (2026-09-16, pedido do usuário) — "mta gente
// usa o gmail ainda (devido a facilidade com o google drive)", mas o login do
// sistema exige o e-mail oficial do instituto. Checado só nos 3 pontos onde um
// e-mail é GRAVADO num solicitante (handleAdminCreateSolicitante,
// handleAdminSetSolicitanteEmail, handleAdminBulkSetSolicitanteEmails) — não no
// login/registro em si, porque ali o e-mail só é CONSULTADO (se nunca foi possível
// gravar um gmail, login nunca vai encontrar um gmail cadastrado de qualquer jeito).
const EMAIL_DOMAIN = 'institutosaovicente.com.br';

// Domínio de verdade (ou subdomínio real dele) — usado nos pontos de ESCRITA do admin
// pra ACEITAR um e-mail como institucional. `endsWith('@'+EMAIL_DOMAIN)` (versão
// original) tinha um bug sutil: comparava o e-mail inteiro, então um subdomínio de
// verdade como `conta@setor.institutosaovicente.com.br` não batia (o caractere antes
// de `institutosaovicente.com.br` era `.`, não `@`) — inofensivo aqui (só rejeitaria
// um e-mail legítimo a mais), mas o mesmo bug em handleRegisterExterno (ver abaixo)
// tinha o efeito contrário e perigoso: não bloqueava. Corrigido comparando o domínio
// isolado (depois do último `@`), não o e-mail inteiro.
function isEmailDoDominio(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1);
  return domain === EMAIL_DOMAIN || domain.endsWith(`.${EMAIL_DOMAIN}`);
}

// Checagem mais paranoica (2026-09-21, achado do agente `revisor`) — só usada pra
// REJEITAR no autocadastro externo, nunca pra aceitar em nenhum ponto de escrita do
// admin. Além do domínio de verdade, barra qualquer domínio que só PAREÇA
// institucional (lookalike/typosquat, ex.: `institutosaovicente.com.br.evil.com`) —
// sem isso, alguém de fora podia se autocadastrar com um e-mail que engana quem olha
// rápido a tela "Usuários" do admin ou o e-mail exibido num chamado, mesmo sem
// conseguir de fato logar como um solicitante interno (o PK em `name` já impedia
// isso). Deliberadamente mais larga que `isEmailDoDominio` — usar só pra bloquear.
function pareceEmailInstitucional(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1);
  return isEmailDoDominio(email) || domain.includes('institutosaovicente');
}

function normalizeNomePessoa(v) {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
}

async function handleRegister(request, env, ctx) {
  if (!hasValidSecret(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const email = normalizeEmail(body.email);
  const password = body.password;
  if (!email || !password || password.length < 8) {
    return jsonRes({ error: 'E-mail e senha (mínimo 8 caracteres) são obrigatórios' }, 400);
  }

  // Mesma proteção que já existia baseada em nome (Fase M1, 2026-08-13) — agora via
  // e-mail: só deixa criar senha se o e-mail já estiver cadastrado e ativo na
  // tabela `solicitantes` (a TI cadastra o e-mail de cada um antes, tela
  // "Usuários") — sem isso, qualquer e-mail viraria conta.
  // Limite de tentativas com e-mail desconhecido, por IP (2026-11-11): sem isso, dava pra
  // varrer e-mails à vontade e descobrir quem existe pela diferença de resposta. Teto
  // generoso (o escritório todo sai por um IP e se cadastra no mesmo dia).
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const regFailKey = `regfail_${ip}`;
  const regFails = parseInt(await env.SUBSCRIPTIONS.get(regFailKey) || '0');
  if (regFails >= MAX_REGISTER_FAIL_PER_IP) {
    return jsonRes({ error: 'Muitas tentativas. Aguarde um pouco e tente de novo.' }, 429);
  }

  const solicitante = await d1GetSolicitanteByEmail(env, email);
  if (!solicitante || solicitante.ativo !== 1) {
    await env.SUBSCRIPTIONS.put(regFailKey, String(regFails + 1), { expirationTtl: REGISTER_FAIL_WINDOW_SECONDS });
    return jsonRes({ error: 'E-mail não encontrado na lista de solicitantes. Fale com a TI.' }, 403);
  }
  let name = solicitante.name;

  if (await env.SUBSCRIPTIONS.get(`auth_${name}`)) {
    return jsonRes({ error: 'Já existe uma senha cadastrada pra esse e-mail. Se esqueceu, peça pro TI resetar.' }, 409);
  }

  // Nome completo no primeiro acesso (2026-11-12): vários e-mails da lista são de CARGO
  // (assistente.administrativo10@, recepcionista@), então o nome que a TI tinha pode estar
  // desatualizado. O que a pessoa digita vira o nome da conta e substitui o da lista; os
  // chamados antigos e a inscrição de push acompanham a troca (mesma cascata do renomear
  // do admin). Checado depois da busca do e-mail pra não mudar a resposta de e-mail
  // desconhecido (403 igual a antes).
  const nomeDigitado = normalizeNomePessoa(body.nome);
  if (!nomeDigitado || nomeDigitado.split(' ').length < 2) {
    return jsonRes({ error: 'Digite seu nome completo (nome e sobrenome)' }, 400);
  }
  if (nomeDigitado.length > 100) return jsonRes({ error: 'Nome muito longo' }, 400);
  if (nomeDigitado !== name) {
    const ocupado = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind(nomeDigitado).first();
    if (ocupado) {
      return jsonRes({ error: 'Já existe alguém cadastrado com esse nome. Inclua mais um sobrenome ou fale com a TI.' }, 409);
    }
    try {
      await garantirEsquemaSolicitacoes(env);
      await garantirEsquemaAvaliacao(env);
      await env.CHAMADOS_DB.batch([
        ...moverAvaliacoes(env, name, nomeDigitado),
        env.CHAMADOS_DB.prepare('UPDATE solicitantes SET name = ? WHERE name = ?').bind(nomeDigitado, name),
        env.CHAMADOS_DB.prepare('UPDATE chamados SET solicitante = ? WHERE solicitante = ?').bind(nomeDigitado, name),
        env.CHAMADOS_DB.prepare('UPDATE solicitacoes SET solicitante = ? WHERE solicitante = ?').bind(nomeDigitado, name),
      ]);
    } catch (err) {
      return jsonRes({ error: /unique/i.test(err.message) ? 'Já existe alguém cadastrado com esse nome. Inclua mais um sobrenome ou fale com a TI.' : err.message }, 409);
    }
    const sub = await env.SUBSCRIPTIONS.get(`usub_${name}`);
    if (sub) {
      await env.SUBSCRIPTIONS.put(`usub_${nomeDigitado}`, sub);
      await env.SUBSCRIPTIONS.delete(`usub_${name}`);
    }
    await revokeSessions(env, name);
    name = nomeDigitado;
  }

  await setAuthRecord(name, password, env);
  const token = await createSession(name, env);
  await avisarNovaConta(env, ctx, name, email, 'interno');
  return jsonRes({ token, name });
}

// Checagem simples de formato (não valida domínio — externo aceita qualquer um,
// diferente de isEmailDoDominio). Só pra pegar erro de digitação óbvio antes de gravar.
const EMAIL_FORMATO_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// =====================================================================
// /auth/register-externo — autocadastro pra quem NÃO está na lista pré-aprovada
// pela TI (visitante, parceiro, fornecedor — 2026-09-17, pedido do usuário: "os
// chamados tbm estao sendo usados de forma externa, e agora recebemos um chamado
// com a identificacao outros e nem sabemos de onde veio"). Até aqui, alguém sem
// e-mail institucional não tinha NENHUMA forma de logar — na prática isso empurrou
// todo mundo externo pra uma conta compartilhada única ("Outros" ou parecido),
// misturando chamados de pessoas diferentes sob a mesma identidade — exatamente o
// problema que o login por e-mail (2026-09-16) queria evitar, só que reintroduzido
// pela porta dos fundos pra quem não está na lista da TI.
// Diferenças deliberadas em relação a handleRegister:
//   - name/email digitados aqui pela própria pessoa (handleRegister resolve o name
//     a partir de um solicitante que a TI JÁ cadastrou; aqui não existe cadastro
//     prévio nenhum — o INSERT acontece nesta própria chamada).
//   - SEM exigência de domínio institucional (isEmailDoDominio nunca é chamada) —
//     é justamente pra quem não tem e-mail @institutosaovicente.com.br.
//   - telefone opcional, mas recomendado: e-mail pessoal é fácil de digitar errado
//     e não dá pra confirmar por nenhuma lista prévia; telefone é uma segunda forma
//     de identificar/contatar alguém que a TI nunca viu antes.
//   - origem: 'externo' grava a distinção pra tela "Usuários" do admin poder
//     filtrar/sinalizar visualmente quem entrou por esse caminho (ver usuarios-view.tsx).
// Body: { name, email, password, telefone? }
// =====================================================================
async function handleRegisterExterno(request, env, ctx) {
  if (!hasValidSecret(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const email = normalizeEmail(body.email);
  const password = body.password;
  const telefone = typeof body.telefone === 'string' && body.telefone.trim() ? body.telefone.trim() : null;

  if (!name || name.split(' ').length < 2) {
    return jsonRes({ error: 'Digite seu nome completo (nome e sobrenome)' }, 400);
  }
  // Sem limite, um nome enorme estourava a chave do KV depois do INSERT e deixava o e-mail travado.
  if (name.length > 100) return jsonRes({ error: 'Nome muito longo (máximo 100 caracteres)' }, 400);
  if (new TextEncoder().encode(`auth_${name}`).length > 400) return jsonRes({ error: 'Nome muito longo' }, 400);
  if (telefone && telefone.length > 30) return jsonRes({ error: 'Telefone muito longo' }, 400);
  if (email && email.length > 254) return jsonRes({ error: 'E-mail inválido' }, 400);
  if (!email || !EMAIL_FORMATO_REGEX.test(email)) {
    return jsonRes({ error: 'E-mail inválido' }, 400);
  }
  // Domínio institucional (ou algo que pareça) é reservado pra conta criada/aprovada
  // pela TI (handleRegister) — sem essa checagem, qualquer um poderia se autocadastrar
  // como "externo" alegando um e-mail @institutosaovicente.com.br (ou um lookalike)
  // que a TI nunca cadastrou de verdade. `pareceEmailInstitucional`, não
  // `isEmailDoDominio` — ver comentário dela (achado do revisor, 2026-09-21).
  if (pareceEmailInstitucional(email)) {
    return jsonRes({ error: 'E-mail institucional detectado — use a tela de entrada normal, não o cadastro externo' }, 400);
  }
  if (!password || password.length < 8) {
    return jsonRes({ error: 'Senha (mínimo 8 caracteres) é obrigatória' }, 400);
  }

  // Rate-limit por IP (2026-09-21, achado do revisor) — diferente de handleLogin
  // (lockout por nome) e isAdmin (lockout por IP contra ADMIN_SECRET errado), esta
  // rota não tinha NENHUM limite: só o X-App-Secret (público por design) protegia,
  // então qualquer script com esse header podia criar solicitantes "externo" em
  // volume ilimitado. Mesmo padrão de chave/TTL de `adminfail_<ip>` — conta só
  // cadastros que de fato completam (ver incremento perto do fim da função), não
  // cada tentativa, pra não punir alguém corrigindo um typo no formulário.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = `externoreg_${ip}`;
  const rateCount = parseInt(await env.SUBSCRIPTIONS.get(rateKey) || '0');
  if (rateCount >= MAX_REGISTER_EXTERNO_PER_IP) {
    return jsonRes({ error: 'Muitos cadastros a partir deste IP. Aguarde um pouco e tente de novo.' }, 429);
  }

  const existente = await d1GetSolicitanteByEmail(env, email);
  if (existente) {
    return jsonRes({ error: 'Já existe um cadastro com esse e-mail. Tente entrar em vez de cadastrar de novo.' }, 409);
  }

  let inserted;
  try {
    ({ inserted } = await d1CreateSolicitante(env, name, email, { origem: 'externo', telefone }));
  } catch (err) {
    if (/unique/i.test(err.message)) {
      return jsonRes({ error: 'Já existe outro cadastro com esse e-mail' }, 409);
    }
    return jsonRes({ error: err.message }, 500);
  }
  // name é PRIMARY KEY — colisão de nome (não de e-mail, já checado acima) é rara
  // mas possível (duas pessoas diferentes digitando o mesmo nome completo). Pedir
  // pra completar o nome em vez de mascarar com sufixo automático, que confundiria
  // a TI olhando o Kanban/Tabela depois.
  if (!inserted) {
    return jsonRes({ error: 'Já existe um cadastro com esse nome. Inclua um sobrenome adicional ou fale com a TI.' }, 409);
  }

  await env.SUBSCRIPTIONS.put(rateKey, String(rateCount + 1), { expirationTtl: REGISTER_EXTERNO_WINDOW_SECONDS });

  await setAuthRecord(name, password, env);
  const token = await createSession(name, env);
  await avisarNovaConta(env, ctx, name, email, 'externo');
  return jsonRes({ token, name });
}

// =====================================================================
// /auth/login — valida senha existente e devolve um token de sessão.
// Body: { email, password, secret }
// =====================================================================
async function handleLogin(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const email = normalizeEmail(body.email);
  const password = body.password;
  if (!email || !password) return jsonRes({ error: 'E-mail e senha são obrigatórios' }, 400);

  const solicitante = await d1GetSolicitanteByEmail(env, email);
  const name = solicitante?.name;
  // Sem solicitante encontrado pra esse e-mail: mesma resposta 404 de "sem senha
  // cadastrada ainda" — não distingue "e-mail desconhecido" de "e-mail válido sem
  // senha" (o frontend cai pro fluxo de registro em qualquer um dos dois casos, e
  // handleRegister rejeita de vez um e-mail que não corresponde a solicitante
  // nenhum — ver comentário lá).
  if (!name) return jsonRes({ error: 'Sem senha cadastrada pra esse e-mail ainda' }, 404);

  // Lockout por nome+IP (quem erra de um IP não tranca o dono da conta em outro) e um
  // teto maior só por nome contra ataque vindo de muitos IPs.
  if (solicitante.ativo !== 1) return jsonRes({ error: 'Senha incorreta' }, 401);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `loginfail_${name}_${ip}`;
  const nameKey = `loginfail_${name}`;
  const failCount = parseInt(await env.SUBSCRIPTIONS.get(failKey) || '0');
  const nameCount = parseInt(await env.SUBSCRIPTIONS.get(nameKey) || '0');
  if (failCount >= MAX_LOGIN_FAILURES || nameCount >= MAX_LOGIN_FAILURES_NAME_BACKSTOP) {
    return jsonRes({ error: 'Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.' }, 429);
  }

  const raw = await env.SUBSCRIPTIONS.get(`auth_${name}`);
  if (!raw) return jsonRes({ error: 'Sem senha cadastrada pra esse e-mail ainda' }, 404);
  const record = JSON.parse(raw);

  const ok = await verifyPassword(password, record);
  if (!ok) {
    await env.SUBSCRIPTIONS.put(failKey, String(failCount + 1), { expirationTtl: LOGIN_LOCKOUT_SECONDS });
    await env.SUBSCRIPTIONS.put(nameKey, String(nameCount + 1), { expirationTtl: LOGIN_LOCKOUT_SECONDS });
    return jsonRes({ error: 'Senha incorreta' }, 401);
  }

  await env.SUBSCRIPTIONS.delete(failKey);
  record.lastLoginAt = Date.now();
  await env.SUBSCRIPTIONS.put(`auth_${name}`, JSON.stringify(record));
  const token = await createSession(name, env);
  return jsonRes({ token, name });
}

// =====================================================================
// /admin/users — lista quem já tem senha cadastrada (nome, quando criou, último login).
// Protegido por env.ADMIN_SECRET (header X-Admin-Secret) — segredo separado do
// APP_SHARED_SECRET, nunca fica em app.js nem em nenhum lugar do navegador de ninguém.
// Nunca devolve hash/salt de senha, só metadados.
// =====================================================================
// Mesma proteção de brute-force do login (MAX_LOGIN_FAILURES/LOGIN_LOCKOUT_SECONDS), mas por
// IP em vez de nome — ADMIN_SECRET é um segredo único e global (não por pessoa), então a chave
// de lockout precisa ser algo que não deixe um atacante travar a TI de fora mandando tentativas
// erradas: o IP de quem está tentando, nunca o segredo em si. Só conta como "tentativa" quando
// o header X-Admin-Secret é realmente mandado (com valor errado) — não quando vem ausente, senão
// qualquer chamada sem esse header (ex.: bater com o secret errado por engano, ou até crawler)
// já contaria como tentativa de adivinhar.
const MAX_ADMIN_FAILURES     = 5;
const ADMIN_LOCKOUT_SECONDS  = 15 * 60;

// Operadores de TI (ids = os mesmos de OPERADORES no frontend). Cada chamado tem EXATAMENTE
// um desses como atendente (regra de 2026-11-24, pedido do usuário).
const OPERADOR_IDS = [170628721, 200498355]; // Everson, Henrique
const OPERADOR_ADMIN_ID = 200498355; // Henrique (desenvolvedor): usa a ADMIN_SECRET e também só vê os dele
const OPERADOR_NOMES = { 170628721: 'Everson', 200498355: 'Henrique' };

// Papéis do painel (2026-11-24): `admin` (ADMIN_SECRET, o desenvolvedor — vê e faz tudo) e
// `operador` (uma chave por operador em env.OPERADOR_SECRETS, JSON {"<id>":"<chave>"} —
// só enxerga/mexe nos chamados atribuídos a ele). Mesmo header X-Admin-Secret e mesmo
// lockout por IP. Devolve { role:'admin' } | { role:'operador', operadorId } | null.
async function getStaff(request, env) {
  const provided = request.headers.get('X-Admin-Secret');
  if (!provided) return null;

  const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `adminfail_${ip}`;
  const failCount = parseInt(await env.SUBSCRIPTIONS.get(failKey) || '0');
  if (failCount >= MAX_ADMIN_FAILURES) return null;

  let staff = null;
  if (env.ADMIN_SECRET && provided === env.ADMIN_SECRET) {
    staff = { role: 'admin', operadorId: OPERADOR_ADMIN_ID };
  } else if (env.OPERADOR_SECRETS) {
    let mapa = {};
    try { mapa = JSON.parse(env.OPERADOR_SECRETS) || {}; } catch { mapa = {}; }
    for (const [id, chave] of Object.entries(mapa)) {
      const idNum = Number(id);
      if (chave && provided === chave && OPERADOR_IDS.includes(idNum)) { staff = { role: 'operador', operadorId: idNum }; break; }
    }
  }

  if (!staff) {
    await env.SUBSCRIPTIONS.put(failKey, String(failCount + 1), { expirationTtl: ADMIN_LOCKOUT_SECONDS });
    return null;
  }
  if (failCount > 0) await env.SUBSCRIPTIONS.delete(failKey);
  return staff;
}

// Só o admin (desenvolvedor): usuários, solicitantes, migrações, exclusão, criar chamado.
async function isAdmin(request, env) {
  const s = await getStaff(request, env);
  return !!s && s.role === 'admin';
}

// Admin OU operador (rotas do dia a dia da TI). Devolve o papel, ou null.
async function isStaff(request, env) {
  return getStaff(request, env);
}

// Cada pessoa da TI (admin incluso) só acessa chamado atribuído a ela.
async function staffCanAccessChamado(env, staff, chamadoId) {
  const r = await env.CHAMADOS_DB.prepare(
    'SELECT 1 AS ok FROM chamado_assignees WHERE chamado_id = ? AND assignee_id = ?'
  ).bind(chamadoId, staff.operadorId).first();
  return !!r;
}

// GET /admin/me — diz ao painel quem entrou (papel e, se operador, o id).
async function handleAdminMe(request, env) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  return jsonRes(staff);
}

async function handleAdminListUsers(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  const users = [];
  let cursor;
  do {
    const list = await env.SUBSCRIPTIONS.list({ prefix: 'auth_', cursor });
    for (const key of list.keys) {
      const raw = await env.SUBSCRIPTIONS.get(key.name);
      if (!raw) continue;
      const record = JSON.parse(raw);
      users.push({
        name: key.name.slice('auth_'.length),
        createdAt: record.createdAt ?? null,
        lastLoginAt: record.lastLoginAt ?? null,
      });
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  users.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return jsonRes({ total: users.length, users });
}

// =====================================================================
// POST /admin/users/:nome/reset-senha (2026-09-16, pedido do usuário: "ver os
// cadastros e possivelmente resetar a senha de acesso dos usuários") — apaga a
// senha atual (`auth_<nome>` no KV) e qualquer lockout de tentativas erradas
// (`loginfail_<nome>`) pra essa pessoa. Não exige que o nome exista em
// `solicitantes` nem que já tenha senha — resetar quem não tem senha nenhuma é só
// um no-op idempotente (nada pra apagar), não um erro. Mesmo efeito prático que
// apagar a chave manualmente no painel da Cloudflare (ver SEGREDOS-LOCAIS.md/
// CLAUDE.md), só que sem precisar de acesso ao dashboard da Cloudflare pra isso.
// =====================================================================
async function handleAdminResetSenha(request, env, name) {
  if (!(await isAdmin(request, env))) return unauthorized();
  const decoded = decodeURIComponent(name);
  await env.SUBSCRIPTIONS.delete(`auth_${decoded}`);
  await env.SUBSCRIPTIONS.delete(`loginfail_${decoded}`);
  // Lockouts por IP (loginfail_<nome>_<ip>) também saem, e as sessões abertas morrem —
  // senão quem tinha a senha antiga (ou o token roubado) continuaria logado por 90 dias.
  const lista = await env.SUBSCRIPTIONS.list({ prefix: `loginfail_${decoded}_` });
  await Promise.all(lista.keys.map(k => env.SUBSCRIPTIONS.delete(k.name)));
  await revokeSessions(env, decoded);
  return jsonRes({ ok: true });
}

// Fase M5 (2026-08-13): `cfValue`/`fetchAllTasks` foram removidas — só existiam pra
// ler o shape bruto de task da ClickUp (usado por `mapClickUpTaskToD1`/
// `handleAdminMigrateD1`/`handleAdminMigrateAnexos`, as três rotas de migração de
// uso único que saíram junto nesta fase, ver mais abaixo). Nenhuma rota que continua
// no ar depende delas.

// =====================================================================
// /admin/tasks — todos os chamados, com filtros opcionais via query string (status,
// setor, tipo, operador, solicitante). Protegido por ADMIN_SECRET, mesmo padrão de
// /admin/users. "setor"/"tipo" são o orderindex numérico (o mesmo valor gravado no
// custom field da ClickUp — ver SETORES/TIPOS em app.js pra mapear pro nome);
// "operador" é o id do assignee (ver OPERADORES em app.js); "solicitante" é o nome.
//
// 🚀 B7 parte 2, fase 2 (2026-08-12): lê do D1 em vez de paginar a ClickUp inteira a
// cada chamada — era o bloqueio documentado desde a parte 1 (`chamados.assignee_id`
// era 1 coluna só, não representava chamado com 2+ operadores; a fase 1 já resolveu
// isso com `chamado_assignees`, ver CLAUDE.md). `withAssignees: true` pede o array
// completo — é o que preserva o aviso de "múltiplos operadores atribuídos" no modal
// "Gerenciar" (ver Fase 4 do painel de admin). `solicitante` filtra direto pelo nome
// (D1 já guarda o nome resolvido na coluna, não um orderindex — não precisa mais do
// passo de resolução via getSolicitanteMaps que a versão ClickUp exigia); nome
// inexistente continua devolvendo lista vazia, só que agora "de graça" (0 linhas
// batem o WHERE), sem precisar de um caso especial pra isso. `truncated` sempre false
// — D1 não pagina como fetchAllTasks, não existe teto de páginas aqui.
// =====================================================================
async function handleAdminListTasks(request, env) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();

  const { searchParams } = new URL(request.url);
  const statusFilter      = searchParams.get('status');
  const setorFilter       = searchParams.get('setor');
  const tipoFilter        = searchParams.get('tipo');
  // Operador só vê os dele: o filtro é imposto no servidor, ignorando o que vier na URL.
  const operadorFilter    = String(staff.operadorId);
  const solicitanteFilter = searchParams.get('solicitante');

  const rows = await d1ListChamados(env, {
    status: statusFilter ? statusFilter.toLowerCase() : undefined,
    setor: setorFilter ?? undefined,
    tipo: tipoFilter ?? undefined,
    assigneeId: operadorFilter ?? undefined,
    solicitante: solicitanteFilter ?? undefined,
    withAssignees: true,
    withAnexos: true,
  });
  const tasks = rows.map(d1RowToTaskShape);

  return jsonRes({ total: tasks.length, tasks, truncated: false });
}

// =====================================================================
// POST /admin/tasks (2026-09-15, pedido do usuário: "Adicionar Chamado" inline na
// Tabela, como a ClickUp tem) — cria um chamado NOVO em nome de um solicitante,
// disparado pela TI direto do painel (diferente de POST /api/tasks, que é o
// solicitante criando o próprio chamado autenticado por SESSÃO). Protegida por
// ADMIN_SECRET, mesma proteção de toda rota /admin/*.
//
// Reaproveita exatamente a mesma lógica de handleCreateTask pra prioridade/prazo
// automáticos (regra de negócio: "prioridade é sempre automática, nunca manual" vale
// aqui também — a TI não escolhe prioridade na mão, só o tipo). Diferente de
// handleCreateTask: `solicitante` vem do BODY (não de sessão nenhuma, o admin não tem
// login por pessoa) — mas só é aceito se já existir e estiver ativo na tabela
// `solicitantes` (mesma validação de handleRegister), pra não criar um chamado em
// nome de alguém que não existe/foi desativado.
//
// Sempre cria como "aberto", mesmo se o botão "+ Adicionar Chamado" foi clicado
// dentro de um grupo diferente (Pendente/Encerrado) na Tabela — decisão deliberada:
// todo o resto do sistema (SLA de aceitação, `start_date`/`date_closed`,
// "solução obrigatória pra encerrar") pressupõe que um chamado sempre COMEÇA aberto e
// muda de status através de `d1TransitionStatus` (POST /admin/tasks/:id), nunca já
// nasce pendente/encerrado — deixar criar direto em outro status abriria uma exceção
// silenciosa a todas essas regras. O frontend só mostra "+ Adicionar Chamado" no
// grupo Aberto por esse motivo (ver tasks-table.tsx).
//
// 🐛 Achado real (2026-09-15, testando notificação com o usuário): esta rota NUNCA
// chamou `notifyAdminsNovoChamado` — só `handleCreateTask` (fluxo do solicitante)
// chamava. Um chamado criado por aqui (a TI, por um operador, em nome de alguém)
// nunca avisava o OUTRO operador (ex.: Everson cria, Henrique nunca fica sabendo).
// Passou despercebido até agora porque "+ Adicionar Chamado" é uso recente — corrigido
// chamando a mesma função, mesmo padrão best-effort (nunca derruba a criação).
async function handleAdminCreateTask(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const solicitante = typeof body.solicitante === 'string' ? body.solicitante.trim() : '';
  if (!name) return jsonRes({ error: 'nome do chamado é obrigatório' }, 400);
  if (!solicitante) return jsonRes({ error: 'solicitante é obrigatório' }, 400);
  const assigneeId = Number(body.assigneeId);
  if (!OPERADOR_IDS.includes(assigneeId)) return jsonRes({ error: 'escolha um atendente: Everson ou Henrique' }, 400);
  if (!(await d1IsSolicitanteAtivo(env, solicitante))) {
    return jsonRes({ error: 'solicitante não encontrado ou inativo' }, 400);
  }

  // Mesmo cálculo de handleCreateTask — não duplicar a regra de negócio, só o
  // caminho de autenticação/origem do payload é diferente.
  const tipoIdx  = body.tipo != null ? Number(body.tipo) : null;
  const setorIdx = body.setor != null ? Number(body.setor) : null;
  const prio     = CATEGORIA_PRIORIDADE[tipoIdx] ?? 3;
  const dueDate  = Date.now() + (PRIORITY_SLA_MS[prio] ?? PRIORITY_SLA_MS[3]);

  const equip = await resolveEquipamentoId(env, body.equipamento_id);
  if (equip.erro) return jsonRes({ error: equip.erro }, 400);

  let row;
  try {
    row = await d1CreateChamado(env, {
      name,
      equipamento_id: equip.id,
      description: typeof body.description === 'string' ? body.description : null,
      status: 'aberto',
      priority: prio,
      tipo: tipoIdx,
      setor: setorIdx,
      solicitante,
      due_date: dueDate,
      assignee_id: assigneeId,
      assignee_ids: [assigneeId],
    });
  } catch (err) {
    return jsonRes({ error: `não foi possível criar o chamado: ${err.message}` }, 400);
  }

  // Avisa quem mais está inscrito pro push de admin — mesmo best-effort de
  // handleCreateTask, nunca derruba a resposta se o push falhar.
  try {
    await notifyAdminsNovoChamado(env, row);
  } catch (err) {
    console.error(`handleAdminCreateTask: falha ao notificar admins do chamado ${row.id}: ${err.message}`);
  }

  return jsonRes(d1RowToTaskShape(row));
}

// =====================================================================
// /admin/metrics — agregados pro painel de admin: total por status, tempo médio de
// atendimento por operador (duração real "em atendimento" -> "encerrado"), % dentro
// do SLA vs atrasado, volume por tipo/setor (chaves = orderindex, mapear pro nome no
// painel via TIPOS/SETORES de app.js). Protegido por ADMIN_SECRET.
//
// 🚀 B7 parte 2, fase 2 (2026-08-12): lê do D1 (d1GetMetrics, escrita desde a Fase B2
// mas nunca chamada por nenhuma rota até agora) em vez de paginar a ClickUp inteira.
// Mesmo motivo/mesma data do corte de /admin/tasks acima — ver comentário lá.
// =====================================================================
// Fase A do roadmap pós-MVP-visual (2026-08-14): filtro de período opcional, `desde`/
// `ate` em epoch ms via querystring — cobre o caso "quero ver só a última semana/mês"
// sem exigir migração de schema (`date_created` já existe na tabela desde sempre).
// Omitidos, o comportamento é idêntico a antes (agregado geral).
// Marco de início da operação real: 16/10/2026 00:00 em Fortaleza (UTC-3).
// Em 2026-10-16 as métricas passaram a ignorar tudo antes dele (os chamados anteriores vieram da
// fase de testes/ClickUp e 66% apareciam como "atrasado"). Em 2026-11-24 o usuário pediu o
// contrário: "preciso ter os dados de todos os chamados desde o início para filtragem dos
// indicadores". O piso foi REMOVIDO: sem `desde`, o agregado conta todos os chamados, e o
// período é decidido por quem filtra. O marco continua sendo devolvido (`inicioOperacao`) só
// pra o painel oferecer o atalho "só a operação", sem forçar nada.
const OPERACAO_INICIO_MS = Date.UTC(2026, 9, 16, 3, 0, 0);

async function handleAdminMetrics(request, env) {
  // Métricas são gerais (decisão do usuário): admin e operador veem o mesmo agregado.
  if (!(await isStaff(request, env))) return unauthorized();

  const { searchParams } = new URL(request.url);
  const desdeRaw = searchParams.get('desde');
  const ateRaw   = searchParams.get('ate');
  const desde = desdeRaw != null ? Number(desdeRaw) : undefined;
  const ate   = ateRaw   != null ? Number(ateRaw)   : undefined;
  if ((desdeRaw != null && !Number.isFinite(desde)) || (ateRaw != null && !Number.isFinite(ate))) {
    return jsonRes({ error: 'desde/ate precisam ser epoch ms (número)' }, 400);
  }

  // Filtros (todos opcionais, combinam com E). Valor inválido = 400, nunca ignorado em silêncio.
  const filtros = {};
  for (const [chave, valido] of [
    ['setor', n => n >= 0 && n < 100], ['tipo', n => n >= 0 && n < 100],
    ['prioridade', n => n >= 1 && n <= 3], ['operador', n => n > 0],
  ]) {
    const raw = searchParams.get(chave);
    if (raw == null || raw === '') continue;
    // Só dígitos: Number() aceitaria "0x10", "1e1", "+3" e " " (vira 0), e o filtro mudaria sem aviso.
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || !valido(n)) return jsonRes({ error: `${chave} inválido` }, 400);
    filtros[chave] = n;
  }
  const statusRaw = searchParams.get('status');
  if (statusRaw) {
    if (!D1_VALID_STATUSES.includes(statusRaw.toLowerCase())) return jsonRes({ error: 'status inválido' }, 400);
    filtros.status = statusRaw.toLowerCase();
  }
  const solicitanteRaw = searchParams.get('solicitante');
  if (solicitanteRaw) filtros.solicitante = solicitanteRaw.slice(0, 120);

  return jsonRes({ ...(await d1GetMetrics(env, { desde, ate, ...filtros })), inicioOperacao: OPERACAO_INICIO_MS });
}

// =====================================================================
// POST /admin/tasks/:id — a TI trabalha por aqui em vez de abrir a ClickUp (decisão de
// 2026-08-07: ClickUp continua guardando o dado, mas deixa de ser a INTERFACE de
// trabalho — ver CLAUDE.md, "Painel de admin"). Protegido por ADMIN_SECRET, mesmo
// padrão das outras rotas /admin/*. Body aceita qualquer subconjunto de:
//   { status, solucao, assigneeId }
//
// Fase M4 (2026-08-13, migração de saída da ClickUp): D1 vira o destino direto de toda
// sub-mutação — não é mais espelho depois de escrever na ClickUp, é a escrita em si.
// `status` chama `d1TransitionStatus` (Fase B5, dormente até agora), que já embute o
// que antes vinha de `runStatusAutomation` via webhook (pausa/retomada de SLA em
// "pendente", start_date/due_date ao entrar em "em atendimento", date_closed ao
// "encerrado", push) — de forma SÍNCRONA, na mesma request, sem depender de nenhuma
// automação configurada na ClickUp. `assigneeId` não precisa mais buscar quem já está
// atribuído pra montar um diff {add, rem} (isso só existia por causa da API da
// ClickUp) — `d1UpdateChamado` com `assigneeIdsForSync` já SUBSTITUI por completo quem
// está atribuído (mesmo padrão que já existia pro espelho, ver comentário de
// `d1UpdateChamado`). Segue valendo: sem transação real entre as sub-mutações (cada
// `d1UpdateChamado`/`d1TransitionStatus` é sua própria escrita) — uma falha no meio
// reporta em `updated` o que já foi aplicado antes de parar, mesma proteção do
// revisor de 2026-08-07 contra mascarar estado parcial.
// =====================================================================
// Fase B do roadmap pós-MVP-visual (2026-08-14): a lógica de aplicar um patch num
// chamado foi extraída de handleAdminUpdateTask pra uma função pura (sem parsear
// request/responder HTTP), reaproveitada também por handleAdminBulkUpdateTasks —
// mesma validação, mesma sequência de sub-mutações, mesmo formato de erro parcial
// (`updated` reportando o que já foi aplicado antes de parar). Ganhou de brinde o
// log automático em `chamado_eventos` pra status/operador (só quando o valor muda de
// verdade — reatribuir pro mesmo operador ou "mudar" pro mesmo status não gera
// evento à toa).
async function applyAdminTaskUpdate(env, taskId, body) {
  // Validação de tipo/valor de cada campo antes de tocar em qualquer coisa — achados do
  // revisor 2026-08-07: "solucao" não-string era ignorado em silêncio (respondia
  // ok:true sem salvar nada) e "assigneeId" não validava número/NaN.
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    return { error: `status inválido — use um de: ${VALID_STATUSES.join(', ')}`, statusCode: 400 };
  }
  if (body.solucao !== undefined && typeof body.solucao !== 'string') {
    return { error: 'solucao precisa ser uma string', statusCode: 400 };
  }
  // Regra (2026-11-24): todo chamado tem exatamente um operador de TI — nada de "sem
  // atribuição" nem de operador desconhecido.
  if (body.assigneeId !== undefined && !OPERADOR_IDS.includes(Number(body.assigneeId))) {
    return { error: 'assigneeId precisa ser um operador de TI válido (um só)', statusCode: 400 };
  }
  if (body.status === undefined && body.solucao === undefined && body.assigneeId === undefined) {
    return { error: 'nada pra atualizar — mande status, solucao e/ou assigneeId', statusCode: 400 };
  }

  const chamado = await d1GetChamado(env, taskId);
  if (!chamado) return { error: 'chamado não encontrado', statusCode: 404 };

  // Regra (2026-11-16, pedido do usuário): escrever uma solução encerra o chamado. Vale quando
  // quem chamou NÃO escolheu um status explícito (um status mandado junto é respeitado) e o
  // chamado não está encerrado nem pendente (pendente = SLA pausado; ali a solução é só anotação) — assim qualquer cliente da API segue a mesma regra do painel.
  if (body.status === undefined && typeof body.solucao === 'string' && body.solucao.trim() && chamado.status !== 'encerrado' && chamado.status !== 'pendente') {
    body = { ...body, status: 'encerrado' };
  }

  // Regra de negócio (2026-08-24, pedido do usuário): a solução precisa estar
  // descrita toda vez que um chamado é encerrado — não dá pra fechar "em branco".
  // `solucaoFinal` é o que a solução VAI SER depois desta atualização: usa o que
  // veio no corpo se `solucao` foi mandado nesta mesma request (caso do popup do
  // Quadro/Tabela e do modal "Gerenciar", que sempre mandam os dois juntos), senão
  // cai pro que já estava salvo (caso de alguém chamar só `{status:'encerrado'}`
  // direto, sem passar pelo popup — ex.: um chamado que já tinha solução escrita
  // antes e só está tendo o status confirmado). Checado ANTES de qualquer
  // sub-mutação rodar — não dá pra "meio-encerrar" sem solução.
  if (body.status === 'encerrado') {
    const solucaoFinal = body.solucao !== undefined ? body.solucao : chamado.solucao;
    if (!solucaoFinal || !solucaoFinal.trim()) {
      return { error: 'não é possível encerrar um chamado sem preencher a solução', statusCode: 400 };
    }
  }

  const updated = {};

  if (body.status !== undefined) {
    const statusAnterior = chamado.status;
    try {
      await d1TransitionStatus(env, taskId, body.status);
      updated.status = body.status;
      if (statusAnterior !== body.status) await d1LogEvento(env, taskId, 'status', statusAnterior, body.status);
    } catch (err) {
      return { error: `status não pôde ser salvo: ${err.message}`, statusCode: 400, updated };
    }
  }

  if (body.solucao !== undefined) {
    try {
      await d1UpdateChamado(env, taskId, { solucao: body.solucao });
      updated.solucao = true;
    } catch (err) {
      return { error: `solução não pôde ser salva: ${err.message}`, statusCode: 400, updated };
    }
  }

  if (body.assigneeId !== undefined) {
    // null = "Sem atribuição" (remove quem estiver atribuído); qualquer outro valor = o
    // id de pra quem atribuir. `assigneeIdsForSync` como array substitui por completo
    // (DELETE+INSERT) quem está em `chamado_assignees` — não precisa de diff {add, rem}
    // nem de buscar quem já estava atribuído antes, já que não tem mais API externa
    // exigindo isso.
    const desiredId = body.assigneeId === null ? null : Number(body.assigneeId);
    const anteriorId = chamado.assignee_id;
    try {
      await d1UpdateChamado(env, taskId, { assigneeId: desiredId }, desiredId != null ? [desiredId] : []);
      updated.assigneeId = desiredId;
      if (anteriorId !== desiredId) {
        await d1LogEvento(env, taskId, 'operador', anteriorId != null ? String(anteriorId) : null, desiredId != null ? String(desiredId) : null);
      }
    } catch (err) {
      return { error: `operador não pôde ser salvo: ${err.message}`, statusCode: 400, updated };
    }
  }

  return { updated };
}

async function handleAdminUpdateTask(request, env, taskId) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  if (!(await d1GetChamado(env, taskId))) return jsonRes({ error: 'chamado não encontrado' }, 404);
  if (!(await staffCanAccessChamado(env, staff, taskId))) return jsonRes({ error: 'este chamado não é seu' }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const result = await applyAdminTaskUpdate(env, taskId, body);
  if (result.error) return jsonRes({ error: result.error, updated: result.updated }, result.statusCode);
  return jsonRes({ ok: true, updated: result.updated });
}

// =====================================================================
// POST /admin/tasks/bulk — ação em lote (Fase B do roadmap pós-MVP-visual,
// 2026-08-14), mesmo conceito já demonstrado no Artifact do MVP visual. Body:
// { ids: string[], status?, solucao?, assigneeId? } — mesmo subconjunto aceito por
// POST /admin/tasks/:id, aplicado a vários chamados de uma vez via
// applyAdminTaskUpdate (sem duplicar a lógica de validação/transição/log de evento).
// Sem transação entre chamados — cada um é sua própria applyAdminTaskUpdate, e a
// resposta reporta por id o que aconteceu (mesma filosofia de "não mascarar estado
// parcial" da rota single-id). Teto de 50 ids por chamada — não é um número
// arbitrário: é o mesmo tipo de cautela já aprendida nesta sessão sobre o orçamento
// de subrequests por invocação do Worker (ver POST /admin/migrate-anexos), aplicada
// de propósito aqui em vez de descobrir o teto real na marra em produção.
// =====================================================================
const BULK_MAX_IDS = 50;
async function handleAdminBulkUpdateTasks(request, env) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : [];
  if (!ids.length) return jsonRes({ error: 'ids precisa ser uma lista não vazia de strings' }, 400);
  if (ids.length > BULK_MAX_IDS) return jsonRes({ error: `no máximo ${BULK_MAX_IDS} chamados por vez` }, 400);

  const { ids: _ids, ...patchBody } = body;
  if (patchBody.status === undefined && patchBody.solucao === undefined && patchBody.assigneeId === undefined) {
    return jsonRes({ error: 'nada pra atualizar — mande status, solucao e/ou assigneeId' }, 400);
  }

  const results = [];
  for (const id of ids) {
    if (!(await d1GetChamado(env, id))) { results.push({ id, ok: false, error: 'chamado não encontrado' }); continue; }
    if (!(await staffCanAccessChamado(env, staff, id))) {
      results.push({ id, ok: false, error: 'este chamado não é seu' });
      continue;
    }
    const r = await applyAdminTaskUpdate(env, id, patchBody);
    results.push({ id, ok: !r.error, error: r.error, updated: r.updated });
  }
  const sucesso = results.filter((r) => r.ok).length;
  return jsonRes({ ok: true, total: ids.length, sucesso, falha: ids.length - sucesso, results });
}

// =====================================================================
// /auth/logout — invalida o token de sessão atual.
// =====================================================================
async function handleLogout(request, env) {
  const token = request.headers.get('X-Session-Token');
  if (token) await env.SUBSCRIPTIONS.delete(`session_${token}`);
  return jsonRes({ ok: true });
}

// =====================================================================
// /subscribe — salva subscription do usuário no KV
// Body: { subscription: PushSubscription }
// =====================================================================
async function handleSubscribe(request, env) {
  try {
    if (!hasValidSecret(request, env)) return unauthorized();

    const session = await requireSession(request, env);
    if (!session) return sessionInvalid();

    const { subscription } = await request.json();
    if (!subscription?.endpoint) return jsonRes({ error: 'subscription ausente' }, 400);
    // Validação (2026-11-11): só https (os serviços de push reais são todos https), chaves
    // presentes e tamanhos razoáveis — antes qualquer JSON era gravado como está.
    let endpointUrl = null;
    try { endpointUrl = new URL(subscription.endpoint); } catch { /* inválido */ }
    if (
      !endpointUrl || endpointUrl.protocol !== 'https:' || subscription.endpoint.length > 1000 ||
      typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string' ||
      subscription.keys.p256dh.length > 200 || subscription.keys.auth.length > 100
    ) {
      return jsonRes({ error: 'subscription inválida (precisa de endpoint https e keys.p256dh/keys.auth)' }, 400);
    }

    // Fase M5 (2026-08-13, migração de saída da ClickUp): a chave passou de
    // `u_<orderindex da ClickUp>` (exigia resolver o índice via getSolicitanteMaps a
    // cada inscrição) pra `usub_<nome>` direto — `session.name` já é a identidade real
    // desde sempre, não precisa de tradução nenhuma. `d1TransitionStatus` lê essa mesma
    // chave pra mandar push. Quem já tinha uma subscription salva sob a chave antiga
    // fica sem push até reabrir o app (o app já rechama /subscribe sozinho toda vez que
    // a página carrega com permissão concedida — ver use-push-notifications.tsx/
    // setupNotifications() em app.js — então se resolve sozinho no uso normal, mesmo
    // padrão do incidente de troca de par VAPID em 2026-08-10).
    await env.SUBSCRIPTIONS.put(`usub_${session.name}`, JSON.stringify(subscription));
    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ error: err.message }, 500);
  }
}

// =====================================================================
// POST /admin/subscribe — inscrição de push pro lado admin (feature de alerta de
// chamado novo, 2026-08-13). Sem login por pessoa no admin (só ADMIN_SECRET
// compartilhado, ver isAdmin) — a inscrição é por NAVEGADOR/DISPOSITIVO: `id` vem do
// cliente (`crypto.randomUUID()`, gerado uma vez e guardado em localStorage), não do
// servidor. Body: { id: string, subscription: PushSubscription }. `handleCreateTask`
// enumera todo mundo sob o prefixo `adminsub_` (mesmo padrão de `.list({prefix})` que
// `handleAdminListUsers` já usa pra `auth_`) e manda push pra cada um quando um
// chamado novo é criado. Reenviar com o mesmo `id` sobrescreve — idempotente.
// =====================================================================
async function handleAdminSubscribe(request, env) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return jsonRes({ error: 'id é obrigatório' }, 400);
  // 🛡️ Achado do revisor (2026-08-13, mesmo dia): validar só `endpoint` deixava
  // gravar uma subscription sem `keys.p256dh`/`keys.auth` — sendWebPush quebraria com
  // um TypeError genérico (não um "Push endpoint 404/410" reconhecível), então
  // notifyAdminsNovoChamado nunca limparia essa inscrição podre, e ela ficaria
  // falhando (só logado, nunca visível) pra sempre a cada chamado novo criado.
  if (!body.subscription?.endpoint || !body.subscription?.keys?.p256dh || !body.subscription?.keys?.auth) {
    return jsonRes({ error: 'subscription inválida (precisa de endpoint e keys.p256dh/keys.auth)' }, 400);
  }

  // Guarda de quem é a inscrição: operador só recebe aviso dos chamados dele (admin recebe todos).
  const guardada = { ...body.subscription, operadorId: staff.operadorId, papel: staff.role };
  await env.SUBSCRIPTIONS.put(`adminsub_${id}`, JSON.stringify(guardada));
  return jsonRes({ ok: true });
}

// =====================================================================
// POST /admin/subscribe/test (2026-09-15) — pedido do usuário ("não estou sendo
// notificado"): dispara um push REAL pra UM device específico (não pra todo mundo,
// diferente de notifyAdminsNovoChamado), pelo mesmo caminho de sendWebPush que um
// chamado novo usaria. Devolve erro explícito em vez de engolir em silêncio — é
// exatamente o diagnóstico que faltava: até agora, uma subscription podre só era
// descoberta (e limpa) na próxima vez que um chamado de verdade fosse criado, sem
// ninguém ver o erro. Body: { id: string } — mesmo id de handleAdminSubscribe.
// =====================================================================
async function handleAdminSubscribeTest(request, env) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return jsonRes({ error: 'id é obrigatório' }, 400);

  const subJson = await env.SUBSCRIPTIONS.get(`adminsub_${id}`);
  if (!subJson) return jsonRes({ error: 'nenhuma inscrição salva pra esse device — clique em "Ativar" primeiro' }, 404);
  // Operador só testa o aparelho dele (inscrição sem dono vale como do admin, igual a notifyAdminsNovoChamado).
  if (staff.role === 'operador') {
    const dono = JSON.parse(subJson).operadorId ?? OPERADOR_ADMIN_ID;
    if (dono !== staff.operadorId) return unauthorized();
  }

  const payload = JSON.stringify({
    title: 'Teste de notificação — Chamados de TI',
    body:  'Se você está vendo isso, as notificações estão funcionando. 🎉',
    data:  { type: 'teste' },
  });

  try {
    await sendWebPush(JSON.parse(subJson), payload, env);
    return jsonRes({ ok: true });
  } catch (err) {
    // Subscription morta (404/410) — mesma limpeza de notifyAdminsNovoChamado, já
    // que o teste acabou de confirmar isso na prática: o próximo "Ativar" gera uma
    // inscrição nova do zero em vez de ficar preso numa referência velha.
    if (/^Push endpoint (404|410):/.test(err.message)) {
      await env.SUBSCRIPTIONS.delete(`adminsub_${id}`);
      return jsonRes({ error: 'inscrição expirada/inválida (removida) — clique em "Ativar" de novo' }, 410);
    }
    return jsonRes({ error: `falha ao enviar: ${err.message}` }, 502);
  }
}

// =====================================================================
// Fase M4 (2026-08-13, migração de saída da ClickUp): `POST /webhook`,
// `handleWebhook` e `runStatusAutomation` foram REMOVIDOS daqui — existiam só pra
// reagir à automação configurada dentro da própria interface da ClickUp (evento
// `taskStatusUpdated`), que ficou dispensada assim que `handleAdminUpdateTask` passou a
// chamar `d1TransitionStatus` de forma síncrona, na mesma request (ver comentário lá).
// Fecha de quebra o item de segurança que já estava documentado no CLAUDE.md: `POST
// /webhook` nunca teve autenticação nenhuma — qualquer um que soubesse a URL do Worker
// (hardcoded em app.js, pública) e um task_id real podia forjar uma mudança de status.
// **Coordenação manual pendente, fora do código:** a automação correspondente
// continua configurada dentro da interface da ClickUp e vai continuar chamando essa
// URL (que agora só devolve 404) até alguém desligá-la/apagá-la lá manualmente — sem
// efeito nenhum aqui (a chamada simplesmente falha em silêncio do lado da ClickUp),
// mas fica como lixo de configuração até ser removida.
// =====================================================================

// =====================================================================
// WEB PUSH — RFC 8030 + RFC 8291 (aes128gcm) + RFC 8292 (VAPID)
// =====================================================================
async function sendWebPush(sub, payloadStr, env) {
  const receiverPub  = urlB64ToBytes(sub.keys.p256dh);
  const authSecret   = urlB64ToBytes(sub.keys.auth);
  const enc          = new TextEncoder();

  // Ephemeral sender key pair
  const senderPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );
  const senderPubBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderPair.publicKey)
  );

  // ECDH shared secret
  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const sharedBits  = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, senderPair.privateKey, 256
  );
  const sharedSecret = new Uint8Array(sharedBits);

  // Random salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 §3.3 key derivation
  const prkCombine = await hkdfExtract(authSecret, sharedSecret);
  const keyInfo    = concat(enc.encode('WebPush: info'), new Uint8Array([0]), receiverPub, senderPubBytes);
  const ikm        = await hkdfExpand(prkCombine, keyInfo, 32);

  const prk       = await hkdfExtract(salt, ikm);
  const cek       = await hkdfExpand(prk, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce     = await hkdfExpand(prk, concat(enc.encode('Content-Encoding: nonce'),     new Uint8Array([0])), 12);

  // Encrypt
  const plaintext = concat(enc.encode(payloadStr), new Uint8Array([0x02]));
  const cekKey    = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, plaintext)
  );

  // aes128gcm binary frame: salt(16) | rs(4) | keyid_len(1) | keyid(65) | ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const body = concat(salt, rs, new Uint8Array([senderPubBytes.length]), senderPubBytes, ciphertext);

  // VAPID JWT
  const { token, publicKey } = await createVapidJwt(sub.endpoint, env);

  const resp = await fetch(sub.endpoint, {
    method:  'POST',
    headers: {
      'Authorization':    `vapid t=${token},k=${publicKey}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Push endpoint ${resp.status}: ${text}`);
  }
}

// =====================================================================
// Alerta de chamado novo pro admin (2026-08-13) — chamada por `handleCreateTask`
// depois que o chamado já foi gravado no D1 com sucesso. Enumera todo mundo sob o
// prefixo `adminsub_` (mesmo padrão de `.list({prefix, cursor})` que
// `handleAdminListUsers` já usa pra `auth_`) e manda push em paralelo pra cada um —
// um assinante com subscription morta (404/410, ex.: desinstalou o navegador) nunca
// deveria travar o aviso pros outros nem, muito menos, a criação do chamado em si
// (chamada isolada num try/catch próprio em handleCreateTask). Subscription morta é
// apagada na hora, em vez de ficar tentando pra sempre a cada chamado novo.
// =====================================================================
async function notifyAdmins(env, payloadObj, tag = "notifyAdmins", { paraOperadorId = null } = {}) {
  const ids = [];
  let cursor;
  do {
    const list = await env.SUBSCRIPTIONS.list({ prefix: 'adminsub_', cursor });
    for (const key of list.keys) ids.push(key.name);
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  if (!ids.length) return;

  const payload = JSON.stringify(payloadObj);

  await Promise.allSettled(ids.map(async (key) => {
    const subJson = await env.SUBSCRIPTIONS.get(key);
    if (!subJson) return;
    const sub = JSON.parse(subJson);
    // Inscrição de operador só recebe os chamados atribuídos a ele; a do admin recebe todos.
    // Inscrições antigas (sem campos) eram do Henrique. Chamado novo: só quem é o atendente.
    // Aviso geral (conta nova, paraOperadorId nulo): só o admin.
    const subOp = sub.operadorId ?? OPERADOR_ADMIN_ID;
    const subPapel = sub.papel ?? 'admin';
    if (paraOperadorId != null ? subOp !== paraOperadorId : subPapel !== 'admin') return;
    try {
      await sendWebPush(sub, payload, env);
    } catch (err) {
      // Endpoint não existe mais (navegador desinstalado/subscription revogada) —
      // limpa em vez de continuar tentando pra sempre a cada aviso.
      if (/^Push endpoint (404|410):/.test(err.message)) {
        await env.SUBSCRIPTIONS.delete(key);
      } else {
        console.error(`${tag}: falha ao enviar push (${key}): ${err.message}`);
      }
    }
  }));
}

async function notifyAdminsNovoChamado(env, row) {
  await notifyAdmins(env, {
    title: 'Chamados de TI – ISV',
    body:  `Novo chamado: "${row.name}" — aberto por ${row.solicitante || 'alguém'}`,
    data:  { task_id: row.id, status: 'aberto', type: 'novo_chamado' },
  }, 'notifyAdminsNovoChamado', { paraOperadorId: row.assignee_id ?? null });
}

// =====================================================================
// Alerta de SLA por push (2026-11-26) — rodado pelo Cron do wrangler.toml a cada 5 min.
// Só no expediente (seg a sex, 07h às 18h de Fortaleza). Chamado "pendente" nunca entra
// (SLA pausado). Quem recebe: o atendente; o admin recebe também os vencidos.
// Marca no KV por (chamado, tipo, prazo, destinatário): não repete, e um prazo novo
// (retomada de pausa, "em atendimento") volta a poder avisar.
// =====================================================================
const SLA_VENCE_LOGO_MS = 15 * 60000;
// Vencido há mais que isso não avisa: cobre o fim de semana (sexta 18h → segunda 07h) sem
// despejar chamados antigos parados toda vez que o alerta rodar.
const SLA_VENCIDO_MAX_MS = 4 * 24 * 3600000;
const SLA_MAX_AVISOS_POR_RODADA = 5;
// Cada aparelho é um subrequest: o teto de verdade da invocação é o de envios.
const SLA_MAX_ENVIOS_POR_RODADA = 10;
const SLA_MARCA_TTL_SECONDS = 7 * 24 * 3600; // maior que SLA_VENCIDO_MAX_MS: depois disso nem é candidato
const FORTALEZA_OFFSET_MS = -3 * 3600000; // UTC-3 fixo, sem horário de verão

function noExpediente(agora) {
  const local = new Date(agora + FORTALEZA_OFFSET_MS);
  const dia = local.getUTCDay();
  const hora = local.getUTCHours();
  return dia >= 1 && dia <= 5 && hora >= 7 && hora < 18;
}

// "15:20" se for hoje (em Fortaleza), senão "24/11 às 15:20".
function prazoFalado(due, agora) {
  const d = new Date(due + FORTALEZA_OFFSET_MS).toISOString();
  const hora = d.slice(11, 16);
  if (d.slice(0, 10) === new Date(agora + FORTALEZA_OFFSET_MS).toISOString().slice(0, 10)) return hora;
  return `${d.slice(8, 10)}/${d.slice(5, 7)} às ${hora}`;
}

async function listarChavesKV(env, prefix) {
  const nomes = [];
  let cursor;
  do {
    const list = await env.SUBSCRIPTIONS.list({ prefix, cursor });
    for (const key of list.keys) nomes.push(key.name);
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return nomes;
}

async function alertarSla(env, agora = Date.now()) {
  if (!noExpediente(agora)) return { avisos: 0 };

  // Os que vencem logo primeiro (a janela deles é curta), depois os vencidos mais recentes.
  const { results } = await env.CHAMADOS_DB.prepare(
    `SELECT c.id, c.numero, c.due_date, COALESCE(a.assignee_id, c.assignee_id) AS atendente
       FROM chamados c LEFT JOIN chamado_assignees a ON a.chamado_id = c.id
      WHERE c.status IN ('aberto', 'em atendimento')
        AND c.due_date IS NOT NULL AND c.due_date > ? AND c.due_date <= ?
      ORDER BY (c.due_date <= ?), ABS(c.due_date - ?)`
  ).bind(agora - SLA_VENCIDO_MAX_MS, agora + SLA_VENCE_LOGO_MS, agora, agora).all();
  if (!results.length) return { avisos: 0 };

  const aparelhos = [];
  for (const key of await listarChavesKV(env, 'adminsub_')) {
    const json = await env.SUBSCRIPTIONS.get(key);
    if (!json) continue;
    try {
      const sub = JSON.parse(json);
      aparelhos.push({ key, sub, operadorId: sub.operadorId ?? OPERADOR_ADMIN_ID });
    } catch { /* inscrição corrompida: ignora */ }
  }
  if (!aparelhos.length) return { avisos: 0 };
  const jaAvisados = new Set(await listarChavesKV(env, 'slaalert_'));

  const porChamado = new Map();
  for (const r of results) {
    if (!porChamado.has(r.id)) porChamado.set(r.id, { ...r, atendentes: new Set() });
    if (r.atendente != null) porChamado.get(r.id).atendentes.add(r.atendente);
  }

  let avisos = 0;
  let envios = 0;
  const semEntrega = new Set(); // quem falhou em todos os aparelhos não gasta mais vagas nesta rodada
  for (const c of porChamado.values()) {
    const venceu = c.due_date <= agora;
    const tipo = venceu ? 'venceu' : 'vencelogo';
    const destinos = new Set(c.atendentes);
    if (venceu) destinos.add(OPERADOR_ADMIN_ID);

    for (const operadorId of destinos) {
      if (avisos >= SLA_MAX_AVISOS_POR_RODADA) return { avisos };
      const marca = `slaalert_${c.id}_${tipo}_${c.due_date}_${operadorId}`;
      if (jaAvisados.has(marca) || semEntrega.has(operadorId)) continue;
      const alvos = aparelhos.filter((a) => !a.morto && a.operadorId === operadorId).slice(0, SLA_MAX_ENVIOS_POR_RODADA);
      if (!alvos.length) continue; // sem aparelho: não marca, avisa quando a pessoa ativar

      const numero = c.numero ? `#${String(c.numero).padStart(4, '0')}` : 'sem número';
      const quando = prazoFalado(c.due_date, agora);
      const deOutro = !c.atendentes.has(operadorId)
        ? ` (atendente: ${[...c.atendentes].map((id) => OPERADOR_NOMES[id] ?? 'outro').join(', ') || 'ninguém'})`
        : '';
      const payload = JSON.stringify({
        title: venceu ? 'Chamado com prazo vencido' : 'Chamado perto do prazo',
        body: (venceu ? `Chamado ${numero} passou do prazo (era ${quando})` : `Chamado ${numero} vence às ${quando}`) + deOutro,
        data: { task_id: c.id, type: 'sla' },
      });

      if (envios + alvos.length > SLA_MAX_ENVIOS_POR_RODADA) return { avisos };
      envios += alvos.length;
      avisos++;
      let entregue = false;
      for (const alvo of alvos) {
        try {
          await sendWebPush(alvo.sub, payload, env);
          entregue = true;
        } catch (err) {
          if (/^Push endpoint (404|410):/.test(err.message)) {
            alvo.morto = true;
            await env.SUBSCRIPTIONS.delete(alvo.key);
          } else {
            console.error(`alertarSla: falha ao enviar push (${alvo.key}): ${err.message}`);
          }
        }
      }
      // Falhou em todos os aparelhos: sem marca, tenta de novo na próxima rodada.
      if (!entregue) { semEntrega.add(operadorId); continue; }
      try {
        await env.SUBSCRIPTIONS.put(marca, '1', { expirationTtl: SLA_MARCA_TTL_SECONDS });
      } catch (err) {
        // Sem conseguir marcar, parar: continuar só geraria mais avisos repetidos.
        console.error(`alertarSla: não gravou a marca, rodada interrompida: ${err.message}`);
        return { avisos };
      }
    }
  }
  return { avisos };
}

// Alerta de conta nova (2026-11-16, pedido do usuário: "preciso saber quando alguém criar
// uma conta"): avisa a TI quando alguém define a senha pela 1ª vez (primeiro acesso de
// quem a TI cadastrou) ou se cadastra como visitante. Best-effort: nunca derruba o
// cadastro (chamadores usam try/catch). Não leva senha nem dado sensível, só nome e e-mail.
// Texto livre do usuário no corpo da notificação: troca caracteres de controle/quebras por
// espaço e corta o tamanho (evita aviso gigante ou enganoso).
function limpaTextoAviso(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Dispara o aviso SEM atrasar a resposta do cadastro: com `ctx.waitUntil` o Worker termina
// o envio depois de responder; sem ctx (testes) aguarda normalmente. Nunca lança.
function avisarNovaConta(env, ctx, name, email, origem) {
  const p = notifyAdminsNovaConta(env, name, email, origem).catch((e) => console.error('nova conta: aviso falhou: ' + e.message));
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(p); return undefined; }
  return p;
}

async function notifyAdminsNovaConta(env, name, email, origem) {
  name = limpaTextoAviso(name, 60);
  email = limpaTextoAviso(email, 100);
  const quem = origem === 'externo' ? 'Visitante' : 'Primeiro acesso';
  await notifyAdmins(env, {
    title: 'Chamados de TI – ISV',
    body:  `${quem}: ${name}${email ? ' (' + email + ')' : ''} criou a conta.`,
    data:  { type: 'nova_conta', name, email: email || null, origem },
  }, 'notifyAdminsNovaConta');
}

// =====================================================================
// VAPID JWT (ES256)
// =====================================================================
async function createVapidJwt(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const now      = Math.floor(Date.now() / 1000);
  const header   = urlSafeB64Encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload  = urlSafeB64Encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT }));
  const sigInput = `${header}.${payload}`;

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(sigInput))
  );

  return { token: `${sigInput}.${bytesToUrlB64(sig)}`, publicKey: env.VAPID_PUBLIC_KEY };
}

// =====================================================================
// HKDF (RFC 5869)
// =====================================================================
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key  = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let T      = new Uint8Array(0);
  let result = new Uint8Array(0);
  for (let i = 1; i <= Math.ceil(length / 32); i++) {
    T      = new Uint8Array(await crypto.subtle.sign('HMAC', key, concat(T, info, new Uint8Array([i]))));
    result = concat(result, T);
  }
  return result.slice(0, length);
}

// =====================================================================
// UTILS
// =====================================================================
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) { out.set(a, i); i += a.length; }
  return out;
}

function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function bytesToUrlB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function urlSafeB64Encode(str) {
  return bytesToUrlB64(new TextEncoder().encode(str));
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

// =====================================================================
// CAMADA DE DADOS — CLOUDFLARE D1 (Fase B2 do roadmap de modernização,
// 2026-08-11 — ver CLAUDE.md "Deploy do Worker"/"Decisões técnicas tomadas")
//
// ⚠️ NADA nas rotas acima usa isto ainda. A ClickUp continua sendo 100% a
// fonte de verdade em produção — estas funções existem só como preparação
// pra uma migração futura (B3 em diante), testadas isoladamente
// (tests/d1-layer.test.js) e exportadas pra isso. Schema em d1/schema.sql,
// já aplicado no banco real (binding CHAMADOS_DB em wrangler.toml).
//
// Espelha os mesmos campos que hoje vivem em custom_fields na ClickUp, mas
// com nomes de coluna diretos (sem a indireção de orderindex que a API da
// ClickUp exige) — ver FIELD_IDS em app.js pro equivalente do lado ClickUp.
//
// Limitação deliberada (documentada, não é bug): só 1 assignee_id por
// chamado — replica exatamente o que o modal "Gerenciar" do admin.js já
// suporta hoje (pré-seleciona só 1 operador, mesmo quando a task da ClickUp
// tem 2+ assignees). Suporte de verdade a múltiplos operadores fica pra uma
// fase futura, se for decidido — não é regressão em relação ao admin atual.
//
// Efeitos colaterais de transição de status (start_date ao virar "em
// atendimento", date_closed ao virar "encerrado", pausa de SLA em
// "pendente") ficam pra Fase B5 ("Automação de SLA embutida") — de propósito
// fora de escopo aqui. d1UpdateChamado só grava os campos que vierem no
// patch, sem inferir nada.
// =====================================================================

const D1_VALID_STATUSES = VALID_STATUSES; // mesmos 4 status, mesma constante — sem duplicar a lista

function d1Row(row) {
  // D1 devolve tudo como veio da coluna (INTEGER vira number, TEXT vira string/null) — só
  // centraliza o formato de retorno num único lugar, pra createChamado/getChamado/list
  // devolverem sempre o mesmo shape de objeto.
  if (!row) return null;
  return { ...row };
}

async function d1CreateChamado(env, data) {
  const id  = crypto.randomUUID();
  const now = Date.now();
  const row = {
    id,
    name:         data.name,
    description:  data.description ?? null,
    status:       data.status ?? 'aberto',
    priority:     data.priority,
    tipo:         data.tipo,
    setor:        data.setor,
    solicitante:  data.solicitante,
    email:        data.email ?? null,
    solucao:      data.solucao ?? null,
    assignee_id:  data.assignee_id ?? null,
    due_date:     data.due_date ?? null,
    date_created: now,
    date_closed:  null,
    start_date:   null,
    created_at:   now,
    updated_at:   now,
  };
  if (!D1_VALID_STATUSES.includes(row.status)) {
    throw new Error(`status inválido: ${row.status}`);
  }
  // `numero` (2026-11-11): número sequencial legível ("#0142") pra a pessoa citar o chamado
  // por telefone/WhatsApp — o id continua sendo UUID. Calculado DENTRO do INSERT
  // (MAX+1), não lido antes: o D1 serializa escritas, então dois chamados simultâneos não
  // pegam o mesmo número.
  const colunas = `id, name, description, status, priority, tipo, setor, solicitante, email, solucao,
       assignee_id, due_date, date_created, date_closed, start_date, created_at, updated_at`;
  const valores = [
    row.id, row.name, row.description, row.status, row.priority, row.tipo, row.setor,
    row.solicitante, row.email, row.solucao, row.assignee_id, row.due_date, row.date_created,
    row.date_closed, row.start_date, row.created_at, row.updated_at,
  ];
  const marcas = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';
  const mainStmt = env.CHAMADOS_DB.prepare(
    `INSERT INTO chamados (${colunas}, numero)
     VALUES (${marcas}, (SELECT COALESCE(MAX(numero), 0) + 1 FROM chamados))`
  ).bind(...valores);
  // Rede de segurança de deploy: o código novo pode entrar no ar um instante antes de
  // POST /admin/migrate-schema-chamados-numero criar a coluna. Nesse intervalo grava sem
  // número (a migração numera depois) em vez de impedir a abertura de chamados.
  const mainSemNumero = () => env.CHAMADOS_DB.prepare(`INSERT INTO chamados (${colunas}) VALUES (${marcas})`).bind(...valores);
  // Mantém chamado_assignees em sincronia, no MESMO .batch() da linha principal — atômico
  // (B7 parte 2, fase 2, 2026-08-12; achado do revisor sobre handleAdminUpdateTask
  // aplicado aqui também, ver comentário em d1UpdateChamado). Aceita `data.assignee_ids`
  // (array completo, mesmo padrão de mapClickUpTaskToD1) — cai pro `assignee_id` único
  // quando não vier, pra quem só passa isso. d1CreateChamado ainda não é chamada por
  // nenhum handler em produção (ver Fase B2), mas os filtros/métricas que agora leem do
  // D1 (d1ListChamados/d1GetMetrics) dependem dessa tabela como fonte de verdade pra
  // "quem está atribuído" — sem isso, qualquer chamado criado por aqui no futuro ficaria
  // invisível pro filtro "operador" e pro tempo médio de atendimento.
  const assigneeIds = data.assignee_ids ?? (row.assignee_id != null ? [row.assignee_id] : []);
  let semColuna = false;
  try {
    await env.CHAMADOS_DB.batch([mainStmt, ...buildSetAssigneesStatements(env, row.id, assigneeIds)]);
  } catch (err) {
    if (!/no column named numero|no such column: numero/i.test(String(err && err.message))) throw err;
    semColuna = true;
    await env.CHAMADOS_DB.batch([mainSemNumero(), ...buildSetAssigneesStatements(env, row.id, assigneeIds)]);
  }
  // Devolve a linha COM o número que o banco atribuiu (o INSERT calcula no servidor).
  row.numero = null;
  // Vínculo com o equipamento (2026-11-23): UPDATE à parte, best-effort. Se a coluna ainda não
  // existir (deploy antes de POST /admin/migrate-schema-equipamentos) o chamado já foi criado,
  // só fica sem o vínculo — nunca derruba a abertura.
  row.equipamento_id = null;
  if (data.equipamento_id) {
    try {
      await env.CHAMADOS_DB.prepare('UPDATE chamados SET equipamento_id = ? WHERE id = ?').bind(data.equipamento_id, row.id).run();
      row.equipamento_id = data.equipamento_id;
    } catch (err) {
      console.error(`d1CreateChamado: vínculo com equipamento falhou (${err.message})`);
    }
  }
  if (!semColuna) {
    const salvo = await env.CHAMADOS_DB.prepare('SELECT numero FROM chamados WHERE id = ?').bind(row.id).first();
    row.numero = salvo?.numero ?? null;
  }
  return d1Row(row);
}

async function d1GetChamado(env, id) {
  const row = await env.CHAMADOS_DB.prepare('SELECT * FROM chamados WHERE id = ?').bind(id).first();
  return d1Row(row);
}

// filters: { status, setor, tipo, assigneeId, solicitante, withAssignees } — todos
// opcionais, mesmo conjunto que GET /admin/tasks já aceita hoje (ver
// handleAdminListTasks). `assigneeId` filtra por QUALQUER operador atribuído (via
// chamado_assignees, B7 parte 2 fase 2 — não só o primeiro/assignee_id).
// `withAssignees: true` (opt-in, não o padrão) anexa `row.assignee_ids` (array
// completo) via uma query extra em lote — só as rotas de admin pedem isso
// (precisam do array pra reconstruir o aviso de "múltiplos operadores"); o poll de
// /api/my-tasks (rota mais chamada do Worker) NÃO pede, pra não pagar esse custo
// extra numa rota já sensível a latência — segue devolvendo só `assignee_id`.
async function d1ListChamados(env, filters = {}) {
  const where  = [];
  const params = [];
  if (filters.status)      { where.push('status = ?');      params.push(filters.status); }
  if (filters.setor != null)      { where.push('setor = ?');       params.push(Number(filters.setor)); }
  if (filters.tipo != null)       { where.push('tipo = ?');        params.push(Number(filters.tipo)); }
  if (filters.assigneeId != null) {
    where.push('id IN (SELECT chamado_id FROM chamado_assignees WHERE assignee_id = ?)');
    params.push(Number(filters.assigneeId));
  }
  if (filters.solicitante) { where.push('solicitante = ?'); params.push(filters.solicitante); }

  const sql = `SELECT * FROM chamados` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY date_created DESC`;
  const { results } = await env.CHAMADOS_DB.prepare(sql).bind(...params).all();
  const rows = (results || []).map(d1Row);

  if (filters.withAnexos) {
    // Uma consulta só pra todos (tabela pequena): quantos anexos cada chamado tem.
    const { results: cont } = await env.CHAMADOS_DB.prepare('SELECT chamado_id, COUNT(*) AS n FROM chamado_anexos GROUP BY chamado_id').all();
    const mapa = new Map((cont || []).map(c => [c.chamado_id, c.n]));
    for (const row of rows) row.anexos_count = mapa.get(row.id) || 0;
  }

  if (filters.withAssignees) {
    const assigneesMap = await d1GetAssigneesMap(env, rows.map(r => r.id));
    for (const row of rows) row.assignee_ids = assigneesMap.get(row.id) || [];
  }
  return rows;
}

const PRIORITY_NUM_TO_NAME = { 1: 'urgent', 2: 'high', 3: 'normal' };

// Fase B7 (2026-08-12) — reconstrói o "shape" de task da ClickUp a partir de uma linha
// do D1, pra rota que já lê do D1 (GET /my-tasks) devolver exatamente o mesmo contrato
// de sempre e o frontend (React) não precisar mudar nada. Deliberadamente NÃO inclui:
// - `attachments`: D1 não guarda isso (upload de anexo continua 100% ClickUp, ver B4);
//   GET /tasks/:id continua lendo da ClickUp só por causa disso.
// - `username` em assignees: o frontend já resolve id->nome sozinho via OPERADORES
//   (mesmo comentário de handleAdminMetrics logo abaixo).
//
// `assignees` (B7 parte 2, fase 2): usa `row.assignee_ids` (array completo, só presente
// quando quem chamou d1ListChamados pediu `withAssignees`) quando disponível — é o que
// preserva o aviso de "múltiplos operadores" no painel de admin. Sem isso, cai pro
// `assignee_id` de sempre (rotas que não pedem o array, ex. GET /api/my-tasks).
//
// 🛡️ Achado real de produção (2026-08-12, mesmo dia): `solicitante` sai como campo
// próprio (nome já resolvido, D1 nunca guarda orderindex), NÃO como entrada em
// `custom_fields` — antes desta correção, o comentário aqui dizia "quem chama esta
// função já sabe de quem é a lista, não precisa reconstruir esse campo" — verdade
// enquanto só `GET /api/my-tasks` usava esta função (uma lista por pessoa só). Deixou
// de ser verdade assim que `GET /admin/tasks` também passou a usar (fase 2, mesmo dia)
// — ali cada linha é de uma pessoa DIFERENTE, e o campo nunca foi adicionado. Resultado:
// `custom_fields` nunca tinha entrada pra `SOLICITANTE_FIELD_ID`, o frontend fazia
// `Number(getCF(task, SOLICITANTE_FIELD_ID))` → `Number(null)` → `0` → mostrava quem
// quer que tivesse `orderindex 0` como solicitante de TODO chamado no Kanban/Tabela do
// admin — não um "—" gracioso, um nome errado. Corrigido expondo `solicitante` direto
// (string), sem depender de orderindex/custom_fields pra esse campo específico.
function d1RowToTaskShape(row) {
  const assigneeIds = row.assignee_ids ?? (row.assignee_id != null ? [row.assignee_id] : []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    text_content: row.description,
    status: { status: row.status },
    priority: { priority: PRIORITY_NUM_TO_NAME[row.priority] || 'normal' },
    assignees: assigneeIds.map(id => ({ id })),
    solicitante: row.solicitante || null,
    nota: row.nota ?? null,
    numero: row.numero ?? null,
    equipamento_id: row.equipamento_id ?? null,
    anexos_count: row.anexos_count ?? 0,
    due_date: row.due_date != null ? String(row.due_date) : null,
    date_created: String(row.date_created),
    date_updated: String(row.updated_at),
    date_closed: row.date_closed != null ? String(row.date_closed) : null,
    start_date: row.start_date != null ? String(row.start_date) : null,
    // tipo/setor omitidos quando null (12 chamados bem antigos sem esses campos, ver
    // Fase B7) em vez de mandar `value: null` — o frontend faz `Number(getCF(...))` pra
    // ler esse campo, e `Number(null)` vira 0 (bateria com o orderindex 0 de verdade),
    // não `NaN`/"—" como seria o esperado pra "campo ausente". Omitir a entrada faz
    // getCF() devolver null por *não encontrar* o campo, que é o caso real aqui.
    custom_fields: [
      ...(row.tipo   != null ? [{ id: TIPO_FIELD_ID,   value: row.tipo   }] : []),
      ...(row.setor  != null ? [{ id: SETOR_FIELD_ID,  value: row.setor  }] : []),
      ...(row.solucao != null ? [{ id: SOLUCAO_FIELD_ID, value: row.solucao }] : []),
    ],
  };
}

// patch: qualquer subconjunto de { status, solucao, assigneeId, description, dueDate,
// dateClosed, startDate } — só atualiza o que vier, igual handleAdminUpdateTask já faz
// do lado ClickUp. Não infere efeito colateral nenhum (ver comentário da seção acima).
// `assigneeIdsForSync` (B7 parte 2, fase 2 — achado do revisor, 2026-08-12): quando
// presente (array, mesmo vazio), a atualização de `chamados` e a substituição de
// `chamado_assignees` viram UM `.batch()` só — atômico, os dois aplicam juntos ou
// nenhum aplica. Sem isso, eram 2 chamadas D1 separadas dentro do mesmo try/catch
// best-effort de `handleAdminUpdateTask`: se a 1ª tivesse sucesso e a 2ª falhasse (erro
// transiente do D1), as duas fontes divergiam **silenciosamente** — e diferente da B7
// parte 1 (onde uma divergência só afetava `GET /api/my-tasks`, "auto-curada" a cada
// leitura porque as rotas de admin ainda liam 100% da ClickUp), agora que `GET
// /admin/tasks`/`GET /admin/metrics` leem exclusivamente de `chamado_assignees` (fase
// 2), essa divergência ficaria presa até o próximo toque manual no operador — o painel
// que a TI usa pra decisão (filtro por operador, tempo médio de atendimento) podia
// ficar errado sem nenhum sinal de erro. `undefined` (padrão) mantém o comportamento de
// sempre — só atualiza `chamados`, não toca `chamado_assignees` (ex.: `d1TransitionStatus`,
// que nunca muda operador).
async function d1UpdateChamado(env, id, patch, assigneeIdsForSync) {
  const fieldMap = {
    status:      'status',
    solucao:     'solucao',
    assigneeId:  'assignee_id',
    description: 'description',
    dueDate:     'due_date',
    dateClosed:  'date_closed',
    startDate:   'start_date',
    nota:        'nota',
  };
  const set    = [];
  const params = [];
  for (const [key, col] of Object.entries(fieldMap)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (key === 'status' && !D1_VALID_STATUSES.includes(patch.status)) {
      throw new Error(`status inválido: ${patch.status}`);
    }
    set.push(`${col} = ?`);
    params.push(patch[key]);
  }
  if (!set.length) return d1GetChamado(env, id); // nada pra atualizar — devolve como está

  set.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  const mainStmt = env.CHAMADOS_DB.prepare(`UPDATE chamados SET ${set.join(', ')} WHERE id = ?`).bind(...params);
  if (assigneeIdsForSync !== undefined) {
    await env.CHAMADOS_DB.batch([mainStmt, ...buildSetAssigneesStatements(env, id, assigneeIdsForSync)]);
  } else {
    await mainStmt.run();
  }
  return d1GetChamado(env, id);
}

// Exclusão de verdade (2026-08-17, pedido do usuário: "fiz uns testes e gostaria de
// excluí-los a partir do admin") — DESTRUTIVO e IRREVERSÍVEL, de propósito diferente
// do resto do painel, que sempre preferiu "desativar"/"sem atribuição" a apagar de vez
// (ver solicitantes.ativo, "Sem atribuição" no lugar de excluir operador). Sem
// FOREIGN KEY nenhuma no schema (ver d1/schema.sql), então limpa as 3 tabelas
// relacionadas manualmente, na mesma transação (.batch()) da linha principal — mesmo
// padrão de atomicidade que d1UpdateChamado já usa com assigneeIdsForSync. Anexos no
// R2 são apagados ANTES do D1, best-effort (Promise.allSettled — um objeto que já não
// existe mais no bucket, ou uma falha pontual do R2, não pode travar a exclusão do
// chamado em si; o pior caso vira um arquivo órfão no bucket, não um chamado que
// devia ter sumido e não sumiu).
async function d1DeleteChamado(env, id) {
  const anexos = await d1ListAnexos(env, id);
  await Promise.allSettled(anexos.map(a => r2DeleteAnexo(env, a.r2_key)));

  await env.CHAMADOS_DB.batch([
    env.CHAMADOS_DB.prepare('DELETE FROM chamados WHERE id = ?').bind(id),
    env.CHAMADOS_DB.prepare('DELETE FROM chamado_assignees WHERE chamado_id = ?').bind(id),
    env.CHAMADOS_DB.prepare('DELETE FROM chamado_anexos WHERE chamado_id = ?').bind(id),
    env.CHAMADOS_DB.prepare('DELETE FROM chamado_eventos WHERE chamado_id = ?').bind(id),
  ]);
}

// =====================================================================
// POST /admin/tasks/:id/delete — apaga um chamado de vez. Protegido por ADMIN_SECRET,
// mesmo padrão de toda rota /admin/*. Sem confirmação em duas etapas no servidor — o
// frontend confirma antes de chamar (ver task-modal.tsx); aqui só confere que o
// chamado existe antes de apagar (404 se não).
// =====================================================================
async function handleAdminDeleteTask(request, env, taskId) {
  if (!(await isAdmin(request, env))) return unauthorized();

  const chamado = await d1GetChamado(env, taskId);
  if (!chamado) return jsonRes({ error: 'chamado não encontrado' }, 404);

  await d1DeleteChamado(env, taskId);
  // A chave de pausa não tem validade: sai junto com o chamado.
  await env.SUBSCRIPTIONS?.delete(`d1_pending_start_${taskId}`);
  return jsonRes({ ok: true });
}

// Mesmo shape de resposta de handleAdminMetrics (porStatus/porTipo/porSetor/sla/
// tempoMedioPorOperador) — de propósito, pra um dia trocar a fonte sem quebrar o
// contrato que admin.js já consome. nome vem null (D1 não guarda nome do operador,
// só o id) — o painel já resolve id->nome via OPERADORES no cliente de qualquer forma.
//
// tempoMedioPorOperador (B7 parte 2, fase 2, 2026-08-12): usa chamado_assignees, não
// mais só assignee_id — cada operador atribuído a um chamado encerrado recebe a
// duração INTEIRA, não dividida entre eles (mesma regra de handleAdminMetrics baseado
// na ClickUp, ver comentário lá — chamado com 2+ assignees não é bug, é o dado real).
// Fase A do roadmap pós-MVP-visual (2026-08-14): `{ desde, ate }` (epoch ms,
// ambos opcionais) filtra por `date_created` — filtro aplicado em JS sobre o
// resultado (não no SQL) de propósito, pra manter a query e o resto da função
// idênticos ao de sempre; volume da tabela não justifica complicar a query por
// isso. Omitidos, comportamento idêntico ao de antes (agregado geral).
// Filtros opcionais (2026-11-24, "Everson ama filtros"): além do período, `setor`/`tipo` (orderindex),
// `prioridade` (1 urgente, 2 alta, 3 normal), `status`, `solicitante` (nome exato) e `operador`
// (id; vale para QUALQUER atendente do chamado, via chamado_assignees). Todos se combinam (E).
function ultimaEntradaEm(historico, status) {
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i].para_valor === status) return historico[i].created_at;
  }
  return null;
}

// Soma dos períodos em "em atendimento" (espera e reabertura ficam de fora). `null` quando o
// histórico não cobre o chamado inteiro (anterior ao registro de eventos ou importado): todo
// chamado nasce aberto, então um histórico que não começa em "aberto" está pela metade.
function tempoEmAtendimento(historico) {
  if (historico[0]?.de_valor !== 'aberto') return null;
  let inicio = null;
  let total = null;
  for (const e of historico) {
    if (e.para_valor === 'em atendimento') {
      inicio = e.created_at;
    } else if (e.de_valor === 'em atendimento') {
      if (inicio == null) return null;
      total = (total ?? 0) + (e.created_at - inicio);
      inicio = null;
    }
  }
  return inicio == null ? total : null;
}

async function d1GetMetrics(env, { desde, ate, setor, tipo, prioridade, status, solicitante, operador } = {}) {
  const { results } = await env.CHAMADOS_DB.prepare(
    'SELECT id, status, priority, solicitante, tipo, setor, due_date, date_closed, start_date, date_created, nota FROM chamados'
  ).all();
  let rows = results || [];
  if (desde != null) rows = rows.filter(r => r.date_created >= desde);
  if (ate   != null) rows = rows.filter(r => r.date_created <= ate);
  if (setor      != null) rows = rows.filter(r => r.setor === setor);
  if (tipo       != null) rows = rows.filter(r => r.tipo === tipo);
  if (prioridade != null) rows = rows.filter(r => r.priority === prioridade);
  if (status     != null) rows = rows.filter(r => r.status === status);
  if (solicitante)        rows = rows.filter(r => r.solicitante === solicitante);

  // Quem atende cada chamado (uma consulta só; a tabela é pequena). Serve ao filtro por operador e ao
  // "volume por operador".
  const { results: atribuicoes } = await env.CHAMADOS_DB.prepare('SELECT chamado_id, assignee_id FROM chamado_assignees').all();
  const atendentesDe = new Map();
  for (const a of atribuicoes || []) {
    if (!atendentesDe.has(a.chamado_id)) atendentesDe.set(a.chamado_id, []);
    atendentesDe.get(a.chamado_id).push(a.assignee_id);
  }
  if (operador != null) rows = rows.filter(r => (atendentesDe.get(r.id) || []).includes(operador));

  // Histórico de status (uma consulta só): dá o momento em que o chamado entrou em espera ou foi
  // encerrado e o tempo realmente passado em atendimento.
  const { results: mudancas } = await env.CHAMADOS_DB.prepare(
    "SELECT chamado_id, de_valor, para_valor, created_at FROM chamado_eventos WHERE tipo = 'status' ORDER BY created_at ASC, rowid ASC"
  ).all();
  const historicoDe = new Map();
  for (const e of mudancas || []) {
    if (!historicoDe.has(e.chamado_id)) historicoDe.set(e.chamado_id, []);
    historicoDe.get(e.chamado_id).push(e);
  }

  const porStatus = {};
  const porTipo    = {};
  const porSetor   = {};
  const porPrioridade = {};
  const porOperador   = {};
  let dentroDoSla = 0;
  let atrasado    = 0;
  let somaNotas   = 0;
  let totalNotas  = 0;
  const agora = Date.now();

  // chamados encerrados com duração válida (start_date + date_closed) — resolvidos em
  // lote depois do loop, junto com o(s) assignee(s) real(is) de cada um.
  const encerradosComDuracao = [];

  for (const r of rows) {
    porStatus[r.status] = (porStatus[r.status] || 0) + 1;
    porPrioridade[r.priority] = (porPrioridade[r.priority] || 0) + 1;
    for (const op of atendentesDe.get(r.id) || []) porOperador[op] = (porOperador[op] || 0) + 1;
    if (r.tipo != null)  porTipo[r.tipo]   = (porTipo[r.tipo]   || 0) + 1;
    if (r.setor != null) porSetor[r.setor] = (porSetor[r.setor] || 0) + 1;

    const historico = historicoDe.get(r.id) || [];
    if (r.due_date != null) {
      let referencia = agora;
      if (r.status === 'pendente') {
        // Prazo parado: vale o momento em que entrou em espera. Sem esse registro, não entra na conta.
        referencia = ultimaEntradaEm(historico, 'pendente');
      } else if (r.status === 'encerrado') {
        referencia = ultimaEntradaEm(historico, 'encerrado') ?? r.date_closed ?? agora;
      }
      if (referencia != null) {
        if (referencia > r.due_date) atrasado++; else dentroDoSla++;
      }
    }

    if (r.status === 'encerrado') {
      const duracaoMs = tempoEmAtendimento(historico)
        ?? (r.start_date != null && r.date_closed != null ? r.date_closed - r.start_date : null);
      if (duracaoMs != null) encerradosComDuracao.push({ id: r.id, duracaoMs });
    }

    if (r.nota != null) {
      somaNotas += r.nota;
      totalNotas++;
    }
  }

  const atendimentoPorOperador = {}; // id -> { somaMs, count }
  for (const { id, duracaoMs } of encerradosComDuracao) {
    for (const assigneeId of (atendentesDe.get(id) || [])) {
      const key = String(assigneeId);
      if (!atendimentoPorOperador[key]) atendimentoPorOperador[key] = { somaMs: 0, count: 0 };
      atendimentoPorOperador[key].somaMs += duracaoMs;
      atendimentoPorOperador[key].count  += 1;
    }
  }

  const tempoMedioPorOperador = {};
  for (const [id, dado] of Object.entries(atendimentoPorOperador)) {
    tempoMedioPorOperador[id] = { nome: null, mediaMs: Math.round(dado.somaMs / dado.count), totalChamados: dado.count };
  }

  const totalComSla = dentroDoSla + atrasado;
  return {
    total: rows.length,
    truncated: false, // D1 não pagina como fetchAllTasks — não existe teto aqui
    porStatus,
    porTipo,
    porSetor,
    porPrioridade,
    porOperador,
    sla: {
      dentroDoSla,
      atrasado,
      dentroDoSlaPercent: totalComSla ? Math.round((dentroDoSla / totalComSla) * 1000) / 10 : null,
      atrasadoPercent:    totalComSla ? Math.round((atrasado    / totalComSla) * 1000) / 10 : null,
    },
    tempoMedioPorOperador,
    // Nota de satisfação (2026-09-21) — média das notas 1-5 que os solicitantes deram,
    // entre os chamados no escopo atual do filtro de período. `null` quando ninguém
    // avaliou ainda nesse período, pro Dashboard mostrar "sem avaliações" em vez de 0.
    satisfacao: {
      mediaNota: totalNotas ? Math.round((somaNotas / totalNotas) * 10) / 10 : null,
      totalAvaliacoes: totalNotas,
    },
  };
}

// =====================================================================
// HISTÓRICO + COMENTÁRIOS POR CHAMADO (Fase B do roadmap pós-MVP-visual, 2026-08-14)
// — tabela `chamado_eventos`, timeline única (eventos automáticos + notas manuais),
// mesmo conceito já validado no Artifact do MVP visual (drawer de detalhe). Ver
// comentário completo no schema (d1/schema.sql).
// =====================================================================

// Gravado automaticamente por applyAdminTaskUpdate (status/operador) — nunca chamado
// direto por uma rota HTTP (por isso não valida input: quem chama já validou).
async function d1LogEvento(env, chamadoId, tipo, deValor, paraValor) {
  await env.CHAMADOS_DB.prepare(
    `INSERT INTO chamado_eventos (id, chamado_id, tipo, autor, texto, de_valor, para_valor, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`
  ).bind(crypto.randomUUID(), chamadoId, tipo, deValor, paraValor, Date.now()).run();
}

// Nota manual — a única escrita em chamado_eventos que vem direto de uma requisição
// HTTP (handleAdminCreateEvento), `autor`/`texto` já validados por quem chama.
async function d1CreateEvento(env, chamadoId, { autor, texto }) {
  const id = crypto.randomUUID();
  const created_at = Date.now();
  await env.CHAMADOS_DB.prepare(
    `INSERT INTO chamado_eventos (id, chamado_id, tipo, autor, texto, de_valor, para_valor, created_at)
     VALUES (?, ?, 'nota', ?, ?, NULL, NULL, ?)`
  ).bind(id, chamadoId, autor, texto, created_at).run();
  return { id, chamado_id: chamadoId, tipo: 'nota', autor, texto, de_valor: null, para_valor: null, created_at };
}

async function d1ListEventos(env, chamadoId) {
  const { results } = await env.CHAMADOS_DB.prepare(
    // ORDER BY created_at, rowid — achado do revisor 2026-08-14: dois eventos no
    // mesmo milissegundo (status+operador mudando na mesma request, ou notas rápidas)
    // ficavam em ordem indefinida só por created_at. rowid é implícito em qualquer
    // tabela SQLite sem WITHOUT ROWID (é o caso de chamado_eventos) e cresce na ordem
    // de inserção — desempate determinístico sem mudar schema.
    'SELECT id, chamado_id, tipo, autor, texto, de_valor, para_valor, created_at FROM chamado_eventos WHERE chamado_id = ? ORDER BY created_at ASC, rowid ASC'
  ).bind(chamadoId).all();
  return results || [];
}

// GET /admin/tasks/:id/eventos — timeline completa (eventos + notas), mais antigo
// primeiro (o frontend já espera essa ordem, igual ao mockup do MVP visual).
async function handleAdminListEventos(request, env, taskId) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  if (!(await d1GetChamado(env, taskId))) return jsonRes({ error: 'chamado não encontrado' }, 404);
  if (!(await staffCanAccessChamado(env, staff, taskId))) return jsonRes({ error: 'este chamado não é seu' }, 403);
  const chamado = await d1GetChamado(env, taskId);
  if (!chamado) return jsonRes({ error: 'chamado não encontrado' }, 404);
  return jsonRes({ eventos: await d1ListEventos(env, taskId) });
}

// POST /admin/tasks/:id/eventos — adiciona uma nota manual. `autor` é texto livre (sem
// login por pessoa no admin, ninguém pra inferir automaticamente quem está
// escrevendo — o painel preenche com um dos OPERADORES via select, mas o servidor não
// força isso, só exige não-vazio).
async function handleAdminCreateEvento(request, env, taskId) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  if (!(await d1GetChamado(env, taskId))) return jsonRes({ error: 'chamado não encontrado' }, 404);
  if (!(await staffCanAccessChamado(env, staff, taskId))) return jsonRes({ error: 'este chamado não é seu' }, 403);
  const chamado = await d1GetChamado(env, taskId);
  if (!chamado) return jsonRes({ error: 'chamado não encontrado' }, 404);

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  // Operador não escolhe quem escreve: o autor é ele mesmo (não dá pra assinar como o outro).
  const autor = staff.role === 'operador'
    ? OPERADOR_NOMES[staff.operadorId]
    : (typeof body.autor === 'string' ? body.autor.trim() : '');
  const texto = typeof body.texto === 'string' ? body.texto.trim() : '';
  if (!autor) return jsonRes({ error: 'autor é obrigatório' }, 400);
  if (!texto) return jsonRes({ error: 'texto é obrigatório' }, 400);

  return jsonRes({ ok: true, evento: await d1CreateEvento(env, taskId, { autor, texto }) });
}

// =====================================================================
// LISTA DE SOLICITANTES NO D1 (Fase M1 da migração de saída da ClickUp,
// 2026-08-13) — até aqui essa lista só existia como custom field dropdown
// dentro da ClickUp (SOLICITANTE_FIELD_ID via getSolicitanteMaps/GET
// /api/field); o boot inteiro do app dos solicitantes travava
// (state = "boot-error") se aquele endpoint falhasse. Nome é a chave — sem
// indireção de orderindex nenhuma (diferente da ClickUp), já que
// `chamados.solicitante`/as chaves de sessão no KV (`auth_<nome>`) sempre
// trabalharam por nome mesmo. `ativo=0` desativa em vez de apagar —
// chamados antigos continuam referenciando o nome pelo histórico.
// =====================================================================
// Achado real de produção (2026-08-13, mesmo dia): `ORDER BY name` no SQLite/D1 é
// ordenação "crua" por byte (não sensível a locale) — nomes acentuados (ex.: "Márcio")
// ficavam fora de ordem, depois de qualquer nome sem acento que começasse com a mesma
// letra (ex.: depois de "Mikaelly", não logo após "Mariana"). A versão ClickUp-based
// sempre ordenou em JS com `localeCompare(..., 'pt-BR')` — reordena aqui do mesmo jeito
// depois de buscar (volume é pequeno, dezenas de nomes, sem custo real).
async function d1ListSolicitantes(env, { ativos = false } = {}) {
  const sql = ativos
    ? 'SELECT name, email, ativo, created_at, origem, telefone FROM solicitantes WHERE ativo = 1'
    : 'SELECT name, email, ativo, created_at, origem, telefone FROM solicitantes';
  const { results } = await env.CHAMADOS_DB.prepare(sql).all();
  return (results || []).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function d1IsSolicitanteAtivo(env, name) {
  const row = await env.CHAMADOS_DB.prepare('SELECT ativo FROM solicitantes WHERE name = ?').bind(name).first();
  return !!row && row.ativo === 1;
}

// Login por e-mail (2026-09-16, pedido da diretoria: "não quer usuários vendo
// chamados de outros usuários" — a isolação em si já era garantida no servidor
// desde sempre, mas escolher o NOME de outra pessoa numa lista era possível; email
// é único por pessoa e não dá pra "escolher sem querer" o de outro). E-mail sempre
// comparado em minúsculas (normalizado na escrita, ver handleRegister/
// handleAdminCreateSolicitante/handleAdminSetSolicitanteEmail) — não depende de
// quem digita bater exatamente maiúsculas/minúsculas no login.
async function d1GetSolicitanteByEmail(env, email) {
  const row = await env.CHAMADOS_DB.prepare('SELECT name, ativo FROM solicitantes WHERE email = ?').bind(email).first();
  return row || null;
}

// INSERT OR IGNORE — idempotente, mesmo padrão do resto da camada D1 (rodar a
// migração de novo, ou tentar cadastrar um nome que já existe, não duplica nem falha).
// `origem`/`telefone` (2026-09-17) — ver comentário em d1/schema.sql. `origem`
// default 'interno' preserva o comportamento de sempre pra quem chama com 2
// argumentos (handleAdminCreateSolicitante, migração de solicitantes).
async function d1CreateSolicitante(env, name, email = null, { origem = 'interno', telefone = null } = {}) {
  const result = await env.CHAMADOS_DB.prepare(
    'INSERT OR IGNORE INTO solicitantes (name, email, ativo, created_at, origem, telefone) VALUES (?, ?, 1, ?, ?, ?)'
  ).bind(name, email, Date.now(), origem, telefone).run();
  return { inserted: (result.meta?.changes ?? 0) > 0 };
}

async function d1SetSolicitanteAtivo(env, name, ativo) {
  const result = await env.CHAMADOS_DB.prepare('UPDATE solicitantes SET ativo = ? WHERE name = ?')
    .bind(ativo ? 1 : 0, name).run();
  return { updated: (result.meta?.changes ?? 0) > 0 };
}

// Índice único parcial em `email` (ver handleAdminMigrateSchemaSolicitantesEmail)
// faz esse UPDATE lançar "UNIQUE constraint failed" se o e-mail já pertence a outro
// solicitante — quem chama trata isso (ver handleAdminSetSolicitanteEmail/
// handleAdminBulkSetSolicitanteEmails).
async function d1SetSolicitanteEmail(env, name, email) {
  const result = await env.CHAMADOS_DB.prepare('UPDATE solicitantes SET email = ? WHERE name = ?')
    .bind(email, name).run();
  return { updated: (result.meta?.changes ?? 0) > 0 };
}

// =====================================================================
// GET /api/solicitantes — substitui GET /api/field pro app de solicitantes e pro
// filtro do painel de admin (Fase M1). Mesma auth pública de sempre (X-App-Secret) —
// não precisa do ADMIN_SECRET, é só a lista de nomes ativos, sem dado sensível.
// =====================================================================
async function handleListSolicitantes(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  const rows = await d1ListSolicitantes(env, { ativos: true });
  return jsonRes({ names: rows.map(r => r.name) });
}

// =====================================================================
// PRESENÇA ("online" no painel de admin, 2026-11-17). Mecanismo clássico de heartbeat:
// cada ABA do solicitante manda POST /api/presence a cada 60 s (e ao mostrar/esconder a aba,
// via Page Visibility API, e ao fechar, via pagehide + fetch keepalive). O servidor guarda
// uma linha por ABA (name + tab_id) — assim fechar uma aba não derruba quem tem outra
// aberta — e o painel junta por pessoa. Sinal tem `ts` do cliente: escrita mais velha que a
// já gravada é ignorada (evita "saindo" atrasado vencer um ping novo). Pings repetidos em
// menos de 10 s são descartados no próprio SQL (limite de frequência, sem custo de KV).
// Fica em D1 (não em KV) porque o KV grátis só aceita 1000 escritas/dia. A tabela se cria
// sozinha na primeira escrita (sem rota de migração pra esquecer).
// =====================================================================
const PRESENCA_ONLINE_MS = 180_000;
const PRESENCA_MIN_INTERVALO_MS = 10_000;

async function ensurePresencaTable(env) {
  await env.CHAMADOS_DB.prepare(
    'CREATE TABLE IF NOT EXISTS presenca_abas (name TEXT NOT NULL, tab_id TEXT NOT NULL, last_seen INTEGER NOT NULL, ts INTEGER NOT NULL DEFAULT 0, visivel INTEGER NOT NULL DEFAULT 1, saiu INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (name, tab_id))'
  ).run();
}

async function handlePresence(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > 500) return jsonRes({ error: 'corpo grande demais' }, 413);
  let body = {};
  try { body = await request.json(); } catch { /* corpo vazio vale como "visível" */ }
  const saindo = body?.saindo === true;
  const visivel = body?.visivel === false ? 0 : 1;
  const tabId = typeof body?.tabId === 'string' && body.tabId.length > 0 ? body.tabId.slice(0, 64) : 'unica';
  const agora = Date.now();
  // ts do cliente só serve pra ordenar; limitado pra um relógio errado não travar a aba.
  const ts = Number.isFinite(body?.ts) ? Math.min(Math.max(body.ts, agora - 86_400_000), agora + 60_000) : agora;
  const sql = `INSERT INTO presenca_abas (name, tab_id, last_seen, ts, visivel, saiu) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(name, tab_id) DO UPDATE SET last_seen = excluded.last_seen, ts = excluded.ts, visivel = excluded.visivel, saiu = excluded.saiu
    WHERE excluded.ts >= presenca_abas.ts
      AND (excluded.saiu = 1 OR presenca_abas.saiu = 1 OR presenca_abas.visivel != excluded.visivel
           OR presenca_abas.last_seen <= excluded.last_seen - ?7)`;
  const grava = () => env.CHAMADOS_DB.prepare(sql).bind(session.name, tabId, agora, ts, visivel, saindo ? 1 : 0, PRESENCA_MIN_INTERVALO_MS).run();
  try {
    try {
      await grava();
    } catch (err) {
      if (!/no such table/i.test(String(err?.message))) throw err;
      await ensurePresencaTable(env);
      await grava();
    }
    // faxina oportunista: abas sem sinal há mais de um dia
    if (saindo) await env.CHAMADOS_DB.prepare('DELETE FROM presenca_abas WHERE last_seen < ?').bind(agora - 86_400_000).run();
  } catch {
    // presença nunca derruba o app: falha vira "ok: false", sem erro HTTP
    return jsonRes({ ok: false });
  }
  return jsonRes({ ok: true });
}

// GET /admin/presenca — um item por pessoa, juntando as abas dela. `agora` vem do servidor
// pra o painel não depender do relógio do computador da TI.
//  - alguma aba aberta (saiu = 0): last_seen = sinal mais recente delas; visivel = 1 se alguma
//    aba aberta e recente está em uso;
//  - só abas fechadas: saiu = 1 e last_seen = quando a última fechou ("visto há X").
async function handleAdminPresenca(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let rows = [];
  try {
    const { results } = await env.CHAMADOS_DB.prepare('SELECT name, last_seen, visivel, saiu FROM presenca_abas').all();
    rows = results || [];
  } catch { /* tabela ainda não existe: ninguém mandou sinal */ }
  const agora = Date.now();
  const porNome = new Map();
  for (const r of rows) {
    const p = porNome.get(r.name) || { name: r.name, abertas: 0, last_open: 0, last_closed: 0, em_uso: 0 };
    if (r.saiu === 1) {
      p.last_closed = Math.max(p.last_closed, r.last_seen);
    } else {
      p.abertas += 1;
      p.last_open = Math.max(p.last_open, r.last_seen);
      if (r.visivel === 1 && agora - r.last_seen <= PRESENCA_ONLINE_MS) p.em_uso = 1;
    }
    porNome.set(r.name, p);
  }
  const presenca = [...porNome.values()].map(p => p.abertas > 0
    ? { name: p.name, last_seen: p.last_open, visivel: p.em_uso, saiu: 0 }
    : { name: p.name, last_seen: p.last_closed, visivel: 0, saiu: 1 });
  return jsonRes({ agora, janelaMs: PRESENCA_ONLINE_MS, presenca });
}

// =====================================================================
// GET /admin/solicitantes — lista TODOS (ativos e inativos), pra tela de gestão saber
// quem já foi desativado (e poder reativar). POST cria; PATCH ativa/desativa. Mesmo
// padrão ADMIN_SECRET de toda rota /admin/*.
// =====================================================================
async function handleAdminListSolicitantes(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  const rows = await d1ListSolicitantes(env);
  return jsonRes({ solicitantes: rows });
}

async function handleAdminCreateSolicitante(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = normalizeEmail(body.email) || null;
  if (!name) return jsonRes({ error: 'nome é obrigatório' }, 400);
  if (email && !isEmailDoDominio(email)) {
    return jsonRes({ error: `e-mail precisa ser do domínio @${EMAIL_DOMAIN}` }, 400);
  }

  try {
    const { inserted } = await d1CreateSolicitante(env, name, email);
    if (!inserted) return jsonRes({ error: 'já existe um solicitante com esse nome' }, 409);
    return jsonRes({ ok: true, name, email });
  } catch (err) {
    // Índice único parcial em `email` (ver handleAdminMigrateSchemaSolicitantesEmail)
    if (/unique/i.test(err.message)) return jsonRes({ error: 'já existe outro solicitante com esse e-mail' }, 409);
    return jsonRes({ error: err.message }, 500);
  }
}

// =====================================================================
// POST /admin/solicitantes/:nome/email — edita o e-mail de um solicitante já
// cadastrado (tela "Usuários", 2026-09-16 — login por e-mail exige que a TI
// cadastre/edite o e-mail de cada um). `email: null` limpa o campo (solicitante
// fica sem e-mail — não consegue logar/registrar até a TI preencher de novo).
// =====================================================================
async function handleAdminSetSolicitanteEmail(request, env, name) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const email = normalizeEmail(body.email) || null;
  if (email && !isEmailDoDominio(email)) {
    return jsonRes({ error: `e-mail precisa ser do domínio @${EMAIL_DOMAIN}` }, 400);
  }

  try {
    const { updated } = await d1SetSolicitanteEmail(env, decodeURIComponent(name), email);
    if (!updated) return jsonRes({ error: 'solicitante não encontrado' }, 404);
    return jsonRes({ ok: true });
  } catch (err) {
    if (/unique/i.test(err.message)) return jsonRes({ error: 'já existe outro solicitante com esse e-mail' }, 409);
    return jsonRes({ error: err.message }, 500);
  }
}

// =====================================================================
// POST /admin/solicitantes/emails/bulk — preenche o e-mail de vários solicitantes
// de uma vez (2026-09-16) — pensado pro momento da migração real: a TI tem uma
// lista nome->email de todo mundo já cadastrado (hoje sem e-mail) e aplica tudo
// numa chamada só, em vez de editar um por um na tela. Body: { emails: [{name,
// email}] }. Mesmo espírito de POST /admin/tasks/bulk — sem transação entre itens,
// reporta sucesso/falha por nome (um e-mail duplicado não derruba os outros).
// =====================================================================
async function handleAdminBulkSetSolicitanteEmails(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const items = Array.isArray(body.emails) ? body.emails : [];
  if (!items.length) return jsonRes({ error: '"emails" (array) é obrigatório' }, 400);
  if (items.length > 200) return jsonRes({ error: 'máximo de 200 por vez' }, 400);

  const results = [];
  for (const item of items) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const email = normalizeEmail(item?.email);
    if (!name || !email) {
      results.push({ name: name || '(sem nome)', ok: false, error: 'nome/e-mail inválido' });
      continue;
    }
    if (!isEmailDoDominio(email)) {
      results.push({ name, ok: false, error: `e-mail precisa ser do domínio @${EMAIL_DOMAIN}` });
      continue;
    }
    try {
      const { updated } = await d1SetSolicitanteEmail(env, name, email);
      results.push(updated ? { name, ok: true } : { name, ok: false, error: 'solicitante não encontrado' });
    } catch (err) {
      results.push({ name, ok: false, error: /unique/i.test(err.message) ? 'e-mail já usado por outro solicitante' : err.message });
    }
  }
  const sucesso = results.filter(r => r.ok).length;
  return jsonRes({ total: results.length, sucesso, falha: results.length - sucesso, results });
}

async function handleAdminSetSolicitanteAtivo(request, env, name) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (typeof body.ativo !== 'boolean') return jsonRes({ error: '"ativo" precisa ser true ou false' }, 400);

  const { updated } = await d1SetSolicitanteAtivo(env, decodeURIComponent(name), body.ativo);
  if (!updated) return jsonRes({ error: 'solicitante não encontrado' }, 404);
  // Desativar derruba as sessões abertas da pessoa (antes ela seguia logada por até 90 dias).
  if (!body.ativo) await revokeSessions(env, decodeURIComponent(name));
  return jsonRes({ ok: true });
}

// POST /admin/solicitantes/:nome/excluir (2026-11-11, pedido do usuário) — apaga o solicitante
// de vez. DESTRUTIVA e irreversível. Até aqui só existia "desativar" (preserva o histórico: os
// chamados guardam o NOME, sem FOREIGN KEY, e ficariam sem dono). Por isso a exclusão tem uma
// trava: se a pessoa tem chamados, responde 409 com a contagem e só segue com
// `{ apagarChamados: true }` (o frontend pergunta de novo, mostrando o número). Apaga: a linha
// em `solicitantes`, os chamados dela (d1DeleteChamado: assignees, anexos D1+R2, eventos), a
// senha (`auth_`), a inscrição de push (`usub_`) e revoga as sessões abertas.
const MAX_CHAMADOS_EXCLUIR_SOLICITANTE = 40; // orçamento de subrequests por invocação
async function handleAdminExcluirSolicitante(request, env, name) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body = {};
  try { body = await request.json(); } catch { /* corpo opcional */ }
  const nome = decodeURIComponent(name);

  const existe = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind(nome).first();
  if (!existe) return jsonRes({ error: 'solicitante não encontrado' }, 404);

  const { results } = await env.CHAMADOS_DB.prepare('SELECT id FROM chamados WHERE solicitante = ?').bind(nome).all();
  const chamados = results || [];
  if (chamados.length > 0 && body.apagarChamados !== true) {
    return jsonRes({ error: `${nome} tem ${chamados.length} chamado(s)`, chamados: chamados.length }, 409);
  }
  if (chamados.length > MAX_CHAMADOS_EXCLUIR_SOLICITANTE) {
    return jsonRes({ error: `são ${chamados.length} chamados, mais que o limite de ${MAX_CHAMADOS_EXCLUIR_SOLICITANTE} por exclusão` }, 400);
  }

  for (const c of chamados) await d1DeleteChamado(env, c.id);
  // Os pedidos (solicitações) dela também saem, com o histórico: guardam o nome como texto, sem cascata automática.
  await garantirEsquemaSolicitacoes(env);
  await env.CHAMADOS_DB.batch([
    env.CHAMADOS_DB.prepare('DELETE FROM solicitacao_eventos WHERE solicitacao_id IN (SELECT id FROM solicitacoes WHERE solicitante = ?)').bind(nome),
    env.CHAMADOS_DB.prepare('DELETE FROM solicitacoes WHERE solicitante = ?').bind(nome),
  ]);
  await garantirEsquemaAvaliacao(env);
  await env.CHAMADOS_DB.prepare('DELETE FROM avaliacoes_mensais WHERE solicitante = ?').bind(nome).run();
  await env.CHAMADOS_DB.prepare('DELETE FROM solicitantes WHERE name = ?').bind(nome).run();
  await env.SUBSCRIPTIONS.delete(`auth_${nome}`);
  await env.SUBSCRIPTIONS.delete(`usub_${nome}`);
  await revokeSessions(env, nome);
  return jsonRes({ ok: true, chamadosApagados: chamados.length });
}

// POST /admin/solicitantes/:nome/renomear (2026-11-11) — body { novoNome, email? }.
// Nasceu pra transformar a conta genérica "Outros" numa conta de TI/testes, mas serve pra
// corrigir qualquer nome. `name` é a identidade em vários lugares, então a troca cascateia:
// solicitantes (PK), chamados.solicitante (num batch atômico) e as chaves do KV (senha e
// inscrição de push). Sessões abertas da conta são revogadas (guardavam o nome antigo).
async function handleAdminRenomearSolicitante(request, env, name) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const antigo = decodeURIComponent(name);
  const novo = typeof body.novoNome === 'string' ? body.novoNome.trim().replace(/\s+/g, ' ') : '';
  if (!novo || novo.length > 100) return jsonRes({ error: 'novoNome inválido' }, 400);
  const email = body.email == null ? undefined : normalizeEmail(body.email);
  if (email !== undefined && (!EMAIL_FORMATO_REGEX.test(email) || !isEmailDoDominio(email))) {
    return jsonRes({ error: `e-mail precisa ser do domínio @${EMAIL_DOMAIN}` }, 400);
  }
  if (antigo === novo) return jsonRes({ error: 'o novo nome é igual ao atual' }, 400);

  const atual = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind(antigo).first();
  if (!atual) return jsonRes({ error: 'solicitante não encontrado' }, 404);
  const ocupado = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind(novo).first();
  if (ocupado) return jsonRes({ error: 'já existe um solicitante com o novo nome' }, 409);

  await garantirEsquemaAvaliacao(env);
  const stmts = [
    ...moverAvaliacoes(env, antigo, novo),
    email !== undefined
      ? env.CHAMADOS_DB.prepare('UPDATE solicitantes SET name = ?, email = ? WHERE name = ?').bind(novo, email, antigo)
      : env.CHAMADOS_DB.prepare('UPDATE solicitantes SET name = ? WHERE name = ?').bind(novo, antigo),
    env.CHAMADOS_DB.prepare('UPDATE chamados SET solicitante = ? WHERE solicitante = ?').bind(novo, antigo),
    env.CHAMADOS_DB.prepare('UPDATE solicitacoes SET solicitante = ? WHERE solicitante = ?').bind(novo, antigo),
  ];
  try {
    await garantirEsquemaSolicitacoes(env);
    await env.CHAMADOS_DB.batch(stmts);
  } catch (err) {
    return jsonRes({ error: /unique/i.test(err.message) ? 'e-mail já usado por outro solicitante' : err.message }, 409);
  }

  for (const prefixo of ['auth_', 'usub_']) {
    const valor = await env.SUBSCRIPTIONS.get(`${prefixo}${antigo}`);
    if (valor) {
      await env.SUBSCRIPTIONS.put(`${prefixo}${novo}`, valor);
      await env.SUBSCRIPTIONS.delete(`${prefixo}${antigo}`);
    }
  }
  await revokeSessions(env, antigo);
  return jsonRes({ ok: true, nome: novo });
}

// POST /admin/solicitantes/:nome/transferir-chamados (2026-11-13) — body { para }. Passa TODOS os
// chamados de um solicitante para outro já existente (ex.: conta de testes -> conta Admin). Só mexe em
// chamados.solicitante; as duas contas continuam existindo. Reversível (basta transferir de volta).
async function handleAdminTransferirChamados(request, env, name) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const de = decodeURIComponent(name);
  const para = typeof body.para === 'string' ? body.para.trim() : '';
  if (!para) return jsonRes({ error: '"para" é obrigatório' }, 400);
  if (de === para) return jsonRes({ error: 'origem e destino são iguais' }, 400);
  const origem = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind(de).first();
  if (!origem) return jsonRes({ error: 'solicitante de origem não encontrado' }, 404);
  const destino = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind(para).first();
  if (!destino) return jsonRes({ error: 'solicitante de destino não encontrado' }, 404);
  await garantirEsquemaSolicitacoes(env);
  const [r] = await env.CHAMADOS_DB.batch([
    env.CHAMADOS_DB.prepare('UPDATE chamados SET solicitante = ? WHERE solicitante = ?').bind(para, de),
    env.CHAMADOS_DB.prepare('UPDATE solicitacoes SET solicitante = ? WHERE solicitante = ?').bind(para, de),
  ]);
  return jsonRes({ ok: true, transferidos: r?.meta?.changes ?? 0 });
}

// Fase M5 (2026-08-13): POST /admin/migrate-solicitantes removida — já rodou em
// produção (43 nomes migrados, ver CLAUDE.md), único consumidor de getSolicitanteMaps
// que sobrava fora de d1TransitionStatus/handleSubscribe (já resolvidos acima).

// Suporte a múltiplos operadores (B7 parte 2, fase 1, 2026-08-12) — substitui por
// completo quem está atribuído a um chamado na tabela de junção. DELETE+INSERT em vez
// de tentar calcular um diff (mesmo espírito simples do resto da camada D1 — não é
// hot path). `assigneeIds` vazio/undefined só limpa (chamado sem ninguém atribuído).
//
// ⚠️ Achado real rodando o backfill em produção (2026-08-12): a versão original daqui
// fazia 1 DELETE + N INSERT sequenciais (`.run()` por statement) — cada um conta como
// um subrequest separado do Worker. Rodando `POST /admin/migrate-d1` pra backfillar os
// 453 chamados existentes, isso estourou o teto de subrequests por invocação do Worker
// (erro real da Cloudflare: "Too many API requests by single Worker invocation", ~1000
// no plano pago) depois de ~332 chamados processados — a migração sempre vinha fazendo
// 1 INSERT OR IGNORE em `chamados` por linha, então de repente virou 1 + até 3 nessa
// função = 4 subrequests/linha, quadruplicando o total. Corrigido usando `.batch()` do
// binding D1 (manda todos os statements num round-trip só — 1 subrequest, não N).
// Monta os statements (sem executar) — extraído de d1SetAssignees pra dar pra combinar
// num .batch() só com OUTRAS mutações no mesmo chamado (ver d1UpdateChamado logo abaixo
// e o achado de consistência descrito lá).
function buildSetAssigneesStatements(env, chamadoId, assigneeIds) {
  const statements = [
    env.CHAMADOS_DB.prepare('DELETE FROM chamado_assignees WHERE chamado_id = ?').bind(chamadoId),
  ];
  for (const id of (assigneeIds || [])) {
    statements.push(
      env.CHAMADOS_DB.prepare(
        'INSERT OR IGNORE INTO chamado_assignees (chamado_id, assignee_id) VALUES (?, ?)'
      ).bind(chamadoId, id)
    );
  }
  return statements;
}

async function d1SetAssignees(env, chamadoId, assigneeIds) {
  await env.CHAMADOS_DB.batch(buildSetAssigneesStatements(env, chamadoId, assigneeIds));
}

// Suporte a múltiplos operadores (B7 parte 2, fase 2, 2026-08-12) — busca os assignees
// de um lote de chamados de uma vez só (`IN (...)`, em pedaços — ver abaixo) em vez de
// 1 query por chamado, devolve Map<chamado_id, number[]>. Usado por d1ListChamados
// (quando `withAssignees`) e d1GetMetrics pra reconstruir o array completo, igual
// `assignees[]` da ClickUp.
//
// ⚠️ Achado real em produção (2026-08-12): a primeira versão mandava TODOS os ids num
// `IN (...)` só — com os 454 chamados reais (ex.: /admin/metrics, ou /admin/tasks sem
// filtro/com filtro de status que bate em centenas de linhas, como "encerrado"), isso
// estourou o limite de variáveis bindáveis por statement do SQLite/D1 (`error code:
// 1101`, exceção não tratada — 500 puro, sem nem chegar no jsonRes de erro). Corrigido
// dividindo em pedaços de no máximo CHUNK ids por query — bem abaixo de qualquer teto
// real (SQLite costuma permitir centenas a ~999; 50 é conservador de propósito, sem
// motivo pra chegar perto do limite).
async function d1GetAssigneesMap(env, chamadoIds) {
  const map = new Map();
  if (!chamadoIds.length) return map;
  const CHUNK = 50;
  for (let i = 0; i < chamadoIds.length; i += CHUNK) {
    const chunk = chamadoIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await env.CHAMADOS_DB.prepare(
      `SELECT chamado_id, assignee_id FROM chamado_assignees WHERE chamado_id IN (${placeholders})`
    ).bind(...chunk).all();
    for (const r of (results || [])) {
      if (!map.has(r.chamado_id)) map.set(r.chamado_id, []);
      map.get(r.chamado_id).push(r.assignee_id);
    }
  }
  return map;
}

// =====================================================================
// POST /admin/migrate-schema-nullable-tipo-setor — migração de schema ÚNICA (Fase B7,
// 2026-08-12, mesmo dia), pra permitir NULL em tipo/setor. Motivo: 12 chamados bem
// antigos na ClickUp não têm custom_fields nenhum preenchido (nem TIPO nem SETOR) —
// o schema original tinha os dois como NOT NULL, então esses 12 nunca migravam (ver
// mapClickUpTaskToD1). SQLite/D1 não suportam ALTER COLUMN pra remover NOT NULL
// direto — o padrão é recriar a tabela: cria uma nova com o schema certo, copia os
// dados, apaga a antiga, renomeia. Protegida por ADMIN_SECRET, idempotente (檢CREATE
// TABLE IF NOT EXISTS na tabela nova — se já rodou uma vez, a 2ª chamada só recria os
// índices à toa (IF NOT EXISTS também), sem duplicar nem perder dado.
// =====================================================================
async function handleAdminMigrateSchemaNullableTipoSetor(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  const db = env.CHAMADOS_DB;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS chamados_v2 (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        status        TEXT NOT NULL CHECK (status IN ('aberto', 'em atendimento', 'pendente', 'encerrado')),
        priority      INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),
        tipo          INTEGER,
        setor         INTEGER,
        solicitante   TEXT NOT NULL,
        email         TEXT,
        solucao       TEXT,
        assignee_id   INTEGER,
        due_date      INTEGER,
        date_created  INTEGER NOT NULL,
        date_closed   INTEGER,
        start_date    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `).run();

    await db.prepare(`
      INSERT OR IGNORE INTO chamados_v2
        (id, name, description, status, priority, tipo, setor, solicitante, email, solucao,
         assignee_id, due_date, date_created, date_closed, start_date, created_at, updated_at)
      SELECT
        id, name, description, status, priority, tipo, setor, solicitante, email, solucao,
        assignee_id, due_date, date_created, date_closed, start_date, created_at, updated_at
      FROM chamados
    `).run();

    const before = await db.prepare('SELECT COUNT(*) AS n FROM chamados').first();
    const after  = await db.prepare('SELECT COUNT(*) AS n FROM chamados_v2').first();
    if (Number(after?.n) < Number(before?.n)) {
      return jsonRes({ error: 'copia incompleta — abortado antes de apagar a tabela antiga', before: before?.n, after: after?.n }, 500);
    }

    await db.prepare('DROP TABLE chamados').run();
    await db.prepare('ALTER TABLE chamados_v2 RENAME TO chamados').run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chamados_status ON chamados (status)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chamados_setor ON chamados (setor)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chamados_tipo ON chamados (tipo)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chamados_assignee ON chamados (assignee_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chamados_solicitante ON chamados (solicitante)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_chamados_date_created ON chamados (date_created)').run();

    return jsonRes({ ok: true, linhasCopiadas: after?.n ?? null });
  } catch (err) {
    return jsonRes({ error: `migração de schema falhou: ${err.message}` }, 500);
  }
}

// =====================================================================
// POST /admin/migrate-schema-chamado-assignees — migração de schema ÚNICA (B7 parte 2,
// fase 1 — 2026-08-12), cria a tabela chamado_assignees (suporte a múltiplos
// operadores). Bem mais simples que a migração anterior: é tabela NOVA, não precisa
// recriar nada existente — só CREATE TABLE/INDEX IF NOT EXISTS, idempotente de
// verdade (rodar de novo não faz nada, não só "não quebra nada").
// =====================================================================
async function handleAdminMigrateSchemaChamadoAssignees(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    // Sem FOREIGN KEY de propósito — ver comentário em d1/schema.sql (foreign_keys
    // ligado por padrão bloquearia qualquer DROP TABLE chamados futuro).
    await env.CHAMADOS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS chamado_assignees (
        chamado_id  TEXT NOT NULL,
        assignee_id INTEGER NOT NULL,
        PRIMARY KEY (chamado_id, assignee_id)
      )
    `).run();
    await env.CHAMADOS_DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_chamado_assignees_assignee ON chamado_assignees (assignee_id)'
    ).run();
    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ error: `migração de schema falhou: ${err.message}` }, 500);
  }
}

// =====================================================================
// POST /admin/migrate-schema-solicitantes — migração de schema ÚNICA (Fase M1,
// 2026-08-13), cria a tabela `solicitantes` no D1 real de produção. Mesmo padrão de
// handleAdminMigrateSchemaChamadoAssignees — CREATE TABLE IF NOT EXISTS, idempotente,
// tabela nova (não precisa recriar nada existente). ADMIN_SECRET, roda uma vez.
// =====================================================================
async function handleAdminMigrateSchemaSolicitantes(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    await env.CHAMADOS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS solicitantes (
        name       TEXT PRIMARY KEY,
        ativo      INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `).run();
    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ error: `migração de schema falhou: ${err.message}` }, 500);
  }
}

// =====================================================================
// POST /admin/migrate-schema-solicitantes-email — migração de schema ÚNICA
// (2026-09-16, login por e-mail pedido pela diretoria) — adiciona a coluna `email`
// na tabela `solicitantes` já existente. `ALTER TABLE ADD COLUMN` (não recria a
// tabela — diferente de handleAdminMigrateSchemaNullableTipoSetor, que precisou
// recriar por causa de NOT NULL; aqui a coluna nasce nullable, ADD COLUMN simples
// resolve). SQLite não tem `ADD COLUMN IF NOT EXISTS` — roda de novo (idempotência)
// tratando o erro "duplicate column name" como sucesso. Índice único PARCIAL
// (`WHERE email IS NOT NULL`) — permite múltiplos solicitantes sem e-mail ainda
// (estado normal logo após esta migração, antes da TI preencher a lista real) sem
// violar unicidade, mas garante que dois solicitantes nunca dividam o mesmo e-mail
// assim que preenchido.
// =====================================================================
async function handleAdminMigrateSchemaSolicitantesEmail(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    await env.CHAMADOS_DB.prepare(`ALTER TABLE solicitantes ADD COLUMN email TEXT`).run();
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) {
      return jsonRes({ error: `migração de schema falhou (ADD COLUMN): ${err.message}` }, 500);
    }
  }
  try {
    await env.CHAMADOS_DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitantes_email ON solicitantes(email) WHERE email IS NOT NULL`
    ).run();
  } catch (err) {
    return jsonRes({ error: `migração de schema falhou (índice): ${err.message}` }, 500);
  }
  return jsonRes({ ok: true });
}

// =====================================================================
// POST /admin/migrate-schema-solicitantes-origem — migração de schema ÚNICA
// (2026-09-17, pedido do usuário: identificar quem abre chamado "de forma externa"
// em vez de todo mundo cair na conta compartilhada "Outros") — adiciona `origem`
// ('interno'/'externo') e `telefone` na tabela `solicitantes`. Mesmo padrão de
// handleAdminMigrateSchemaSolicitantesEmail: ADD COLUMN, idempotente (SQLite não
// tem ADD COLUMN IF NOT EXISTS — erro "duplicate column name" tratado como sucesso).
// `NOT NULL DEFAULT 'interno'` num ADD COLUMN com valor constante já preenche as
// linhas existentes na hora — sem precisar de um UPDATE de backfill separado.
// =====================================================================
async function handleAdminMigrateSchemaSolicitantesOrigem(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    await env.CHAMADOS_DB.prepare(`ALTER TABLE solicitantes ADD COLUMN origem TEXT NOT NULL DEFAULT 'interno'`).run();
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) {
      return jsonRes({ error: `migração de schema falhou (origem): ${err.message}` }, 500);
    }
  }
  try {
    await env.CHAMADOS_DB.prepare(`ALTER TABLE solicitantes ADD COLUMN telefone TEXT`).run();
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) {
      return jsonRes({ error: `migração de schema falhou (telefone): ${err.message}` }, 500);
    }
  }
  return jsonRes({ ok: true });
}

// =====================================================================
// POST /admin/migrate-schema-chamados-nota — migração de schema ÚNICA (2026-09-21,
// pedido do usuário: "julgo essencial") — adiciona `nota` na tabela `chamados` já
// existente. Mesmo padrão de sempre — ALTER TABLE ADD COLUMN, idempotente
// (SQLite não tem ADD COLUMN IF NOT EXISTS — "duplicate column name" tratado como sucesso).
// =====================================================================
async function handleAdminMigrateSchemaChamadosNota(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    await env.CHAMADOS_DB.prepare(`ALTER TABLE chamados ADD COLUMN nota INTEGER`).run();
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) {
      return jsonRes({ error: `migração de schema falhou (nota): ${err.message}` }, 500);
    }
  }
  return jsonRes({ ok: true });
}

// =====================================================================
// POST /admin/migrate-schema-chamados-numero — migração de schema ÚNICA (2026-11-11,
// pré-implantação): número sequencial legível do chamado. Adiciona a coluna `numero` e
// numera os chamados que já existem pela ordem de abertura (1 = o mais antigo). Idempotente:
// o ALTER tolera "duplicate column" e a numeração só toca em chamados SEM número (rodar de
// novo não renumera nada, e os que faltarem entram depois do maior número já em uso).
// =====================================================================
async function handleAdminMigrateSchemaChamadosNumero(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    await env.CHAMADOS_DB.prepare(`ALTER TABLE chamados ADD COLUMN numero INTEGER`).run();
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) {
      return jsonRes({ error: `migração de schema falhou (numero): ${err.message}` }, 500);
    }
  }
  try {
    // Numera só os que ainda não têm número, do mais antigo pro mais novo, DEPOIS do maior
    // número já em uso (assim um chamado criado entre o deploy e esta migração não colide).
    const { results } = await env.CHAMADOS_DB.prepare(
      `SELECT id FROM chamados WHERE numero IS NULL ORDER BY date_created ASC, id ASC`
    ).all();
    const semNumero = results || [];
    if (semNumero.length) {
      const maxRow = await env.CHAMADOS_DB.prepare(`SELECT COALESCE(MAX(numero), 0) AS m FROM chamados`).first();
      let proximo = (maxRow?.m || 0) + 1;
      const stmts = semNumero.map(r => env.CHAMADOS_DB.prepare(`UPDATE chamados SET numero = ? WHERE id = ? AND numero IS NULL`).bind(proximo++, r.id));
      // lotes de 100: um .batch() é 1 subrequest, e assim nenhum lote fica gigante
      for (let i = 0; i < stmts.length; i += 100) await env.CHAMADOS_DB.batch(stmts.slice(i, i + 100));
    }
    await env.CHAMADOS_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chamados_numero ON chamados (numero)`).run();
  } catch (err) {
    return jsonRes({ error: `numeração dos chamados falhou: ${err.message}` }, 500);
  }
  return jsonRes({ ok: true });
}

// =====================================================================
// INVENTÁRIO DE EQUIPAMENTOS (2026-11-23, ideia do estudo do OS800)
//   GET  /admin/equipamentos          lista (ADMIN_SECRET), com nº de chamados por equipamento
//   POST /admin/equipamentos          cria (ADMIN_SECRET)
//   POST /admin/equipamentos/:id      edita; `ativo:false` tira da lista sem apagar histórico
//   GET  /api/equipamentos            lista enxuta pro select do "Novo chamado" (sessão)
//   POST /admin/migrate-schema-equipamentos   cria a tabela e a coluna chamados.equipamento_id
// Equipamento no chamado é OPCIONAL: não trava a abertura enquanto o inventário está vazio.
// =====================================================================
const EQUIP_TIPOS   = ['impressora', 'computador', 'monitor', 'notebook', 'rede', 'outro'];
const EQUIP_ORIGENS = ['patrimonio', 'locado'];
const EQUIP_STATUS  = ['ativo', 'manutencao', 'reserva', 'baixado'];

// undefined = campo ausente (não mexe); null/'' = limpar; string = valor. Lança Error se inválido.
function equipTexto(v, max, nome) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${nome} inválido`);
  const t = v.trim();
  if (t.length > max) throw new Error(`${nome} muito longo (máximo ${max} caracteres)`);
  return t || null;
}

// IPv4 (4 números de 0 a 255). undefined = não mexe; null/'' = limpar.
function equipIp(v) {
  const t = equipTexto(v, 15, 'IP');
  if (t === undefined || t === null) return t;
  const partes = t.split('.');
  if (partes.length !== 4 || partes.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    throw new Error('IP inválido (use o formato 192.168.0.10)');
  }
  return partes.map(Number).join('.');
}

// Tipos que uma pessoa comum abriria chamado para escolher (rede, servidores e "outro" ficam só com a TI).
const EQUIP_TIPOS_SOLICITANTE = ['impressora', 'computador', 'monitor', 'notebook'];

async function contaExterna(env, nome) {
  const conta = await env.CHAMADOS_DB.prepare(`SELECT origem FROM solicitantes WHERE name = ?`).bind(nome).first();
  return conta?.origem === 'externo';
}

// Valida o equipamento de um chamado novo. Devolve { id } (ou { id: null } se não veio) ou { erro }.
// `restrito` = quem abre é o próprio solicitante (não a TI): conta externa não vincula nada e só vale os 4 tipos.
async function resolveEquipamentoId(env, valor, { restrito = false, solicitante = null } = {}) {
  if (valor == null || valor === '') return { id: null };
  if (typeof valor !== 'string' || valor.length > 64) return { erro: 'equipamento inválido' };
  if (restrito && solicitante && await contaExterna(env, solicitante)) return { erro: 'equipamento não encontrado' };
  try {
    const filtroTipo = restrito ? ` AND tipo IN (${EQUIP_TIPOS_SOLICITANTE.map(t => `'${t}'`).join(', ')})` : '';
    const eq = await env.CHAMADOS_DB.prepare(`SELECT id FROM equipamentos WHERE id = ? AND ativo = 1 AND status != 'baixado'${filtroTipo}`).bind(valor).first();
    return eq ? { id: eq.id } : { erro: 'equipamento não encontrado' };
  } catch {
    return { erro: 'equipamento não encontrado' };
  }
}

const EQUIP_JANELA_REINCIDENCIA_MS = 30 * 24 * 60 * 60 * 1000;

async function handleAdminListEquipamentos(request, env) {
  if (!(await isStaff(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  const { results } = await env.CHAMADOS_DB.prepare(`SELECT * FROM equipamentos WHERE ativo = 1 ORDER BY tipo, tombamento, modelo`).all();
  // Chamados por equipamento. Antes da migração a coluna não existe: devolve a lista com zeros.
  const contagem = new Map();
  try {
    const { results: cs } = await env.CHAMADOS_DB.prepare(
      `SELECT equipamento_id, COUNT(*) AS total, SUM(CASE WHEN status != 'encerrado' THEN 1 ELSE 0 END) AS abertos,
              SUM(CASE WHEN date_created >= ? THEN 1 ELSE 0 END) AS ult30
         FROM chamados WHERE equipamento_id IS NOT NULL GROUP BY equipamento_id`
    ).bind(Date.now() - EQUIP_JANELA_REINCIDENCIA_MS).all();
    for (const c of cs || []) contagem.set(c.equipamento_id, c);
  } catch { /* coluna ainda não migrada */ }
  return jsonRes({
    equipamentos: (results || []).map(e => ({
      ...e,
      chamadosTotal: contagem.get(e.id)?.total ?? 0,
      chamadosAbertos: contagem.get(e.id)?.abertos ?? 0,
      // Reincidência: quantos chamados nos últimos 30 dias (o problema aqui volta rápido, decisão do usuário).
      chamados30d: contagem.get(e.id)?.ult30 ?? 0,
    })),
  });
}

async function handleListEquipamentosSolicitante(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();
  await garantirEsquemaInventario(env);
  // Conta de fora (autocadastro com qualquer e-mail) não vê o inventário da empresa.
  if (await contaExterna(env, session.name)) return jsonRes({ equipamentos: [] });
  // Só o que alguém abriria chamado para escolher (rede, servidores e "outro" ficam só com a TI).
  const { results } = await env.CHAMADOS_DB.prepare(
    `SELECT id, tombamento, tipo, marca, modelo, setor, local FROM equipamentos
      WHERE ativo = 1 AND status != 'baixado' AND tipo IN (${EQUIP_TIPOS_SOLICITANTE.map(t => `'${t}'`).join(', ')})
      ORDER BY tipo, tombamento, modelo`
  ).all();
  return jsonRes({ equipamentos: results || [] });
}

async function handleAdminSaveEquipamento(request, env, id) {
  if (!(await isStaff(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (!body || typeof body !== 'object') return jsonRes({ error: 'corpo inválido' }, 400);
  if (body.ativo !== undefined && typeof body.ativo !== 'boolean') return jsonRes({ error: 'ativo precisa ser verdadeiro ou falso' }, 400);

  let d;
  try {
    d = {
      tombamento:   equipTexto(body.tombamento, 40, 'tombamento'),
      marca:        equipTexto(body.marca, 60, 'marca'),
      modelo:       equipTexto(body.modelo, 80, 'modelo'),
      numero_serie: equipTexto(body.numero_serie, 80, 'número de série'),
      fornecedor:   equipTexto(body.fornecedor, 80, 'fornecedor'),
      local:        equipTexto(body.local, 120, 'local'),
      ip:           equipIp(body.ip),
      observacao:   equipTexto(body.observacao, 500, 'observação'),
    };
    for (const [campo, lista, nome] of [['tipo', EQUIP_TIPOS, 'tipo'], ['origem', EQUIP_ORIGENS, 'origem'], ['status', EQUIP_STATUS, 'situação']]) {
      if (body[campo] === undefined) continue;
      if (!lista.includes(body[campo])) throw new Error(`${nome} inválido`);
      d[campo] = body[campo];
    }
    if (body.setor !== undefined) {
      if (body.setor !== null && (!Number.isInteger(body.setor) || body.setor < 0 || body.setor > 99)) throw new Error('setor inválido');
      d.setor = body.setor;
    }
  } catch (e) {
    return jsonRes({ error: e.message }, 400);
  }

  const agora = Date.now();
  try {
    if (id === null) {
      if (!d.tipo) return jsonRes({ error: 'tipo é obrigatório' }, 400);
      const novo = crypto.randomUUID();
      await env.CHAMADOS_DB.prepare(
        `INSERT INTO equipamentos (id, tombamento, tipo, marca, modelo, numero_serie, origem, fornecedor, setor, local, ip, status, observacao, ativo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(novo, d.tombamento ?? null, d.tipo, d.marca ?? null, d.modelo ?? null, d.numero_serie ?? null,
             d.origem ?? 'patrimonio', d.fornecedor ?? null, d.setor ?? null, d.local ?? null, d.ip ?? null,
             d.status ?? 'ativo', d.observacao ?? null, agora, agora).run();
      return jsonRes({ id: novo }, 201);
    }
    const sets = [];
    const binds = [];
    for (const [k, v] of Object.entries(d)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`); binds.push(v);
    }
    if (body.ativo !== undefined) { sets.push('ativo = ?'); binds.push(body.ativo ? 1 : 0); }
    if (!sets.length) return jsonRes({ error: 'nada para atualizar' }, 400);
    sets.push('updated_at = ?'); binds.push(agora);
    const r = await env.CHAMADOS_DB.prepare(`UPDATE equipamentos SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
    if (!r.meta?.changes) return jsonRes({ error: 'equipamento não encontrado' }, 404);
    return jsonRes({ ok: true });
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) return jsonRes({ error: 'já existe um equipamento com esse tombamento' }, 409);
    return jsonRes({ error: `não foi possível salvar: ${err.message}` }, 400);
  }
}

// Esquema do Inventário/Toners aplicado de forma idempotente. É o que as rotas
// POST /admin/migrate-schema-equipamentos e -toners rodam, e também o que as próprias rotas rodam
// sozinhas no primeiro uso (garantirEsquemaInventario) — sem isso, publicar o código antes de rodar a
// migração derrubava as abas Inventário e Toners ("Não foi possível carregar") até alguém lembrar dela.
// Devolve null se deu certo, ou a mensagem de erro.
async function aplicarEsquemaInventario(env) {
  const db = env.CHAMADOS_DB;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS equipamentos (
        id TEXT PRIMARY KEY, tombamento TEXT, tipo TEXT NOT NULL, marca TEXT, modelo TEXT, numero_serie TEXT,
        origem TEXT NOT NULL DEFAULT 'patrimonio', fornecedor TEXT, setor INTEGER, local TEXT, ip TEXT,
        status TEXT NOT NULL DEFAULT 'ativo', observacao TEXT, ativo INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
      db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_equipamentos_tombamento ON equipamentos (tombamento) WHERE tombamento IS NOT NULL`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_equipamentos_tipo ON equipamentos (tipo)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS toners (
        id TEXT PRIMARY KEY, equipamento_id TEXT NOT NULL, codigo TEXT NOT NULL, cor TEXT NOT NULL DEFAULT 'preto',
        capacidade_paginas INTEGER, ciclo_dias_padrao INTEGER, observacao TEXT,
        nivel_percentual INTEGER, nivel_lido_em INTEGER, ativo INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_toners_equipamento ON toners (equipamento_id)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS toner_recargas (
        id TEXT PRIMARY KEY, toner_id TEXT NOT NULL, feita_em INTEGER NOT NULL, autor TEXT, observacao TEXT)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_toner_recargas_toner ON toner_recargas (toner_id, feita_em)`),
    ]);
  } catch (err) {
    return `criar as tabelas do inventário falhou: ${err.message}`;
  }
  // Colunas acrescentadas depois da primeira versão das tabelas (bancos que já tinham a tabela). Confere antes
  // de alterar, para não gerar um erro "duplicate column" no log a cada instância fria; se a conferência
  // falhar, tenta o ALTER do mesmo jeito e tolera a duplicata.
  for (const [tabela, coluna, definicao] of [['chamados', 'equipamento_id', 'TEXT'], ['equipamentos', 'ip', 'TEXT'], ['toners', 'nivel_percentual', 'INTEGER'], ['toners', 'nivel_lido_em', 'INTEGER']]) {
    let existe = false;
    try {
      const { results } = await db.prepare(`SELECT name FROM pragma_table_info('${tabela}')`).all();
      existe = (results || []).some(r => r.name === coluna);
    } catch { /* segue para o ALTER */ }
    if (existe) continue;
    try {
      await db.prepare(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`).run();
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) return `acrescentar ${tabela}.${coluna} falhou: ${err.message}`;
    }
  }
  // Uma impressora não tem dois toners ativos da mesma cor. Rede de segurança contra corrida de duplo clique: a
  // rota já checa antes (handleAdminSaveToner). Melhor esforço: se já existirem repetidos, o índice não é criado.
  try {
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_toners_equip_cor_ativo ON toners (equipamento_id, cor) WHERE ativo = 1`).run();
  } catch (err) {
    console.error(`índice único de toner (impressora + cor) não criado: ${err.message}`);
  }
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chamados_equipamento ON chamados (equipamento_id)`).run();
  } catch (err) {
    return `criar o índice de chamados.equipamento_id falhou: ${err.message}`;
  }
  return null;
}

// Por banco (não por variável global): cada instância do Worker faz isso no máximo uma vez.
const esquemaInventarioGarantido = new WeakSet();
async function garantirEsquemaInventario(env) {
  if (esquemaInventarioGarantido.has(env.CHAMADOS_DB)) return;
  const erro = await aplicarEsquemaInventario(env);
  if (erro) throw new Error(erro);
  esquemaInventarioGarantido.add(env.CHAMADOS_DB);
}

async function handleAdminMigrateSchemaEquipamentos(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  const erro = await aplicarEsquemaInventario(env);
  return erro ? jsonRes({ error: `migração de schema falhou: ${erro}` }, 500) : jsonRes({ ok: true });
}

// =====================================================================
// TONERS (2026-11-23, ideia do estudo do OS800)
//   GET  /admin/toners                          lista com as datas de recarga de cada um
//   POST /admin/toners                          cadastra (toner de uma impressora do Inventário)
//   POST /admin/toners/:id                      edita; `ativo:false` tira da lista
//   POST /admin/toners/:id/recarga              registra uma troca/recarga (padrão: agora)
//   POST /admin/toners/:id/recarga/desfazer     apaga a recarga mais recente (clique errado)
//   POST /admin/migrate-schema-toners           cria as tabelas
// Tudo com ADMIN_SECRET. A situação (crítico/atenção/ok) é calculada no frontend.
// =====================================================================
const TONER_CORES = ['preto', 'ciano', 'magenta', 'amarelo'];

function inteiroPositivoOuNulo(v, max, nome) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!Number.isInteger(v) || v <= 0 || v > max) throw new Error(`${nome} precisa ser um número inteiro de 1 a ${max}`);
  return v;
}

async function handleAdminListToners(request, env) {
  if (!(await isStaff(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  const { results: toners } = await env.CHAMADOS_DB.prepare(
    `SELECT t.*, e.tombamento, e.marca, e.modelo, e.setor, e.local, e.ip
       FROM toners t LEFT JOIN equipamentos e ON e.id = t.equipamento_id
      WHERE t.ativo = 1 AND (e.id IS NULL OR (e.ativo = 1 AND e.status != 'baixado')) ORDER BY t.created_at`
  ).all();
  const { results: recargas } = await env.CHAMADOS_DB.prepare(
    `SELECT r.toner_id, r.feita_em FROM toner_recargas r JOIN toners t ON t.id = r.toner_id WHERE t.ativo = 1 ORDER BY r.feita_em`
  ).all();
  const porToner = new Map();
  for (const r of recargas || []) {
    if (!porToner.has(r.toner_id)) porToner.set(r.toner_id, []);
    porToner.get(r.toner_id).push(r.feita_em);
  }
  return jsonRes({ toners: (toners || []).map(t => ({ ...t, recargas: porToner.get(t.id) ?? [] })) });
}

async function handleAdminSaveToner(request, env, id) {
  if (!(await isStaff(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (!body || typeof body !== 'object') return jsonRes({ error: 'corpo inválido' }, 400);
  if (body.ativo !== undefined && typeof body.ativo !== 'boolean') return jsonRes({ error: 'ativo precisa ser verdadeiro ou falso' }, 400);

  let d;
  try {
    d = {
      codigo: equipTexto(body.codigo, 40, 'código do toner'),
      observacao: equipTexto(body.observacao, 300, 'observação'),
      capacidade_paginas: inteiroPositivoOuNulo(body.capacidade_paginas, 1_000_000, 'capacidade'),
      ciclo_dias_padrao: inteiroPositivoOuNulo(body.ciclo_dias_padrao, 3650, 'ciclo'),
    };
    if (body.cor !== undefined) {
      if (!TONER_CORES.includes(body.cor)) throw new Error('cor inválida');
      d.cor = body.cor;
    }
    if (body.equipamento_id !== undefined) {
      if (typeof body.equipamento_id !== 'string' || body.equipamento_id.length > 64) throw new Error('impressora inválida');
      d.equipamento_id = body.equipamento_id;
    }
  } catch (e) {
    return jsonRes({ error: e.message }, 400);
  }
  if (d.codigo === null) return jsonRes({ error: 'o código do toner é obrigatório' }, 400);

  if (d.equipamento_id !== undefined) {
    const eq = await env.CHAMADOS_DB.prepare(`SELECT tipo FROM equipamentos WHERE id = ? AND ativo = 1 AND status != 'baixado'`).bind(d.equipamento_id).first();
    if (!eq) return jsonRes({ error: 'impressora não encontrada' }, 400);
    if (eq.tipo !== 'impressora') return jsonRes({ error: 'toner só pode ser ligado a uma impressora' }, 400);
  }

  // Uma impressora não tem dois toners ativos da mesma cor. Checagem prévia (mensagem clara) + índice único
  // no banco como rede de segurança (corrida de duplo clique).
  {
    const atual = id === null ? null : await env.CHAMADOS_DB.prepare(`SELECT equipamento_id, cor, ativo FROM toners WHERE id = ?`).bind(id).first();
    if (id !== null && !atual) return jsonRes({ error: 'toner não encontrado' }, 404);
    const equipamentoFinal = d.equipamento_id ?? atual?.equipamento_id;
    const corFinal = d.cor ?? atual?.cor ?? 'preto';
    const ficaAtivo = body.ativo !== undefined ? body.ativo : (atual ? atual.ativo === 1 : true);
    if (equipamentoFinal && ficaAtivo) {
      const outro = await env.CHAMADOS_DB.prepare(
        `SELECT id FROM toners WHERE equipamento_id = ? AND cor = ? AND ativo = 1 AND id != ?`
      ).bind(equipamentoFinal, corFinal, id ?? '').first();
      if (outro) {
        const reativando = atual && atual.ativo !== 1 && body.ativo === true;
        return jsonRes({
          error: reativando
            ? 'não dá para reativar: esta impressora já tem outro toner dessa cor ativo'
            : 'esta impressora já tem um toner dessa cor; edite o que já existe',
        }, 409);
      }
    }
  }

  try {
    if (id === null) {
      if (!d.codigo) return jsonRes({ error: 'o código do toner é obrigatório' }, 400);
      if (!d.equipamento_id) return jsonRes({ error: 'escolha a impressora' }, 400);
      const novo = crypto.randomUUID();
      await env.CHAMADOS_DB.prepare(
        `INSERT INTO toners (id, equipamento_id, codigo, cor, capacidade_paginas, ciclo_dias_padrao, observacao, ativo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).bind(novo, d.equipamento_id, d.codigo, d.cor ?? 'preto', d.capacidade_paginas ?? null, d.ciclo_dias_padrao ?? null, d.observacao ?? null, Date.now()).run();
      return jsonRes({ id: novo }, 201);
    }
    const sets = [];
    const binds = [];
    for (const [k, v] of Object.entries(d)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`); binds.push(v);
    }
    if (body.ativo !== undefined) { sets.push('ativo = ?'); binds.push(body.ativo ? 1 : 0); }
    if (!sets.length) return jsonRes({ error: 'nada para atualizar' }, 400);
    const r = await env.CHAMADOS_DB.prepare(`UPDATE toners SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
    if (!r.meta?.changes) return jsonRes({ error: 'toner não encontrado' }, 404);
    return jsonRes({ ok: true });
  } catch (err) {
    // Índice único (impressora + cor) entre os toners ativos: duplo clique ou edição que repetiria a cor.
    if (/UNIQUE/i.test(String(err.message))) return jsonRes({ error: 'esta impressora já tem um toner dessa cor; edite o que já existe' }, 409);
    return jsonRes({ error: `não foi possível salvar: ${err.message}` }, 400);
  }
}

async function handleAdminRegistrarRecarga(request, env, tonerId) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  await garantirEsquemaInventario(env);
  let body = {};
  try { body = (await request.json()) || {}; } catch { /* corpo vazio vale: recarga agora */ }
  const toner = await env.CHAMADOS_DB.prepare(`SELECT id FROM toners WHERE id = ? AND ativo = 1`).bind(tonerId).first();
  if (!toner) return jsonRes({ error: 'toner não encontrado' }, 404);
  const agora = Date.now();
  const feitaEm = body.feita_em == null ? agora : body.feita_em;
  if (!Number.isFinite(feitaEm) || feitaEm > agora + 60_000 || feitaEm < 946684800000) {
    return jsonRes({ error: 'data da recarga inválida' }, 400);
  }
  let autor, observacao;
  try {
    autor = equipTexto(body.autor, 60, 'autor');
    observacao = equipTexto(body.observacao, 300, 'observação');
  } catch (e) {
    return jsonRes({ error: e.message }, 400);
  }
  // Operador assina sempre como ele mesmo (mesma regra das notas do chamado); o admin pode informar o autor.
  if (staff.role === 'operador') autor = OPERADOR_NOMES[staff.operadorId] ?? null;
  else if (!autor) autor = OPERADOR_NOMES[staff.operadorId] ?? null;
  await env.CHAMADOS_DB.prepare(
    `INSERT INTO toner_recargas (id, toner_id, feita_em, autor, observacao) VALUES (?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), tonerId, feitaEm, autor ?? null, observacao ?? null).run();
  return jsonRes({ ok: true }, 201);
}

// Desfaz o clique errado: apaga só a recarga mais recente (a que distorceria o ciclo médio).
async function handleAdminDesfazerRecarga(request, env, tonerId) {
  if (!(await isStaff(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  let corpo = {};
  try { corpo = (await request.json()) || {}; } catch { /* sem corpo: comportamento antigo */ }
  const ultima = await env.CHAMADOS_DB.prepare(
    `SELECT id, feita_em FROM toner_recargas WHERE toner_id = ? ORDER BY feita_em DESC, rowid DESC LIMIT 1`
  ).bind(tonerId).first();
  if (!ultima) return jsonRes({ error: 'este toner não tem recarga para desfazer' }, 404);
  // Dois cliques rápidos (ou outra pessoa mexendo) apagariam DUAS recargas. Quem sabe qual estava vendo manda a data.
  if (corpo.feita_em !== undefined && Number(corpo.feita_em) !== ultima.feita_em) {
    return jsonRes({ error: 'a lista mudou enquanto você olhava; atualize a tela e confira antes de desfazer' }, 409);
  }
  await env.CHAMADOS_DB.prepare(`DELETE FROM toner_recargas WHERE id = ?`).bind(ultima.id).run();
  return jsonRes({ ok: true });
}

// Mesma migração (o esquema do inventário e dos toners é um só); rota mantida por compatibilidade.
async function handleAdminMigrateSchemaToners(request, env) {
  return handleAdminMigrateSchemaEquipamentos(request, env);
}

// =====================================================================
// AGENTE DE LEITURA DE TONERS (2026-11-23)
// O Worker roda na nuvem e não alcança IPs da rede interna da empresa. Quem consulta as
// impressoras é um programa pequeno rodando DENTRO da rede (pasta agente-toners/), que usa
// estas duas rotas:
//   GET  /agente/impressoras   quais impressoras consultar (as que têm IP) e as cores com toner cadastrado
//   POST /agente/leituras      nível (0-100%) lido de cada cor; grava no toner correspondente
// Autenticação: header X-Agente-Secret contra env.TONER_AGENT_SECRET, segredo PRÓPRIO que só
// serve para estas duas rotas (um agente vazado não dá acesso ao painel). Falha FECHADO: sem o
// segredo configurado no Worker, as rotas respondem 403.
// =====================================================================
const AGENTE_MAX_LEITURAS = 200;
const AGENTE_MAX_SUPRIMENTOS = 8;

// Compara em tempo constante: o tempo de resposta não revela quantos caracteres do segredo acertaram.
function igualConstante(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Mesmo modelo do ADMIN_SECRET (getStaff): 5 erros por IP bloqueiam por 15 min (`agentefail_<ip>`); acertar
// zera o contador; requisição SEM o cabeçalho não conta como tentativa.
async function agenteAutorizado(request, env) {
  if (!env.TONER_AGENT_SECRET) return false;
  const provided = request.headers.get('X-Agente-Secret');
  if (!provided) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `agentefail_${ip}`;
  const failCount = parseInt(await env.SUBSCRIPTIONS.get(failKey) || '0');
  if (failCount >= MAX_ADMIN_FAILURES) return false;
  if (igualConstante(provided, env.TONER_AGENT_SECRET)) {
    if (failCount > 0) await env.SUBSCRIPTIONS.delete(failKey);
    return true;
  }
  await env.SUBSCRIPTIONS.put(failKey, String(failCount + 1), { expirationTtl: ADMIN_LOCKOUT_SECONDS });
  return false;
}

async function handleAgenteListaImpressoras(request, env) {
  if (!(await agenteAutorizado(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  const { results } = await env.CHAMADOS_DB.prepare(
    `SELECT id, tombamento, marca, modelo, ip FROM equipamentos
      WHERE ativo = 1 AND tipo = 'impressora' AND status != 'baixado' AND ip IS NOT NULL ORDER BY tombamento`
  ).all();
  const { results: toners } = await env.CHAMADOS_DB.prepare(`SELECT equipamento_id, cor FROM toners WHERE ativo = 1`).all();
  const cores = new Map();
  for (const t of toners || []) {
    if (!cores.has(t.equipamento_id)) cores.set(t.equipamento_id, []);
    cores.get(t.equipamento_id).push(t.cor);
  }
  return jsonRes({ impressoras: (results || []).map(e => ({ ...e, cores: cores.get(e.id) ?? [] })) });
}

// POST /agente/descobertas (2026-11-25) — cadastro AUTOMÁTICO a partir do que o agente achou na rede.
// Ninguém digita impressora nem toner: o agente varre a rede por SNMP e manda cada impressora com seus
// cartuchos. Aqui cada uma vira (ou atualiza) um equipamento, e cada cor um toner, com o nível lido.
// Regras: acha a impressora pelo nº de série (a impressora pode trocar de IP) e, sem série, pelo IP;
// o que a TI já editou na tela NÃO é sobrescrito (só campos vazios são preenchidos; o IP acompanha a
// impressora). Impressora baixada não é reativada. Idempotente: repetir não duplica.
// Body: { impressoras: [{ ip, marca?, modelo?, numero_serie?, local?, suprimentos: [{ cor, nivel?, codigo? }] }] }
const AGENTE_MAX_DESCOBERTAS = 10;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
async function handleAgenteDescobertas(request, env) {
  if (!(await agenteAutorizado(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const lista = body && body.impressoras;
  if (!Array.isArray(lista) || lista.length === 0 || lista.length > AGENTE_MAX_DESCOBERTAS) {
    return jsonRes({ error: `impressoras precisa ser uma lista de 1 a ${AGENTE_MAX_DESCOBERTAS}` }, 400);
  }
  const txt = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const agora = Date.now();
  const out = { criadas: 0, atualizadas: 0, toners_criados: 0, toners_atualizados: 0, ignoradas: [] };
  for (const d of lista) {
    const ip = txt(d && d.ip, 15);
    if (!ip || !IPV4_RE.test(ip) || !Array.isArray(d.suprimentos) || d.suprimentos.length > AGENTE_MAX_SUPRIMENTOS) {
      out.ignoradas.push({ ip: ip || null, motivo: 'dados inválidos' });
      continue;
    }
    const marca = txt(d.marca, 60), modelo = txt(d.modelo, 80), serie = txt(d.numero_serie, 60), local = txt(d.local, 120);
    let eq = null;
    if (serie) eq = await env.CHAMADOS_DB.prepare(`SELECT * FROM equipamentos WHERE tipo = 'impressora' AND numero_serie = ? AND ativo = 1`).bind(serie).first();
    if (!eq) eq = await env.CHAMADOS_DB.prepare(`SELECT * FROM equipamentos WHERE tipo = 'impressora' AND ip = ? AND ativo = 1`).bind(ip).first();
    if (eq && eq.status === 'baixado') { out.ignoradas.push({ ip, motivo: 'impressora baixada no inventário' }); continue; }
    let eqId;
    if (eq) {
      eqId = eq.id;
      await env.CHAMADOS_DB.prepare(
        'UPDATE equipamentos SET ip = ?, marca = COALESCE(marca, ?), modelo = COALESCE(modelo, ?), numero_serie = COALESCE(numero_serie, ?), local = COALESCE(local, ?), updated_at = ? WHERE id = ?'
      ).bind(ip, marca, modelo, serie, local, agora, eqId).run();
      out.atualizadas++;
    } else {
      eqId = crypto.randomUUID();
      await env.CHAMADOS_DB.prepare(
        `INSERT INTO equipamentos (id, tipo, marca, modelo, numero_serie, origem, local, ip, status, observacao, ativo, created_at, updated_at)
         VALUES (?, 'impressora', ?, ?, ?, 'patrimonio', ?, ?, 'ativo', 'Cadastrada automaticamente pelo agente de rede', 1, ?, ?)`
      ).bind(eqId, marca, modelo, serie, local, ip, agora, agora).run();
      out.criadas++;
    }
    for (const s of d.suprimentos) {
      if (!s || !TONER_CORES.includes(s.cor)) continue;
      const nivel = Number.isInteger(s.nivel) && s.nivel >= 0 && s.nivel <= 100 ? s.nivel : null;
      const codigo = txt(s.codigo, 60);
      const t = await env.CHAMADOS_DB.prepare('SELECT id, codigo FROM toners WHERE equipamento_id = ? AND cor = ? AND ativo = 1').bind(eqId, s.cor).first();
      if (t) {
        // O código só é preenchido se ainda for o marcador automático — não sobrescreve o que a TI digitou.
        await env.CHAMADOS_DB.prepare(
          'UPDATE toners SET nivel_percentual = COALESCE(?, nivel_percentual), nivel_lido_em = CASE WHEN ? IS NULL THEN nivel_lido_em ELSE ? END, codigo = CASE WHEN codigo = ? AND ? IS NOT NULL THEN ? ELSE codigo END WHERE id = ?'
        ).bind(nivel, nivel, agora, 'A identificar', codigo, codigo, t.id).run();
        out.toners_atualizados++;
      } else {
        await env.CHAMADOS_DB.prepare(
          'INSERT INTO toners (id, equipamento_id, codigo, cor, nivel_percentual, nivel_lido_em, ativo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
        ).bind(crypto.randomUUID(), eqId, codigo || 'A identificar', s.cor, nivel, nivel == null ? null : agora, agora).run();
        out.toners_criados++;
      }
    }
  }
  return jsonRes(out);
}

async function handleAgenteLeituras(request, env) {
  if (!(await agenteAutorizado(request, env))) return unauthorized();
  await garantirEsquemaInventario(env);
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (!body || !Array.isArray(body.leituras) || body.leituras.length > AGENTE_MAX_LEITURAS) {
    return jsonRes({ error: `leituras precisa ser uma lista de até ${AGENTE_MAX_LEITURAS}` }, 400);
  }
  const agora = Date.now();
  const stmts = [];
  const ignorados = [];
  for (const l of body.leituras) {
    if (!l || typeof l.equipamento_id !== 'string' || !Array.isArray(l.suprimentos) || l.suprimentos.length > AGENTE_MAX_SUPRIMENTOS) {
      ignorados.push({ equipamento_id: l?.equipamento_id ?? null, motivo: 'leitura malformada' });
      continue;
    }
    for (const s of l.suprimentos) {
      if (!s || !TONER_CORES.includes(s.cor) || !Number.isInteger(s.nivel) || s.nivel < 0 || s.nivel > 100) {
        ignorados.push({ equipamento_id: l.equipamento_id, cor: s?.cor ?? null, motivo: 'cor ou nível inválido' });
        continue;
      }
      // A hora da leitura é a do servidor (não confia no relógio do agente).
      stmts.push({ eq: l.equipamento_id, cor: s.cor, nivel: s.nivel });
    }
  }
  let atualizados = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const lote = stmts.slice(i, i + 50);
    const res = await env.CHAMADOS_DB.batch(lote.map(s =>
      env.CHAMADOS_DB.prepare(`UPDATE toners SET nivel_percentual = ?, nivel_lido_em = ?
          WHERE equipamento_id = ? AND cor = ? AND ativo = 1
            AND equipamento_id IN (SELECT id FROM equipamentos WHERE ativo = 1 AND status != 'baixado')`)
        .bind(s.nivel, agora, s.eq, s.cor)));
    res.forEach((r, j) => {
      if (r.meta?.changes) atualizados += r.meta.changes;
      else ignorados.push({ equipamento_id: lote[j].eq, cor: lote[j].cor, motivo: 'sem toner cadastrado para esta cor' });
    });
  }
  return jsonRes({ atualizados, ignorados });
}

// =====================================================================
// AVALIAÇÃO MENSAL DA TI (2026-11-25, ideia do estudo do OS800)
//   GET  /api/avaliacao-mensal        (sessão) a avaliação do mês atual de quem está logado
//   POST /api/avaliacao-mensal        (sessão) grava/sobrescreve a do mês atual
//   GET  /admin/avaliacoes-mensais    (staff)  resumo do mês: participação, médias, NPS, comentários SEM nome
// Competência = mês de Fortaleza ('AAAA-MM'). Comentários são devolvidos sem identificar quem escreveu.
// =====================================================================
const AVALIACAO_PERGUNTAS = ['tempo_resposta', 'primeiro_atendimento', 'conhecimento', 'cordialidade', 'equipamentos', 'comunicacao'];
const COMPETENCIA_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const AVALIACAO_MIN_ANONIMATO = 3;

function competenciaAtual(agora = Date.now()) {
  // America/Fortaleza é UTC-3 fixo (sem horário de verão), mesma conta usada no resto do projeto.
  const d = new Date(agora - 3 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// As avaliações guardam o nome como texto: acompanham a troca de nome. O que sobrar no nome de destino
// é de alguém que não existe mais (o destino está livre em `solicitantes`) e sai antes, por causa da chave.
function moverAvaliacoes(env, de, para) {
  return [
    env.CHAMADOS_DB.prepare('DELETE FROM avaliacoes_mensais WHERE solicitante = ?').bind(para),
    env.CHAMADOS_DB.prepare('UPDATE avaliacoes_mensais SET solicitante = ? WHERE solicitante = ?').bind(para, de),
  ];
}

const esquemaAvaliacaoGarantido = new WeakSet();
async function garantirEsquemaAvaliacao(env) {
  if (esquemaAvaliacaoGarantido.has(env.CHAMADOS_DB)) return;
  await env.CHAMADOS_DB.batch([
    env.CHAMADOS_DB.prepare(`CREATE TABLE IF NOT EXISTS avaliacoes_mensais (
      solicitante TEXT NOT NULL, competencia TEXT NOT NULL, respostas TEXT NOT NULL, comentario TEXT,
      created_at INTEGER NOT NULL, PRIMARY KEY (solicitante, competencia))`),
    env.CHAMADOS_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_avaliacoes_mensais_competencia ON avaliacoes_mensais (competencia)`),
  ]);
  esquemaAvaliacaoGarantido.add(env.CHAMADOS_DB);
}

async function handleGetAvaliacaoMensal(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();
  await garantirEsquemaAvaliacao(env);
  const competencia = competenciaAtual();
  const externa = await contaExterna(env, session.name);
  // Conta de fora nunca lê respostas, mesmo que exista linha antiga com o mesmo nome.
  const row = externa ? null : await env.CHAMADOS_DB.prepare(
    `SELECT respostas, comentario FROM avaliacoes_mensais WHERE solicitante = ? AND competencia = ?`
  ).bind(session.name, competencia).first();
  let respostas = null;
  try { respostas = row ? JSON.parse(row.respostas) : null; } catch { respostas = null; }
  // Conta de fora (autocadastro) não avalia a TI da instituição: a faixa não aparece e o POST recusa.
  return jsonRes({ competencia, respondida: !!row, elegivel: !externa, respostas, comentario: row?.comentario ?? null });
}

async function handlePostAvaliacaoMensal(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (await contaExterna(env, session.name)) return jsonRes({ error: 'A avaliação mensal é para as pessoas da instituição.' }, 403);
  // Quem abriu o formulário no último dia e enviou depois da meia-noite não grava no mês errado em silêncio.
  if (body && body.competencia !== undefined && body.competencia !== competenciaAtual()) {
    return jsonRes({ error: 'O mês virou enquanto você respondia. Abra a avaliação de novo para avaliar o mês atual.' }, 409);
  }
  const r = body && body.respostas;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return jsonRes({ error: 'respostas é obrigatório' }, 400);

  const respostas = {};
  for (const chave of AVALIACAO_PERGUNTAS) {
    const n = r[chave];
    if (!Number.isInteger(n) || n < 1 || n > 5) return jsonRes({ error: `Responda "${chave}" com uma nota de 1 a 5` }, 400);
    respostas[chave] = n;
  }
  if (!Number.isInteger(r.recomendacao) || r.recomendacao < 0 || r.recomendacao > 10) {
    return jsonRes({ error: 'A recomendação vai de 0 a 10' }, 400);
  }
  respostas.recomendacao = r.recomendacao;

  let comentario = null;
  if (body.comentario != null && body.comentario !== '') {
    if (typeof body.comentario !== 'string') return jsonRes({ error: 'comentário inválido' }, 400);
    if (body.comentario.trim().length > 1000) return jsonRes({ error: 'comentário muito longo (máximo 1000 caracteres)' }, 400);
    comentario = body.comentario.trim() || null;
  }

  await garantirEsquemaAvaliacao(env);
  const competencia = competenciaAtual();
  await env.CHAMADOS_DB.prepare(
    `INSERT INTO avaliacoes_mensais (solicitante, competencia, respostas, comentario, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(solicitante, competencia) DO UPDATE SET respostas = excluded.respostas,
       comentario = excluded.comentario, created_at = excluded.created_at`
  ).bind(session.name, competencia, JSON.stringify(respostas), comentario, Date.now()).run();
  return jsonRes({ ok: true, competencia });
}

async function handleAdminAvaliacoesMensais(request, env) {
  if (!(await isStaff(request, env))) return unauthorized();
  await garantirEsquemaAvaliacao(env);
  const { searchParams } = new URL(request.url);
  const pedida = searchParams.get('competencia');
  if (pedida && !COMPETENCIA_RE.test(pedida)) return jsonRes({ error: 'competencia inválida (use AAAA-MM)' }, 400);

  const atual = competenciaAtual();
  // Só contam respostas de pessoas internas e ativas (conta de fora ou desativada depois de responder não entra,
  // senão a participação passaria de 100% e a média teria gente de fora).
  const SO_INTERNOS = `JOIN solicitantes s ON s.name = a.solicitante AND s.ativo = 1 AND s.origem = 'interno'`;
  const { results: meses } = await env.CHAMADOS_DB.prepare(
    `SELECT a.competencia AS competencia, COUNT(*) AS respondentes FROM avaliacoes_mensais a ${SO_INTERNOS}
      GROUP BY a.competencia ORDER BY a.competencia DESC LIMIT 24`
  ).all();
  const lista = meses || [];
  if (!lista.some(m => m.competencia === atual)) lista.unshift({ competencia: atual, respondentes: 0 });
  // O mês pedido sempre existe no seletor (mesmo sem respostas ou fora dos 24 mais recentes).
  if (pedida && !lista.some(m => m.competencia === pedida)) lista.push({ competencia: pedida, respondentes: 0 });
  // Padrão: o mês atual se já tiver respostas; senão o mais recente que tenha.
  const competencia = pedida || (lista.find(m => m.respondentes > 0)?.competencia ?? atual);

  const { results: linhas } = await env.CHAMADOS_DB.prepare(
    `SELECT a.respostas AS respostas, a.comentario AS comentario FROM avaliacoes_mensais a ${SO_INTERNOS} WHERE a.competencia = ?`
  ).bind(competencia).all();
  // Linha com JSON inválido, que não é objeto ou com nota fora da faixa é ignorada (nunca derruba o resumo).
  const notaOk = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const validas = [];
  for (const l of linhas || []) {
    let r;
    try { r = JSON.parse(l.respostas); } catch { continue; }
    if (!r || typeof r !== 'object' || !AVALIACAO_PERGUNTAS.every(q => notaOk(r[q], 1, 5)) || !notaOk(r.recomendacao, 0, 10)) continue;
    validas.push({ r, comentario: l.comentario });
  }
  const n = validas.length;

  let elegiveis = null;
  try {
    elegiveis = (await env.CHAMADOS_DB.prepare(`SELECT COUNT(*) AS n FROM solicitantes WHERE ativo = 1 AND origem = 'interno'`).first())?.n ?? null;
  } catch { /* coluna origem ausente: sem taxa de participação */ }

  const um = x => Math.round(x * 10) / 10;
  const mediaBruta = q => validas.reduce((s, v) => s + v.r[q], 0) / n;
  const medias = {};
  for (const q of AVALIACAO_PERGUNTAS) medias[q] = n ? um(mediaBruta(q)) : null;
  // Média geral sobre as médias SEM arredondar (arredondar duas vezes acumula erro).
  const mediaGeral = n ? um(AVALIACAO_PERGUNTAS.reduce((s, q) => s + mediaBruta(q), 0) / AVALIACAO_PERGUNTAS.length) : null;
  const promotores = validas.filter(v => v.r.recomendacao >= 9).length;
  const detratores = validas.filter(v => v.r.recomendacao <= 6).length;

  return jsonRes({
    competencia,
    meses: lista,
    respondentes: n,
    elegiveis,
    participacaoPercent: n && elegiveis ? Math.round((n / elegiveis) * 100) : null,
    medias,
    mediaGeral,
    nps: n ? { valor: Math.round(((promotores - detratores) / n) * 100), promotores, neutros: n - promotores - detratores, detratores } : null,
    // Anonimato: com menos de 3 respondentes um comentário é praticamente identificável, então não é mostrado;
    // e a ordem é alfabética (nada de ordem por horário, que permitiria ligar o comentário a quem respondeu).
    comentarios: n >= AVALIACAO_MIN_ANONIMATO
      ? validas.filter(v => v.comentario).map(v => v.comentario).sort((a, b) => a.localeCompare(b, 'pt-BR')).slice(0, 50)
      : [],
    comentariosOcultos: n < AVALIACAO_MIN_ANONIMATO && validas.some(v => v.comentario),
  });
}

// =====================================================================
// SOLICITAÇÕES (2026-11-25, ideia do estudo do OS800): pedido de equipamento, material, peça ou autorização,
// com andamento em 5 etapas (Pendente → Em análise → Aprovado → A caminho → Entregue; ou Rejeitado).
//   GET  /api/solicitacoes                  (sessão) as minhas
//   POST /api/solicitacoes                  (sessão, só pessoa interna) cria
//   GET  /admin/solicitacoes                (staff)  lista, com filtros status/categoria
//   POST /admin/solicitacoes/:id/status     (staff)  avança/volta a etapa (transições validadas)
// Quem pediu recebe push a cada mudança; a TI (admin) recebe um aviso quando chega pedido novo.
// =====================================================================
const SOLIC_CATEGORIAS = ['equipamento', 'material', 'peca', 'autorizacao'];
const SOLIC_STATUS = ['pendente', 'em_analise', 'aprovado', 'em_transito', 'entregue', 'rejeitado'];
// Andamento linear, de propósito (o OS800 e o app mostram as etapas em sequência; pular etapa confunde quem acompanha).
// "Autorização" não tem entrega física, por isso aprovado pode ir direto a entregue.
const SOLIC_TRANSICOES = {
  pendente:    ['em_analise', 'rejeitado'],
  em_analise:  ['aprovado', 'rejeitado', 'pendente'],
  aprovado:    ['em_transito', 'entregue', 'rejeitado'],
  em_transito: ['entregue'],
  entregue:    [],
  rejeitado:   ['pendente'],
};
const SOLIC_ROTULO_STATUS = { pendente: 'pendente', em_analise: 'em análise', aprovado: 'aprovado', em_transito: 'a caminho', entregue: 'entregue', rejeitado: 'rejeitado' };
const SOLIC_MAX_PENDENTES = 20;       // contra flood: quantos pedidos "pendente" a mesma pessoa pode ter ao mesmo tempo
const SOLIC_JANELA_REPETIDO_MS = 60_000; // mesmo pedido em menos de 1 min = duplo clique

const esquemaSolicitacoesGarantido = new WeakSet();
// Interruptor do módulo Solicitações (2026-11-25): no ISV a TI é interna e o módulo não se aplica, então fica
// DESLIGADO por padrão. Para a versão vendida a empresas: variável SOLICITACOES_ATIVO = "true" no Worker.
// Desligado, as 4 rotas respondem 404 e as telas (que tratam o 404) escondem a aba e a seção.
const solicitacoesAtivo = (env) => ['true', '1'].includes(String(env.SOLICITACOES_ATIVO ?? '').toLowerCase());
const solicitacoesDesligado = () => jsonRes({ error: 'Módulo de solicitações não está ativo.' }, 404);

async function garantirEsquemaSolicitacoes(env) {
  if (esquemaSolicitacoesGarantido.has(env.CHAMADOS_DB)) return;
  await env.CHAMADOS_DB.batch([
    env.CHAMADOS_DB.prepare(`CREATE TABLE IF NOT EXISTS solicitacoes (
      id TEXT PRIMARY KEY, numero INTEGER, categoria TEXT NOT NULL, item TEXT NOT NULL, quantidade INTEGER NOT NULL DEFAULT 1,
      justificativa TEXT NOT NULL, solicitante TEXT NOT NULL, setor INTEGER, status TEXT NOT NULL DEFAULT 'pendente',
      nota_ti TEXT, motivo_rejeicao TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    env.CHAMADOS_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_solicitacoes_status ON solicitacoes (status)`),
    env.CHAMADOS_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_solicitacoes_solicitante ON solicitacoes (solicitante, created_at)`),
    env.CHAMADOS_DB.prepare(`CREATE TABLE IF NOT EXISTS solicitacao_eventos (
      id TEXT PRIMARY KEY, solicitacao_id TEXT NOT NULL, de_status TEXT, para_status TEXT NOT NULL, autor TEXT, texto TEXT, created_at INTEGER NOT NULL)`),
    env.CHAMADOS_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_solicitacao_eventos ON solicitacao_eventos (solicitacao_id, created_at)`),
  ]);
  esquemaSolicitacoesGarantido.add(env.CHAMADOS_DB);
}

const SOLIC_CAMPOS = 'id, numero, categoria, item, quantidade, justificativa, solicitante, setor, status, nota_ti, motivo_rejeicao, created_at, updated_at';

async function handleMinhasSolicitacoes(request, env) {
  if (!solicitacoesAtivo(env)) return solicitacoesDesligado();
  if (!hasValidSecret(request, env)) return unauthorized();
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();
  // Conta externa não usa Solicitações: a tela esconde a aba quando recebe este 403.
  if (await contaExterna(env, session.name)) return jsonRes({ error: 'Solicitações são para as pessoas da instituição.' }, 403);
  await garantirEsquemaSolicitacoes(env);
  const { results } = await env.CHAMADOS_DB.prepare(
    `SELECT ${SOLIC_CAMPOS} FROM solicitacoes WHERE solicitante = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(session.name).all();
  return jsonRes({ solicitacoes: results || [] });
}

async function handleCriarSolicitacao(request, env) {
  if (!solicitacoesAtivo(env)) return solicitacoesDesligado();
  if (!hasValidSecret(request, env)) return unauthorized();
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();
  if (await contaExterna(env, session.name)) return jsonRes({ error: 'Solicitações são para as pessoas da instituição.' }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (!body || typeof body !== 'object') return jsonRes({ error: 'corpo inválido' }, 400);

  if (!SOLIC_CATEGORIAS.includes(body.categoria)) return jsonRes({ error: 'Escolha o que você precisa: equipamento, material, peça ou autorização.' }, 400);
  let item, justificativa;
  try {
    item = equipTexto(body.item, 120, 'item');
    justificativa = equipTexto(body.justificativa, 1000, 'justificativa');
  } catch (e) {
    return jsonRes({ error: e.message }, 400);
  }
  if (!item) return jsonRes({ error: 'Diga o que você precisa.' }, 400);
  if (!justificativa) return jsonRes({ error: 'Explique para que você precisa.' }, 400);
  const quantidade = body.quantidade === undefined ? 1 : body.quantidade;
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 999) return jsonRes({ error: 'A quantidade precisa ser um número de 1 a 999.' }, 400);
  let setor = null;
  if (body.setor != null) {
    if (!Number.isInteger(body.setor) || body.setor < 0 || body.setor > 99) return jsonRes({ error: 'setor inválido' }, 400);
    setor = body.setor;
  }

  await garantirEsquemaSolicitacoes(env);
  const agora = Date.now();
  const repetido = await env.CHAMADOS_DB.prepare(
    `SELECT id FROM solicitacoes WHERE solicitante = ? AND categoria = ? AND item = ? AND created_at > ?`
  ).bind(session.name, body.categoria, item, agora - SOLIC_JANELA_REPETIDO_MS).first();
  if (repetido) return jsonRes({ error: 'Você acabou de fazer este mesmo pedido. Ele já está na sua lista.' }, 409);
  const { n: pendentes } = await env.CHAMADOS_DB.prepare(`SELECT COUNT(*) AS n FROM solicitacoes WHERE solicitante = ? AND status = 'pendente'`).bind(session.name).first();
  if (pendentes >= SOLIC_MAX_PENDENTES) return jsonRes({ error: `Você já tem ${SOLIC_MAX_PENDENTES} pedidos aguardando a TI. Espere alguns serem atendidos.` }, 429);

  const id = crypto.randomUUID();
  // O número sequencial é calculado dentro do próprio INSERT (o D1 serializa escritas), como em chamados.numero.
  await env.CHAMADOS_DB.batch([
    env.CHAMADOS_DB.prepare(
      `INSERT INTO solicitacoes (id, numero, categoria, item, quantidade, justificativa, solicitante, setor, status, created_at, updated_at)
       VALUES (?, (SELECT COALESCE(MAX(numero), 0) + 1 FROM solicitacoes), ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`
    ).bind(id, body.categoria, item, quantidade, justificativa, session.name, setor, agora, agora),
    env.CHAMADOS_DB.prepare(
      `INSERT INTO solicitacao_eventos (id, solicitacao_id, de_status, para_status, autor, created_at) VALUES (?, ?, NULL, 'pendente', ?, ?)`
    ).bind(crypto.randomUUID(), id, session.name, agora),
  ]);
  const { numero } = await env.CHAMADOS_DB.prepare(`SELECT numero FROM solicitacoes WHERE id = ?`).bind(id).first();

  try {
    await notifyAdmins(env, {
      title: 'Chamados de TI – ISV',
      body: `Nova solicitação de ${SOLIC_ROTULO_CATEGORIA(body.categoria)}: ${limpaTextoAviso(item, 80)} (${limpaTextoAviso(session.name, 60)})`,
      data: { type: 'nova_solicitacao', solicitacao_id: id },
    }, 'handleCriarSolicitacao');
  } catch (err) {
    console.error(`handleCriarSolicitacao: falha ao avisar a TI da solicitação ${id}: ${err.message}`);
  }
  return jsonRes({ id, numero }, 201);
}
const SOLIC_ROTULO_CATEGORIA = (c) => ({ equipamento: 'equipamento', material: 'material', peca: 'peça', autorizacao: 'autorização' }[c] ?? c);

async function handleAdminListSolicitacoes(request, env) {
  if (!solicitacoesAtivo(env)) return solicitacoesDesligado();
  if (!(await isStaff(request, env))) return unauthorized();
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const categoria = searchParams.get('categoria');
  if (status && !SOLIC_STATUS.includes(status)) return jsonRes({ error: 'status inválido' }, 400);
  if (categoria && !SOLIC_CATEGORIAS.includes(categoria)) return jsonRes({ error: 'categoria inválida' }, 400);
  await garantirEsquemaSolicitacoes(env);
  const where = [];
  const binds = [];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (categoria) { where.push('categoria = ?'); binds.push(categoria); }
  const { results } = await env.CHAMADOS_DB.prepare(
    `SELECT ${SOLIC_CAMPOS} FROM solicitacoes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`
  ).bind(...binds).all();
  // Para o selo do menu: quantos pedidos esperam a primeira resposta da TI (independe dos filtros).
  const { n: pendentes } = await env.CHAMADOS_DB.prepare(`SELECT COUNT(*) AS n FROM solicitacoes WHERE status = 'pendente'`).first();
  return jsonRes({ solicitacoes: results || [], pendentes });
}

async function handleAdminMudarStatusSolicitacao(request, env, id) {
  if (!solicitacoesAtivo(env)) return solicitacoesDesligado();
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (!body || typeof body !== 'object') return jsonRes({ error: 'corpo inválido' }, 400);
  await garantirEsquemaSolicitacoes(env);

  const atual = await env.CHAMADOS_DB.prepare(`SELECT ${SOLIC_CAMPOS} FROM solicitacoes WHERE id = ?`).bind(id).first();
  if (!atual) return jsonRes({ error: 'Solicitação não encontrada' }, 404);
  const para = body.status;
  if (!SOLIC_STATUS.includes(para)) return jsonRes({ error: 'status inválido' }, 400);
  if (!SOLIC_TRANSICOES[atual.status].includes(para)) {
    return jsonRes({ error: `Não dá para ir de "${SOLIC_ROTULO_STATUS[atual.status]}" para "${SOLIC_ROTULO_STATUS[para]}".` }, 400);
  }
  let motivo;
  try { motivo = equipTexto(body.motivo, 500, 'recado'); } catch (e) { return jsonRes({ error: e.message }, 400); }
  if (para === 'rejeitado' && !motivo) return jsonRes({ error: 'Explique o motivo da rejeição: quem pediu vai ler.' }, 400);

  const autor = OPERADOR_NOMES[staff.operadorId] ?? null;
  const agora = Date.now();
  // A condição `status = ?` no WHERE protege de corrida (outro operador mexeu antes): se nada mudou, o evento não entra.
  const [upd] = await env.CHAMADOS_DB.batch([
    env.CHAMADOS_DB.prepare(
      `UPDATE solicitacoes SET status = ?, nota_ti = CASE WHEN ? = 1 THEN NULL WHEN ? = 1 THEN nota_ti ELSE COALESCE(?, nota_ti) END, motivo_rejeicao = ?, updated_at = ? WHERE id = ? AND status = ?`
    ).bind(para, para === 'pendente' ? 1 : 0, para === 'rejeitado' ? 1 : 0, motivo ?? null, para === 'rejeitado' ? motivo : null, agora, id, atual.status),
    env.CHAMADOS_DB.prepare(
      `INSERT INTO solicitacao_eventos (id, solicitacao_id, de_status, para_status, autor, texto, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM solicitacoes WHERE id = ? AND status = ? AND updated_at = ?)`
    ).bind(crypto.randomUUID(), id, atual.status, para, autor, motivo ?? null, agora, id, para, agora),
  ]);
  if (!upd.meta?.changes) return jsonRes({ error: 'Esta solicitação mudou enquanto você olhava. Atualize a tela e confira.' }, 409);

  try {
    const subJson = await env.SUBSCRIPTIONS.get(`usub_${atual.solicitante}`);
    if (subJson) {
      await sendWebPush(JSON.parse(subJson), JSON.stringify({
        title: 'Chamados de TI – ISV',
        body: `Sua solicitação de ${SOLIC_ROTULO_CATEGORIA(atual.categoria)} (${limpaTextoAviso(atual.item, 60)}) está: ${SOLIC_ROTULO_STATUS[para]}${para === 'rejeitado' && motivo ? ` — ${limpaTextoAviso(motivo, 120)}` : ''}`,
        data: { type: 'solicitacao', solicitacao_id: id, status: para },
      }), env);
    }
  } catch (err) {
    console.error(`handleAdminMudarStatusSolicitacao: falha ao avisar ${atual.solicitante}: ${err.message}`);
  }
  return jsonRes({ ok: true });
}

// =====================================================================
// POST /admin/migrate-schema-chamado-eventos — migração de schema ÚNICA (Fase B do
// roadmap pós-MVP-visual, 2026-08-14), cria a tabela `chamado_eventos` (histórico +
// comentários). Mesmo padrão de sempre — CREATE TABLE/INDEX IF NOT EXISTS,
// idempotente, tabela nova (não precisa recriar nada existente).
// =====================================================================
async function handleAdminMigrateSchemaChamadoEventos(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    await env.CHAMADOS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS chamado_eventos (
        id         TEXT PRIMARY KEY,
        chamado_id TEXT NOT NULL,
        tipo       TEXT NOT NULL CHECK (tipo IN ('nota', 'status', 'operador')),
        autor      TEXT,
        texto      TEXT,
        de_valor   TEXT,
        para_valor TEXT,
        created_at INTEGER NOT NULL
      )
    `).run();
    await env.CHAMADOS_DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_chamado_eventos_chamado ON chamado_eventos (chamado_id, created_at)'
    ).run();
    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ error: `migração de schema falhou: ${err.message}` }, 500);
  }
}

// =====================================================================
// CAMADA DE ANEXOS — CLOUDFLARE R2 (Fase B4 do roadmap de modernização,
// 2026-08-11 — ver CLAUDE.md "Decisões técnicas tomadas")
//
// ✅ Em uso desde a Fase M2 (migração de saída da ClickUp, 2026-08-13):
// handleUploadAttachment grava aqui + em chamado_anexos (D1) — anexo novo não
// sobe mais pra ClickUp. Limite de 10MB agora também é aplicado no servidor
// (ver MAX_ANEXO_BYTES), não só no cliente como antes.
//
// Chave do objeto no bucket: chamados/<chamadoId>/<uuid>-<nome sanitizado> —
// prefixo por chamado facilita listar/limpar todos os anexos de um chamado
// de uma vez no futuro (R2 permite list({prefix})).
// =====================================================================

function r2SanitizeFilename(name) {
  // Remove separador de caminho e ".." — nome vira só o "basename", sem chance
  // de escrever fora do prefixo do chamado (path traversal via nome de arquivo).
  const base = String(name || 'arquivo').split(/[\\/]/).pop().replace(/\.\./g, '');
  return base.slice(0, 200) || 'arquivo'; // limite de tamanho razoável pro nome
}

async function r2UploadAnexo(env, chamadoId, filename, contentType, body) {
  const key = `chamados/${chamadoId}/${crypto.randomUUID()}-${r2SanitizeFilename(filename)}`;
  const obj = await env.ANEXOS.put(key, body, {
    httpMetadata: { contentType: contentType || 'application/octet-stream' },
  });
  return { key, size: obj?.size ?? null, contentType: contentType || 'application/octet-stream' };
}

async function r2GetAnexo(env, key) {
  const obj = await env.ANEXOS.get(key);
  if (!obj) return null;
  return {
    key,
    size: obj.size,
    contentType: obj.httpMetadata?.contentType ?? null,
    body: obj.body, // ReadableStream — quem chamar decide se lê tudo ou repassa direto numa Response
  };
}

async function r2DeleteAnexo(env, key) {
  await env.ANEXOS.delete(key);
}

async function d1ListAnexos(env, chamadoId) {
  const { results } = await env.CHAMADOS_DB.prepare(
    'SELECT id, chamado_id, r2_key, filename, content_type, size, created_at FROM chamado_anexos WHERE chamado_id = ? ORDER BY created_at'
  ).bind(chamadoId).all();
  return results || [];
}

async function d1GetAnexoRow(env, id) {
  return env.CHAMADOS_DB.prepare('SELECT * FROM chamado_anexos WHERE id = ?').bind(id).first();
}

// =====================================================================
// GET /api/anexos/:id — serve o arquivo do R2, autenticado por sessão (Fase M2,
// 2026-08-13). Diferente da URL pública/direta que a ClickUp sempre devolveu, esta
// rota CONFERE dono antes de servir — melhoria de segurança em relação ao
// comportamento anterior (qualquer um com o link da ClickUp via `<img src>`
// conseguia abrir, sem sessão nenhuma). `:id` é o id da linha em chamado_anexos
// (UUID gerado pela aplicação), nunca a r2_key bruta — não expõe o formato
// interno da key do bucket pro cliente.
// =====================================================================
async function handleGetAnexo(request, env, anexoId) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const row = await d1GetAnexoRow(env, anexoId);
  if (!row) return jsonRes({ error: 'anexo não encontrado' }, 404);

  const chamado = await d1GetChamado(env, row.chamado_id);
  if (!chamado || chamado.solicitante !== session.name) return unauthorized('sem permissão pra ver esse anexo');

  const obj = await r2GetAnexo(env, row.r2_key);
  if (!obj) return jsonRes({ error: 'arquivo não encontrado no armazenamento' }, 404);

  return anexoResponse(obj, row.filename);
}

// Resposta de anexo segura (2026-11-11): o Content-Type vem do cliente no upload, então
// nunca é confiável. Só tipos da lista (imagem/PDF) são servidos como são; qualquer outro
// (HTML, SVG, script…) vira octet-stream + download. `nosniff` impede o navegador de
// "adivinhar" outro tipo, e o CSP com sandbox neutraliza script mesmo se algo escapar.
function anexoResponse(obj, filename) {
  const tipo = (obj.contentType || '').split(';')[0].trim().toLowerCase();
  const inline = ANEXO_TIPOS_INLINE.has(tipo);
  const nome = encodeURIComponent(filename || 'anexo').replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': inline ? tipo : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${nome}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}

// Acesso da TI aos anexos (2026-11-11): antes só o dono (sessão) abria, então a TI não via
// o print que o solicitante mandou. Mesma proteção ADMIN_SECRET das outras rotas /admin/*.
async function handleAdminListAnexos(request, env, taskId) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  if (!(await staffCanAccessChamado(env, staff, taskId))) return jsonRes({ error: 'este chamado não é seu' }, 403);
  const origin = new URL(request.url).origin;
  const anexos = await d1ListAnexos(env, taskId);
  return jsonRes({
    anexos: anexos.map(a => ({
      id: a.id, name: a.filename, size: a.size, content_type: a.content_type,
      url: `${origin}/admin/anexos/${a.id}`,
    })),
  });
}

async function handleAdminGetAnexo(request, env, anexoId) {
  const staff = await isStaff(request, env);
  if (!staff) return unauthorized();
  const row = await d1GetAnexoRow(env, anexoId);
  if (!row) return jsonRes({ error: 'anexo não encontrado' }, 404);
  if (!(await staffCanAccessChamado(env, staff, row.chamado_id))) return jsonRes({ error: 'este chamado não é seu' }, 403);
  const obj = await r2GetAnexo(env, row.r2_key);
  if (!obj) return jsonRes({ error: 'arquivo não encontrado no armazenamento' }, 404);
  return anexoResponse(obj, row.filename);
}

// POST /admin/import-anexo-url — importação ÚNICA de anexos que ficaram só na ClickUp (2026-11-24).
// Os chamados importados da ClickUp (outubro e hoje) vieram sem os arquivos. O Worker baixa a URL
// temporária (uso único) que a ClickUp entrega e grava no R2 + chamado_anexos. Só aceita endereços
// https de *.clickup-attachments.com (nada de URL arbitrária). Idempotente por (chamado, nome do arquivo).
// Body: { chamado_id, url, filename, content_type? }. Remover depois de usar.
async function handleAdminImportAnexoUrl(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  const { chamado_id, url, filename } = body || {};
  if (typeof chamado_id !== 'string' || typeof filename !== 'string' || !filename || typeof url !== 'string') {
    return jsonRes({ error: 'chamado_id, url e filename são obrigatórios' }, 400);
  }
  let u;
  try { u = new URL(url); } catch { return jsonRes({ error: 'url inválida' }, 400); }
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.clickup-attachments.com')) {
    return jsonRes({ error: 'só aceita https://*.clickup-attachments.com' }, 400);
  }
  if (!(await d1GetChamado(env, chamado_id))) return jsonRes({ error: 'chamado não encontrado' }, 404);
  const ja = await env.CHAMADOS_DB.prepare('SELECT 1 FROM chamado_anexos WHERE chamado_id = ? AND filename = ?').bind(chamado_id, filename).first();
  if (ja) return jsonRes({ ok: true, skipped: true });

  const resp = await fetch(url);
  if (!resp.ok) return jsonRes({ error: `download falhou (HTTP ${resp.status})` }, 502);
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength > MAX_ANEXO_BYTES) return jsonRes({ error: 'arquivo maior que o limite' }, 413);
  const tipo = body.content_type || resp.headers.get('content-type') || 'application/octet-stream';
  const { key, size, contentType } = await r2UploadAnexo(env, chamado_id, filename, tipo, bytes);
  try {
    await env.CHAMADOS_DB.prepare(
      'INSERT INTO chamado_anexos (id, chamado_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), chamado_id, key, filename, contentType, size ?? bytes.byteLength, Date.now()).run();
  } catch (err) {
    await r2DeleteAnexo(env, key).catch(() => {});
    return jsonRes({ error: 'não foi possível salvar o anexo' }, 500);
  }
  return jsonRes({ ok: true, size: size ?? bytes.byteLength });
}

// =====================================================================
// POST /admin/migrate-schema-anexos — migração de schema ÚNICA (Fase M2), cria a
// tabela `chamado_anexos` no D1 real de produção. Mesmo padrão de toda outra
// migração de schema desta sessão — CREATE TABLE IF NOT EXISTS, idempotente.
// =====================================================================
async function handleAdminMigrateSchemaAnexos(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  try {
    await env.CHAMADOS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS chamado_anexos (
        id           TEXT PRIMARY KEY,
        chamado_id   TEXT NOT NULL,
        r2_key       TEXT NOT NULL,
        filename     TEXT,
        content_type TEXT,
        size         INTEGER,
        created_at   INTEGER NOT NULL
      )
    `).run();
    await env.CHAMADOS_DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_chamado_anexos_chamado ON chamado_anexos (chamado_id)'
    ).run();
    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ error: `migração de schema falhou: ${err.message}` }, 500);
  }
}

// Fase M5 (2026-08-13): POST /admin/migrate-anexos removida — já rodou em produção
// (46 anexos reais migrados em 41 chamados, 0 erros, ver CLAUDE.md). Era a última rota
// que ainda chamava api.clickup.com pra ler task/anexo (fora do lookup de push, já
// resolvido acima) — não sobra nenhum `fetch` pra ClickUp neste arquivo depois desta
// fase (só o comentário de arquitetura no topo do arquivo/router, histórico).

// =====================================================================
// AUTOMAÇÃO DE SLA/PUSH EMBUTIDA — D1 (Fase B5 do roadmap de modernização,
// 2026-08-11 — ver CLAUDE.md "Decisões técnicas tomadas")
//
// Escrita e testada na Fase B5, ficou dormente até a Fase M4 (2026-08-13) ligar de
// verdade em `handleAdminUpdateTask` — hoje é a ÚNICA automação de status que existe
// (a versão baseada em webhook/`runStatusAutomation` foi removida na mesma M4).
//
// Diferenças deliberadas em relação ao `runStatusAutomation` original, não são bug:
// - Sem dedup (`processed_<id>_<status>` no original): aquele dedup existia só porque
//   o webhook da ClickUp podia entregar o mesmo evento mais de uma vez. Sem webhook
//   nenhum (nem essa classe de duplicata), essa função só roda quando alguém chama ela
//   direto — uma vez por mudança de status.
// - "encerrado" sempre grava date_closed, mesmo sem start_date (chamado que pula "em
//   atendimento" e vai direto pra "encerrado"). O original pulava o registro de tempo
//   nesse caso porque dependia de start_date pra calcular a duração pra API de
//   time-tracking da ClickUp — o D1 não tem equivalente disso (a duração já é só
//   date_closed - start_date, calculada sob demanda em d1GetMetrics, que já ignora
//   quando start_date falta).
// - Push embutido na mesma função (não um passo separado), lendo a chave `usub_<nome>`
//   direto (Fase M5 — antes resolvia orderindex via getSolicitanteMaps, chamada à
//   ClickUp que não existe mais). Falha ao enviar push nunca derruba a mudança de
//   status (fica num try/catch próprio).
// =====================================================================
async function d1TransitionStatus(env, chamadoId, novoStatus) {
  if (!VALID_STATUSES.includes(novoStatus)) {
    throw new Error(`status inválido: ${novoStatus}`);
  }
  const chamado = await d1GetChamado(env, chamadoId);
  if (!chamado) throw new Error('chamado não encontrado no D1');

  const prevStatus     = chamado.status;
  // Mesmo status = nada a fazer. O modal "Gerenciar" sempre manda o status junto, e sem isto
  // salvar só a solução reiniciava início/prazo do atendimento, a data de encerramento ou a
  // pausa, além de repetir o push.
  if (prevStatus === novoStatus) return chamado;
  const saiuDePendente = prevStatus === 'pendente' && novoStatus !== 'pendente';
  // 🛡️ Achado do revisor (2026-08-13, mesmo dia do fix de saiuDePendente abaixo): o
  // painel de admin aceita QUALQUER transição de status a qualquer momento (Kanban
  // com drag-and-drop livre, limitação já aceita/documentada), então "Aberto ->
  // Pendente -> Em Atendimento" (pausar ANTES de nunca ter começado a atender) é uma
  // sequência real. Nesse caso `saiuDePendente` sozinho não basta pra decidir se é
  // uma "retomada de verdade": `chamado.start_date` só é não-nulo depois que o
  // chamado já entrou em "em atendimento" pelo menos uma vez — é isso que distingue
  // "retomando um atendimento pausado" (não deveria resetar o prazo de finalização)
  // de "pausou antes de começar, tá entrando em atendimento agora pela 1ª vez"
  // (deveria sim aplicar o padrão da prioridade, igual a qualquer entrada normal).
  const retomandoAtendimentoPausado = saiuDePendente && chamado.start_date != null;
  const patch = { status: novoStatus };

  if (novoStatus === 'pendente') {
    // Sem validade: com TTL de 30 dias, uma espera longa perdia o crédito do tempo parado.
    // A chave é apagada quando o chamado sai de pendente.
    await env.SUBSCRIPTIONS.put(`d1_pending_start_${chamadoId}`, String(Date.now()));
  } else if (saiuDePendente) {
    const pendingStartStr = await env.SUBSCRIPTIONS.get(`d1_pending_start_${chamadoId}`);
    // Sem a chave (pausas antigas, gravadas com validade de 30 dias), vale o histórico.
    const pausadoEm = pendingStartStr
      ? parseInt(pendingStartStr, 10)
      : ultimaEntradaEm(await d1ListEventos(env, chamadoId), 'pendente');
    if (pausadoEm != null && chamado.due_date != null) {
      patch.dueDate = chamado.due_date + (Date.now() - pausadoEm);
    }
    await env.SUBSCRIPTIONS.delete(`d1_pending_start_${chamadoId}`);
  }

  if (novoStatus === 'em atendimento') {
    const now = Date.now();
    patch.startDate = now;
    // 🛡️ Achado real (2026-08-13, testando a feature de alerta de admin — flaky por
    // sorte de timing, não por acaso): quando a transição é uma RETOMADA de um
    // atendimento pausado (`retomandoAtendimentoPausado`), o bloco acima já calculou
    // o due_date certo (due_date antigo + tempo pausado). Sem essa checagem aqui,
    // esta atribuição sobrescrevia esse valor com `now + timeEstimate` — resetando o
    // prazo pra uma janela cheia nova a cada pausa/retomada, em vez de só empurrar
    // pelo tempo que ficou pendente (o chamado voltaria a ter até 1h/4h/15min
    // inteiros de novo, mesmo já tendo consumido a maior parte do prazo antes de
    // pausar). Só aplica o padrão por prioridade na entrada "de verdade" em
    // atendimento — vindo de "aberto" diretamente, OU pausado antes de qualquer
    // atendimento real ter começado (`chamado.start_date` ainda nulo nesse caso,
    // então NÃO é `retomandoAtendimentoPausado` — é a 1ª entrada de verdade, só que
    // com uma pausa no meio do caminho).
    if (!retomandoAtendimentoPausado) {
      const timeEstimate = DEFAULT_TIME_ESTIMATE_MS_BY_PRIORITY[chamado.priority];
      if (timeEstimate) patch.dueDate = now + timeEstimate;
    }
  }

  if (novoStatus === 'encerrado') {
    patch.dateClosed = Date.now();
  }

  // Reabrir um chamado encerrado zera a nota de satisfação: a avaliação era do
  // atendimento anterior. Sem isso a nota ficava escondida (o widget só aparece em
  // "encerrado") mas continuava contando na média do dashboard.
  if (prevStatus === 'encerrado' && novoStatus !== 'encerrado') {
    patch.nota = null;
    // Reativação (2026-11-24, pedido do gestor): o chamado deixa de ter data de encerramento.
    // Voltando pra "aberto" ou "pendente" ele recomeça a fase de aceitação: sem start_date e com
    // prazo novo (senão voltaria já "atrasado", com o prazo do chamado antigo). Em "pendente" o
    // prazo novo fica parado e é empurrado pelo tempo de espera, como em qualquer pausa.
    patch.dateClosed = null;
    if (novoStatus === 'aberto' || novoStatus === 'pendente') {
      patch.startDate = null;
      const sla = PRIORITY_SLA_MS[chamado.priority];
      if (sla) patch.dueDate = Date.now() + sla;
    }
  }

  const updated = await d1UpdateChamado(env, chamadoId, patch);

  const label = NOTIFY_STATUSES[novoStatus];
  if (label) {
    try {
      const subJson = await env.SUBSCRIPTIONS.get(`usub_${chamado.solicitante}`);
      if (subJson) {
        await sendWebPush(JSON.parse(subJson), JSON.stringify({
          title: 'Chamados de TI – ISV',
          body:  `"${chamado.name}" está agora: ${label}`,
          data:  { task_id: chamadoId, status: novoStatus }
        }), env);
      }
    } catch (err) {
      console.error(`d1TransitionStatus: falha ao enviar push pra ${chamadoId}: ${err.message}`);
    }
  }

  return updated;
}

export { alertarSla, competenciaAtual, d1CreateChamado, d1GetChamado, d1ListChamados, d1UpdateChamado, d1DeleteChamado, d1GetMetrics, r2UploadAnexo, r2GetAnexo, r2DeleteAnexo, d1TransitionStatus, d1SetAssignees, d1ListSolicitantes, d1IsSolicitanteAtivo, d1CreateSolicitante, d1SetSolicitanteAtivo, d1GetSolicitanteByEmail, d1SetSolicitanteEmail, d1ListAnexos, d1GetAnexoRow, d1LogEvento, d1CreateEvento, d1ListEventos };
