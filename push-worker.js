// =====================================================================
// CHAMADOS TI – PUSH NOTIFICATION WORKER
// Cloudflare Worker — cola este arquivo no editor do dashboard
//
// Variáveis de ambiente (Settings → Variables → Add):
//   VAPID_PUBLIC_KEY  → chave pública gerada (PUBLIC_KEY)
//   VAPID_PRIVATE_JWK → chave privada em JSON (PRIVATE_JWK)
//   CLICKUP_API_KEY   → chave da API do ClickUp (marcar como secret) — usada na automação de
//                        status E no proxy /api/* (o app.js NUNCA recebe essa chave)
//   SUBSCRIBE_SECRET  → mesmo valor de APP_SHARED_SECRET no app.js (marcar como secret) —
//                        valida /subscribe e /api/* (header X-App-Secret) e /auth/* (mesmo header)
//   ADMIN_SECRET      → segredo só seu (marcar como secret) — gere um valor aleatório
//                        qualquer, NUNCA o mesmo do SUBSCRIBE_SECRET. Não fica em nenhum
//                        lugar do app.js/navegador. Usado nas rotas /admin/* (header
//                        X-Admin-Secret): GET /admin/users (quem já tem senha cadastrada),
//                        GET /admin/tasks (todos os chamados, com filtros), GET /admin/metrics
//                        (agregados de SLA/volume/tempo de atendimento) e POST /admin/tasks/:id
//                        (única rota de admin que MUTA a ClickUp — status/solução/operador;
//                        é o que substitui a ClickUp como interface de trabalho da TI).
//
// KV Namespace (Settings → KV Namespace Bindings → Add):
//   Nome da variável: SUBSCRIPTIONS — reaproveitado também pra login (sem KV novo):
//     auth_<nome>       → { algo, iterations, salt, hash, createdAt, lastLoginAt } (senha,
//                          nunca expira sozinha — dado exposto em /admin/users é só nome/datas)
//     session_<token>   → { name } (expira em SESSION_TTL_SECONDS)
//     loginfail_<nome>  → contador de tentativas erradas de senha de usuário (expira em 15min)
//     adminfail_<ip>    → contador de tentativas erradas de ADMIN_SECRET, por IP (expira em 15min)
// =====================================================================

// ⚠️ Mantenha sincronizado com LIST_ID/FIELD_IDS.SOLICITANTE/FIELD_IDS.TIPO/FIELD_IDS.SETOR/
// FIELD_IDS.SOLUCAO/FIELD_IDS.EMAIL em app.js
const LIST_ID               = '901324490220';
const SOLICITANTE_FIELD_ID  = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const TIPO_FIELD_ID         = '47e475fe-e911-40cd-b4a2-23625fbf57f1';
const SETOR_FIELD_ID        = 'c1ca88de-4b01-4933-93ff-24494bed59e2';
const SOLUCAO_FIELD_ID      = '16144175-845e-4e3c-baaa-a2517325cd43';
// Só usado pela migração pro D1 (Fase B3) — nenhuma rota anterior precisava ler EMAIL.
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
const ALLOWED_ORIGIN = 'https://tecnologiadainformacaoisv.github.io';
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

// =====================================================================
// ROUTER
//
// /api/* — proxy autenticado pra ClickUp: o app (app.js) nunca recebe a
// chave da ClickUp. Ele manda o header X-App-Secret (mesmo valor de
// APP_SHARED_SECRET em app.js / env.SUBSCRIBE_SECRET aqui); o Worker
// injeta env.CLICKUP_API_KEY (secret, só existe aqui) antes de repassar.
// =====================================================================
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const { pathname } = new URL(request.url);

    if (request.method === 'POST') {
      if (pathname === '/auth/register') return handleRegister(request, env);
      if (pathname === '/auth/login')    return handleLogin(request, env);
      if (pathname === '/auth/logout')   return handleLogout(request, env);
      if (pathname === '/subscribe')     return handleSubscribe(request, env);
      if (pathname === '/webhook')       return handleWebhook(request, env);
      if (pathname === '/api/tasks')     return handleCreateTask(request, env);
      const attachMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/attachment$/);
      if (attachMatch) return handleUploadAttachment(request, env, attachMatch[1]);
      const adminUpdateMatch = pathname.match(/^\/admin\/tasks\/([^/]+)$/);
      if (adminUpdateMatch) return handleAdminUpdateTask(request, env, adminUpdateMatch[1]);
      if (pathname === '/admin/migrate-d1') return handleAdminMigrateD1(request, env);
      if (pathname === '/admin/migrate-schema-nullable-tipo-setor') return handleAdminMigrateSchemaNullableTipoSetor(request, env);
      if (pathname === '/admin/migrate-schema-chamado-assignees') return handleAdminMigrateSchemaChamadoAssignees(request, env);
      if (pathname === '/admin/migrate-schema-solicitantes') return handleAdminMigrateSchemaSolicitantes(request, env);
      if (pathname === '/admin/migrate-solicitantes') return handleAdminMigrateSolicitantes(request, env);
      if (pathname === '/admin/solicitantes') return handleAdminCreateSolicitante(request, env);
      const solAtivoMatch = pathname.match(/^\/admin\/solicitantes\/([^/]+)\/ativo$/);
      if (solAtivoMatch) return handleAdminSetSolicitanteAtivo(request, env, solAtivoMatch[1]);
      if (pathname === '/admin/migrate-schema-anexos') return handleAdminMigrateSchemaAnexos(request, env);
      if (pathname === '/admin/migrate-anexos') return handleAdminMigrateAnexos(request, env);
    }

    if (request.method === 'GET') {
      if (pathname === '/api/field')         return handleGetField(request, env);
      if (pathname === '/api/solicitantes')  return handleListSolicitantes(request, env);
      if (pathname === '/api/my-tasks')      return handleGetMyTasks(request, env);
      if (pathname === '/admin/users')       return handleAdminListUsers(request, env);
      if (pathname === '/admin/tasks')       return handleAdminListTasks(request, env);
      if (pathname === '/admin/metrics')     return handleAdminMetrics(request, env);
      if (pathname === '/admin/solicitantes') return handleAdminListSolicitantes(request, env);
      const anexoMatch = pathname.match(/^\/api\/anexos\/([^/]+)$/);
      if (anexoMatch) return handleGetAnexo(request, env, anexoMatch[1]);
      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) return handleGetTask(request, env, taskMatch[1]);
      return new Response('Chamados TI – Push Worker OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// =====================================================================
// PROXY AUTENTICADO PRA CLICKUP (/api/*)
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

async function passthrough(upstream) {
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...CORS, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' }
  });
}

// Quem está autenticado nesta requisição, segundo o token de sessão — nunca segundo o que
// o cliente alega no corpo/query. Base de tudo que protege um solicitante ver dado de outro.
async function requireSession(request, env) {
  const token = request.headers.get('X-Session-Token');
  if (!token) return null;
  const raw = await env.SUBSCRIPTIONS.get(`session_${token}`);
  return raw ? JSON.parse(raw) : null;
}

// Nome <-> orderindex real da ClickUp, buscado fresco a cada chamada que precisa (mesma
// lógica de app.js, só que do lado do servidor — usada pra nunca confiar no índice que o
// cliente manda ao criar/filtrar/notificar.
async function getSolicitanteMaps(env) {
  const upstream = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/field`, {
    headers: { Authorization: env.CLICKUP_API_KEY }
  });
  const data = await upstream.json();
  const field = data.fields?.find(f => f.id === SOLICITANTE_FIELD_ID);
  const options = field?.type_config?.options || [];
  const nameToIdx = {};
  const idxToName = {};
  for (const opt of options) {
    nameToIdx[opt.name] = opt.orderindex;
    idxToName[opt.orderindex] = opt.name;
  }
  return { nameToIdx, idxToName };
}

async function handleGetField(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  const upstream = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/field`, {
    headers: { Authorization: env.CLICKUP_API_KEY }
  });
  return passthrough(upstream);
}

// Fase B7 (2026-08-12): lê do D1 em vez de paginar a ClickUp — é a rota mais chamada
// do Worker (poll de 60s de cada solicitante logado), então é onde o corte pro D1
// rende mais (sem round-trip pra API externa a cada poll). D1 guarda `solicitante`
// como o nome já resolvido (não um orderindex), então nem precisa mais do fallback
// que existia aqui pra quando o nome não resolvia no campo customizado atual da
// ClickUp — essa ambiguidade simplesmente não existe mais neste caminho.
// GET /tasks/:id (não esta rota) continua na ClickUp — é lá que mora `attachments`.
async function handleGetMyTasks(request, env) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const rows = await d1ListChamados(env, { solicitante: session.name });
  return jsonRes({ tasks: rows.map(d1RowToTaskShape) });
}

async function handleGetTask(request, env, taskId) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const upstream = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    headers: { Authorization: env.CLICKUP_API_KEY }
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    return new Response(text, { status: upstream.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Dono do chamado tem que bater com quem está logado — sem isso, dava pra ver qualquer
  // chamado só sabendo/adivinhando o ID.
  const task = JSON.parse(text);
  const { idxToName } = await getSolicitanteMaps(env);
  const cf = task.custom_fields?.find(f => f.id === SOLICITANTE_FIELD_ID);
  const v  = cf?.value?.orderindex ?? cf?.value;
  if (idxToName[v] !== session.name) return unauthorized('sem permissão pra ver esse chamado');

  // Fase M2 (2026-08-13, migração de saída da ClickUp): anexo passou a morar no R2/D1
  // (`chamado_anexos`), não mais na ClickUp — sobrescreve `attachments` com o que tiver
  // lá, no mesmo shape que o frontend já espera (url/title/name/extension). A "url"
  // aqui é a rota autenticada nova (`/api/anexos/:id`), não mais um link direto/público
  // da ClickUp — precisa deploy JUNTO com a mudança de handleUploadAttachment/frontend
  // (AnexoModal), nunca separado: se o upload já vai pro R2 mas esta rota ainda lê
  // attachments da ClickUp, o anexo recém-subido fica invisível até os dois baterem.
  const anexos = await d1ListAnexos(env, taskId);
  const origin = new URL(request.url).origin;
  task.attachments = anexos.map(a => ({
    url: `${origin}/api/anexos/${a.id}`,
    title: a.filename,
    name: a.filename,
    extension: (a.filename || '').includes('.') ? a.filename.split('.').pop() : null,
  }));

  return jsonRes(task);
}

async function handleCreateTask(request, env) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  let payload;
  try { payload = JSON.parse(await request.text()); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  // Nunca confia no valor de SOLICITANTE que o cliente mandou — troca pelo da sessão
  // autenticada. É isso que impede alguém de abrir um chamado "como" outra pessoa.
  const { nameToIdx, idxToName } = await getSolicitanteMaps(env);
  const cuIdx = nameToIdx[session.name];
  if (cuIdx == null) return jsonRes({ error: 'não foi possível confirmar seu cadastro na ClickUp' }, 400);

  payload.custom_fields = (payload.custom_fields || []).filter(f => f.id !== SOLICITANTE_FIELD_ID);
  payload.custom_fields.push({ id: SOLICITANTE_FIELD_ID, value: cuIdx });

  // Prioridade e prazo também nunca vêm do cliente — "prioridade é sempre automática, nunca
  // manual" é regra do projeto, e o due_date define a fila de SLA. Recalcula os dois a partir
  // do TIPO só pra garantir que quem chamar o proxy direto (sabendo o APP_SHARED_SECRET, que é
  // público por design) não consiga abrir chamado como Urgente com prazo já vencido.
  const tipoField = payload.custom_fields.find(f => f.id === TIPO_FIELD_ID);
  const tipoIdx   = tipoField?.value;
  const prio      = CATEGORIA_PRIORIDADE[tipoIdx] ?? 3;
  payload.priority      = prio;
  payload.due_date       = Date.now() + (PRIORITY_SLA_MS[prio] ?? PRIORITY_SLA_MS[3]);
  payload.due_date_time  = true;

  // Throttle simples: no máximo 1 chamado a cada 60s por pessoa logada — evita duplo-clique
  // acidental virando 2 tickets, e freia flood sem precisar de infra nova (reaproveita o
  // mesmo KV já usado pro dedup da automação).
  // ⚠️ expirationTtl mínimo aceito pelo Cloudflare KV é 60 — qualquer valor menor faz o PUT
  // falhar com 400, e essa falha não tratada derrubava handleCreateTask inteiro ANTES de
  // chegar a criar o chamado na ClickUp (incidente 2026-08-10: "Abrir Chamado" não funcionava
  // pra ninguém, sempre por essa exceção, não por CORS/rede como os erros do navegador sugeriam).
  const throttleKey = `throttle_create_${session.name}`;
  if (await env.SUBSCRIPTIONS.get(throttleKey)) {
    return jsonRes({ error: 'Aguarde alguns segundos antes de abrir outro chamado' }, 429);
  }
  await env.SUBSCRIPTIONS.put(throttleKey, '1', { expirationTtl: 60 });

  const upstream = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task`, {
    method: 'POST',
    headers: { Authorization: env.CLICKUP_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await upstream.text();
  const res = new Response(text, {
    status: upstream.status,
    headers: { ...CORS, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' }
  });

  // Espelho no D1 (Fase B7, 2026-08-12) — ClickUp continua sendo quem cria de verdade
  // (é ela quem gera o task_id, e o anexo/attachment ainda sobe só pra lá); o D1 só
  // espelha o resultado, best-effort. Uma falha aqui NUNCA derruba a resposta pro
  // usuário — o chamado já foi criado na ClickUp de qualquer forma, e a próxima
  // migração completa (POST /admin/migrate-d1) fecha qualquer lacuna que sobrar.
  if (upstream.ok) {
    try {
      const created = JSON.parse(text);
      await d1MigrateChamado(env, mapClickUpTaskToD1(created, idxToName));
    } catch (err) {
      console.warn('espelho D1 falhou na criação (chamado já existe na ClickUp normalmente):', err.message);
    }
  }

  return res;
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

  const { key, size, contentType } = await r2UploadAnexo(env, taskId, file.name, file.type, file.stream());
  const anexoId = crypto.randomUUID();
  await env.CHAMADOS_DB.prepare(
    'INSERT INTO chamado_anexos (id, chamado_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(anexoId, taskId, key, file.name, contentType, size, Date.now()).run();

  return jsonRes({ ok: true, id: anexoId });
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
  await env.SUBSCRIPTIONS.put(`session_${token}`, JSON.stringify({ name }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

// =====================================================================
// /auth/register — cria a senha de alguém que ainda não tem uma (primeiro acesso).
// Body: { name, password, secret }
// =====================================================================
async function handleRegister(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const name = body.name;
  const password = body.password;
  if (!name || !password || password.length < 8) {
    return jsonRes({ error: 'Nome e senha (mínimo 8 caracteres) são obrigatórios' }, 400);
  }

  // Fase M1 (2026-08-13, migração de saída da ClickUp): antes desta checagem, QUALQUER
  // string virava conta — não existia validação nenhuma de que `name` era um solicitante
  // de verdade (a única "trava" era o dropdown da UI, que confia no cliente). Agora exige
  // que o nome esteja cadastrado e ativo na tabela `solicitantes` do D1 antes de deixar
  // criar senha — fecha essa lacuna real de segurança.
  if (!(await d1IsSolicitanteAtivo(env, name))) {
    return jsonRes({ error: 'Nome não encontrado na lista de solicitantes. Fale com a TI.' }, 403);
  }

  if (await env.SUBSCRIPTIONS.get(`auth_${name}`)) {
    return jsonRes({ error: 'Já existe uma senha cadastrada pra esse nome. Se esqueceu, peça pro TI resetar.' }, 409);
  }

  await setAuthRecord(name, password, env);
  const token = await createSession(name, env);
  return jsonRes({ token, name });
}

// =====================================================================
// /auth/login — valida senha existente e devolve um token de sessão.
// Body: { name, password, secret }
// =====================================================================
async function handleLogin(request, env) {
  if (!hasValidSecret(request, env)) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  const name = body.name;
  const password = body.password;
  if (!name || !password) return jsonRes({ error: 'Nome e senha são obrigatórios' }, 400);

  const failKey = `loginfail_${name}`;
  const failCount = parseInt(await env.SUBSCRIPTIONS.get(failKey) || '0');
  if (failCount >= MAX_LOGIN_FAILURES) {
    return jsonRes({ error: 'Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.' }, 429);
  }

  const raw = await env.SUBSCRIPTIONS.get(`auth_${name}`);
  if (!raw) return jsonRes({ error: 'Sem senha cadastrada pra esse nome ainda' }, 404);
  const record = JSON.parse(raw);

  const ok = await verifyPassword(password, record);
  if (!ok) {
    await env.SUBSCRIPTIONS.put(failKey, String(failCount + 1), { expirationTtl: LOGIN_LOCKOUT_SECONDS });
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

async function isAdmin(request, env) {
  if (!env.ADMIN_SECRET) return false;

  const provided = request.headers.get('X-Admin-Secret');
  if (!provided) return false;

  const ip      = request.headers.get('CF-Connecting-IP') || 'unknown';
  const failKey = `adminfail_${ip}`;
  const failCount = parseInt(await env.SUBSCRIPTIONS.get(failKey) || '0');
  if (failCount >= MAX_ADMIN_FAILURES) return false;

  if (provided !== env.ADMIN_SECRET) {
    await env.SUBSCRIPTIONS.put(failKey, String(failCount + 1), { expirationTtl: ADMIN_LOCKOUT_SECONDS });
    return false;
  }
  if (failCount > 0) await env.SUBSCRIPTIONS.delete(failKey);
  return true;
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

// Valor "puro" de um campo customizado — mesmo padrão repetido em handleGetMyTasks/
// handleGetTask/handleUploadAttachment (cf?.value?.orderindex ?? cf?.value), só que
// nomeado, pra não reescrever de novo nas rotas de admin abaixo.
function cfValue(task, fieldId) {
  const cf = task.custom_fields?.find(f => f.id === fieldId);
  return cf?.value?.orderindex ?? cf?.value ?? null;
}

// Busca TODOS os chamados da lista (não só a primeira página) — as rotas de admin
// precisam do total real pra métricas/filtros baterem, diferente de handleGetMyTasks
// (que é por pessoa e raramente passa de 100 chamados).
//
// LIMITAÇÃO CONHECIDA (teto de páginas + double-fetch): teto de `maxPages` páginas
// (~2000 chamados no padrão) só como salvaguarda contra loop infinito se a API mudar
// de formato — mas na prática, se o volume real passar disso, os chamados mais antigos
// somem silenciosamente das métricas/filtros. Por isso devolve `truncated: true` quando
// bate o teto, pra quem chama poder avisar. Além disso, /admin/tasks e /admin/metrics
// chamam esta função de forma independente (cada carregamento do painel faz a paginação
// completa duas vezes) — aceitável no volume atual (dezenas de chamados = 1 página cada),
// mas vira ~40 chamadas à ClickUp por carregamento se o volume um dia chegar na casa dos
// milhares. Se isso passar a importar, a solução é cachear o resultado por alguns
// segundos no KV (chave curta, TTL de 15-30s) em vez de buscar tudo de novo a cada rota.
async function fetchAllTasks(env, maxPages = 20) {
  const tasks = [];
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ order_by: 'created', reverse: 'true', include_closed: 'true', page: String(page) });
    const upstream = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?${params}`, {
      headers: { Authorization: env.CLICKUP_API_KEY }
    });
    const data  = await upstream.json();
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (batch.length < 100 || data.last_page) return { tasks, truncated: false };
  }
  // Só chega aqui se todas as `maxPages` páginas vieram cheias (100 itens, sem last_page) —
  // sinal de que ainda tem mais chamados na ClickUp que não foram buscados.
  return { tasks, truncated: true };
}

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
  if (!(await isAdmin(request, env))) return unauthorized();

  const { searchParams } = new URL(request.url);
  const statusFilter      = searchParams.get('status');
  const setorFilter       = searchParams.get('setor');
  const tipoFilter        = searchParams.get('tipo');
  const operadorFilter    = searchParams.get('operador');
  const solicitanteFilter = searchParams.get('solicitante');

  const rows = await d1ListChamados(env, {
    status: statusFilter ? statusFilter.toLowerCase() : undefined,
    setor: setorFilter ?? undefined,
    tipo: tipoFilter ?? undefined,
    assigneeId: operadorFilter ?? undefined,
    solicitante: solicitanteFilter ?? undefined,
    withAssignees: true,
  });
  const tasks = rows.map(d1RowToTaskShape);

  return jsonRes({ total: tasks.length, tasks, truncated: false });
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
async function handleAdminMetrics(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();
  return jsonRes(await d1GetMetrics(env));
}

// =====================================================================
// POST /admin/tasks/:id — a TI passa a trabalhar por aqui em vez de abrir a ClickUp
// (decisão de 2026-08-07: ClickUp continua guardando o dado, mas deixa de ser a
// INTERFACE de trabalho — ver CLAUDE.md, "Painel de admin"). Protegido por ADMIN_SECRET,
// mesmo padrão das outras rotas /admin/*. Body aceita qualquer subconjunto de:
//   { status, solucao, assigneeId }
// Cada campo presente dispara uma chamada própria pra ClickUp, porque a API dela usa
// formatos diferentes pra cada tipo de mudança (status é PUT direto na task; campo
// customizado como SOLUCAO é POST num endpoint próprio de campo; assignee é PUT com
// {add, rem} depois de buscar quem já está atribuído). Mudar o status aqui já é
// suficiente pra disparar a automação de SLA existente (runStatusAutomation) — ela reage
// à automação/webhook configurada na ClickUp, que dispara em QUALQUER mudança de status,
// não importa se veio da UI da ClickUp ou da API (que é o que este endpoint usa).
// =====================================================================
async function handleAdminUpdateTask(request, env, taskId) {
  if (!(await isAdmin(request, env))) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  // Validação de tipo/valor de cada campo antes de tocar em qualquer coisa na ClickUp —
  // achados do revisor 2026-08-07: "solucao" não-string era ignorado em silêncio (respondia
  // ok:true sem salvar nada) e "assigneeId" não validava número/NaN.
  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    return jsonRes({ error: `status inválido — use um de: ${VALID_STATUSES.join(', ')}` }, 400);
  }
  if (body.solucao !== undefined && typeof body.solucao !== 'string') {
    return jsonRes({ error: 'solucao precisa ser uma string' }, 400);
  }
  if (body.assigneeId !== undefined && body.assigneeId !== null && !Number.isFinite(Number(body.assigneeId))) {
    return jsonRes({ error: 'assigneeId precisa ser um número, null (remove atribuição), ou omitido' }, 400);
  }
  if (body.status === undefined && body.solucao === undefined && body.assigneeId === undefined) {
    return jsonRes({ error: 'nada pra atualizar — mande status, solucao e/ou assigneeId' }, 400);
  }

  const headers = { Authorization: env.CLICKUP_API_KEY, 'Content-Type': 'application/json' };
  const updated = {};

  if (body.status !== undefined) {
    const upstream = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
      method: 'PUT', headers, body: JSON.stringify({ status: body.status })
    });
    if (!upstream.ok) return passthrough(upstream); // nada foi aplicado ainda, passthrough puro está ok
    updated.status = body.status;
  }

  // Da 2ª sub-mutação em diante, uma falha não é mais "nada foi aplicado" — reporta em
  // `updated` o que já tinha sido salvo antes de falhar, pra quem chamou (admin.js) saber
  // que a operação ficou parcialmente aplicada, em vez de um erro genérico (achado do
  // revisor 2026-08-07: não há rollback entre as 3 sub-mutações, cada uma é uma chamada
  // separada à ClickUp; reportar o que já foi salvo é o possível aqui sem transação real).
  if (body.solucao !== undefined) {
    const upstream = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/field/${SOLUCAO_FIELD_ID}`, {
      method: 'POST', headers, body: JSON.stringify({ value: body.solucao })
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return jsonRes({ error: `solução não pôde ser salva: ${text}`, updated }, upstream.status || 502);
    }
    updated.solucao = true;
  }

  if (body.assigneeId !== undefined) {
    // null = "Sem atribuição" (remove quem estiver atribuído); qualquer outro valor = o
    // id de pra quem atribuir.
    const desiredId = body.assigneeId === null ? null : Number(body.assigneeId);
    // Busca quem já está atribuído pra montar o diff {add, rem} — a API da ClickUp não
    // tem "set assignee", só "adicionar"/"remover" em cima do que já existe. Sem isso,
    // "atribuir pro Henrique" um chamado que já era do Everson deixaria os dois atribuídos.
    const taskResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, { headers: { Authorization: env.CLICKUP_API_KEY } });
    if (!taskResp.ok) return jsonRes({ error: 'não foi possível confirmar quem já estava atribuído', updated }, taskResp.status || 502);
    const task = await taskResp.json();
    const currentIds = (task.assignees || []).map(a => a.id);
    const rem = desiredId === null ? currentIds : currentIds.filter(id => id !== desiredId);
    const add = desiredId === null ? [] : (currentIds.includes(desiredId) ? [] : [desiredId]);

    if (add.length || rem.length) {
      const upstream = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
        method: 'PUT', headers, body: JSON.stringify({ assignees: { add, rem } })
      });
      if (!upstream.ok) {
        const text = await upstream.text();
        return jsonRes({ error: `operador não pôde ser salvo: ${text}`, updated }, upstream.status || 502);
      }
    }
    updated.assigneeId = desiredId;
  }

  // Espelho no D1 (Fase B7, 2026-08-12) — só chega aqui se TODAS as sub-mutações acima
  // já tiverem sido aplicadas com sucesso na ClickUp (qualquer falha no meio retorna
  // antes, mais acima). Best-effort, nunca derruba a resposta: a ClickUp já é a fonte
  // de verdade da mutação em si, o D1 só está copiando o resultado. Só espelha os
  // campos literais (status/solução/operador) — não recalcula start_date/due_date/
  // date_closed aqui (isso continua vindo só da automação da ClickUp via webhook,
  // ver runStatusAutomation); uma migração completa fecha essa lacuna se acumular.
  if (Object.keys(updated).length > 0) {
    try {
      const d1Patch = {};
      if (updated.status !== undefined) d1Patch.status = updated.status;
      if (updated.solucao !== undefined) d1Patch.solucao = body.solucao;
      if (updated.assigneeId !== undefined) d1Patch.assigneeId = updated.assigneeId;
      // Sincroniza chamados + chamado_assignees no MESMO .batch() (achado do revisor,
      // 2026-08-12 — ver comentário em d1UpdateChamado) — este endpoint sempre colapsa
      // pra 0 ou 1 operador (o diff add/rem contra a ClickUp já remove qualquer outro
      // que estivesse atribuído, ver acima), então é seguro substituir por completo.
      await d1UpdateChamado(env, taskId, d1Patch,
        updated.assigneeId !== undefined ? (updated.assigneeId != null ? [updated.assigneeId] : []) : undefined);
    } catch (err) {
      console.warn('espelho D1 falhou na atualização (ClickUp já foi atualizada normalmente):', err.message);
    }
  }

  return jsonRes({ ok: true, updated });
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
// Body: { user_idx: number, subscription: PushSubscription, secret: string }
// =====================================================================
async function handleSubscribe(request, env) {
  try {
    if (!hasValidSecret(request, env)) return unauthorized();

    const session = await requireSession(request, env);
    if (!session) return sessionInvalid();

    const { subscription } = await request.json();
    if (!subscription?.endpoint) return jsonRes({ error: 'subscription ausente' }, 400);

    // O índice usado como chave é resolvido aqui, não mandado pelo cliente — fica
    // consistente com o valor que /webhook lê depois direto da task pra achar essa chave.
    const { nameToIdx } = await getSolicitanteMaps(env);
    const cuIdx = nameToIdx[session.name];
    if (cuIdx == null) return jsonRes({ error: 'não foi possível confirmar seu cadastro na ClickUp' }, 400);

    await env.SUBSCRIPTIONS.put(`u_${cuIdx}`, JSON.stringify(subscription));
    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ error: err.message }, 500);
  }
}

// =====================================================================
// /webhook — recebe evento taskStatusUpdated do ClickUp
// =====================================================================
async function handleWebhook(request, env) {
  try {
    const body = await request.json();

    if (body.event !== 'taskStatusUpdated') {
      return new Response('ignored', { status: 200 });
    }

    const taskId     = body.task_id;
    const newStatus  = (body.history_items?.[0]?.after?.status  ?? '').toLowerCase();
    const prevStatus = (body.history_items?.[0]?.before?.status ?? '').toLowerCase();

    // Busca detalhes da tarefa uma única vez (usada pela automação e pela notificação)
    const taskResp = await fetch(
      `https://api.clickup.com/api/v2/task/${taskId}`,
      { headers: { Authorization: env.CLICKUP_API_KEY } }
    );
    if (!taskResp.ok) return new Response('task fetch error', { status: 200 });
    const task = await taskResp.json();

    await runStatusAutomation(taskId, newStatus, prevStatus, task, env);

    const label = NOTIFY_STATUSES[newStatus];
    if (!label) return new Response(`status "${newStatus}" sem notificação`, { status: 200 });

    const cf      = task.custom_fields?.find(f => f.id === SOLICITANTE_FIELD_ID);
    const userIdx = cf?.value?.orderindex ?? cf?.value;

    if (userIdx == null) return new Response('sem solicitante', { status: 200 });

    const subJson = await env.SUBSCRIPTIONS.get(`u_${userIdx}`);
    if (!subJson)  return new Response(`sem subscription para user ${userIdx}`, { status: 200 });

    await sendWebPush(JSON.parse(subJson), JSON.stringify({
      title: 'Chamados de TI – ISV',
      body:  `"${task.name}" está agora: ${label}`,
      data:  { task_id: task.id, status: newStatus }
    }), env);

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('error: ' + err.message, { status: 500 });
  }
}

// =====================================================================
// AUTOMAÇÃO DE STATUS (migrado do Apps Script)
// "pendente"       -> marca início da pausa de SLA
// saiu de pendente -> empurra o due_date pelo tempo que ficou pausado
// "em atendimento" -> define start_date/due_date com base no time_estimate
// "encerrado"      -> calcula tempo decorrido e registra como time tracked
//
// LIMITAÇÃO CONHECIDA (pausa de SLA + dedup): o dedup abaixo é por
// taskId+status, com janela de 10min. Se uma tarefa for pra "pendente",
// saltar pra outro status e voltar pra "pendente" de novo dentro dessa
// janela de 10min, a segunda entrada em "pendente" é ignorada como
// duplicata — e o início dessa segunda pausa não é gravado. Resultado:
// o tempo da segunda pausa não é somado ao due_date depois. Cenário raro
// no uso real (exigiria trocas de status muito rápidas), então foi aceito
// como trade-off; se isso passar a importar, o dedup precisaria considerar
// a transição (prevStatus+status), não só o status final.
// =====================================================================
async function runStatusAutomation(taskId, status, prevStatus, task, env) {
  const saiuDePendente = prevStatus === 'pendente' && status !== 'pendente';
  const relevante = status === 'em atendimento' || status === 'encerrado' || status === 'pendente' || saiuDePendente;
  if (!relevante) return;

  // Dedup: evita reprocessar o mesmo taskId+status (webhooks podem duplicar entrega)
  const dedupKey = `processed_${taskId}_${status}`;
  if (await env.SUBSCRIPTIONS.get(dedupKey)) {
    console.log(`Automação ignorada (duplicada): ${taskId} -> ${status}`);
    return;
  }
  await env.SUBSCRIPTIONS.put(dedupKey, '1', { expirationTtl: 600 });

  const headers = { Authorization: env.CLICKUP_API_KEY, 'Content-Type': 'application/json' };

  try {
    if (status === 'pendente') {
      await env.SUBSCRIPTIONS.put(`pending_start_${taskId}`, String(Date.now()), { expirationTtl: 2592000 });
      console.log(`Automação: pausa de SLA iniciada (pendente) em ${taskId}`);
      return;
    }

    if (saiuDePendente) {
      const pendingStartStr = await env.SUBSCRIPTIONS.get(`pending_start_${taskId}`);
      if (pendingStartStr && task.due_date) {
        const pendingMs   = Date.now() - parseInt(pendingStartStr);
        const newDueDate  = Number(task.due_date) + pendingMs;
        await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ due_date: newDueDate, due_date_time: true })
        });
        console.log(`Automação: due_date adiado ${Math.round(pendingMs / 60000)}min (pausa em ${taskId})`);
      }
      await env.SUBSCRIPTIONS.delete(`pending_start_${taskId}`);
    }

    if (status === 'em atendimento') {
      const timeEstimate = task.time_estimate || DEFAULT_TIME_ESTIMATE_MS[task.priority?.priority];
      if (!timeEstimate) {
        console.log(`Automação: sem time_estimate em ${taskId} e sem padrão pra prioridade "${task.priority?.priority}", ignorando`);
        return;
      }

      const now = Date.now();
      await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          start_date:      now,
          start_date_time: true,
          due_date:        now + timeEstimate,
          due_date_time:   true
        })
      });
      console.log(`Automação: start_date/due_date definidos para ${taskId}`);
      return;
    }

    if (status === 'encerrado') {
      const startDate = task.start_date;
      if (!startDate) {
        console.log(`Automação: sem start_date em ${taskId}, ignorando`);
        return;
      }

      const now        = Date.now();
      const tempoGasto = now - parseInt(startDate);

      const timeResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/time`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ start: parseInt(startDate), end: now, time: tempoGasto })
      });

      if (timeResp.ok) {
        console.log(`Automação: tempo registrado para ${taskId} (${Math.round(tempoGasto / 60000)} min)`);
      } else {
        console.error(`Automação: erro ao registrar tempo em ${taskId}: ${await timeResp.text()}`);
      }
    }
  } catch (err) {
    console.error(`Automação: erro geral em ${taskId}: ${err.message}`);
  }
}

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
  const mainStmt = env.CHAMADOS_DB.prepare(
    `INSERT INTO chamados
      (id, name, description, status, priority, tipo, setor, solicitante, email, solucao,
       assignee_id, due_date, date_created, date_closed, start_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id, row.name, row.description, row.status, row.priority, row.tipo, row.setor,
    row.solicitante, row.email, row.solucao, row.assignee_id, row.due_date, row.date_created,
    row.date_closed, row.start_date, row.created_at, row.updated_at
  );
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
  await env.CHAMADOS_DB.batch([mainStmt, ...buildSetAssigneesStatements(env, row.id, assigneeIds)]);
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

// Mesmo shape de resposta de handleAdminMetrics (porStatus/porTipo/porSetor/sla/
// tempoMedioPorOperador) — de propósito, pra um dia trocar a fonte sem quebrar o
// contrato que admin.js já consome. nome vem null (D1 não guarda nome do operador,
// só o id) — o painel já resolve id->nome via OPERADORES no cliente de qualquer forma.
//
// tempoMedioPorOperador (B7 parte 2, fase 2, 2026-08-12): usa chamado_assignees, não
// mais só assignee_id — cada operador atribuído a um chamado encerrado recebe a
// duração INTEIRA, não dividida entre eles (mesma regra de handleAdminMetrics baseado
// na ClickUp, ver comentário lá — chamado com 2+ assignees não é bug, é o dado real).
async function d1GetMetrics(env) {
  const { results } = await env.CHAMADOS_DB.prepare(
    'SELECT id, status, tipo, setor, due_date, date_closed, start_date FROM chamados'
  ).all();
  const rows = results || [];

  const porStatus = {};
  const porTipo    = {};
  const porSetor   = {};
  let dentroDoSla = 0;
  let atrasado    = 0;
  const agora = Date.now();

  // chamados encerrados com duração válida (start_date + date_closed) — resolvidos em
  // lote depois do loop, junto com o(s) assignee(s) real(is) de cada um.
  const encerradosComDuracao = [];

  for (const r of rows) {
    porStatus[r.status] = (porStatus[r.status] || 0) + 1;
    if (r.tipo != null)  porTipo[r.tipo]   = (porTipo[r.tipo]   || 0) + 1;
    if (r.setor != null) porSetor[r.setor] = (porSetor[r.setor] || 0) + 1;

    if (r.due_date != null) {
      const referencia = (r.status === 'encerrado' && r.date_closed != null) ? r.date_closed : agora;
      if (referencia > r.due_date) atrasado++; else dentroDoSla++;
    }

    if (r.status === 'encerrado' && r.start_date != null && r.date_closed != null) {
      encerradosComDuracao.push({ id: r.id, duracaoMs: r.date_closed - r.start_date });
    }
  }

  const atendimentoPorOperador = {}; // id -> { somaMs, count }
  if (encerradosComDuracao.length) {
    const assigneesMap = await d1GetAssigneesMap(env, encerradosComDuracao.map(e => e.id));
    for (const { id, duracaoMs } of encerradosComDuracao) {
      for (const assigneeId of (assigneesMap.get(id) || [])) {
        const key = String(assigneeId);
        if (!atendimentoPorOperador[key]) atendimentoPorOperador[key] = { somaMs: 0, count: 0 };
        atendimentoPorOperador[key].somaMs += duracaoMs;
        atendimentoPorOperador[key].count  += 1;
      }
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
    sla: {
      dentroDoSla,
      atrasado,
      dentroDoSlaPercent: totalComSla ? Math.round((dentroDoSla / totalComSla) * 1000) / 10 : null,
      atrasadoPercent:    totalComSla ? Math.round((atrasado    / totalComSla) * 1000) / 10 : null,
    },
    tempoMedioPorOperador
  };
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
    ? 'SELECT name, ativo, created_at FROM solicitantes WHERE ativo = 1'
    : 'SELECT name, ativo, created_at FROM solicitantes';
  const { results } = await env.CHAMADOS_DB.prepare(sql).all();
  return (results || []).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function d1IsSolicitanteAtivo(env, name) {
  const row = await env.CHAMADOS_DB.prepare('SELECT ativo FROM solicitantes WHERE name = ?').bind(name).first();
  return !!row && row.ativo === 1;
}

// INSERT OR IGNORE — idempotente, mesmo padrão do resto da camada D1 (rodar a
// migração de novo, ou tentar cadastrar um nome que já existe, não duplica nem falha).
async function d1CreateSolicitante(env, name) {
  const result = await env.CHAMADOS_DB.prepare(
    'INSERT OR IGNORE INTO solicitantes (name, ativo, created_at) VALUES (?, 1, ?)'
  ).bind(name, Date.now()).run();
  return { inserted: (result.meta?.changes ?? 0) > 0 };
}

async function d1SetSolicitanteAtivo(env, name, ativo) {
  const result = await env.CHAMADOS_DB.prepare('UPDATE solicitantes SET ativo = ? WHERE name = ?')
    .bind(ativo ? 1 : 0, name).run();
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
  if (!name) return jsonRes({ error: 'nome é obrigatório' }, 400);

  const { inserted } = await d1CreateSolicitante(env, name);
  if (!inserted) return jsonRes({ error: 'já existe um solicitante com esse nome' }, 409);
  return jsonRes({ ok: true, name });
}

async function handleAdminSetSolicitanteAtivo(request, env, name) {
  if (!(await isAdmin(request, env))) return unauthorized();
  let body;
  try { body = await request.json(); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  if (typeof body.ativo !== 'boolean') return jsonRes({ error: '"ativo" precisa ser true ou false' }, 400);

  const { updated } = await d1SetSolicitanteAtivo(env, decodeURIComponent(name), body.ativo);
  if (!updated) return jsonRes({ error: 'solicitante não encontrado' }, 404);
  return jsonRes({ ok: true });
}

// =====================================================================
// POST /admin/migrate-solicitantes — migração de uso único (Fase M1): copia a lista
// de nomes que hoje vive só na ClickUp (mesmo campo/mesma função que GET /api/field já
// usava) pra tabela `solicitantes` do D1. Idempotente (d1CreateSolicitante usa INSERT
// OR IGNORE) — rodar de novo não duplica, só marca como "skipped" quem já migrou.
// =====================================================================
async function handleAdminMigrateSolicitantes(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  const { idxToName } = await getSolicitanteMaps(env);
  const nomes = Object.values(idxToName);

  let migrated = 0, skipped = 0;
  for (const name of nomes) {
    const { inserted } = await d1CreateSolicitante(env, name);
    if (inserted) migrated++; else skipped++;
  }
  return jsonRes({ total: nomes.length, migrated, skipped });
}

// =====================================================================
// POST /admin/migrate-d1 — Fase B3 do roadmap (migração de histórico, 2026-08-11).
// Só leitura na ClickUp (fetchAllTasks, mesma função que /admin/tasks já usa) + escrita
// no D1 — não muda NADA em produção, já que nenhuma rota lê do D1 ainda. Protegido por
// ADMIN_SECRET, mesmo padrão das outras rotas /admin/*.
//
// Idempotente: usa INSERT OR IGNORE com o próprio task_id da ClickUp como id no D1 (só
// pras linhas migradas — chamados criados depois direto no D1, quando existirem, usam
// UUID via d1CreateChamado) — rodar de novo não duplica nem falha, só marca como
// "skipped" o que já tinha sido migrado antes.
//
// Aceita { "dryRun": true } no corpo pra simular sem gravar nada — mapeia/valida todas as
// tasks e devolve a mesma contagem que uma migração de verdade daria, sem tocar no D1.
//
// Falha por task individual não derruba a migração inteira (mesmo espírito de
// handleAdminUpdateTask reportando "updated" parcial) — cada erro vai pra "errors",
// identificado pelo id/nome da task, migração continua pras próximas.
// =====================================================================

function mapClickUpTaskToD1(task, idxToName) {
  const statusRaw = (task.status?.status || '').toLowerCase();
  if (!VALID_STATUSES.includes(statusRaw)) {
    throw new Error(`status fora do esperado: "${task.status?.status}"`);
  }

  // Fase B7 (2026-08-12): os 269 chamados de antes do app existir (2026-01 a metade de
  // 2026-05, quando o campo SOLICITANTE nem existia/não era preenchido — ver CLAUDE.md,
  // "Fase B3") agora migram mesmo assim, com solicitante = '' (string vazia, não NULL —
  // a coluna é NOT NULL no schema). Decisão tomada em 2026-08-11: prioriza ter o
  // histórico completo num lugar só sobre a praticidade de não aparecerem em "meus
  // chamados" de ninguém (não têm dono mesmo, não é bug perder essa associação).
  const solicitanteIdx  = cfValue(task, SOLICITANTE_FIELD_ID);
  const solicitanteName = (solicitanteIdx != null ? idxToName[solicitanteIdx] : null) || '';

  // Fase B7 (2026-08-12, mesmo dia): os 12 chamados bem antigos que ainda faltavam
  // migrar tinham TIPO e SETOR ausentes (nenhum custom_fields preenchido — não é bug,
  // são tasks de antes desses campos serem obrigatórios no formulário). Mesmo
  // tratamento do SOLICITANTE acima: migra com null em vez de virar erro, pra ter o
  // histórico completo — mas aqui pode ser NULL de verdade (não string vazia), porque
  // a coluna já não tem NOT NULL (ver d1/schema.sql). Investigado antes de mudar: a
  // prioridade dessas 12 tasks está presente normalmente, só tipo/setor faltam mesmo.
  const tipoIdx  = cfValue(task, TIPO_FIELD_ID);
  const setorIdx = cfValue(task, SETOR_FIELD_ID);

  const priorityName = task.priority?.priority;
  const priority = PRIORITY_NAME_TO_NUM[priorityName];
  if (!priority) throw new Error(`prioridade ausente/desconhecida: "${priorityName}"`);

  return {
    id:           task.id,
    name:         task.name,
    description:  task.description || task.text_content || null,
    status:       statusRaw,
    priority,
    tipo:         tipoIdx  != null ? Number(tipoIdx)  : null,
    setor:        setorIdx != null ? Number(setorIdx) : null,
    solicitante:  solicitanteName,
    email:        cfValue(task, EMAIL_FIELD_ID),
    solucao:      cfValue(task, SOLUCAO_FIELD_ID),
    assignee_id:  task.assignees?.[0]?.id ?? null,
    // Suporte a múltiplos operadores (B7 parte 2, fase 1) — array completo, não só o
    // primeiro. `assignee_id` acima continua existindo à parte (coluna já em uso por
    // GET /api/my-tasks) — este campo alimenta a tabela chamado_assignees.
    assignee_ids: (task.assignees || []).map(a => a.id),
    due_date:     task.due_date    != null ? Number(task.due_date)    : null,
    date_created: task.date_created != null ? Number(task.date_created) : Date.now(),
    date_closed:  task.date_closed != null ? Number(task.date_closed)  : null,
    start_date:   task.start_date  != null ? Number(task.start_date)   : null,
  };
}

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

async function d1MigrateChamado(env, data) {
  const now = Date.now();
  const result = await env.CHAMADOS_DB.prepare(
    `INSERT OR IGNORE INTO chamados
      (id, name, description, status, priority, tipo, setor, solicitante, email, solucao,
       assignee_id, due_date, date_created, date_closed, start_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    data.id, data.name, data.description, data.status, data.priority, data.tipo, data.setor,
    data.solicitante, data.email, data.solucao, data.assignee_id, data.due_date, data.date_created,
    data.date_closed, data.start_date, now, now
  ).run();
  // Sempre sincroniza os operadores, mesmo quando o INSERT acima foi ignorado (chamado
  // já existia) — é assim que rodar a migração de novo também BACKFILLA o 2º+ operador
  // dos chamados que já estavam no D1 antes desta tabela existir (ela só guardava o
  // primeiro até aqui). d1SetAssignees já é 1 subrequest só (.batch()) — total de 2
  // subrequests/linha nesta função (INSERT + batch), bem abaixo do teto mesmo pros 453.
  if (data.assignee_ids !== undefined) {
    await d1SetAssignees(env, data.id, data.assignee_ids);
  }
  return { inserted: (result.meta?.changes ?? 0) > 0 };
}

async function handleAdminMigrateD1(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  let body = {};
  const text = await request.text();
  if (text) {
    try { body = JSON.parse(text); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  }
  const dryRun = body.dryRun === true;

  const { tasks, truncated } = await fetchAllTasks(env);
  const { idxToName } = await getSolicitanteMaps(env);

  let migrated = 0, skipped = 0;
  const errors = [];

  for (const task of tasks) {
    let mapped;
    try {
      mapped = mapClickUpTaskToD1(task, idxToName);
    } catch (err) {
      errors.push({ id: task.id, name: task.name, reason: err.message });
      continue;
    }
    if (dryRun) { migrated++; continue; }
    try {
      const result = await d1MigrateChamado(env, mapped);
      if (result.inserted) migrated++; else skipped++;
    } catch (err) {
      errors.push({ id: task.id, name: task.name, reason: err.message });
    }
  }

  return jsonRes({ dryRun, total: tasks.length, migrated, skipped, errors, truncated });
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

  return new Response(obj.body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': obj.contentType || 'application/octet-stream' },
  });
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

// =====================================================================
// POST /admin/migrate-anexos — migração de uso único dos anexos históricos da
// ClickUp pro R2 (Fase M2, 2026-08-13). O MAIOR RISCO TÉCNICO da migração inteira
// (volume desconhecido de anexos, arquivos grandes, teto de subrequests por
// invocação do Worker — ver o achado de 2026-08-12 sobre `.batch()`) — por isso
// PAGINADA desde o início (aceita { offset, limit } no corpo), em vez de tentar
// processar tudo numa invocação só e descobrir o estouro na hora, como aconteceu
// antes com o backfill de chamado_assignees. Idempotente: confere se já existe uma
// linha pra aquele chamado_id+filename antes de baixar/subir de novo.
//
// `fetchAllTasks` não devolve `attachments` (só a lista de tasks) — precisa de 1
// GET /task/:id por task pra saber se ela tem anexo, daí o teto de `limit` baixo
// por padrão (cada task nesse range já custa 1 subrequest só pra checar).
//
// 🛡️ Achado real rodando em produção (2026-08-13, mesmo dia): o teto de subrequests
// por invocação do Worker é BEM menor do que os "~1000 no plano pago" documentados
// em 2026-08-12 pro backfill de chamado_assignees — `limit:50` (padrão inicial desta
// rota) estourava consistentemente ANTES de terminar o lote, com o erro real da
// Cloudflare "Too many subrequests by single Worker invocation" (nota: mensagem
// "subrequests", diferente da variante "API requests" vista no achado de 2026-08-12 —
// mesma causa raiz, mensagem um pouco diferente). Pior ainda: uma vez estourado, TODO
// o resto do lote falhava também (inclusive o `GET /task/:id` que só checa se a task
// TEM anexo) — ou seja, tasks que nem tinham anexo apareciam como "erro", não como
// "sem anexo". `limit:5` rodou os 455 chamados reais (91 chamadas) com ZERO erros.
// Conclusão prática: não confiar em "~1000" como orçamento de subrequests pra
// qualquer migração futura neste projeto — testar empiricamente com lotes pequenos
// primeiro. Corrigido reduzindo o padrão daqui pra 5 (comprovado em produção).
// =====================================================================
async function handleAdminMigrateAnexos(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  let body = {};
  const text = await request.text();
  if (text) {
    try { body = JSON.parse(text); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }
  }
  const offset = Number.isInteger(body.offset) ? body.offset : 0;
  const limit  = Number.isInteger(body.limit) ? body.limit : 5;

  const { tasks, truncated } = await fetchAllTasks(env);
  const slice = tasks.slice(offset, offset + limit);

  let tasksComAnexo = 0, migrated = 0, skipped = 0;
  const errors = [];

  for (const task of slice) {
    try {
      const detailResp = await fetch(`https://api.clickup.com/api/v2/task/${task.id}`, {
        headers: { Authorization: env.CLICKUP_API_KEY }
      });
      if (!detailResp.ok) {
        errors.push({ id: task.id, name: task.name, reason: `GET task falhou: ${detailResp.status}` });
        continue;
      }
      const detail = await detailResp.json();
      const attachments = detail.attachments || [];
      if (!attachments.length) continue;
      tasksComAnexo++;

      for (const att of attachments) {
        const filename = att.title || att.name || 'arquivo';
        try {
          const already = await env.CHAMADOS_DB.prepare(
            'SELECT id FROM chamado_anexos WHERE chamado_id = ? AND filename = ?'
          ).bind(task.id, filename).first();
          if (already) { skipped++; continue; }

          const fileResp = await fetch(att.url);
          if (!fileResp.ok) {
            errors.push({ id: task.id, name: task.name, reason: `download do anexo "${filename}" falhou: ${fileResp.status}` });
            continue;
          }
          const contentType = fileResp.headers.get('Content-Type') || 'application/octet-stream';
          const { key, size } = await r2UploadAnexo(env, task.id, filename, contentType, fileResp.body);
          await env.CHAMADOS_DB.prepare(
            'INSERT INTO chamado_anexos (id, chamado_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(crypto.randomUUID(), task.id, key, filename, contentType, size, Date.now()).run();
          migrated++;
        } catch (err) {
          errors.push({ id: task.id, name: task.name, reason: `"${filename}": ${err.message}` });
        }
      }
    } catch (err) {
      errors.push({ id: task.id, name: task.name, reason: err.message });
    }
  }

  const nextOffset = offset + slice.length;
  return jsonRes({
    totalTasks: tasks.length, offset, limit, processedTasks: slice.length,
    tasksComAnexo, migrated, skipped, errors,
    hasMore: nextOffset < tasks.length, nextOffset,
    truncated,
  });
}

// =====================================================================
// AUTOMAÇÃO DE SLA/PUSH EMBUTIDA — D1 (Fase B5 do roadmap de modernização,
// 2026-08-11 — ver CLAUDE.md "Decisões técnicas tomadas")
//
// Mesma automação de runStatusAutomation (acima), reescrita pra não depender do
// webhook da automação da ClickUp — chamar esta função já basta, tudo embutido
// na própria mudança de status. ⚠️ NADA nas rotas usa isto ainda (mesmo espírito
// das Fases B2/B4) — é a peça que falta pra um dia (Fase B7) o D1 não precisar
// mais da automação configurada na ClickUp pra funcionar.
//
// Diferenças deliberadas em relação ao original, não são bug:
// - Sem dedup (processed_<id>_<status> no original): aquele dedup existe só
//   porque o webhook da ClickUp pode entregar o mesmo evento mais de uma vez.
//   Aqui não tem webhook nenhum — esta função só roda quando ALGUÉM chama ela
//   direto (uma vez por mudança de status), então a duplicata que o dedup
//   evitava não pode acontecer nesse desenho.
// - "encerrado" sempre grava date_closed, mesmo sem start_date (chamado que
//   pula "em atendimento" e vai direto pra "encerrado"). O original pulava o
//   registro de tempo nesse caso porque dependia de start_date pra calcular a
//   duração pra API de time-tracking da ClickUp — o D1 não tem equivalente
//   disso (a duração já é só date_closed - start_date, calculada sob demanda
//   em d1GetMetrics, que já ignora quando start_date falta).
// - Push embutido na mesma função (não um passo separado) — ainda resolve a
//   inscrição pelo orderindex da ClickUp (getSolicitanteMaps + sendWebPush, os
//   dois já existentes), porque é assim que handleSubscribe grava a chave hoje;
//   isso não muda nesta fase. Falha ao enviar push nunca derruba a mudança de
//   status (fica num try/catch próprio) — igual ao original, que já mandava a
//   automação em separado de qualquer jeito.
// =====================================================================
async function d1TransitionStatus(env, chamadoId, novoStatus) {
  if (!VALID_STATUSES.includes(novoStatus)) {
    throw new Error(`status inválido: ${novoStatus}`);
  }
  const chamado = await d1GetChamado(env, chamadoId);
  if (!chamado) throw new Error('chamado não encontrado no D1');

  const prevStatus     = chamado.status;
  const saiuDePendente = prevStatus === 'pendente' && novoStatus !== 'pendente';
  const patch = { status: novoStatus };

  if (novoStatus === 'pendente') {
    await env.SUBSCRIPTIONS.put(`d1_pending_start_${chamadoId}`, String(Date.now()), { expirationTtl: 2592000 });
  } else if (saiuDePendente) {
    const pendingStartStr = await env.SUBSCRIPTIONS.get(`d1_pending_start_${chamadoId}`);
    if (pendingStartStr && chamado.due_date != null) {
      patch.dueDate = chamado.due_date + (Date.now() - parseInt(pendingStartStr, 10));
    }
    await env.SUBSCRIPTIONS.delete(`d1_pending_start_${chamadoId}`);
  }

  if (novoStatus === 'em atendimento') {
    const now = Date.now();
    patch.startDate = now;
    const timeEstimate = DEFAULT_TIME_ESTIMATE_MS_BY_PRIORITY[chamado.priority];
    if (timeEstimate) patch.dueDate = now + timeEstimate;
  }

  if (novoStatus === 'encerrado') {
    patch.dateClosed = Date.now();
  }

  const updated = await d1UpdateChamado(env, chamadoId, patch);

  const label = NOTIFY_STATUSES[novoStatus];
  if (label) {
    try {
      const { nameToIdx } = await getSolicitanteMaps(env);
      const idx = nameToIdx[chamado.solicitante];
      if (idx != null) {
        const subJson = await env.SUBSCRIPTIONS.get(`u_${idx}`);
        if (subJson) {
          await sendWebPush(JSON.parse(subJson), JSON.stringify({
            title: 'Chamados de TI – ISV',
            body:  `"${chamado.name}" está agora: ${label}`,
            data:  { task_id: chamadoId, status: novoStatus }
          }), env);
        }
      }
    } catch (err) {
      console.error(`d1TransitionStatus: falha ao enviar push pra ${chamadoId}: ${err.message}`);
    }
  }

  return updated;
}

export { d1CreateChamado, d1GetChamado, d1ListChamados, d1UpdateChamado, d1GetMetrics, r2UploadAnexo, r2GetAnexo, r2DeleteAnexo, d1TransitionStatus, d1SetAssignees, d1ListSolicitantes, d1IsSolicitanteAtivo, d1CreateSolicitante, d1SetSolicitanteAtivo, d1ListAnexos, d1GetAnexoRow };
