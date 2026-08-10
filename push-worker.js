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
// FIELD_IDS.SOLUCAO em app.js
const LIST_ID               = '901324490220';
const SOLICITANTE_FIELD_ID  = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const TIPO_FIELD_ID         = '47e475fe-e911-40cd-b4a2-23625fbf57f1';
const SETOR_FIELD_ID        = 'c1ca88de-4b01-4933-93ff-24494bed59e2';
const SOLUCAO_FIELD_ID      = '16144175-845e-4e3c-baaa-a2517325cd43';
const VAPID_SUBJECT         = 'mailto:henrique.krvalho@gmail.com';

// ⚠️ Mantenha sincronizado com as chaves de STATUS_MAP em app.js (que por sua vez precisam
// ficar iguais a NOTIFY_STATUSES, ver abaixo) — usado por handleAdminUpdateTask pra validar
// o status recebido do painel de admin antes de mandar pra ClickUp.
const VALID_STATUSES = ['aberto', 'em atendimento', 'pendente', 'encerrado'];

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
    }

    if (request.method === 'GET') {
      if (pathname === '/api/field')     return handleGetField(request, env);
      if (pathname === '/api/my-tasks')  return handleGetMyTasks(request, env);
      if (pathname === '/admin/users')   return handleAdminListUsers(request, env);
      if (pathname === '/admin/tasks')   return handleAdminListTasks(request, env);
      if (pathname === '/admin/metrics') return handleAdminMetrics(request, env);
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

// Substitui o antigo GET /api/tasks (sem filtro nenhum, que devolvia TODO MUNDO pra
// qualquer um com o secret do app). Agora sempre escopado pra quem está logado — o
// filtro é decidido aqui dentro, o cliente não escolhe mais de quem são os chamados.
async function handleGetMyTasks(request, env) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  const { nameToIdx, idxToName } = await getSolicitanteMaps(env);
  const cuIdx = nameToIdx[session.name];

  // Só cai no fallback (buscar TODA a lista e filtrar aqui dentro) quando o nome da sessão
  // nem existe no campo SOLICITANTE agora — isso sim é divergência de verdade. Zero chamados
  // filtrados NÃO entra mais nessa condição: é o caso normal de colaborador novo sem nenhum
  // chamado ainda, e isso ia disparar 2 chamadas extra à API da ClickUp a cada poll de 60s
  // pra cada pessoa nessa situação — pesado justo na semana de rollout, quando é a maioria.
  if (cuIdx == null) {
    const params = new URLSearchParams({ order_by: 'created', reverse: 'true', include_closed: 'true', page: '0' });
    const upstream = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?${params}`, {
      headers: { Authorization: env.CLICKUP_API_KEY }
    });
    const data = await upstream.json();
    const tasks = (data.tasks || []).filter(t => {
      const cf = t.custom_fields?.find(f => f.id === SOLICITANTE_FIELD_ID);
      const v  = cf?.value?.orderindex ?? cf?.value;
      return idxToName[v] === session.name;
    });
    return jsonRes({ tasks });
  }

  const cf     = JSON.stringify([{ field_id: SOLICITANTE_FIELD_ID, operator: '=', value: cuIdx }]);
  const params = new URLSearchParams({ order_by: 'created', reverse: 'true', include_closed: 'true', page: '0', custom_fields: cf });
  const upstream = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?${params}`, {
    headers: { Authorization: env.CLICKUP_API_KEY }
  });
  const data = await upstream.json();
  return jsonRes({ tasks: data.tasks || [] });
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

  return new Response(text, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function handleCreateTask(request, env) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  let payload;
  try { payload = JSON.parse(await request.text()); } catch { return jsonRes({ error: 'corpo inválido' }, 400); }

  // Nunca confia no valor de SOLICITANTE que o cliente mandou — troca pelo da sessão
  // autenticada. É isso que impede alguém de abrir um chamado "como" outra pessoa.
  const { nameToIdx } = await getSolicitanteMaps(env);
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
  return passthrough(upstream);
}

async function handleUploadAttachment(request, env, taskId) {
  const session = await requireSession(request, env);
  if (!session) return sessionInvalid();

  // Mesma checagem de dono que handleGetTask já faz — sem isso, qualquer pessoa logada
  // conseguia anexar arquivo no chamado de outra só sabendo/adivinhando o ID.
  const taskResp = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    headers: { Authorization: env.CLICKUP_API_KEY }
  });
  if (!taskResp.ok) return passthrough(taskResp);
  const task = await taskResp.json();
  const { idxToName } = await getSolicitanteMaps(env);
  const cf = task.custom_fields?.find(f => f.id === SOLICITANTE_FIELD_ID);
  const v  = cf?.value?.orderindex ?? cf?.value;
  if (idxToName[v] !== session.name) return unauthorized('sem permissão pra anexar nesse chamado');

  const upstream = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
    method: 'POST',
    headers: {
      Authorization: env.CLICKUP_API_KEY,
      'Content-Type': request.headers.get('Content-Type') || ''
    },
    body: request.body
  });
  return passthrough(upstream);
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
// /admin/tasks — todos os chamados da lista, com filtros opcionais via query string
// (status, setor, tipo, operador, solicitante). Protegido por ADMIN_SECRET, mesmo
// padrão de /admin/users. "setor"/"tipo" são o orderindex numérico (o mesmo valor
// gravado no custom field — ver SETORES/TIPOS em app.js pra mapear pra nome);
// "operador" é o id do assignee na ClickUp (ver OPERADORES em app.js); "solicitante"
// é o nome (resolvido aqui pro orderindex real via getSolicitanteMaps, igual o resto
// do arquivo já faz — nunca comparamos nome direto contra o índice guardado na task).
// =====================================================================
async function handleAdminListTasks(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  const { searchParams } = new URL(request.url);
  const statusFilter      = searchParams.get('status');
  const setorFilter       = searchParams.get('setor');
  const tipoFilter        = searchParams.get('tipo');
  const operadorFilter    = searchParams.get('operador');
  const solicitanteFilter = searchParams.get('solicitante');

  let solicitanteIdx = null;
  if (solicitanteFilter) {
    const { nameToIdx } = await getSolicitanteMaps(env);
    solicitanteIdx = nameToIdx[solicitanteFilter];
    if (solicitanteIdx == null) return jsonRes({ total: 0, tasks: [] });
  }

  const { tasks, truncated } = await fetchAllTasks(env);
  const filtered = tasks.filter(t => {
    if (statusFilter && (t.status?.status || '').toLowerCase() !== statusFilter.toLowerCase()) return false;
    if (operadorFilter && !(t.assignees || []).some(a => String(a.id) === operadorFilter)) return false;
    if (setorFilter && String(cfValue(t, SETOR_FIELD_ID)) !== setorFilter) return false;
    if (tipoFilter && String(cfValue(t, TIPO_FIELD_ID)) !== tipoFilter) return false;
    if (solicitanteFilter && Number(cfValue(t, SOLICITANTE_FIELD_ID)) !== Number(solicitanteIdx)) return false;
    return true;
  });

  return jsonRes({ total: filtered.length, tasks: filtered, truncated });
}

// =====================================================================
// /admin/metrics — agregados pro painel de admin: total por status, tempo médio de
// atendimento por operador (duração real "em atendimento" -> "encerrado", pelos
// timestamps start_date/date_closed da própria task), % dentro do SLA vs atrasado
// (comparando due_date com date_closed pra encerrados, ou com "agora" pra tasks
// ainda abertas — mesma lógica informativa que o app.js já usa no cliente) e volume
// por tipo/setor (chaves = orderindex, mapear pro nome no painel via TIPOS/SETORES
// de app.js). Protegido por ADMIN_SECRET, mesmo padrão de /admin/users.
// =====================================================================
async function handleAdminMetrics(request, env) {
  if (!(await isAdmin(request, env))) return unauthorized();

  const { tasks, truncated } = await fetchAllTasks(env);

  const porStatus = {};
  const porTipo   = {};
  const porSetor  = {};
  const atendimentoPorOperador = {}; // id -> { nome, somaMs, count }
  let dentroDoSla = 0;
  let atrasado    = 0;

  for (const t of tasks) {
    const status = (t.status?.status || '').toLowerCase();
    porStatus[status] = (porStatus[status] || 0) + 1;

    const tipoIdx = cfValue(t, TIPO_FIELD_ID);
    if (tipoIdx != null) porTipo[tipoIdx] = (porTipo[tipoIdx] || 0) + 1;

    const setorIdx = cfValue(t, SETOR_FIELD_ID);
    if (setorIdx != null) porSetor[setorIdx] = (porSetor[setorIdx] || 0) + 1;

    if (t.due_date) {
      const dueDate    = Number(t.due_date);
      const referencia = (status === 'encerrado' && t.date_closed) ? Number(t.date_closed) : Date.now();
      if (referencia > dueDate) atrasado++; else dentroDoSla++;
    }

    if (status === 'encerrado' && t.start_date && t.date_closed) {
      const duracaoMs = Number(t.date_closed) - Number(t.start_date);
      // Chamado com 2+ assignees: cada um recebe a duração INTEIRA, não uma fração dividida
      // entre eles — decisão deliberada (cada operador atribuído "esteve no chamado" o tempo
      // todo, não meio-a-meio), não é bug.
      for (const a of (t.assignees || [])) {
        const key = String(a.id);
        if (!atendimentoPorOperador[key]) {
          atendimentoPorOperador[key] = { nome: a.username || null, somaMs: 0, count: 0 };
        }
        atendimentoPorOperador[key].somaMs += duracaoMs;
        atendimentoPorOperador[key].count  += 1;
      }
    }
  }

  const tempoMedioPorOperador = {};
  for (const [id, dado] of Object.entries(atendimentoPorOperador)) {
    tempoMedioPorOperador[id] = {
      nome: dado.nome,
      mediaMs: Math.round(dado.somaMs / dado.count),
      totalChamados: dado.count
    };
  }

  const totalComSla = dentroDoSla + atrasado;
  return jsonRes({
    total: tasks.length,
    truncated,
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
  });
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
