'use strict';
// Testes do push-worker.js — foco na autenticação e no isolamento entre solicitantes
// (o motivo de tudo isso existir: ninguém pode ver/criar chamado como outra pessoa).
// Sem dependências: usa import() nativo + fetch/Response do Node. Mocka fetch e o KV —
// NUNCA toca na API real da ClickUp. Rodar com `node tests/push-worker.test.js`.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

// Mesmo adaptador de tests/d1-layer.test.js (imita a interface do binding D1 da
// Cloudflare por cima de node:sqlite) — usado aqui só nos testes de POST /admin/migrate-d1.
function makeD1FromSqlite(db) {
  return {
    prepare(sql) {
      let boundParams = [];
      const stmt = {
        bind(...params) { boundParams = params; return stmt; },
        async run() {
          const info = db.prepare(sql).run(...boundParams);
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        },
        async first() {
          const row = db.prepare(sql).get(...boundParams);
          return row === undefined ? null : row;
        },
        async all() {
          return { results: db.prepare(sql).all(...boundParams), success: true };
        },
        _sql: sql,
        _params: () => boundParams,
      };
      return stmt;
    },
    // Mesmo adaptador de .batch() de tests/d1-layer.test.js — ver comentário lá.
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await db.prepare(stmt._sql).run(...stmt._params()));
      }
      return results.map(info => ({ success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }));
    },
  };
}
function freshD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
  return makeD1FromSqlite(db);
}

const SOLICITANTE_FIELD_ID = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const TIPO_FIELD_ID = '47e475fe-e911-40cd-b4a2-23625fbf57f1';
const SETOR_FIELD_ID = 'c1ca88de-4b01-4933-93ff-24494bed59e2';
const MAX_ANEXO_BYTES = 10 * 1024 * 1024; // mesmo valor de push-worker.js (Fase M2)
// Data fixa (não Date.now()) pra métricas/SLA ficarem determinísticas nos testes de
// /admin/metrics — usada por seedChamadoComId('task-michael-1', ...) mais abaixo. Fase
// M5 (2026-08-13): até aqui isso vivia num FAKE_TASKS/FAKE_OPTIONS no formato bruto da
// ClickUp, usado como resposta de um mock de fetch — removido junto com
// fetchAllTasks/getSolicitanteMaps/as rotas de migração (produção não lê mais nada da
// ClickUp). Os valores de task-michael-1/task-ariele-1 continuam os mesmos de sempre,
// só que gravados direto no D1 agora (ver seedChamadoComId, dentro do IIFE abaixo).
const FAKE_DUE_DATE_MICHAEL = 1700000000000;

function makeMockKV() {
  const store = new Map();
  return {
    get: async k => (store.has(k) ? store.get(k) : null),
    // O KV real da Cloudflare rejeita expirationTtl < 60 com erro 400 — reproduzido aqui
    // de propósito (incidente 2026-08-10: um mock que ignorava isso deixou passar sem
    // nenhum teste falhar um throttle_create_ com expirationTtl:10, que quebrava toda
    // criação de chamado em produção — o mock antigo nunca teria pego esse bug).
    put: async (k, v, opts) => {
      if (opts && opts.expirationTtl !== undefined && opts.expirationTtl < 60) {
        throw new Error(`KV PUT failed: 400 Invalid expiration_ttl of ${opts.expirationTtl}. Expiration TTL must be at least 60.`);
      }
      store.set(k, v);
    },
    delete: async k => store.delete(k),
    // Mock simplificado do KV.list({prefix}) real da Cloudflare — sem paginação (nosso volume é pequeno).
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  };
}

// Mock em memória do binding R2 (Fase M2, 2026-08-13) — mesmo padrão de makeMockR2 em
// tests/r2-layer.test.js. Aceita string/Uint8Array/ReadableStream no `put` (handleUpload
// Attachment/handleAdminMigrateAnexos passam `file.stream()`/`fileResp.body`, streams de
// verdade, direto pro R2 real).
async function toBytesR2(body) {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  }
  throw new Error('mock R2 só aceita string/Uint8Array/ReadableStream nos testes');
}
function makeMockR2() {
  const store = new Map();
  return {
    _store: store,
    async put(key, body, options) {
      const bytes = await toBytesR2(body);
      store.set(key, { bytes, httpMetadata: options?.httpMetadata || {} });
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { key, size: entry.bytes.byteLength, httpMetadata: entry.httpMetadata, body: entry.bytes };
    },
    async delete(key) { store.delete(key); },
  };
}

function req(method, path, { body, headers = {} } = {}) {
  return new Request('https://worker.local' + path, { method, headers, body });
}

// Login por e-mail (2026-09-16) — e-mail sintético e determinístico pra cada nome
// de teste, só pra bater name<->email nos testes (não representa e-mail real de
// ninguém). Usado tanto pra semear `solicitantes.email` (d1CreateSolicitante)
// quanto no corpo de /auth/register e /auth/login.
function emailFor(nome) {
  return nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') + '@institutosaovicente.com.br';
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { failed++; console.log(`FAIL  - ${name}\n        ${err.message}`); }
}

(async () => {
  const workerPath = pathToFileURL(path.join(__dirname, '..', 'push-worker.js')).href;
  const { default: worker, d1GetChamado, d1SetAssignees, d1CreateSolicitante, d1ListAnexos, d1CreateChamado, d1ListEventos, competenciaAtual, alertarSla } = await import(workerPath);

  // Regra de 2026-11-24: todo chamado nasce com exatamente um operador. Os testes antigos criam
  // chamado sem se importar com isso, então este adaptador completa o corpo com o Everson quando
  // o teste não mandou atendente. Os testes da regra em si usam o header X-Test-Raw (sem adaptar).
  const fetchReal = worker.fetch.bind(worker);
  worker.fetch = async (request, env2, ctx) => {
    const p = new URL(request.url).pathname;
    if (request.method === 'POST' && (p === '/api/tasks' || p === '/admin/tasks') && !request.headers.get('X-Test-Raw')) {
      try {
        const corpo = JSON.parse(await request.clone().text());
        if (corpo && typeof corpo === 'object') {
          if (p === '/api/tasks' && corpo.assignees === undefined) corpo.assignees = [200498355];
          if (p === '/admin/tasks' && corpo.assigneeId === undefined) corpo.assigneeId = 200498355;
          request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(corpo) });
        }
      } catch { /* corpo inválido: deixa o Worker responder */ }
    }
    return fetchReal(request, env2, ctx);
  };

  // Fase M5 (2026-08-13, migração de saída da ClickUp): push-worker.js não chama mais
  // `fetch()` pra `api.clickup.com` em NENHUMA rota — este mock vira um guarda-costas
  // que quebra alto (em vez de silenciosamente bater na rede real) se algum código
  // algum dia voltar a tentar. Antes disso, esta função simulava `GET /list/:id/field`,
  // `GET /task/:id` e `GET /list/:id/task` pra alimentar getSolicitanteMaps/
  // fetchAllTasks/handleGetTask/as rotas de migração — todas removidas nesta fase.
  //
  // Exceção deliberada (feature de alerta de chamado novo, 2026-08-13): chamadas pra
  // `https://fake-push-endpoint.test/*` são o endpoint de push simulado que
  // `notifyAdminsNovoChamado`/`sendWebPush` de fato precisam chamar de verdade — não é
  // ClickUp, é o "serviço de push" do navegador (mockado aqui do mesmo jeito que
  // tests/d1-layer.test.js já faz pra `d1TransitionStatus`). `failingPushEndpoints`
  // (mapa url->status, populado por teste) permite simular subscription morta (404/410)
  // pra um endpoint específico sem afetar os outros.
  const adminPushCalls = [];
  const failingPushEndpoints = new Map();
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://fake-push-endpoint.test/')) {
      adminPushCalls.push({ url: u, headers: opts?.headers });
      if (failingPushEndpoints.has(u)) return new Response('endpoint fora do ar', { status: failingPushEndpoints.get(u) });
      return new Response('', { status: 201 });
    }
    throw new Error(`teste tentou chamar fetch('${u}') de verdade — push-worker.js não deveria mais fazer nenhuma chamada à ClickUp`);
  };

  // Par VAPID descartável só pra createVapidJwt (dentro de sendWebPush) não falhar ao
  // assinar — mesma técnica de tests/d1-layer.test.js (crypto.subtle nativo, sem
  // dependência nova). VAPID_PUBLIC_KEY não precisa bater criptograficamente com nada
  // pro teste — só vai literal no header Authorization, que o mock acima não valida.
  const vapidKeyPairAdmin = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapidPrivateJwkAdmin = JSON.stringify(await crypto.subtle.exportKey('jwk', vapidKeyPairAdmin.privateKey));

  const env = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1(), ANEXOS: makeMockR2(), VAPID_PRIVATE_JWK: vapidPrivateJwkAdmin, VAPID_PUBLIC_KEY: 'fake-vapid-public-key' };
  const SECRET_HEADERS = { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'Content-Type': 'application/json' };
  let brunoToken; // Bruno nunca erra senha nem esbarra em throttle — usado pra testes que precisam de uma sessão "limpa"

  // Fase M5: `d1MigrateChamado` (que a produção usava pra gravar com um id específico,
  // o task_id da ClickUp) foi removida do push-worker.js — produção sempre usa
  // `d1CreateChamado` agora (UUID próprio). Este arquivo, porém, ainda referencia ids
  // fixos e conhecidos (task-michael-1, etc.) em dezenas de asserts — helper local só
  // pra popular fixtures com id escolhido, sem reescrever o arquivo inteiro.
  async function seedChamadoComId(targetEnv, id, data) {
    const now = Date.now();
    await targetEnv.CHAMADOS_DB.prepare(
      `INSERT INTO chamados
        (id, name, description, status, priority, tipo, setor, solicitante, email, solucao,
         assignee_id, due_date, date_created, date_closed, start_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, data.name, data.description ?? null, data.status ?? 'aberto', data.priority,
      data.tipo ?? null, data.setor ?? null, data.solicitante ?? null, data.email ?? null,
      data.solucao ?? null, data.assignee_id ?? null, data.due_date ?? null,
      data.date_created ?? now, data.date_closed ?? null, data.start_date ?? null, now, now
    ).run();
    if (data.assignee_ids !== undefined) await d1SetAssignees(targetEnv, id, data.assignee_ids);
  }

  // Semeia o D1 com os 2 chamados fake (task-michael-1/task-ariele-1) ANTES de qualquer
  // teste — GET /api/my-tasks lê do D1, não mais da ClickUp (Fase B7, 2026-08-12), então
  // os testes de isolamento logo abaixo precisam encontrar esses chamados lá. Mesmos
  // valores que FAKE_TASKS sempre teve (ver topo do arquivo) — antes chegavam ao D1 via
  // `POST /admin/migrate-d1` (removida nesta fase), agora vão direto por aqui.
  await seedChamadoComId(env, 'task-michael-1', {
    name: 'Chamado do Michael', status: 'encerrado', priority: 1, tipo: 0, setor: 1,
    solicitante: 'Michael Vasconcelos', assignee_id: 200498355, assignee_ids: [200498355],
    due_date: FAKE_DUE_DATE_MICHAEL, date_closed: FAKE_DUE_DATE_MICHAEL - 60000,
    start_date: FAKE_DUE_DATE_MICHAEL - 3600000,
  });
  await seedChamadoComId(env, 'task-ariele-1', {
    name: 'Chamado da Ariele', status: 'aberto', priority: 3, tipo: 2, setor: 0,
    solicitante: 'Ariele Santo', assignee_id: 200498355, assignee_ids: [200498355],
    due_date: Date.now() - 60000, // prazo já vencido e ainda aberta -> atrasado
  });

  // Fase M1 (2026-08-13): /auth/register agora exige que o nome esteja cadastrado e
  // ativo na tabela `solicitantes` do D1 antes de deixar criar senha — semeia os nomes
  // usados pelos testes de auth/isolamento abaixo, mesma função real de produção
  // (d1CreateSolicitante), não uma reimplementação paralela.
  for (const nome of ['Michael Vasconcelos', 'Ariele Santo', 'Bruno Guilherme']) {
    await d1CreateSolicitante(env, nome, emailFor(nome));
  }

  console.log('--- registro e login ---');
  let token;
  await test('registra senha nova com sucesso e já devolve token', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), nome: 'Michael Vasconcelos', password: 'senha123' }) }), env);
    if (res.status !== 200) throw new Error(`status ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.token) throw new Error('sem token na resposta');
    token = data.token;
  });
  await test('registrar de novo o mesmo nome falha com 409', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), nome: 'Michael Vasconcelos', password: 'outrasenha' }) }), env);
    assert.strictEqual(res.status, 409);
  });
  await test('senha curta demais é rejeitada', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Nova Pessoa'), nome: 'Nova Pessoa', password: '12' }) }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('registrar com nome que não está na lista de solicitantes dá 403 (Fase M1, 2026-08-13)', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Alguém Que Não Existe'), nome: 'Alguém Que Não Existe', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  // Nome completo no primeiro acesso (2026-11-12): vários e-mails da lista são de cargo, então o
  // nome digitado pela pessoa substitui o da lista (e leva os chamados junto).
  await test('primeiro acesso sem nome dá 400 e não cria senha', async () => {
    await d1CreateSolicitante(env, 'Cargo Sem Nome', 'cargo.sem.nome@institutosaovicente.com.br');
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: 'cargo.sem.nome@institutosaovicente.com.br', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(await env.SUBSCRIPTIONS.get('auth_Cargo Sem Nome'), null);
  });
  await test('primeiro acesso com nome de uma palavra só dá 400', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: 'cargo.sem.nome@institutosaovicente.com.br', nome: 'Clara', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('nome digitado substitui o da lista: conta, chamados e login passam a usar o nome novo', async () => {
    await d1CreateSolicitante(env, 'Recepcionista', 'recepcionista.teste@institutosaovicente.com.br');
    await seedChamadoComId(env, 'task-recepcao-1', {
      name: 'Chamado da recepção', status: 'aberto', priority: 3, tipo: 2, setor: 0,
      solicitante: 'Recepcionista', assignee_id: 200498355, assignee_ids: [200498355],
      due_date: Date.now() + 3600000,
    });
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: 'recepcionista.teste@institutosaovicente.com.br', nome: '  Clara   Souza ', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.name, 'Clara Souza');
    const antigo = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind('Recepcionista').first();
    assert.strictEqual(antigo, null);
    const novo = await env.CHAMADOS_DB.prepare('SELECT email FROM solicitantes WHERE name = ?').bind('Clara Souza').first();
    assert.strictEqual(novo.email, 'recepcionista.teste@institutosaovicente.com.br');
    const ch = await d1GetChamado(env, 'task-recepcao-1');
    assert.strictEqual(ch.solicitante, 'Clara Souza');
    // Logada com o nome novo, ela vê o chamado que já era da conta.
    const minhas = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': data.token } }), env);
    assert.strictEqual(minhas.status, 200);
    assert.ok((await minhas.text()).includes('Chamado da recepção'));
    // E o login seguinte pelo e-mail funciona normalmente.
    const login = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: 'recepcionista.teste@institutosaovicente.com.br', password: 'senhaboa123' }) }), env);
    assert.strictEqual(login.status, 200);
    assert.strictEqual((await login.json()).name, 'Clara Souza');
  });
  await test('nome digitado igual ao de outra pessoa dá 409 e não muda nada', async () => {
    await d1CreateSolicitante(env, 'Cargo Dois', 'cargo.dois@institutosaovicente.com.br');
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: 'cargo.dois@institutosaovicente.com.br', nome: 'Ariele Santo', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 409);
    const ainda = await env.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE email = ?').bind('cargo.dois@institutosaovicente.com.br').first();
    assert.strictEqual(ainda.name, 'Cargo Dois');
    assert.strictEqual(await env.SUBSCRIPTIONS.get('auth_Cargo Dois'), null);
  });
  // Limpa as contas criadas só por estes testes: os testes seguintes contam usuários/solicitantes do mesmo env.
  await env.CHAMADOS_DB.prepare("DELETE FROM solicitantes WHERE name IN ('Cargo Sem Nome','Cargo Dois','Clara Souza')").run();
  await env.CHAMADOS_DB.prepare("DELETE FROM chamados WHERE id = 'task-recepcao-1'").run();
  await env.SUBSCRIPTIONS.delete('auth_Clara Souza');
  await test('login com senha certa funciona', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), password: 'senha123' }) }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('login com senha errada dá 401', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), password: 'errada' }) }), env);
    assert.strictEqual(res.status, 401);
  });
  await test('login pra nome sem senha cadastrada dá 404', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Alguém Sem Conta'), password: 'x' }) }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('após 5 tentativas erradas, a 6ª fica bloqueada por lockout (429)', async () => {
    await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Ariele Santo'), nome: 'Ariele Santo', password: 'senhadaariele' }) }), env);
    for (let i = 0; i < 5; i++) {
      const r = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Ariele Santo'), password: 'errada' }) }), env);
      assert.strictEqual(r.status, 401, `tentativa ${i + 1} deveria dar 401`);
    }
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Ariele Santo'), password: 'errada' }) }), env);
    assert.strictEqual(res.status, 429);
  });

  console.log('--- login por e-mail (2026-09-16, pedido da diretoria) ---');
  await test('login funciona com o e-mail em CAIXA ALTA/mista (normalizado)', async () => {
    const email = emailFor('Michael Vasconcelos').toUpperCase();
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email, password: 'senha123' }) }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('login com e-mail cercado de espaço (trim) funciona', async () => {
    const email = `  ${emailFor('Michael Vasconcelos')}  `;
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email, password: 'senha123' }) }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('e-mail desconhecido (não é de nenhum solicitante) dá 404 no login — mesma resposta de "sem senha ainda" (não vaza se o e-mail existe)', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: 'ninguem@teste.local', password: 'x' }) }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('registrar com e-mail desconhecido dá 403 (diferente do 404 de login — aqui sim distingue, é intencional: só o registro precisa saber se vale a pena)', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: 'ninguem@teste.local', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('sem e-mail no corpo dá 400', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ password: 'x' }) }), env);
    assert.strictEqual(res.status, 400);
  });

  console.log('--- isolamento entre pessoas (o motivo de tudo isso) ---');
  await test('sem token de sessão, /api/my-tasks dá 401', async () => {
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: SECRET_HEADERS }), env);
    assert.strictEqual(res.status, 401);
  });
  await test('Michael logado só vê o chamado do Michael, nunca o da Ariele', async () => {
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(res.status, 200);
    const { tasks } = await res.json();
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('task-michael-1'), 'não trouxe o chamado do próprio Michael');
    assert.ok(!ids.includes('task-ariele-1'), 'VAZOU o chamado da Ariele pro Michael');
  });
  await test('Michael consegue GET no chamado dele por ID', async () => {
    const res = await worker.fetch(req('GET', '/api/tasks/task-michael-1', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('Michael NÃO consegue GET no chamado da Ariele mesmo sabendo o ID (403)', async () => {
    const res = await worker.fetch(req('GET', '/api/tasks/task-ariele-1', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(res.status, 403);
  });

  console.log('--- criação de chamado sempre usa a identidade da sessão ---');
  // Fase M3 (2026-08-13): handleCreateTask grava direto no D1 (não mais na ClickUp) —
  // não existe mais `lastCreatePayload` pra inspecionar (isso era o body mandado pro
  // proxy da ClickUp). O jeito de confirmar "SOLICITANTE nunca vem do cliente" agora é
  // olhar `solicitante` na resposta direto (d1RowToTaskShape expõe como campo próprio,
  // ver achado de 2026-08-12) — nem faz sentido mais o payload aceitar um
  // SOLICITANTE_FIELD_ID em custom_fields, já que o servidor nunca olha pra ele.
  await test('forjar SOLICITANTE de outra pessoa ao criar é ignorado — servidor usa o da sessão', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': token },
      body: JSON.stringify({ name: 'chamado forjado', custom_fields: [{ id: SOLICITANTE_FIELD_ID, value: 1 /* Ariele! */ }] })
    }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.solicitante, 'Michael Vasconcelos', 'SOLICITANTE devia ter sido forçado pro Michael, ignorando o valor forjado');
  });
  await test('criação sem sessão dá 401', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'x' }) }), env);
    assert.strictEqual(res.status, 401);
  });
  // Fase M3 (2026-08-13): handleCreateTask grava direto no D1 — não é mais um espelho
  // best-effort de uma criação "de verdade" na ClickUp, é a própria fonte de verdade
  // agora. Título/asserções atualizados pra refletir isso (a ClickUp não entra mais
  // nessa rota nenhuma).
  await test('chamado criado grava direto no D1 (Fase M3 — não é mais só um espelho)', async () => {
    await env.SUBSCRIPTIONS.delete('throttle_create_Michael Vasconcelos'); // testes anteriores já usaram o throttle de 60s do Michael
    const res = await worker.fetch(req('POST', '/api/tasks', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': token },
      body: JSON.stringify({
        name: 'Chamado pra testar a criação D1-nativa',
        custom_fields: [
          { id: TIPO_FIELD_ID, value: 0 },
          { id: SETOR_FIELD_ID, value: 1 },
        ],
      })
    }), env);
    assert.strictEqual(res.status, 200);
    const created = await res.json();
    assert.ok(created.id, 'devia devolver um id (UUID gerado pela aplicação, não mais task_id da ClickUp)');
    const linha = await d1GetChamado(env, created.id);
    assert.ok(linha, 'chamado devia existir no D1 com o id devolvido');
    assert.strictEqual(linha.name, 'Chamado pra testar a criação D1-nativa');
    assert.strictEqual(linha.solicitante, 'Michael Vasconcelos');
    assert.strictEqual(linha.tipo, 0);
    assert.strictEqual(linha.setor, 1);
    assert.strictEqual(linha.status, 'aberto');
  });
  await test('forjar priority/due_date ao criar é ignorado — servidor recalcula pelo TIPO', async () => {
    // Usa uma sessão do Bruno (recém-registrado aqui), não a do Michael — ele acabou de criar
    // um chamado no teste anterior e cairia no throttle de 10s (429), que não é o que este
    // teste quer verificar. A Ariele não serve: ficou bloqueada pelo lockout do teste anterior.
    const brunoRegister = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Bruno Guilherme'), nome: 'Bruno Guilherme', password: 'senhadobruno' }) }), env);
    brunoToken = (await brunoRegister.json()).token;
    const tipoNotebooks = 0; // Urgente (1h) em CATEGORIA_PRIORIDADE
    const before = Date.now();
    const res = await worker.fetch(req('POST', '/api/tasks', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': brunoToken },
      body: JSON.stringify({
        name: 'chamado com prioridade forjada',
        priority: 4, // tentando mandar "Baixa" (nunca deveria existir)
        due_date: 1, // tentando mandar prazo já vencido
        custom_fields: [{ id: TIPO_FIELD_ID, value: tipoNotebooks }],
      })
    }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.priority.priority, 'urgent', 'Notebooks é Urgente — não deveria aceitar o 4 (\"Baixa\") forjado');
    const dueDate = Number(data.due_date);
    assert.ok(dueDate > before, 'due_date forjado (1) não deveria ter sido aceito');
    assert.ok(dueDate <= before + 3600000 + 5000, 'due_date deveria ser ~1h a partir de agora (Urgente)');
  });

  console.log('--- POST /admin/subscribe e alerta de chamado novo pro admin (2026-08-13) ---');
  await test('POST /admin/subscribe sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/subscribe', {
      body: JSON.stringify({ id: 'dispositivo-1', subscription: { endpoint: 'https://fake-push-endpoint.test/x', keys: { p256dh: 'a', auth: 'b' } } }),
    }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('POST /admin/subscribe sem id dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ subscription: { endpoint: 'https://fake-push-endpoint.test/x', keys: { p256dh: 'a', auth: 'b' } } }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('POST /admin/subscribe sem subscription dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ id: 'dispositivo-1' }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('POST /admin/subscribe com subscription sem keys.p256dh/keys.auth dá 400 (achado do revisor)', async () => {
    // Sem isso, uma subscription incompleta ficaria gravada, e sendWebPush quebraria
    // com um erro genérico (não "Push endpoint 404/410") toda vez que um chamado novo
    // fosse criado — nunca seria limpa, ficaria falhando pra sempre em silêncio.
    const res = await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'dispositivo-incompleto', subscription: { endpoint: 'https://fake-push-endpoint.test/incompleto' } }),
    }), env);
    assert.strictEqual(res.status, 400);
    const stored = await env.SUBSCRIPTIONS.get('adminsub_dispositivo-incompleto');
    assert.strictEqual(stored, null, 'não deveria ter gravado nada no KV');
  });
  await test('grava adminsub_<id> no KV, e reenviar com o mesmo id sobrescreve (idempotente)', async () => {
    const res = await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'dispositivo-idem', subscription: { endpoint: 'https://fake-push-endpoint.test/v1', keys: { p256dh: 'a', auth: 'b' } } }),
    }), env);
    assert.strictEqual(res.status, 200);
    let stored = JSON.parse(await env.SUBSCRIPTIONS.get('adminsub_dispositivo-idem'));
    assert.strictEqual(stored.endpoint, 'https://fake-push-endpoint.test/v1');

    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'dispositivo-idem', subscription: { endpoint: 'https://fake-push-endpoint.test/v2', keys: { p256dh: 'a', auth: 'b' } } }),
    }), env);
    stored = JSON.parse(await env.SUBSCRIPTIONS.get('adminsub_dispositivo-idem'));
    assert.strictEqual(stored.endpoint, 'https://fake-push-endpoint.test/v2', 'reenviar com o mesmo id deveria sobrescrever, não duplicar');
  });
  // Fase M5+ (alerta de admin): sendWebPush faz ECDH de verdade em cima de `p256dh`
  // (precisa ser um ponto EC P-256 válido, não qualquer string) — mesmas chaves
  // "descartáveis mas válidas" já usadas em tests/d1-layer.test.js pro mesmo motivo.
  const FAKE_PUSH_KEYS = { p256dh: 'BMgcsTAUEhUr-dau-LaPhTHktmCZ90q4GXFF6CX0p3IvmeB51v68JqZLeuKrO3swUcSXKiNhQ6Ur5I74fm6tp2Q', auth: 'dGVzdC1hdXRoLTE2Yg' };

  console.log('--- POST /admin/subscribe/test (2026-09-15, diagnóstico de "não estou sendo notificado") ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/subscribe/test', {
      body: JSON.stringify({ id: 'qualquer' }),
    }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('sem id dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/subscribe/test', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({}),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('id sem inscrição salva dá 404 com mensagem acionável', async () => {
    const res = await worker.fetch(req('POST', '/admin/subscribe/test', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'device-nunca-inscrito' }),
    }), env);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /Ativar/);
  });
  await test('dispositivo inscrito de verdade: manda o push real e devolve ok', async () => {
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'device-teste-ok', subscription: { endpoint: 'https://fake-push-endpoint.test/teste-ok', keys: FAKE_PUSH_KEYS } }),
    }), env);
    adminPushCalls.length = 0;
    const res = await worker.fetch(req('POST', '/admin/subscribe/test', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'device-teste-ok' }),
    }), env);
    assert.strictEqual(res.status, 200);
    const call = adminPushCalls.find(c => c.url === 'https://fake-push-endpoint.test/teste-ok');
    assert.ok(call, 'deveria ter mandado o push de teste pro endpoint certo');
  });
  await test('inscrição expirada (410): devolve erro acionável E limpa a inscrição podre do KV', async () => {
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'device-teste-morto', subscription: { endpoint: 'https://fake-push-endpoint.test/teste-morto', keys: FAKE_PUSH_KEYS } }),
    }), env);
    failingPushEndpoints.set('https://fake-push-endpoint.test/teste-morto', 410);
    try {
      const res = await worker.fetch(req('POST', '/admin/subscribe/test', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
        body: JSON.stringify({ id: 'device-teste-morto' }),
      }), env);
      assert.strictEqual(res.status, 410);
      const body = await res.json();
      assert.match(body.error, /Ativar/);
      const stored = await env.SUBSCRIPTIONS.get('adminsub_device-teste-morto');
      assert.strictEqual(stored, null, '410 no teste deveria limpar a inscrição, igual notifyAdminsNovoChamado já faz');
    } finally {
      failingPushEndpoints.delete('https://fake-push-endpoint.test/teste-morto');
    }
  });
  await test('outra falha de envio (nem 404 nem 410) devolve 502 SEM apagar a inscrição', async () => {
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'device-teste-500', subscription: { endpoint: 'https://fake-push-endpoint.test/teste-500', keys: FAKE_PUSH_KEYS } }),
    }), env);
    failingPushEndpoints.set('https://fake-push-endpoint.test/teste-500', 500);
    try {
      const res = await worker.fetch(req('POST', '/admin/subscribe/test', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
        body: JSON.stringify({ id: 'device-teste-500' }),
      }), env);
      assert.strictEqual(res.status, 502);
      const stored = await env.SUBSCRIPTIONS.get('adminsub_device-teste-500');
      assert.ok(stored, 'uma falha transitória (não 404/410) não deveria apagar a inscrição');
    } finally {
      failingPushEndpoints.delete('https://fake-push-endpoint.test/teste-500');
    }
  });

  await test('criar chamado dispara push pro admin inscrito', async () => {
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'dispositivo-vivo', subscription: { endpoint: 'https://fake-push-endpoint.test/vivo', keys: FAKE_PUSH_KEYS } }),
    }), env);
    adminPushCalls.length = 0;
    await env.SUBSCRIPTIONS.delete('throttle_create_Michael Vasconcelos');
    const res = await worker.fetch(req('POST', '/api/tasks', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': token },
      body: JSON.stringify({ name: 'chamado pra testar alerta de admin', custom_fields: [{ id: TIPO_FIELD_ID, value: 0 }] }),
    }), env);
    assert.strictEqual(res.status, 200, 'criar o chamado não deveria falhar mesmo com o alerta pro admin no meio do caminho');
    const call = adminPushCalls.find(c => c.url === 'https://fake-push-endpoint.test/vivo');
    assert.ok(call, 'deveria ter mandado push pro dispositivo inscrito');
    assert.ok(call.headers.Authorization?.startsWith('vapid '), 'deveria mandar o header VAPID');
  });
  await test('assinante com subscription morta (410) é removido, sem impedir push pros outros nem a criação do chamado', async () => {
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'dispositivo-morto', subscription: { endpoint: 'https://fake-push-endpoint.test/morto', keys: FAKE_PUSH_KEYS } }),
    }), env);
    failingPushEndpoints.set('https://fake-push-endpoint.test/morto', 410);
    adminPushCalls.length = 0;
    await env.SUBSCRIPTIONS.delete('throttle_create_Michael Vasconcelos');
    try {
      const res = await worker.fetch(req('POST', '/api/tasks', {
        headers: { ...SECRET_HEADERS, 'X-Session-Token': token },
        body: JSON.stringify({ name: 'chamado pra testar limpeza de inscrição morta', custom_fields: [{ id: TIPO_FIELD_ID, value: 0 }] }),
      }), env);
      assert.strictEqual(res.status, 200, 'chamado deveria ser criado mesmo com um assinante admin morto');
      const vivoCall = adminPushCalls.find(c => c.url === 'https://fake-push-endpoint.test/vivo');
      assert.ok(vivoCall, 'o assinante vivo (do teste anterior) deveria continuar recebendo push');
      const mortoStill = await env.SUBSCRIPTIONS.get('adminsub_dispositivo-morto');
      assert.strictEqual(mortoStill, null, '410 deveria ter apagado a inscrição morta');
    } finally {
      failingPushEndpoints.delete('https://fake-push-endpoint.test/morto');
    }
  });
  await test('sem nenhum admin inscrito, criar chamado não falha (só não manda push nenhum)', async () => {
    const solitaryEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1(), VAPID_PRIVATE_JWK: vapidPrivateJwkAdmin, VAPID_PUBLIC_KEY: 'fake-vapid-public-key' };
    await d1CreateSolicitante(solitaryEnv, 'Michael Vasconcelos', emailFor('Michael Vasconcelos'));
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), nome: 'Michael Vasconcelos', password: 'senha123' }) }), solitaryEnv);
    const soloToken = (await reg.json()).token;
    adminPushCalls.length = 0;
    const res = await worker.fetch(req('POST', '/api/tasks', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': soloToken },
      body: JSON.stringify({ name: 'chamado sem admin nenhum inscrito', custom_fields: [{ id: TIPO_FIELD_ID, value: 0 }] }),
    }), solitaryEnv);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(adminPushCalls.length, 0, 'sem ninguém inscrito, não deveria tentar mandar push nenhum');
  });

  console.log('--- upload de anexo também respeita quem é dono do chamado (Fase M2: R2 + D1, não mais ClickUp) ---');
  function fakeAnexoFormData(nome = 'foto.png', conteudo = 'fake-file-bytes') {
    const formData = new FormData();
    formData.append('attachment', new File([conteudo], nome, { type: 'image/png' }));
    return formData;
  }
  await test('Michael consegue anexar arquivo no chamado dele — vai pro R2, não pra ClickUp', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/attachment', {
      headers: { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'X-Session-Token': token },
      body: fakeAnexoFormData(),
    }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.id, 'devia devolver o id do anexo (linha em chamado_anexos)');
    const anexos = await d1ListAnexos(env, 'task-michael-1');
    assert.strictEqual(anexos.length, 1);
    assert.strictEqual(anexos[0].filename, 'foto.png');
    assert.ok(anexos[0].r2_key.startsWith('chamados/task-michael-1/'), 'key do R2 devia ter o prefixo do chamado certo');
  });
  await test('Michael NÃO consegue anexar arquivo no chamado da Ariele (403)', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-ariele-1/attachment', {
      headers: { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'X-Session-Token': token },
      body: fakeAnexoFormData(),
    }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('upload de anexo sem sessão dá 401', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/attachment', { headers: SECRET_HEADERS, body: 'x' }), env);
    assert.strictEqual(res.status, 401);
  });
  await test('arquivo maior que o limite (10MB) dá 413, mesmo tendo dono certo', async () => {
    const grandao = 'x'.repeat(MAX_ANEXO_BYTES + 1);
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/attachment', {
      headers: { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'X-Session-Token': token },
      body: fakeAnexoFormData('grande.png', grandao),
    }), env);
    assert.strictEqual(res.status, 413);
  });
  await test('GET /api/anexos/:id serve o arquivo certo, só pro dono', async () => {
    const uploadRes = await worker.fetch(req('POST', '/api/tasks/task-michael-1/attachment', {
      headers: { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'X-Session-Token': token },
      body: fakeAnexoFormData('unico.png', 'conteudo-do-anexo-unico'),
    }), env);
    const { id: anexoId } = await uploadRes.json();

    const semSessao = await worker.fetch(req('GET', `/api/anexos/${anexoId}`, { headers: SECRET_HEADERS }), env);
    assert.strictEqual(semSessao.status, 401);

    const donoRes = await worker.fetch(req('GET', `/api/anexos/${anexoId}`, { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(donoRes.status, 200);
    assert.strictEqual(await donoRes.text(), 'conteudo-do-anexo-unico');
    assert.strictEqual(donoRes.headers.get('Content-Type'), 'image/png');
  });
  await test('GET /api/anexos/:id dá 404 pra id inexistente', async () => {
    const res = await worker.fetch(req('GET', '/api/anexos/id-que-nao-existe', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('GET /api/tasks/:id devolve os anexos do R2/D1 (não mais da ClickUp) — precisa deployar junto com o upload', async () => {
    const res = await worker.fetch(req('GET', '/api/tasks/task-michael-1', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(res.status, 200);
    const task = await res.json();
    // task-michael-1 já recebeu 2 uploads nos testes acima ("foto.png" e "unico.png").
    assert.strictEqual(task.attachments.length, 2);
    const nomes = task.attachments.map(a => a.name).sort();
    assert.deepStrictEqual(nomes, ['foto.png', 'unico.png']);
    for (const a of task.attachments) {
      assert.ok(a.url.startsWith('https://worker.local/api/anexos/'), 'url devolvida deveria ser a rota autenticada nova, não um link direto da ClickUp');
      assert.strictEqual(a.extension, 'png');
    }
  });

  console.log('--- POST /admin/migrate-schema-anexos (Fase M2, 2026-08-13) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('cria a tabela chamado_anexos, idempotente rodando de novo', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res.status, 200);
    const res2 = await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res2.status, 200, 'rodar de novo não deveria falhar (CREATE ... IF NOT EXISTS)');
  });
  // Fase M5 (2026-08-13): POST /admin/migrate-anexos removida (já rodou em produção —
  // 46 anexos/41 chamados migrados, ver CLAUDE.md) — sem rota, sem teste.

  console.log('--- falha fechada se o Worker não tiver SUBSCRIBE_SECRET configurado ---');
  await test('sem SUBSCRIBE_SECRET no ambiente, /auth/login fica bloqueado (não aberto)', async () => {
    const envSemSecret = { ...env, SUBSCRIBE_SECRET: undefined };
    const res = await worker.fetch(req('POST', '/auth/login', { body: JSON.stringify({ email: 'a@b.com', password: 'x' }) }), envSemSecret);
    assert.strictEqual(res.status, 403);
  });

  console.log('--- presença (online no painel de admin) ---');
  const ADM_PRES = { 'X-Admin-Secret': env.ADMIN_SECRET };
  const pres = (body, tk = token) => worker.fetch(req('POST', '/api/presence', { headers: { ...SECRET_HEADERS, 'X-Session-Token': tk }, body: JSON.stringify(body) }), env);
  const lerPres = async (nome = 'Michael Vasconcelos') => {
    const data = await worker.fetch(req('GET', '/admin/presenca', { headers: ADM_PRES }), env).then(r => r.json());
    return { data, p: data.presenca.find(x => x.name === nome) };
  };
  await test('POST /api/presence sem sessão dá 401', async () => {
    const res = await worker.fetch(req('POST', '/api/presence', { headers: SECRET_HEADERS, body: '{}' }), env);
    assert.strictEqual(res.status, 401);
  });
  await test('GET /admin/presenca sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('GET', '/admin/presenca'), env);
    assert.strictEqual(res.status, 403);
  });
  await test('sinal de vida grava a presença da pessoa da sessão (aba visível)', async () => {
    assert.strictEqual((await pres({ tabId: 'A', visivel: true })).status, 200);
    const { data, p } = await lerPres();
    assert.ok(data.agora > 0 && data.janelaMs > 0);
    assert.ok(p, 'Michael deveria aparecer');
    assert.strictEqual(p.visivel, 1);
    assert.strictEqual(p.saiu, 0);
    assert.ok(Math.abs(data.agora - p.last_seen) < 5000);
  });
  await test('aba em segundo plano grava visivel = 0', async () => {
    await pres({ tabId: 'A', visivel: false });
    assert.strictEqual((await lerPres()).p.visivel, 0);
  });
  await test('duas abas: uma visível e outra em segundo plano => pessoa em uso; fechar uma não derruba a outra', async () => {
    await pres({ tabId: 'A', visivel: true });
    await pres({ tabId: 'B', visivel: false });
    let { p } = await lerPres();
    assert.strictEqual(p.visivel, 1, 'aba A em uso deve valer');
    await pres({ tabId: 'B', saindo: true });
    ({ p } = await lerPres());
    assert.strictEqual(p.saiu, 0, 'aba A continua aberta');
    assert.strictEqual(p.visivel, 1);
  });
  await test('"saindo" da última aba marca saiu = 1 mas guarda o horário (visto há X)', async () => {
    await pres({ tabId: 'A', saindo: true });
    const { p } = await lerPres();
    assert.strictEqual(p.saiu, 1);
    assert.ok(p.last_seen > 0, 'horário real preservado');
  });
  await test('sinal atrasado (ts mais velho) não sobrescreve um mais novo', async () => {
    const agora = Date.now();
    await pres({ tabId: 'C', visivel: true, ts: agora });
    await pres({ tabId: 'C', saindo: true, ts: agora - 5000 });
    const { p } = await lerPres();
    assert.strictEqual(p.saiu, 0, '"saindo" atrasado deve ser ignorado');
    await pres({ tabId: 'C', saindo: true, ts: agora + 1000 });
  });
  await test('pings em menos de 10 s são descartados (limite de frequência), mas mudança de visibilidade passa', async () => {
    await pres({ tabId: 'D', visivel: true });
    const antes = await env.CHAMADOS_DB.prepare("SELECT last_seen FROM presenca_abas WHERE tab_id = 'D'").first();
    await new Promise(r => setTimeout(r, 20));
    await pres({ tabId: 'D', visivel: true });
    const meio = await env.CHAMADOS_DB.prepare("SELECT last_seen FROM presenca_abas WHERE tab_id = 'D'").first();
    assert.strictEqual(meio.last_seen, antes.last_seen, 'segundo ping rápido não grava');
    await pres({ tabId: 'D', visivel: false });
    const depois = await env.CHAMADOS_DB.prepare("SELECT visivel FROM presenca_abas WHERE tab_id = 'D'").first();
    assert.strictEqual(depois.visivel, 0);
  });
  await test('corpo grande demais dá 413', async () => {
    const res = await worker.fetch(req('POST', '/api/presence', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token, 'Content-Length': '9999' }, body: '{}' }), env);
    assert.strictEqual(res.status, 413);
  });
  await test('sem a tabela presenca_abas (produção antes do 1º sinal) a gravação cria a tabela sozinha', async () => {
    await env.CHAMADOS_DB.prepare('DROP TABLE presenca_abas').run();
    const vazio = await worker.fetch(req('GET', '/admin/presenca', { headers: ADM_PRES }), env);
    assert.strictEqual(vazio.status, 200);
    assert.deepStrictEqual((await vazio.json()).presenca, []);
    const res = await pres({ tabId: 'A' });
    assert.strictEqual((await res.json()).ok, true);
    assert.ok((await lerPres()).p);
  });

  console.log('--- /admin/users (visão geral de quem já criou senha) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('GET', '/admin/users'), env);
    assert.strictEqual(res.status, 403);
  });
  await test('com X-Admin-Secret errado dá 403', async () => {
    const res = await worker.fetch(req('GET', '/admin/users', { headers: { 'X-Admin-Secret': 'chute' } }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('X-App-Secret (o do app, não o de admin) NÃO dá acesso ao admin', async () => {
    const res = await worker.fetch(req('GET', '/admin/users', { headers: SECRET_HEADERS }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('lista todo mundo que já registrou senha, sem vazar hash/salt', async () => {
    const res = await worker.fetch(req('GET', '/admin/users', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res.status, 200);
    const { total, users } = await res.json();
    assert.strictEqual(total, 3);
    const names = users.map(u => u.name).sort();
    assert.deepStrictEqual(names, ['Ariele Santo', 'Bruno Guilherme', 'Michael Vasconcelos']);
    users.forEach(u => {
      assert.ok(u.createdAt, `${u.name} sem createdAt`);
      assert.strictEqual(u.hash, undefined, 'endpoint de admin não pode devolver hash de senha');
      assert.strictEqual(u.salt, undefined, 'endpoint de admin não pode devolver salt de senha');
    });
  });
  await test('lastLoginAt é atualizado depois de um login bem-sucedido', async () => {
    const before = (await worker.fetch(req('GET', '/admin/users', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json()))
      .users.find(u => u.name === 'Michael Vasconcelos').lastLoginAt;
    await new Promise(r => setTimeout(r, 5));
    await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), password: 'senha123' }) }), env);
    const after = (await worker.fetch(req('GET', '/admin/users', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json()))
      .users.find(u => u.name === 'Michael Vasconcelos').lastLoginAt;
    assert.ok(after > before, 'lastLoginAt deveria ter avançado após novo login');
  });

  console.log('--- lista de solicitantes sai da ClickUp (Fase M1, 2026-08-13) ---');
  await test('POST /admin/migrate-schema-solicitantes sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('cria a tabela solicitantes, idempotente rodando de novo', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 200);
    const res2 = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res2.status, 200, 'rodar de novo não deveria falhar (CREATE ... IF NOT EXISTS)');
  });
  await test('GET /api/solicitantes só com o segredo público do app dá 403 (lista só para a TI)', async () => {
    const res = await worker.fetch(req('GET', '/api/solicitantes', { headers: SECRET_HEADERS }), env);
    assert.strictEqual(res.status, 403);
    assert.ok(!('names' in await res.json()));
  });
  await test('GET /api/solicitantes aceita a chave de operador', async () => {
    const opEnv = { ...env, OPERADOR_SECRETS: JSON.stringify({ 170628721: 'chave-do-operador' }) };
    const res = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-Admin-Secret': 'chave-do-operador' } }), opEnv);
    assert.strictEqual(res.status, 200);
  });
  await test('GET /api/solicitantes sem nenhuma chave dá 403', async () => {
    const res = await worker.fetch(req('GET', '/api/solicitantes'), env);
    assert.strictEqual(res.status, 403);
  });
  // 🛡️ Achado real de produção (2026-08-13): ORDER BY do SQLite/D1 não é sensível a
  // locale — "Márcio" (acentuado) ficava depois de "Mikaelly" em vez de logo após
  // "Mariana", porque compara por byte, não por colação pt-BR. Corrigido ordenando em
  // JS (localeCompare) depois de buscar, igual a versão ClickUp-based sempre fez.
  await test('ordena por localeCompare pt-BR, não por byte cru do SQLite (nomes acentuados no lugar certo)', async () => {
    const solEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes', { headers: { 'X-Admin-Secret': solEnv.ADMIN_SECRET } }), solEnv);
    for (const nome of ['Mikaelly Lima', 'Mariana Maia', 'Márcio Delukken']) {
      await worker.fetch(req('POST', '/admin/solicitantes', {
        headers: { 'X-Admin-Secret': solEnv.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nome }),
      }), solEnv);
    }
    const res = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-Admin-Secret': solEnv.ADMIN_SECRET } }), solEnv);
    const { names } = await res.json();
    // A ordem exata entre "Márcio"/"Mariana" é uma nuance fina de colação (o próprio
    // localeCompare('pt-BR') do Node — mesmo mecanismo que a versão ClickUp-based
    // sempre usou — não concorda com um chute ingênuo aqui); o que importa de verdade
    // é o bug real que motivou o fix: "Márcio" não pode ficar isolado no fim da lista,
    // depois de "Mikaelly" (comparação por byte cru, sem acento, do ORDER BY do SQL).
    assert.strictEqual(names.indexOf('Márcio Delukken') < names.indexOf('Mikaelly Lima'), true, '"Márcio" deveria vir antes de "Mikaelly", agrupado com os outros nomes por M — não isolado no fim');
    assert.deepStrictEqual([...names].sort((a, b) => a.localeCompare(b, 'pt-BR')), names, 'a lista já deveria estar na ordem que localeCompare(pt-BR) produz');
  });
  await test('GET /api/solicitantes devolve só os ativos, ordenados', async () => {
    const res = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res.status, 200);
    const { names } = await res.json();
    assert.deepStrictEqual(names, ['Ariele Santo', 'Bruno Guilherme', 'Michael Vasconcelos']);
  });
  await test('POST /admin/solicitantes sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes', { body: JSON.stringify({ name: 'Novo Nome' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('POST /admin/solicitantes cria um solicitante novo', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Carlos Eduardo', email: emailFor('Carlos Eduardo') }),
    }), env);
    assert.strictEqual(res.status, 200);
    const res2 = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    const { names } = await res2.json();
    assert.ok(names.includes('Carlos Eduardo'));
  });
  await test('POST /admin/solicitantes com nome repetido dá 409', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Carlos Eduardo' }),
    }), env);
    assert.strictEqual(res.status, 409);
  });
  await test('desativar um solicitante some da lista pública, mas continua aparecendo em GET /admin/solicitantes', async () => {
    const res = await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Carlos Eduardo')}/ativo`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo: false }),
    }), env);
    assert.strictEqual(res.status, 200);

    const publica = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    assert.ok(!publica.names.includes('Carlos Eduardo'), 'desativado não deveria aparecer na lista pública (login)');

    const admin = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const carlos = admin.solicitantes.find(s => s.name === 'Carlos Eduardo');
    assert.ok(carlos, 'desativado ainda deveria aparecer na tela de gestão (pra poder reativar)');
    assert.strictEqual(carlos.ativo, 0);
  });
  await test('reativar um solicitante devolve ele pra lista pública', async () => {
    await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Carlos Eduardo')}/ativo`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo: true }),
    }), env);
    const publica = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    assert.ok(publica.names.includes('Carlos Eduardo'));
  });
  await test('ativar/desativar um nome que não existe dá 404', async () => {
    const res = await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Fantasma')}/ativo`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo: false }),
    }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('registrar com um nome desativado dá 403, mesmo já tendo existido antes', async () => {
    await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Carlos Eduardo')}/ativo`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo: false }),
    }), env);
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Carlos Eduardo'), nome: 'Carlos Eduardo', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  // Fase M5 (2026-08-13): POST /admin/migrate-solicitantes removida (já rodou em
  // produção, ver CLAUDE.md) — sem rota, sem teste.

  console.log('--- POST /admin/users/:nome/reset-senha (2026-09-16) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', `/admin/users/${encodeURIComponent('Michael Vasconcelos')}/reset-senha`, {}), env);
    assert.strictEqual(res.status, 403);
  });
  await test('reseta: some de GET /admin/users, e o próximo login vira registro (404)', async () => {
    const antes = await worker.fetch(req('GET', '/admin/users', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    assert.ok(antes.users.some(u => u.name === 'Michael Vasconcelos'), 'Michael deveria ter senha cadastrada antes do reset (testes anteriores registraram)');

    const res = await worker.fetch(req('POST', `/admin/users/${encodeURIComponent('Michael Vasconcelos')}/reset-senha`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 200);

    const depois = await worker.fetch(req('GET', '/admin/users', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    assert.ok(!depois.users.some(u => u.name === 'Michael Vasconcelos'), 'Michael não deveria mais ter senha cadastrada');

    const login = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), password: 'senha123' }) }), env);
    assert.strictEqual(login.status, 404, 'login com a senha antiga deveria falhar — foi resetada');

    // E consegue cadastrar uma senha nova, normalmente.
    const registro = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Michael Vasconcelos'), nome: 'Michael Vasconcelos', password: 'senhaNovaDepoisDoReset' }) }), env);
    assert.strictEqual(registro.status, 200);
    // O reset derruba as sessões antigas (2026-11-11): o token de antes não vale mais...
    const velho = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(velho.status, 401, 'sessão anterior ao reset deveria ter sido revogada');
    // ...mas a sessão criada no novo cadastro vale, e vira o token dos testes seguintes.
    token = (await registro.json()).token;
    const novo = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(novo.status, 200);
  });
  await test('resetar quem nunca teve senha é um no-op (200, não é erro)', async () => {
    const res = await worker.fetch(req('POST', `/admin/users/${encodeURIComponent('Ninguém Nunca Registrou')}/reset-senha`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('reset limpa o lockout de tentativas erradas também', async () => {
    // Ariele já tem 5 tentativas erradas acumuladas de um teste anterior (lockout
    // ativo) — resetar a senha dela deveria destravar o lockout também, não só
    // apagar a senha.
    const bloqueada = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Ariele Santo'), password: 'senhadaariele' }) }), env);
    assert.strictEqual(bloqueada.status, 429, 'devia estar bloqueada por lockout antes do reset (setup do teste)');

    await worker.fetch(req('POST', `/admin/users/${encodeURIComponent('Ariele Santo')}/reset-senha`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);

    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor('Ariele Santo'), password: 'qualquer' }) }), env);
    assert.strictEqual(res.status, 404, 'sem lockout, sem senha (foi resetada) — 404, não 429');
  });

  console.log('--- e-mail dos solicitantes (2026-09-16, login por e-mail) ---');
  await test('POST /admin/migrate-schema-solicitantes-email sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes-email', {}), env);
    assert.strictEqual(res.status, 403);
  });
  await test('POST /admin/migrate-schema-solicitantes-email é idempotente (coluna já existe)', async () => {
    // freshD1() já roda o schema.sql atual (com a coluna email desde o início) — este
    // teste confirma que rodar a migração DE NOVO num banco que já tem a coluna não
    // quebra (trata "duplicate column name" como sucesso, não como erro).
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes-email', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.ok, true);
  });
  await test('GET /admin/solicitantes devolve o e-mail de cada um', async () => {
    const res = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    const { solicitantes } = await res.json();
    const michael = solicitantes.find(s => s.name === 'Michael Vasconcelos');
    assert.strictEqual(michael.email, emailFor('Michael Vasconcelos'));
  });
  await test('POST /admin/solicitantes com e-mail já usado por outro solicitante dá 409', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Nova Com Email Duplicado', email: emailFor('Michael Vasconcelos') }),
    }), env);
    assert.strictEqual(res.status, 409);
  });
  await test('POST /admin/solicitantes/:nome/email edita o e-mail de um solicitante existente', async () => {
    await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Sem Email Ainda' }),
    }), env);
    const novoEmail = 'pessoa.sem.email.ainda@institutosaovicente.com.br';
    const res = await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Pessoa Sem Email Ainda')}/email`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: novoEmail }),
    }), env);
    assert.strictEqual(res.status, 200);

    // E o login já funciona com o e-mail recém-cadastrado.
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: novoEmail, nome: 'Pessoa Sem Email Ainda', password: 'senhaboa123' }) }), env);
    assert.strictEqual(reg.status, 200);
  });
  await test('POST /admin/solicitantes/:nome/email pra nome inexistente dá 404', async () => {
    const res = await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Fantasma')}/email`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fantasma@institutosaovicente.com.br' }),
    }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('POST /admin/solicitantes/:nome/email pra e-mail já usado por outro dá 409, sem sobrescrever nada', async () => {
    const res = await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Bruno Guilherme')}/email`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailFor('Michael Vasconcelos') }),
    }), env);
    assert.strictEqual(res.status, 409);
    const admin = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const bruno = admin.solicitantes.find(s => s.name === 'Bruno Guilherme');
    assert.notStrictEqual(bruno.email, emailFor('Michael Vasconcelos'), 'não deveria ter sobrescrito o e-mail do Bruno');
  });

  console.log('--- domínio institucional obrigatório (2026-09-16, "muita gente usa o gmail ainda") ---');
  await test('POST /admin/solicitantes com e-mail fora do domínio dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Com Gmail', email: 'pessoa@gmail.com' }),
    }), env);
    assert.strictEqual(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /institutosaovicente\.com\.br/);
  });
  await test('POST /admin/solicitantes com e-mail do domínio certo funciona', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Com Email Institucional', email: 'pessoa.institucional@institutosaovicente.com.br' }),
    }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('POST /admin/solicitantes/:nome/email com gmail dá 400, não sobrescreve nada', async () => {
    const res = await worker.fetch(req('POST', `/admin/solicitantes/${encodeURIComponent('Bruno Guilherme')}/email`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bruno@gmail.com' }),
    }), env);
    assert.strictEqual(res.status, 400);
    const admin = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const bruno = admin.solicitantes.find(s => s.name === 'Bruno Guilherme');
    assert.notStrictEqual(bruno.email, 'bruno@gmail.com');
  });
  await test('POST /admin/solicitantes/emails/bulk rejeita item com gmail (400 por item), sem derrubar os outros do lote', async () => {
    await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Bulk Gmail' }),
    }), env);
    await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Bulk Institucional' }),
    }), env);
    const res = await worker.fetch(req('POST', '/admin/solicitantes/emails/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emails: [
          { name: 'Pessoa Bulk Gmail', email: 'pessoa.bulk@gmail.com' },
          { name: 'Pessoa Bulk Institucional', email: 'pessoa.bulk.institucional@institutosaovicente.com.br' },
        ],
      }),
    }), env);
    const data = await res.json();
    assert.strictEqual(data.sucesso, 1);
    assert.strictEqual(data.falha, 1);
    assert.match(data.results[0].error, /institutosaovicente\.com\.br/);
    assert.strictEqual(data.results[1].ok, true);
  });

  console.log('--- POST /admin/solicitantes/emails/bulk (migração da lista real, 2026-09-16) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes/emails/bulk', { body: JSON.stringify({ emails: [] }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('sem "emails" (array) dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/solicitantes/emails/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('aplica vários de uma vez, reporta sucesso/falha por nome — um e-mail duplicado não derruba os outros', async () => {
    await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Bulk Um' }),
    }), env);
    await worker.fetch(req('POST', '/admin/solicitantes', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoa Bulk Dois' }),
    }), env);
    const res = await worker.fetch(req('POST', '/admin/solicitantes/emails/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emails: [
          { name: 'Pessoa Bulk Um', email: 'pessoa.bulk.um@institutosaovicente.com.br' },
          { name: 'Pessoa Bulk Dois', email: emailFor('Michael Vasconcelos') }, // duplicado, deve falhar
          { name: 'Pessoa Que Não Existe', email: 'x@institutosaovicente.com.br' }, // nome inexistente, deve falhar
        ],
      }),
    }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.total, 3);
    assert.strictEqual(data.sucesso, 1);
    assert.strictEqual(data.falha, 2);
    assert.strictEqual(data.results[0].ok, true);
    assert.strictEqual(data.results[1].ok, false);
    assert.strictEqual(data.results[2].ok, false);

    const admin = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const um = admin.solicitantes.find(s => s.name === 'Pessoa Bulk Um');
    assert.strictEqual(um.email, 'pessoa.bulk.um@institutosaovicente.com.br');
  });

  console.log('--- alerta de conta nova pra TI (2026-11-16) ---');
  await test('primeiro acesso dispara push pro admin inscrito, sem senha no payload, e cadastro nao falha com assinante morto', async () => {
    await d1CreateSolicitante(env, 'Conta Alerta', 'conta.alerta@institutosaovicente.com.br');
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'device-conta-nova', subscription: { endpoint: 'https://fake-push-endpoint.test/conta-nova', keys: FAKE_PUSH_KEYS } }),
    }), env);
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'device-conta-morto', subscription: { endpoint: 'https://fake-push-endpoint.test/conta-morto', keys: FAKE_PUSH_KEYS } }),
    }), env);
    failingPushEndpoints.set('https://fake-push-endpoint.test/conta-morto', 410);
    adminPushCalls.length = 0;
    try {
      const res = await worker.fetch(req('POST', '/auth/register', {
        headers: SECRET_HEADERS,
        body: JSON.stringify({ email: 'conta.alerta@institutosaovicente.com.br', nome: 'Conta Alerta Silva', password: 'senhaboa123' }),
      }), env);
      assert.strictEqual(res.status, 200, 'o cadastro deveria funcionar mesmo com o aviso falhando para um assinante');
      const call = adminPushCalls.find(c => c.url === 'https://fake-push-endpoint.test/conta-nova');
      assert.ok(call, 'deveria avisar o dispositivo admin inscrito');
      assert.strictEqual(await env.SUBSCRIPTIONS.get('adminsub_device-conta-morto'), null, 'assinante morto deveria ser limpo');
    } finally {
      failingPushEndpoints.delete('https://fake-push-endpoint.test/conta-morto');
      await env.SUBSCRIPTIONS.delete('adminsub_device-conta-nova');
      await env.SUBSCRIPTIONS.delete('adminsub_device-conta-morto');
    }
  });

  console.log('--- POST /auth/register-externo (2026-09-17, "chamados usados de forma externa... recebemos um chamado com identificacao outros e nem sabemos de onde veio") ---');
  await test('sem X-App-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      body: JSON.stringify({ name: 'Visitante Teste', email: 'visitante@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('cadastra com sucesso, já devolve token, e aparece em /admin/solicitantes com origem "externo"', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Fornecedor Externo', email: 'fornecedor.externo@gmail.com', password: 'senhaboa123', telefone: '85999998888' }),
    }), env);
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.ok(data.token);
    assert.strictEqual(data.name, 'Fornecedor Externo');

    const admin = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const s = admin.solicitantes.find(x => x.name === 'Fornecedor Externo');
    assert.strictEqual(s.origem, 'externo');
    assert.strictEqual(s.email, 'fornecedor.externo@gmail.com');
    assert.strictEqual(s.telefone, '85999998888');
    assert.strictEqual(s.ativo, 1);
  });
  await test('login funciona logo em seguida, com o e-mail cadastrado no autocadastro', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ email: 'fornecedor.externo@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('telefone é opcional', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Visitante Sem Telefone', email: 'visitante.sem.tel@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 200, await res.text());
  });
  await test('nome só com um termo (sem sobrenome) dá 400', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'SóUmNome', email: 'so.um.nome@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('e-mail mal formado dá 400', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Pessoa Externa', email: 'não-é-email', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('senha curta demais dá 400', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Pessoa Externa Dois', email: 'pessoa.ext.dois@gmail.com', password: '123' }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('e-mail do domínio institucional é rejeitado (autocadastro externo não pode se passar por colaborador interno)', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Pessoa Falsa Interna', email: 'falso@institutosaovicente.com.br', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /institucional/i);
  });
  await test('e-mail já cadastrado (interno ou externo) dá 409, não sobrescreve', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Outra Pessoa Qualquer', email: 'fornecedor.externo@gmail.com', password: 'outrasenha123' }),
    }), env);
    assert.strictEqual(res.status, 409);
  });
  await test('nome já usado por outro solicitante (colisão de PK) dá 409 com mensagem clara, não derruba o e-mail já checado', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Bruno Guilherme', email: 'bruno.homonimo@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 409);
    const admin = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const bruno = admin.solicitantes.find(s => s.name === 'Bruno Guilherme');
    assert.strictEqual(bruno.origem, 'interno', 'Bruno é interno de verdade — a tentativa externa não deveria ter mudado nada nele');
  });
  await test('solicitante criado pelo admin (handleAdminCreateSolicitante) continua com origem "interno" por padrão', async () => {
    const admin = await worker.fetch(req('GET', '/admin/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const pessoaInstitucional = admin.solicitantes.find(s => s.name === 'Pessoa Com Email Institucional');
    assert.strictEqual(pessoaInstitucional.origem, 'interno');
  });

  console.log('--- achados do revisor sobre /auth/register-externo (2026-09-21) ---');
  await test('subdomínio real do instituto (ex.: setor.institutosaovicente.com.br) também é rejeitado, não só o domínio exato', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Pessoa Subdominio Falsa', email: 'falso@setor.institutosaovicente.com.br', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /institucional/i);
  });
  await test('domínio "parecido" (lookalike/typosquat) também é rejeitado', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Pessoa Lookalike Falsa', email: 'falso@institutosaovicente.com.br.evil.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /institucional/i);
  });
  await test('e-mail gmail comum continua funcionando normalmente (o fix de lookalike não pegou gente de verdade)', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: 'Pessoa Gmail Normal', email: 'pessoa.normal.demais@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 200, await res.text());
  });
  await test('rate-limit por IP: depois de 5 cadastros bem-sucedidos do mesmo IP, o 6º dá 429', async () => {
    const ipHeaders = { ...SECRET_HEADERS, 'CF-Connecting-IP': '203.0.113.77' };
    for (let i = 1; i <= 5; i++) {
      const res = await worker.fetch(req('POST', '/auth/register-externo', {
        headers: ipHeaders,
        body: JSON.stringify({ name: `Pessoa Rate Limit ${i}`, email: `pessoa.ratelimit${i}@gmail.com`, password: 'senhaboa123' }),
      }), env);
      assert.strictEqual(res.status, 200, `cadastro ${i} deveria passar: ${await res.text()}`);
    }
    const res6 = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: ipHeaders,
      body: JSON.stringify({ name: 'Pessoa Rate Limit Seis', email: 'pessoa.ratelimit6@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res6.status, 429);
  });
  await test('rate-limit é por IP — outro IP não é afetado pelo lockout do IP anterior', async () => {
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '198.51.100.20' },
      body: JSON.stringify({ name: 'Pessoa Outro Ip', email: 'pessoa.outro.ip@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 200, await res.text());
  });
  await test('tentativa rejeitada por validação (nome/domínio/senha) não consome a cota de rate-limit', async () => {
    const ipHeaders = { ...SECRET_HEADERS, 'CF-Connecting-IP': '198.51.100.40' };
    for (let i = 1; i <= 3; i++) {
      const res = await worker.fetch(req('POST', '/auth/register-externo', {
        headers: ipHeaders,
        body: JSON.stringify({ name: 'SóUmNome', email: `x${i}@gmail.com`, password: 'senhaboa123' }),
      }), env);
      assert.strictEqual(res.status, 400);
    }
    const res = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: ipHeaders,
      body: JSON.stringify({ name: 'Pessoa Cota Preservada', email: 'pessoa.cota.preservada@gmail.com', password: 'senhaboa123' }),
    }), env);
    assert.strictEqual(res.status, 200, await res.text());
  });

  await test('cadastro externo recusa nome, telefone ou e-mail gigantes sem gravar nada', async () => {
    const tentar = (extra) => worker.fetch(req('POST', '/auth/register-externo', {
      headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '198.51.100.90' },
      body: JSON.stringify({ name: 'Pessoa Limite', email: 'pessoa.limite@gmail.com', password: 'senhaboa123', ...extra }),
    }), env);
    assert.strictEqual((await tentar({ name: `Pessoa ${'a'.repeat(100)}` })).status, 400);
    assert.strictEqual((await tentar({ telefone: '9'.repeat(31) })).status, 400);
    assert.strictEqual((await tentar({ email: `${'a'.repeat(250)}@gmail.com` })).status, 400);
    assert.strictEqual((await tentar({})).status, 200, 'o e-mail continua livre depois das recusas');
  });

  await test('sessão de quem está desativado no cadastro é recusada, mesmo sem revogação gravada', async () => {
    const reg = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '198.51.100.91' },
      body: JSON.stringify({ name: 'Pessoa Antiga Inativa', email: 'antiga.inativa@gmail.com', password: 'senhaboa123' }),
    }), env);
    const h = { ...SECRET_HEADERS, 'X-Session-Token': (await reg.json()).token };
    assert.strictEqual((await worker.fetch(req('GET', '/api/my-tasks', { headers: h }), env)).status, 200);
    // desativação direta no banco, como as feitas antes de existir `sessver_`
    await env.CHAMADOS_DB.prepare('UPDATE solicitantes SET ativo = 0 WHERE name = ?').bind('Pessoa Antiga Inativa').run();
    assert.strictEqual((await worker.fetch(req('GET', '/api/my-tasks', { headers: h }), env)).status, 401);
  });
  await test('cadastro externo: respostas "já existe" também gastam o limite por IP', async () => {
    const h = { ...SECRET_HEADERS, 'CF-Connecting-IP': '198.51.100.92' };
    const tentar = () => worker.fetch(req('POST', '/auth/register-externo', {
      headers: h, body: JSON.stringify({ name: 'Fornecedor Externo', email: 'outro.palpite@gmail.com', password: 'senhaboa123' }),
    }), env);
    for (let i = 0; i < 5; i++) assert.strictEqual((await tentar()).status, 409);
    assert.strictEqual((await tentar()).status, 429);
  });

  console.log('--- POST /admin/migrate-schema-solicitantes-origem (2026-09-17) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes-origem'), env);
    assert.strictEqual(res.status, 403);
  });
  await test('idempotente — rodar 2x não quebra nada', async () => {
    const r1 = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes-origem', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(r1.status, 200);
    const r2 = await worker.fetch(req('POST', '/admin/migrate-schema-solicitantes-origem', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(r2.status, 200);
  });

  console.log('--- POST /admin/migrate-schema-chamados-nota (2026-09-21) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-chamados-nota'), env);
    assert.strictEqual(res.status, 403);
  });
  await test('idempotente — rodar 2x não quebra nada', async () => {
    const r1 = await worker.fetch(req('POST', '/admin/migrate-schema-chamados-nota', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(r1.status, 200);
    const r2 = await worker.fetch(req('POST', '/admin/migrate-schema-chamados-nota', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(r2.status, 200);
  });

  console.log('--- GET /api/my-tasks lê do D1, não bate na ClickUp (Fase B7, 2026-08-12) ---');
  await test('devolve o que o D1 tem pro solicitante, sem nenhuma chamada à ClickUp', async () => {
    // Bruno tem exatamente 1 chamado no D1 nesse ponto — o do teste "forjar priority/
    // due_date" lá em cima, que agora espelha com sucesso mesmo sem SETOR (Fase B7,
    // mesmo dia: tipo/setor ausentes viram NULL em vez de bloquear o mirror). Fase M5:
    // "sem nenhuma chamada à ClickUp" agora é garantido pelo mock de fetch global (lança
    // se alguém tentar) — não precisa mais de um contador dedicado só pra essa checagem.
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': brunoToken } }), env);
    assert.strictEqual(res.status, 200);
    const { tasks } = await res.json();
    assert.strictEqual(tasks.length, 1, 'Bruno tem 1 chamado espelhado no D1 (criado num teste anterior)');
  });

  await test('mesmo se o D1 tiver 2+ assignees pra um chamado, GET /api/my-tasks continua devolvendo só 1 (deliberado — evita o custo extra de withAssignees na rota mais chamada do Worker)', async () => {
    // task-michael-1 já está no D1 (semeado no início do arquivo) — dá 2 operadores
    // reais na tabela de junção, mas /api/my-tasks nunca passa `withAssignees` pro
    // d1ListChamados (ver handleGetMyTasks), então a reconstrução de `assignees[]` cai
    // pro `assignee_id` único de sempre, não o array completo.
    await d1SetAssignees(env, 'task-michael-1', [170628721, 200498355]);
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    const { tasks } = await res.json();
    const michael1 = tasks.find(t => t.id === 'task-michael-1');
    assert.ok(michael1, 'task-michael-1 deveria estar na lista do Michael');
    assert.strictEqual(michael1.assignees.length, 1, 'sem withAssignees, cai pro assignee_id único — não é bug, é a rota mais chamada do Worker evitando query extra');
  });

  console.log('--- POST /api/tasks/:id/nota (satisfação, 2026-09-21, "julgo essencial") ---');
  await test('sem sessão dá 401', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/nota', { headers: SECRET_HEADERS, body: JSON.stringify({ nota: 5 }) }), env);
    assert.strictEqual(res.status, 401);
  });
  await test('chamado inexistente dá 404', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/nao-existe/nota', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token }, body: JSON.stringify({ nota: 5 }) }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('avaliar chamado de outra pessoa dá 403 (dono é Michael, não Bruno)', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/nota', { headers: { ...SECRET_HEADERS, 'X-Session-Token': brunoToken }, body: JSON.stringify({ nota: 5 }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await seedChamadoComId(env, 'task-michael-aberto-nota', {
    name: 'Chamado aberto pra teste de nota', status: 'aberto', priority: 3, tipo: 0, setor: 0, solicitante: 'Michael Vasconcelos',
  });
  await test('avaliar chamado ainda não encerrado dá 400', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-aberto-nota/nota', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token }, body: JSON.stringify({ nota: 5 }) }), env);
    assert.strictEqual(res.status, 400);
  });
  for (const notaInvalida of [0, 6, 'abc', null, '3', true, [4], 3.5]) {
    await test(`nota inválida (${JSON.stringify(notaInvalida)}) dá 400`, async () => {
      const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/nota', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token }, body: JSON.stringify({ nota: notaInvalida }) }), env);
      assert.strictEqual(res.status, 400);
    });
  }
  await test('corpo JSON null ou não-objeto dá 400, não 500', async () => {
    for (const raw of ['null', '5', '"x"']) {
      const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/nota', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token }, body: raw }), env);
      assert.strictEqual(res.status, 400, raw);
    }
  });
  await test('avalia com sucesso — nota aparece na resposta e em GET /api/tasks/:id', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/nota', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token }, body: JSON.stringify({ nota: 4 }) }), env);
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.nota, 4);

    const getRes = await worker.fetch(req('GET', '/api/tasks/task-michael-1', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    const task = await getRes.json();
    assert.strictEqual(task.nota, 4);
  });
  await test('reenviar sobrescreve a nota anterior (deliberado — corrige clique errado)', async () => {
    await worker.fetch(req('POST', '/api/tasks/task-michael-1/nota', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token }, body: JSON.stringify({ nota: 2 }) }), env);
    const getRes = await worker.fetch(req('GET', '/api/tasks/task-michael-1', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    const task = await getRes.json();
    assert.strictEqual(task.nota, 2);
  });
  await test('chamado nunca avaliado devolve nota: null (não 0) — confirmado via GET /admin/tasks', async () => {
    const admin = await worker.fetch(req('GET', '/admin/tasks', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env).then(r => r.json());
    const ariele1 = admin.tasks.find(t => t.id === 'task-ariele-1');
    assert.strictEqual(ariele1.nota, null);
  });

  console.log('--- /admin/tasks (todos os chamados, com filtros) ---');
  // /admin/tasks e /admin/metrics leem do D1 (B7 parte 2, fase 2) — env ISOLADO aqui (D1
  // próprio, não o `env` global) porque a essa altura do arquivo o `env` compartilhado já
  // acumulou chamados extras de outros testes (dual-write desde a B7 parte 1); um dataset
  // isolado com só os 2 fixtures conhecidos mantém as contagens abaixo determinísticas.
  // Mesmos 2 chamados/mesmos valores de sempre (task-michael-1/task-ariele-1) — antes
  // chegavam aqui via `POST /admin/migrate-d1` (removida na Fase M5), direto por
  // seedChamadoComId agora.
  const adminEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
  await seedChamadoComId(adminEnv, 'task-michael-1', {
    name: 'Chamado do Michael', status: 'encerrado', priority: 1, tipo: 0, setor: 1,
    solicitante: 'Michael Vasconcelos', assignee_id: 200498355, assignee_ids: [200498355],
    due_date: FAKE_DUE_DATE_MICHAEL, date_closed: FAKE_DUE_DATE_MICHAEL - 60000,
    start_date: FAKE_DUE_DATE_MICHAEL - 3600000,
  });
  await seedChamadoComId(adminEnv, 'task-ariele-1', {
    name: 'Chamado da Ariele', status: 'aberto', priority: 3, tipo: 2, setor: 0,
    solicitante: 'Ariele Santo', assignee_id: 200498355, assignee_ids: [200498355],
    due_date: Date.now() - 60000,
  });

  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks'), adminEnv);
    assert.strictEqual(res.status, 403);
  });
  await test('X-App-Secret (o do app, não o de admin) NÃO dá acesso', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks', { headers: SECRET_HEADERS }), adminEnv);
    assert.strictEqual(res.status, 403);
  });
  await test('sem filtro nenhum, devolve todos os chamados', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual(res.status, 200);
    const { total, tasks, truncated } = await res.json();
    assert.strictEqual(total, 2);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(truncated, false, 'D1 não pagina como a ClickUp — nunca deveria truncar');
  });

  // 🛡️ Achado real de produção (2026-08-12, mesmo dia): antes deste fix, o nome do
  // solicitante nunca vinha em `custom_fields` (só tipo/setor/solução) — o frontend
  // fazia `Number(getCF(task, SOLICITANTE_FIELD_ID))` -&gt; `Number(null)` -&gt; `0` -&gt;
  // mostrava quem tivesse orderindex 0 como solicitante de TODO chamado no Kanban/
  // Tabela do admin. Corrigido expondo `solicitante` como campo próprio (nome já
  // resolvido, não orderindex).
  await test('cada chamado devolve o nome do solicitante certo, direto (não via custom_fields/orderindex)', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { tasks } = await res.json();
    const michael = tasks.find(t => t.id === 'task-michael-1');
    const ariele  = tasks.find(t => t.id === 'task-ariele-1');
    assert.strictEqual(michael.solicitante, 'Michael Vasconcelos');
    assert.strictEqual(ariele.solicitante, 'Ariele Santo');
    // Não deveria mais existir nenhuma entrada de SOLICITANTE_FIELD_ID em custom_fields
    // — se voltar, é sinal de que alguém reintroduziu a indireção por orderindex.
    for (const t of tasks) {
      assert.ok(!(t.custom_fields || []).some(f => f.id === SOLICITANTE_FIELD_ID), `${t.id} não deveria ter custom_field de SOLICITANTE`);
    }
  });
  await test('token de sessão válido (sem X-Admin-Secret) NÃO dá acesso — admin é um segredo separado da sessão de usuário', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks', { headers: { 'X-Session-Token': token } }), adminEnv);
    assert.strictEqual(res.status, 403);
  });
  await test('filtro por status devolve só os chamados daquele status', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks?status=aberto', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { total, tasks } = await res.json();
    assert.strictEqual(total, 1);
    assert.strictEqual(tasks[0].id, 'task-ariele-1');
  });
  await test('filtro por operador (assignee) funciona', async () => {
    // Desde 2026-11-24 o painel só lista os chamados da própria pessoa (admin = Henrique):
    // o filtro da URL não abre os do outro operador.
    const res = await worker.fetch(req('GET', '/admin/tasks?operador=170628721', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { tasks } = await res.json();
    assert.ok(tasks.length >= 1);
    assert.ok(tasks.every(t => t.assignees.some(a => a.id === 200498355)), 'só chamados do Henrique');
  });
  await test('filtro por setor (orderindex) funciona', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks?setor=0', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { total, tasks } = await res.json();
    assert.strictEqual(total, 1);
    assert.strictEqual(tasks[0].id, 'task-ariele-1');
  });
  await test('filtro por tipo (orderindex) funciona', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks?tipo=0', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { total, tasks } = await res.json();
    assert.strictEqual(total, 1);
    assert.strictEqual(tasks[0].id, 'task-michael-1');
  });
  await test('filtro por solicitante (nome) — D1 já guarda o nome resolvido, filtra direto sem round-trip pra ClickUp', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks?solicitante=' + encodeURIComponent('Michael Vasconcelos'), { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { total, tasks } = await res.json();
    assert.strictEqual(total, 1);
    assert.strictEqual(tasks[0].id, 'task-michael-1');
  });
  await test('solicitante que não existe devolve lista vazia (não erro)', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks?solicitante=Ninguém+Assim', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual(res.status, 200);
    const { total } = await res.json();
    assert.strictEqual(total, 0);
  });
  await test('combina múltiplos filtros com AND, não OR', async () => {
    const noMatch = await worker.fetch(req('GET', '/admin/tasks?status=aberto&setor=1', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual((await noMatch.json()).total, 0, 'Ariele é aberto+setor 0, Michael é encerrado+setor 1 — aberto+setor1 não deveria bater com nenhum dos dois');

    const bothMatch = await worker.fetch(req('GET', '/admin/tasks?status=aberto&setor=0', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const data = await bothMatch.json();
    assert.strictEqual(data.total, 1);
    assert.strictEqual(data.tasks[0].id, 'task-ariele-1');
  });
  await test('devolve o array completo de assignees (não só o primeiro) — preserva o aviso de múltiplos operadores no painel', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { tasks } = await res.json();
    assert.deepStrictEqual(tasks.find(t => t.id === 'task-michael-1').assignees.map(a => a.id), [200498355]);
  });

  // Fase M5 (2026-08-13): fetchAllTasks (e o teste de paginação/truncated que existia
  // aqui) foi removida junto com /admin/migrate-d1 — era a única rota que ainda usava.
  // `truncated` continua no contrato de /admin/tasks/-metrics (sempre `false`, D1 não
  // pagina) — coberto nos testes dessas duas rotas, abaixo.

  console.log('--- /admin/metrics (agregados de SLA/volume/tempo de atendimento) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('GET', '/admin/metrics'), adminEnv);
    assert.strictEqual(res.status, 403);
  });
  await test('agrega total, por status, por tipo/setor, SLA e tempo médio por operador', async () => {
    const res = await worker.fetch(req('GET', '/admin/metrics', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.strictEqual(data.total, 2);
    assert.strictEqual(data.truncated, false, 'D1 não pagina como a ClickUp — nunca deveria truncar');
    assert.deepStrictEqual(data.porStatus, { encerrado: 1, aberto: 1 });
    assert.strictEqual(data.porTipo['0'], 1, 'chamado do Michael é tipo 0 (Notebooks)');
    assert.strictEqual(data.porTipo['2'], 1, 'chamado da Ariele é tipo 2 (Redes)');
    assert.strictEqual(data.porSetor['1'], 1);
    assert.strictEqual(data.porSetor['0'], 1);

    // Michael: encerrado 1min antes do prazo -> dentro do SLA. Ariele: aberta e já vencida -> atrasado.
    assert.strictEqual(data.sla.dentroDoSla, 1);
    assert.strictEqual(data.sla.atrasado, 1);
    assert.strictEqual(data.sla.dentroDoSlaPercent, 50);
    assert.strictEqual(data.sla.atrasadoPercent, 50);

    // Só o chamado do Michael tem start_date+date_closed -> só Everson entra na média.
    const everson = data.tempoMedioPorOperador['200498355'];
    assert.ok(everson, 'Everson deveria aparecer no tempo médio de atendimento');
    // D1 não guarda nome de operador, só o id (diferente da versão ClickUp-based, que
    // tinha `a.username` de graça) — o painel resolve id->nome via OPERADORES no cliente.
    assert.strictEqual(everson.nome, null);
    assert.strictEqual(everson.totalChamados, 1);
    assert.ok(everson.mediaMs > 0);
    assert.strictEqual(data.tempoMedioPorOperador['170628721'], undefined, 'chamado da Ariele não foi encerrado, não deveria contar tempo de atendimento pro Henrique');

    assert.deepStrictEqual(data.satisfacao, { mediaNota: null, totalAvaliacoes: 0 }, 'ninguém avaliou nada ainda neste dataset isolado');
  });

  // Fase A do roadmap pós-MVP-visual (2026-08-14): filtro de período opcional
  // (desde/ate, epoch ms). task-michael-1/task-ariele-1 foram criados agora (Date.now())
  // via seedChamadoComId — ajusta date_created direto no D1 pra ter datas conhecidas.
  await test('desde/ate filtram por date_created — chamado fora do intervalo não conta', async () => {
    // Datas relativas ao marco de início da operação (16/10/2026 00:00 Fortaleza).
    const MARCO = Date.UTC(2026, 9, 16, 3, 0, 0);
    await adminEnv.CHAMADOS_DB.prepare('UPDATE chamados SET date_created = ? WHERE id = ?').bind(MARCO + 1_000_000, 'task-michael-1').run();
    await adminEnv.CHAMADOS_DB.prepare('UPDATE chamados SET date_created = ? WHERE id = ?').bind(MARCO + 5_000_000, 'task-ariele-1').run();

    const res = await worker.fetch(req('GET', `/admin/metrics?desde=${MARCO + 900_000}&ate=${MARCO + 1_100_000}`, { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.total, 1, 'só o chamado do Michael deveria estar dentro do range');
  });
  await test('o marco de início da operação NÃO corta mais as métricas: sem filtro conta tudo, e o período decide o resto', async () => {
    const MARCO = Date.UTC(2026, 9, 16, 3, 0, 0);
    const headers = { 'X-Admin-Secret': adminEnv.ADMIN_SECRET };
    const antes = await (await worker.fetch(req('GET', '/admin/metrics', { headers }), adminEnv)).json();
    assert.strictEqual(antes.inicioOperacao, MARCO, 'o marco continua sendo informado (vira atalho no painel)');
    // Ariele passa a ser "legado" (1 ms antes do marco): continua CONTANDO nas métricas.
    await adminEnv.CHAMADOS_DB.prepare('UPDATE chamados SET date_created = ? WHERE id = ?').bind(MARCO - 1, 'task-ariele-1').run();
    const depois = await (await worker.fetch(req('GET', '/admin/metrics', { headers }), adminEnv)).json();
    assert.strictEqual(depois.total, antes.total, 'chamado anterior ao marco entra no total');
    // Pedir um período ANTERIOR ao marco traz exatamente o legado.
    const antigo = await (await worker.fetch(req('GET', `/admin/metrics?desde=0&ate=${MARCO}`, { headers }), adminEnv)).json();
    assert.strictEqual(antigo.total, 1);
    // E "só a operação" (desde o marco) deixa o legado de fora, por escolha de quem filtra.
    const soOperacao = await (await worker.fetch(req('GET', `/admin/metrics?desde=${MARCO}`, { headers }), adminEnv)).json();
    assert.strictEqual(soOperacao.total, antes.total - 1);
    await adminEnv.CHAMADOS_DB.prepare('UPDATE chamados SET date_created = ? WHERE id = ?').bind(MARCO + 5_000_000, 'task-ariele-1').run();
  });
  await test('desde/ate inválido (não-numérico) devolve 400', async () => {
    const res = await worker.fetch(req('GET', '/admin/metrics?desde=nao-e-numero', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual(res.status, 400);
  });
  await test('satisfacao.mediaNota reflete as notas dadas (arredondada a 1 casa), só entre chamados avaliados', async () => {
    // Só task-michael-1 ganha nota — task-ariele-1 (nunca avaliado, nota: null) não deve
    // entrar no denominador da média.
    await adminEnv.CHAMADOS_DB.prepare('UPDATE chamados SET nota = ? WHERE id = ?').bind(5, 'task-michael-1').run();
    const res = await worker.fetch(req('GET', '/admin/metrics', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const data = await res.json();
    assert.deepStrictEqual(data.satisfacao, { mediaNota: 5, totalAvaliacoes: 1 });
  });

  console.log('--- POST /admin/tasks (TI cria chamado em nome de um solicitante, 2026-09-15) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      body: JSON.stringify({ name: 'x', solicitante: 'Michael Vasconcelos' }),
    }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('sem name dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ solicitante: 'Michael Vasconcelos' }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('sem solicitante dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ name: 'Impressora sem tinta' }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('solicitante inexistente/não cadastrado dá 400 (não cria em nome de qualquer string)', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ name: 'Impressora sem tinta', solicitante: 'Alguém Que Não Existe' }),
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('cria com sucesso: status sempre aberto, prioridade automática pelo tipo, solicitante do body', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ name: 'Impressora sem tinta', solicitante: 'Ariele Santo', tipo: 0, setor: 1, description: 'trocar o toner' }),
    }), env);
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.status.status, 'aberto');
    assert.strictEqual(data.priority.priority, 'urgent', 'tipo 0 (Notebooks) mapeia pra urgent em CATEGORIA_PRIORIDADE');
    const row = await d1GetChamado(env, data.id);
    assert.strictEqual(row.solicitante, 'Ariele Santo');
    assert.strictEqual(row.description, 'trocar o toner');
    assert.ok(row.due_date > Date.now(), 'due_date deveria ter sido calculado automaticamente, no futuro');
  });
  await test('chamado criado pela TI aparece em GET /admin/tasks igual a qualquer outro', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ name: 'Chamado criado pela TI pra teste de listagem', solicitante: 'Bruno Guilherme', tipo: 3 }),
    }), env);
    const created = await res.json();
    const list = await worker.fetch(req('GET', '/admin/tasks?status=aberto', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    const data = await list.json();
    assert.ok(data.tasks.some(t => t.id === created.id), 'chamado recém-criado pela TI deveria aparecer na listagem');
  });
  await test('tipo/setor ausentes: cria mesmo assim, prioridade cai no padrão (3=normal)', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ name: 'Chamado sem tipo/setor', solicitante: 'Michael Vasconcelos' }),
    }), env);
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.priority.priority, 'normal');
  });
  // 🐛 Achado real (2026-09-15, testando com o usuário): esta rota nunca chamava
  // notifyAdminsNovoChamado — um chamado criado por um operador via "+ Adicionar
  // Chamado" nunca avisava OUTROS operadores inscritos. Corrigido; este teste trava
  // a regressão.
  await test('dispara push pro admin inscrito, igual o fluxo do solicitante', async () => {
    await worker.fetch(req('POST', '/admin/subscribe', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ id: 'dispositivo-criado-pela-ti', subscription: { endpoint: 'https://fake-push-endpoint.test/criado-pela-ti', keys: FAKE_PUSH_KEYS } }),
    }), env);
    adminPushCalls.length = 0
    const res = await worker.fetch(req('POST', '/admin/tasks', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ name: 'Chamado criado pela TI pra outro operador ver', solicitante: 'Michael Vasconcelos', tipo: 0 }),
    }), env);
    assert.strictEqual(res.status, 200)
    const call = adminPushCalls.find(c => c.url === 'https://fake-push-endpoint.test/criado-pela-ti')
    assert.ok(call, 'POST /admin/tasks deveria disparar push pros admins inscritos, igual POST /api/tasks já faz')
  });

  console.log('--- POST /admin/tasks/:id — a TI trabalha por aqui, direto no D1 (Fase M4, 2026-08-13) ---');
  // Fase M4: handleAdminUpdateTask parou de chamar a ClickUp — grava direto no D1
  // (d1TransitionStatus/d1UpdateChamado). `criarChamadoTeste` semeia um chamado fresco
  // via d1CreateChamado (a mesma função de produção, não uma reimplementação paralela)
  // pra cada teste que precisa de um — mais simples que reaproveitar task-michael-1
  // (que já está "encerrado", herdado de FAKE_TASKS) quando o teste precisa de um
  // ponto de partida "aberto".
  async function criarChamadoTeste(overrides = {}) {
    const row = await d1CreateChamado(env, {
      name: 'Chamado de teste (M4)', priority: 3, tipo: 0, setor: 0,
      solicitante: 'Michael Vasconcelos', status: 'aberto', assignee_id: 200498355,
      ...overrides,
    });
    return row.id;
  }

  await test('sem X-Admin-Secret dá 403', async () => {
    const id = await criarChamadoTeste();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, { body: JSON.stringify({ status: 'em atendimento' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('status inválido dá 400', async () => {
    const id = await criarChamadoTeste();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'invalido' })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('corpo sem nada pra atualizar dá 400', async () => {
    const id = await criarChamadoTeste();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({})
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('chamado inexistente dá 404', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/nao-existe-no-d1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'em atendimento' })
    }), env);
    assert.strictEqual(res.status, 404);
  });

  console.log('--- solução obrigatória pra encerrar (regra de negócio, 2026-08-24) ---');
  await test('encerrar sem mandar solução (chamado nunca teve uma) dá 400, nada muda', async () => {
    const id = await criarChamadoTeste({ status: 'em atendimento' });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'encerrado' })
    }), env);
    assert.strictEqual(res.status, 400);
    const linha = await d1GetChamado(env, id);
    assert.strictEqual(linha.status, 'em atendimento', 'status não deveria ter mudado');
  });
  await test('encerrar mandando solução em branco (só espaço) dá 400', async () => {
    const id = await criarChamadoTeste({ status: 'em atendimento' });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'encerrado', solucao: '   ' })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('encerrar mandando status + solução juntos (fluxo do popup/modal) funciona', async () => {
    const id = await criarChamadoTeste({ status: 'em atendimento' });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ status: 'encerrado', solucao: 'Resolvido trocando o cabo.' }),
    }), env);
    assert.strictEqual(res.status, 200);
    const linha = await d1GetChamado(env, id);
    assert.strictEqual(linha.status, 'encerrado');
    assert.strictEqual(linha.solucao, 'Resolvido trocando o cabo.');
  });
  await test('encerrar SEM mandar solução, mas o chamado já tinha uma salva antes, funciona', async () => {
    const id = await criarChamadoTeste({ status: 'em atendimento', solucao: 'Já resolvido mais cedo.' });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'encerrado' })
    }), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await d1GetChamado(env, id)).status, 'encerrado');
  });
  await test('mudar pra QUALQUER outro status continua sem exigir solução', async () => {
    const id = await criarChamadoTeste({ status: 'aberto' });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'em atendimento' })
    }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('escrever so a solucao (sem status) encerra o chamado; status explicito e respeitado; solucao em branco nao encerra', async () => {
    const id1 = await criarChamadoTeste();
    let res = await worker.fetch(req('POST', '/admin/tasks/' + id1, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ solucao: 'Trocado o cabo.' }) }), env);
    assert.strictEqual(res.status, 200, await res.clone().text());
    assert.strictEqual((await d1GetChamado(env, id1)).status, 'encerrado');

    const id2 = await criarChamadoTeste();
    res = await worker.fetch(req('POST', '/admin/tasks/' + id2, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'pendente', solucao: 'Aguardando peca.' }) }), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await d1GetChamado(env, id2)).status, 'pendente', 'status explicito deve ser respeitado');

    // pendente (SLA pausado): escrever a solucao so anota, nao encerra
    const idP = await criarChamadoTeste();
    await worker.fetch(req('POST', '/admin/tasks/' + idP, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'pendente' }) }), env);
    res = await worker.fetch(req('POST', '/admin/tasks/' + idP, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ solucao: 'aguardando peca' }) }), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await d1GetChamado(env, idP)).status, 'pendente', 'solucao em chamado pendente nao deve encerrar');

    const id3 = await criarChamadoTeste();
    res = await worker.fetch(req('POST', '/admin/tasks/' + id3, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ solucao: '   ' }) }), env);
    assert.strictEqual(res.status, 200);
    assert.notStrictEqual((await d1GetChamado(env, id3)).status, 'encerrado', 'solucao em branco nao deve encerrar');
  });
  await test('ação em lote também recusa encerrar sem solução (mesma regra, sem caso especial)', async () => {
    const idComSolucao = await criarChamadoTeste({ status: 'em atendimento', solucao: 'Já resolvido.' });
    const idSemSolucao = await criarChamadoTeste({ status: 'em atendimento' });
    const res = await worker.fetch(req('POST', '/admin/tasks/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ ids: [idComSolucao, idSemSolucao], status: 'encerrado' }),
    }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const porId = Object.fromEntries(data.results.map(r => [r.id, r]));
    assert.strictEqual(porId[idComSolucao].ok, true);
    assert.strictEqual(porId[idSemSolucao].ok, false);
    assert.strictEqual((await d1GetChamado(env, idSemSolucao)).status, 'em atendimento', 'não deveria ter encerrado sem solução');
  });

  await test('muda status, escreve solução e reatribui operador — grava tudo direto no D1, sem tocar na ClickUp', async () => {
    const id = await criarChamadoTeste();
    const previousFetch = globalThis.fetch;
    let taskMutationCalled = false;
    globalThis.fetch = async (url, opts) => {
      // A única chamada residual esperada é o GET de /field (resolução nome->orderindex
      // pro lookup de subscription de push em d1TransitionStatus — dependência conhecida
      // e documentada, só sai na Fase M5). Nenhuma chamada em /task/ (GET, PUT ou POST)
      // deveria mais acontecer — essa é a garantia real desta fase.
      if (String(url).includes('/task/')) taskMutationCalled = true;
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
        body: JSON.stringify({ status: 'em atendimento', solucao: 'Reiniciei o notebook e atualizei o driver.', assigneeId: 200498355 })
      }), env);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data.updated, { status: 'em atendimento', solucao: true, assigneeId: 200498355 });
      assert.strictEqual(taskMutationCalled, false, 'M4: nenhuma sub-mutação deveria mais chamar /task/ na ClickUp — tudo no D1 direto');

      const linha = await d1GetChamado(env, id);
      assert.strictEqual(linha.status, 'em atendimento');
      assert.strictEqual(linha.solucao, 'Reiniciei o notebook e atualizei o driver.');
      assert.strictEqual(linha.assignee_id, 200498355);
      assert.ok(linha.start_date, 'd1TransitionStatus deveria ter definido start_date ao entrar em "em atendimento"');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
  await test('status "em atendimento" -> d1TransitionStatus define start_date/due_date pelo padrão da prioridade (sem webhook nenhum)', async () => {
    const id = await criarChamadoTeste({ priority: 1 }); // Urgente -> 15min padrão (DEFAULT_TIME_ESTIMATE_MS_BY_PRIORITY)
    const before = Date.now();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'em atendimento' })
    }), env);
    assert.strictEqual(res.status, 200);
    const linha = await d1GetChamado(env, id);
    assert.ok(linha.start_date >= before);
    assert.ok(linha.due_date >= linha.start_date + 15 * 60000 - 1000 && linha.due_date <= linha.start_date + 15 * 60000 + 5000, 'Urgente: due_date deveria ser ~15min após start_date');
  });
  await test('status "encerrado" -> d1TransitionStatus grava date_closed', async () => {
    const id = await criarChamadoTeste({ status: 'em atendimento' });
    const before = Date.now();
    // solução obrigatória pra encerrar (regra de 2026-08-24, ver bloco de testes
    // dedicado acima) — mandada junto aqui só pra não travar no 400 e continuar
    // testando o que este teste sempre testou (date_closed).
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'encerrado', solucao: 'Resolvido.' })
    }), env);
    assert.strictEqual(res.status, 200);
    const linha = await d1GetChamado(env, id);
    assert.strictEqual(linha.status, 'encerrado');
    assert.ok(linha.date_closed >= before);
  });
  await test('"pendente" pausa o SLA e sair de "pendente" empurra o due_date pelo tempo pausado', async () => {
    const dueDateOriginal = Date.now() + 3600000;
    const id = await criarChamadoTeste({ status: 'em atendimento', due_date: dueDateOriginal });
    // `start_date` precisa vir preenchido aqui — é o que representa "já estava em
    // atendimento de verdade antes de pausar" (ver `retomandoAtendimentoPausado` em
    // d1TransitionStatus). `d1CreateChamado` sempre grava `start_date: null` (não lê
    // `data.start_date` — dormente desde a Fase B2, nunca precisou disso até agora),
    // então ajusta direto via SQL depois de criar. Achado do revisor (2026-08-13):
    // sem isso, esta fixture ficava num estado que não existe na prática (status "em
    // atendimento" mas start_date nulo) — o que fazia ESTE teste ficar flaky depois
    // do fix do achado anterior, pelo mesmo motivo original (o padrão da prioridade
    // sendo aplicado por engano, só que agora por causa da fixture, não do código).
    await env.CHAMADOS_DB.prepare('UPDATE chamados SET start_date = ? WHERE id = ?').bind(Date.now() - 600000, id).run();
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'pendente' })
    }), env);
    const emPendente = await d1GetChamado(env, id);
    assert.strictEqual(emPendente.due_date, dueDateOriginal, 'due_date não deveria mudar só por entrar em pendente');

    // Simula alguns minutos de pausa mexendo direto no KV (sem precisar de sleep real no teste).
    await env.SUBSCRIPTIONS.put(`d1_pending_start_${id}`, String(Date.now() - 120000), { expirationTtl: 2592000 });
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'em atendimento' })
    }), env);
    const depoisDaPausa = await d1GetChamado(env, id);
    assert.ok(depoisDaPausa.due_date > dueDateOriginal, 'due_date deveria ter sido empurrado pelo tempo que ficou pendente');
  });
  await test('sair de "pendente" pra "em atendimento" pela 1ª vez (nunca tinha começado) aplica o padrão da prioridade, não o due_date de aceitação + pausa (achado do revisor)', async () => {
    // Sequência real possível no Kanban (transição livre entre qualquer status):
    // Aberto -> Pendente -> Em Atendimento, ou seja, pausar ANTES de nunca ter
    // começado a atender. `start_date` continua null até aqui — é isso que distingue
    // essa sequência de uma retomada de atendimento de verdade (testada acima).
    const dueDateAceitacao = Date.now() + 3600000; // prazo de ACEITAÇÃO, não de finalização
    const id = await criarChamadoTeste({ priority: 1, due_date: dueDateAceitacao }); // status 'aberto' (padrão do helper), Urgente -> 15min de finalização
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'pendente' })
    }), env);
    await env.SUBSCRIPTIONS.put(`d1_pending_start_${id}`, String(Date.now() - 120000), { expirationTtl: 2592000 });
    const before = Date.now();
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'em atendimento' })
    }), env);
    const linha = await d1GetChamado(env, id);
    assert.ok(linha.start_date >= before, 'start_date deveria ter sido definido agora — 1ª vez de verdade em atendimento');
    assert.ok(
      linha.due_date >= linha.start_date + 15 * 60000 - 1000 && linha.due_date <= linha.start_date + 15 * 60000 + 5000,
      'due_date deveria seguir o padrão de finalização da prioridade (~15min a partir de agora), não o due_date de aceitação + tempo pausado'
    );
  });
  await test('assigneeId:null ("sem atribuição") agora é recusado — todo chamado tem um operador (2026-11-24)', async () => {
    const id = await criarChamadoTeste({ assignee_id: 200498355, assignee_ids: [200498355] });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: null })
    }), env);
    assert.strictEqual(res.status, 400);
    const linha = await d1GetChamado(env, id);
    assert.strictEqual(linha.assignee_id, 200498355, 'não pode ter mudado nada');
  });

  console.log('--- POST /admin/tasks/:id/delete (exclusão de verdade, 2026-08-17) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const id = await criarChamadoTeste();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}/delete`), env);
    assert.strictEqual(res.status, 403);
  });
  await test('chamado inexistente dá 404', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/nao-existe-no-d1/delete', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('apaga o chamado — some do D1, GET /admin/tasks/:id vira 404', async () => {
    const id = await criarChamadoTeste();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}/delete`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.strictEqual(await d1GetChamado(env, id), null);
  });
  await test('apaga também assignees, anexos (D1 + R2) e eventos — sem deixar rastro órfão', async () => {
    const id = await criarChamadoTeste({ assignee_id: 170628721, assignee_ids: [170628721, 200498355] });
    // nota manual (evento) + anexo de verdade (R2), pra confirmar que a exclusão em
    // cascata limpa TUDO que está ligado a este chamado, não só a linha principal.
    await worker.fetch(req('POST', `/admin/tasks/${id}/eventos`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ autor: 'Henrique', texto: 'nota de teste' }),
    }), env);
    const uploadRes = await worker.fetch(req('POST', `/api/tasks/${id}/attachment`, {
      headers: { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'X-Session-Token': token },
      body: fakeAnexoFormData(),
    }), env);
    assert.strictEqual(uploadRes.status, 200, 'pré-condição: upload do anexo de teste precisa ter dado certo');
    const anexosAntes = await d1ListAnexos(env, id);
    assert.strictEqual(anexosAntes.length, 1);
    const r2Key = anexosAntes[0].r2_key;
    assert.ok(await env.ANEXOS.get(r2Key), 'pré-condição: objeto precisa existir no R2 antes de apagar');

    const res = await worker.fetch(req('POST', `/admin/tasks/${id}/delete`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 200);

    assert.strictEqual(await d1GetChamado(env, id), null, 'linha principal deveria ter sumido');
    const { results: assignees } = await env.CHAMADOS_DB.prepare('SELECT * FROM chamado_assignees WHERE chamado_id = ?').bind(id).all();
    assert.deepStrictEqual(assignees, [], 'chamado_assignees deveria ter sido limpo');
    assert.deepStrictEqual(await d1ListAnexos(env, id), [], 'chamado_anexos deveria ter sido limpo');
    assert.deepStrictEqual(await d1ListEventos(env, id), [], 'chamado_eventos deveria ter sido limpo');
    assert.strictEqual(await env.ANEXOS.get(r2Key), null, 'objeto do R2 deveria ter sido apagado junto, não deixado órfão no bucket');
  });
  await test('chamado apagado some de GET /admin/tasks (não sobra fantasma na listagem)', async () => {
    const id = await criarChamadoTeste({ name: 'Vou sumir da lista' });
    await worker.fetch(req('POST', `/admin/tasks/${id}/delete`, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    const res = await worker.fetch(req('GET', '/admin/tasks', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    const data = await res.json();
    assert.ok(!data.tasks.some(t => t.id === id), 'chamado apagado não deveria mais aparecer em GET /admin/tasks');
  });

  console.log('--- histórico + comentários / ação em lote (Fase B pós-MVP-visual, 2026-08-14) ---');
  await test('mudar status via POST /admin/tasks/:id grava um evento automático na timeline', async () => {
    const id = await criarChamadoTeste({ status: 'aberto' });
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'em atendimento' })
    }), env);
    const eventos = await d1ListEventos(env, id);
    assert.strictEqual(eventos.length, 1);
    assert.strictEqual(eventos[0].tipo, 'status');
    assert.strictEqual(eventos[0].de_valor, 'aberto');
    assert.strictEqual(eventos[0].para_valor, 'em atendimento');
  });
  await test('mudar status pro MESMO valor não gera evento à toa', async () => {
    const id = await criarChamadoTeste({ status: 'aberto' });
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'aberto' })
    }), env);
    assert.deepStrictEqual(await d1ListEventos(env, id), []);
  });
  await test('reatribuir operador via POST /admin/tasks/:id grava um evento automático', async () => {
    const id = await criarChamadoTeste({ assignee_id: 200498355, assignee_ids: [200498355] });
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: 170628721 })
    }), env);
    const eventos = await d1ListEventos(env, id);
    const evOperador = eventos.find(e => e.tipo === 'operador');
    assert.ok(evOperador, 'deveria ter gravado um evento de troca de operador');
    assert.strictEqual(evOperador.de_valor, '200498355');
    assert.strictEqual(evOperador.para_valor, '170628721');
  });

  console.log('--- GET/POST /admin/tasks/:id/eventos (notas manuais) ---');
  await test('sem X-Admin-Secret dá 403 (GET e POST)', async () => {
    const id = await criarChamadoTeste();
    const getRes = await worker.fetch(req('GET', `/admin/tasks/${id}/eventos`), env);
    assert.strictEqual(getRes.status, 403);
    const postRes = await worker.fetch(req('POST', `/admin/tasks/${id}/eventos`, { body: JSON.stringify({ autor: 'x', texto: 'y' }) }), env);
    assert.strictEqual(postRes.status, 403);
  });
  await test('chamado inexistente dá 404 (GET e POST)', async () => {
    const getRes = await worker.fetch(req('GET', '/admin/tasks/nao-existe/eventos', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(getRes.status, 404);
    const postRes = await worker.fetch(req('POST', '/admin/tasks/nao-existe/eventos', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ autor: 'x', texto: 'y' })
    }), env);
    assert.strictEqual(postRes.status, 404);
  });
  await test('POST sem autor/texto (ou vazio) dá 400', async () => {
    const id = await criarChamadoTeste();
    const semAutor = await worker.fetch(req('POST', `/admin/tasks/${id}/eventos`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ texto: 'oi' })
    }), env);
    assert.strictEqual(semAutor.status, 400);
    const textoVazio = await worker.fetch(req('POST', `/admin/tasks/${id}/eventos`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ autor: 'Henrique', texto: '   ' })
    }), env);
    assert.strictEqual(textoVazio.status, 400);
  });
  await test('POST cria a nota, GET devolve na timeline', async () => {
    const id = await criarChamadoTeste();
    const postRes = await worker.fetch(req('POST', `/admin/tasks/${id}/eventos`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ autor: 'Henrique', texto: 'Já entrei em contato com o fornecedor.' })
    }), env);
    assert.strictEqual(postRes.status, 200);
    const { evento } = await postRes.json();
    assert.strictEqual(evento.autor, 'Henrique');

    const getRes = await worker.fetch(req('GET', `/admin/tasks/${id}/eventos`, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    const { eventos } = await getRes.json();
    assert.strictEqual(eventos.length, 1);
    assert.strictEqual(eventos[0].texto, 'Já entrei em contato com o fornecedor.');
  });

  console.log('--- POST /admin/tasks/bulk (ação em lote) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/bulk', { body: JSON.stringify({ ids: ['a'], status: 'pendente' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('ids vazio/ausente dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'pendente' })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('mais de 50 ids dá 400 (teto de segurança)', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const res = await worker.fetch(req('POST', '/admin/tasks/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ ids, status: 'pendente' })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('sem nada pra atualizar (só ids) dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ ids: ['a'] })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('aplica status em todos os ids válidos, reporta sucesso/falha por id', async () => {
    const id1 = await criarChamadoTeste({ status: 'aberto' });
    const id2 = await criarChamadoTeste({ status: 'aberto' });
    const res = await worker.fetch(req('POST', '/admin/tasks/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
      body: JSON.stringify({ ids: [id1, id2, 'nao-existe'], status: 'pendente' })
    }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.total, 3);
    assert.strictEqual(data.sucesso, 2);
    assert.strictEqual(data.falha, 1);
    assert.strictEqual((await d1GetChamado(env, id1)).status, 'pendente');
    assert.strictEqual((await d1GetChamado(env, id2)).status, 'pendente');
    const falhou = data.results.find(r => r.id === 'nao-existe');
    assert.strictEqual(falhou.ok, false);
    assert.strictEqual(falhou.error, 'chamado não encontrado');
  });
  await test('ação em lote também grava evento automático por chamado', async () => {
    const id = await criarChamadoTeste({ status: 'aberto' });
    await worker.fetch(req('POST', '/admin/tasks/bulk', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ ids: [id], status: 'em atendimento' })
    }), env);
    const eventos = await d1ListEventos(env, id);
    assert.strictEqual(eventos.length, 1);
    assert.strictEqual(eventos[0].tipo, 'status');
  });

  console.log('--- validação de tipo/valor (achados do revisor 2026-08-07) ---');
  await test('solucao com tipo diferente de string dá 400 (não fica ok:true em silêncio)', async () => {
    const id = await criarChamadoTeste();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ solucao: 123 })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('assigneeId não numérico (nem null) dá 400', async () => {
    const id = await criarChamadoTeste();
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: 'nao-e-numero' })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('atualizar só o status de um chamado com 2 assignees NÃO toca na tabela de junção (preserva os dois)', async () => {
    // Este é o cenário do bug crítico encontrado pelo revisor em 2026-08-07: o front-end
    // só deve mandar "assigneeId" quando o admin realmente toca o campo — aqui simula
    // exatamente o corpo que admin.js manda (sem a chave assigneeId) e confirma que o
    // Worker não sincroniza chamado_assignees nesse caso (d1TransitionStatus nunca passa
    // assigneeIdsForSync pra d1UpdateChamado).
    const id = await criarChamadoTeste({ assignee_id: 170628721, assignee_ids: [170628721, 200498355] });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'pendente' })
    }), env);
    assert.strictEqual(res.status, 200);
    const { results } = await env.CHAMADOS_DB.prepare('SELECT assignee_id FROM chamado_assignees WHERE chamado_id = ? ORDER BY assignee_id').bind(id).all();
    assert.deepStrictEqual(results.map(r => r.assignee_id), [170628721, 200498355], 'sem a chave assigneeId no body, os dois operadores deveriam continuar intactos');
  });
  await test('falha ao salvar a solução reporta em "updated" o que já tinha sido aplicado antes (status)', async () => {
    const id = await criarChamadoTeste();
    // Simula falha do D1 especificamente na sub-mutação da solução, depois do status já
    // ter aplicado — mesma proteção do revisor de 2026-08-07 (reportar `updated` parcial
    // em vez de mascarar estado parcial), agora validada contra o D1 direto, não a ClickUp.
    const realPrepare = env.CHAMADOS_DB.prepare.bind(env.CHAMADOS_DB);
    env.CHAMADOS_DB.prepare = (sql) => {
      if (sql.includes('SET solucao')) throw new Error('D1 indisponível (simulado)');
      return realPrepare(sql);
    };
    try {
      const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
        body: JSON.stringify({ status: 'em atendimento', solucao: 'tentativa que vai falhar' })
      }), env);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.deepStrictEqual(data.updated, { status: 'em atendimento' }, 'deveria reportar que o status já tinha sido salvo antes da solução falhar');
    } finally {
      env.CHAMADOS_DB.prepare = realPrepare;
    }
  });

  console.log('--- lockout de ADMIN_SECRET por IP (mesma proteção do login, mas por IP em vez de nome) ---');
  await test('após 5 tentativas com X-Admin-Secret errado do mesmo IP, o IP fica bloqueado mesmo com o segredo certo depois', async () => {
    const ipHeaders = { 'CF-Connecting-IP': '203.0.113.9' };
    for (let i = 0; i < 5; i++) {
      const r = await worker.fetch(req('GET', '/admin/users', { headers: { ...ipHeaders, 'X-Admin-Secret': 'chute-errado' } }), env);
      assert.strictEqual(r.status, 403, `tentativa ${i + 1} deveria dar 403`);
    }
    const withCorrectSecret = await worker.fetch(req('GET', '/admin/users', { headers: { ...ipHeaders, 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(withCorrectSecret.status, 403, 'IP travado por lockout deveria continuar bloqueado mesmo com o segredo certo');
  });
  await test('outro IP não é afetado pelo lockout do IP anterior', async () => {
    const res = await worker.fetch(req('GET', '/admin/users', { headers: { 'CF-Connecting-IP': '198.51.100.20', 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('requisição sem X-Admin-Secret nenhum não conta como tentativa de adivinhar (não contribui pro lockout)', async () => {
    const ipHeaders = { 'CF-Connecting-IP': '192.0.2.55' };
    for (let i = 0; i < 10; i++) {
      await worker.fetch(req('GET', '/admin/users', { headers: ipHeaders }), env); // sem X-Admin-Secret nenhum
    }
    const res = await worker.fetch(req('GET', '/admin/users', { headers: { ...ipHeaders, 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res.status, 200, 'não deveria estar bloqueado só por chamadas sem header nenhum');
  });

  console.log('--- CORS e logout ---');
  await test('CORS restrito à origem do GitHub Pages, não mais "*"', async () => {
    const res = await worker.fetch(req('OPTIONS', '/api/solicitantes'), env);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'https://tecnologiadainformacaoisv.github.io');
  });
  await test('CORS reflete o domínio próprio do instituto (preflight e resposta normal)', async () => {
    const origin = 'https://chamados.institutosaovicente.com.br';
    const pre = await worker.fetch(req('OPTIONS', '/api/solicitantes', { headers: { Origin: origin } }), env);
    assert.strictEqual(pre.headers.get('Access-Control-Allow-Origin'), origin);
    assert.ok((pre.headers.get('Vary') || '').includes('Origin'));
    const res = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET, Origin: origin } }), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), origin);
  });
  await test('CORS de origem desconhecida cai na origem padrão, nunca é refletida nem vira "*"', async () => {
    const res = await worker.fetch(req('OPTIONS', '/api/solicitantes', { headers: { Origin: 'https://evil.example.com' } }), env);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'https://tecnologiadainformacaoisv.github.io');
    const lookalike = await worker.fetch(req('OPTIONS', '/api/solicitantes', { headers: { Origin: 'https://chamados.institutosaovicente.com.br.evil.com' } }), env);
    assert.strictEqual(lookalike.headers.get('Access-Control-Allow-Origin'), 'https://tecnologiadainformacaoisv.github.io');
  });
  await test('logout invalida a sessão', async () => {
    await worker.fetch(req('POST', '/auth/logout', { headers: { 'X-Session-Token': token } }), env);
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(res.status, 401);
  });

  // Fase M5 (2026-08-13): POST /admin/migrate-d1 removida (já rodou em produção — 453/453
  // chamados reais migrados, ver CLAUDE.md) — sem rota, sem teste. `mig-1` (fixture usada
  // pelos testes de migração de schema abaixo) agora é semeada direto via
  // seedChamadoComId, no lugar de vir de uma migração da ClickUp.

  console.log('--- POST /admin/migrate-schema-nullable-tipo-setor (Fase B7, mesmo dia — recria a tabela pra permitir NULL em tipo/setor) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-nullable-tipo-setor', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('migra o schema preservando os dados já gravados, e continua idempotente rodando de novo', async () => {
    await seedChamadoComId(env, 'mig-1', {
      name: 'Impressora não imprime', status: 'aberto', priority: 2, tipo: 2, setor: 1,
      solicitante: 'Michael Vasconcelos', assignee_id: 170628721, due_date: 1700000000000,
    });
    const antes = await d1GetChamado(env, 'mig-1');
    assert.ok(antes, 'pré-condição: mig-1 já devia estar no D1 antes da migração de schema');

    const res = await worker.fetch(req('POST', '/admin/migrate-schema-nullable-tipo-setor', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);

    const depois = await d1GetChamado(env, 'mig-1');
    assert.ok(depois, 'mig-1 deveria continuar no D1 depois de recriar a tabela');
    assert.strictEqual(depois.name, antes.name);
    assert.strictEqual(depois.tipo, antes.tipo);

    // agora tipo/setor ausentes não devem mais dar erro de constraint na hora de gravar.
    await seedChamadoComId(env, 'schema-v2-check', {
      name: 'Chamado de teste pós-migração', status: 'aberto', priority: 3,
      tipo: null, setor: null, solicitante: 'Michael Vasconcelos',
    });
    const gravado = await d1GetChamado(env, 'schema-v2-check');
    assert.strictEqual(gravado.tipo, null);
    assert.strictEqual(gravado.setor, null);

    // rodar a migração de schema DE NOVO não apaga nem duplica nada
    const res2 = await worker.fetch(req('POST', '/admin/migrate-schema-nullable-tipo-setor', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res2.status, 200);
    const aindaLa = await d1GetChamado(env, 'schema-v2-check');
    assert.ok(aindaLa, 'segunda rodada da migração de schema não deveria ter perdido nenhuma linha');
  });

  console.log('--- POST /admin/migrate-schema-chamado-eventos (Fase B pós-MVP-visual, 2026-08-14) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-chamado-eventos', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('cria a tabela chamado_eventos, idempotente rodando de novo', async () => {
    const res1 = await worker.fetch(req('POST', '/admin/migrate-schema-chamado-eventos', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res1.status, 200);
    const res2 = await worker.fetch(req('POST', '/admin/migrate-schema-chamado-eventos', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res2.status, 200);
  });

  console.log('--- suporte a múltiplos operadores (B7 parte 2, fase 1 — 2026-08-12) ---');
  async function assigneesDoChamado(id) {
    const { results } = await env.CHAMADOS_DB.prepare(
      'SELECT assignee_id FROM chamado_assignees WHERE chamado_id = ? ORDER BY assignee_id'
    ).bind(id).all();
    return results.map(r => r.assignee_id);
  }

  await test('sem X-Admin-Secret dá 403 (migração de schema da tabela nova)', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-chamado-assignees', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('cria a tabela chamado_assignees, idempotente rodando de novo', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-chamado-assignees', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res.status, 200);
    const res2 = await worker.fetch(req('POST', '/admin/migrate-schema-chamado-assignees', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
    }), env);
    assert.strictEqual(res2.status, 200, 'rodar de novo não deveria falhar (CREATE ... IF NOT EXISTS)');
  });

  await test('chamado com 2+ operadores grava os dois na tabela de junção (via assignee_ids)', async () => {
    await seedChamadoComId(env, 'multi-op-1', {
      name: 'Chamado com dois operadores', status: 'aberto', priority: 3, tipo: 0, setor: 0,
      solicitante: 'Michael Vasconcelos', assignee_id: 170628721,
      assignee_ids: [170628721, 200498355],
    });

    const row = await d1GetChamado(env, 'multi-op-1');
    assert.strictEqual(row.assignee_id, 170628721, 'coluna assignee_id continua guardando só o 1º (compat com /api/my-tasks)');
    assert.deepStrictEqual(await assigneesDoChamado('multi-op-1'), [170628721, 200498355], 'os DOIS operadores devem estar na tabela de junção');
  });

  // 🛡️ Achado do revisor (2026-08-12): o teste de "array completo de assignees" lá em
  // cima em /admin/tasks só exercitava um chamado com 1 assignee — nunca provava, pela
  // rota HTTP de verdade, que 2+ operadores voltam completos (só testes diretos contra
  // d1GetChamado/a tabela de junção cobriam isso). Fechando essa lacuna aqui, com
  // multi-op-1 (2 assignees reais) e passando pelo handler real de GET /admin/tasks.
  await test('GET /admin/tasks devolve os 2+ assignees completos de um chamado real (não só o primeiro) — o motivo de existir a B7 parte 2', async () => {
    const res = await worker.fetch(req('GET', '/admin/tasks?operador=200498355', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    const { tasks } = await res.json();
    const multiOp = tasks.find(t => t.id === 'multi-op-1');
    assert.ok(multiOp, 'filtrar pelo 2º operador (Henrique, não o assignee_id "principal") deveria encontrar o chamado mesmo assim');
    assert.deepStrictEqual(multiOp.assignees.map(a => a.id).sort(), [170628721, 200498355], 'os 2 operadores reais deveriam vir completos, não só o primeiro');
  });

  // Fase M5 (2026-08-13): o teste "rodar a migração de novo também sincroniza operador…
  // (backfill)" que existia aqui foi removido — testava especificamente reprocessar
  // `POST /admin/migrate-d1` pra backfillar `chamado_assignees` de um chamado que já
  // estava no D1 de antes dessa tabela existir; a rota (e o cenário que ela cobria) não
  // existem mais. `d1SetAssignees`/`buildSetAssigneesStatements` continuam cobertas pelo
  // teste acima e por tests/d1-layer.test.js.

  await test('atualização admin com operador único substitui a tabela de junção por completo', async () => {
    // Fase M4: sem mock de ClickUp nenhum — handleAdminUpdateTask nem chama fetch mais
    // pra atualizar assignee (não precisa mais buscar quem já estava atribuído pra
    // montar um diff {add,rem}, d1UpdateChamado já substitui por completo).
    const res = await worker.fetch(req('POST', '/admin/tasks/multi-op-1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: 170628721 }),
    }), env);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await assigneesDoChamado('multi-op-1'), [170628721], 'painel de admin sempre colapsa pra 1 operador — junção deve refletir isso, sem sobrar o Henrique');
  });

  console.log('--- atomicidade entre chamados.assignee_id e chamado_assignees numa atualização admin (Fase M4) ---');
  await test('se o .batch() falhar ao salvar o operador, nem assignee_id nem a tabela de junção mudam — tudo ou nada', async () => {
    // Fase M4: a garantia de atomicidade que importava de verdade (achado do revisor,
    // 2026-08-12) sempre foi entre `chamados.assignee_id` e `chamado_assignees` — as
    // DUAS linhas que representam "quem está atribuído" — não entre campos
    // independentes como status/operador (esses nunca tiveram transação real entre si,
    // nem quando cada um era uma chamada separada à ClickUp; ver comentário no topo de
    // handleAdminUpdateTask). Isso continua garantido porque `d1UpdateChamado` sempre
    // grava as duas no MESMO `.batch()` quando `assigneeIdsForSync` é passado.
    //
    // Diferença real em relação à versão anterior deste teste (que existia quando D1 era
    // só espelho best-effort da ClickUp): antes, o endpoint respondia 200 mesmo com o
    // `.batch()` falhando (a mutação "de verdade" já tinha sido aplicada na ClickUp).
    // Agora o D1 É a escrita — uma falha aqui é uma falha real, reportada como erro.
    const atomicEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    const created = await d1CreateChamado(atomicEnv, {
      name: 'Chamado pra teste de atomicidade', priority: 3, tipo: 0, setor: 0,
      solicitante: 'Michael Vasconcelos', status: 'aberto', assignee_id: 200498355,
    });

    const realBatch = atomicEnv.CHAMADOS_DB.batch.bind(atomicEnv.CHAMADOS_DB);
    atomicEnv.CHAMADOS_DB.batch = async () => { throw new Error('D1 indisponível (simulado)'); };
    try {
      const res = await worker.fetch(req('POST', `/admin/tasks/${created.id}`, {
        headers: { 'X-Admin-Secret': atomicEnv.ADMIN_SECRET },
        body: JSON.stringify({ assigneeId: 170628721 }),
      }), atomicEnv);
      assert.strictEqual(res.status, 400, 'D1 é a escrita agora — uma falha real deveria virar erro, não um 200 silencioso');
    } finally {
      atomicEnv.CHAMADOS_DB.batch = realBatch;
    }

    const after = await d1GetChamado(atomicEnv, created.id);
    assert.strictEqual(after.assignee_id, 200498355, 'assignee_id NÃO deveria ter mudado — o batch falhou, nada aplicou');
    const { results } = await atomicEnv.CHAMADOS_DB.prepare('SELECT assignee_id FROM chamado_assignees WHERE chamado_id = ?').bind(created.id).all();
    assert.deepStrictEqual(results.map(r => r.assignee_id), [200498355], 'tabela de junção também não deveria ter mudado — sem isso, ficaria mostrando o Henrique enquanto assignee_id ainda diz Everson (ou pior, vazia)');
  });

  // ===================================================================
  // Endurecimento do servidor (2026-11-11) — env isolado pra não mexer no estado dos
  // testes acima.
  // ===================================================================
  console.log('--- endurecimento do servidor (2026-11-11) ---');
  const hEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1(), ANEXOS: makeMockR2(), VAPID_PRIVATE_JWK: vapidPrivateJwkAdmin, VAPID_PUBLIC_KEY: 'fake-vapid-public-key' };
  const ADM = { 'X-Admin-Secret': 'admin-secret' };
  const doPost = (path, headers, body) => worker.fetch(req('POST', path, { headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), hEnv);
  async function cadastra(nome, ip = '10.0.0.1') {
    await d1CreateSolicitante(hEnv, nome, emailFor(nome));
    const r = await doPost('/auth/register', { ...SECRET_HEADERS, 'CF-Connecting-IP': ip }, { email: emailFor(nome), nome, password: 'senhaboa123' });
    return (await r.json()).token;
  }
  const comSessao = (t, extra = {}) => ({ ...SECRET_HEADERS, 'X-Session-Token': t, ...extra });
  const tipoOk = [{ id: TIPO_FIELD_ID, value: 0 }];

  // 1) validação da criação de chamado
  const tCriar = await cadastra('Pessoa Criar');
  await test('criar chamado sem título dá 400 e NÃO ativa o throttle', async () => {
    const r1 = await doPost('/api/tasks', comSessao(tCriar), { name: '   ', description: 'x', custom_fields: tipoOk });
    assert.strictEqual(r1.status, 400);
    const r2 = await doPost('/api/tasks', comSessao(tCriar), { name: 'Título válido', description: 'x', custom_fields: tipoOk });
    assert.strictEqual(r2.status, 200, 'pedido inválido anterior não podia travar a pessoa');
  });
  await test('criar chamado com título/descrição gigantes ou assignees lixo dá 400', async () => {
    const t2 = await cadastra('Pessoa Criar Dois');
    const casos = [
      { name: 'a'.repeat(201) },
      { name: 'ok', description: 'd'.repeat(5001) },
      { name: 'ok', description: 123 },
      { name: 'ok', assignees: 'não é lista' },
      { name: 'ok', assignees: [1, 2, 3, 4, 5, 6] },
      { name: 'ok', assignees: ['abc'] },
      { name: 'ok', assignees: [-5] },
    ];
    for (const c of casos) {
      const r = await doPost('/api/tasks', comSessao(t2), { ...c, custom_fields: tipoOk });
      assert.strictEqual(r.status, 400, JSON.stringify(c).slice(0, 60));
    }
  });
  await test('throttle: segundo chamado em seguida ainda dá 429', async () => {
    const r = await doPost('/api/tasks', comSessao(tCriar), { name: 'Outro', custom_fields: tipoOk });
    assert.strictEqual(r.status, 429);
  });

  // 2) revogação de sessão
  await test('desativar o solicitante derruba a sessão dele', async () => {
    const t = await cadastra('Pessoa Desativada');
    const antes = await worker.fetch(req('GET', '/api/my-tasks', { headers: comSessao(t) }), hEnv);
    assert.strictEqual(antes.status, 200);
    await doPost(`/admin/solicitantes/${encodeURIComponent('Pessoa Desativada')}/ativo`, ADM, { ativo: false });
    const depois = await worker.fetch(req('GET', '/api/my-tasks', { headers: comSessao(t) }), hEnv);
    assert.strictEqual(depois.status, 401);
  });
  await test('reset de senha derruba a sessão; entrar de novo cria sessão válida', async () => {
    const t = await cadastra('Pessoa Resetada');
    await doPost(`/admin/users/${encodeURIComponent('Pessoa Resetada')}/reset-senha`, ADM, {});
    const morta = await worker.fetch(req('GET', '/api/my-tasks', { headers: comSessao(t) }), hEnv);
    assert.strictEqual(morta.status, 401);
    const reg = await doPost('/auth/register', SECRET_HEADERS, { email: emailFor('Pessoa Resetada'), nome: 'Pessoa Resetada', password: 'senhaNova123' });
    const novo = (await reg.json()).token;
    const viva = await worker.fetch(req('GET', '/api/my-tasks', { headers: comSessao(novo) }), hEnv);
    assert.strictEqual(viva.status, 200);
  });
  await test('desativado não consegue logar mesmo com a senha certa', async () => {
    const r = await doPost('/auth/login', SECRET_HEADERS, { email: emailFor('Pessoa Desativada'), password: 'senhaboa123' });
    assert.strictEqual(r.status, 401);
  });

  // 3) primeiro acesso: tentativas com e-mail desconhecido têm teto por IP (generoso)
  await test('varredura de e-mails desconhecidos no primeiro acesso é freada por IP (429), outro IP segue livre', async () => {
    const ip = '203.0.113.200';
    let ultimo;
    for (let i = 0; i < 41; i++) {
      ultimo = await doPost('/auth/register', { ...SECRET_HEADERS, 'CF-Connecting-IP': ip }, { email: `ninguem${i}@institutosaovicente.com.br`, password: 'senhaboa123' });
    }
    assert.strictEqual(ultimo.status, 429);
    const outro = await doPost('/auth/register', { ...SECRET_HEADERS, 'CF-Connecting-IP': '203.0.113.201' }, { email: 'ninguem@institutosaovicente.com.br', password: 'senhaboa123' });
    assert.strictEqual(outro.status, 403);
  });
  await test('cadastro legítimo de muita gente no mesmo IP (escritório) não é barrado', async () => {
    for (let i = 0; i < 12; i++) {
      const nome = `Colega Escritorio ${'abcdefghijkl'[i]}`;
      await d1CreateSolicitante(hEnv, nome, emailFor(nome));
      const r = await doPost('/auth/register', { ...SECRET_HEADERS, 'CF-Connecting-IP': '198.18.0.1' }, { email: emailFor(nome), nome, password: 'senhaboa123' });
      assert.strictEqual(r.status, 200, nome);
    }
  });

  // 4) lockout por nome+IP
  await test('errar a senha de outro IP não tranca o dono da conta', async () => {
    await cadastra('Pessoa Alvo');
    for (let i = 0; i < 6; i++) {
      await doPost('/auth/login', { ...SECRET_HEADERS, 'CF-Connecting-IP': '192.0.2.250' }, { email: emailFor('Pessoa Alvo'), password: 'errada' });
    }
    const atacante = await doPost('/auth/login', { ...SECRET_HEADERS, 'CF-Connecting-IP': '192.0.2.250' }, { email: emailFor('Pessoa Alvo'), password: 'senhaboa123' });
    assert.strictEqual(atacante.status, 429, 'o IP que errou fica travado');
    const dono = await doPost('/auth/login', { ...SECRET_HEADERS, 'CF-Connecting-IP': '192.0.2.10' }, { email: emailFor('Pessoa Alvo'), password: 'senhaboa123' });
    assert.strictEqual(dono.status, 200, 'o dono, de outro IP, continua entrando');
  });
  await test('ataque distribuído (muitos IPs) esbarra no teto por nome', async () => {
    await cadastra('Pessoa Distribuida');
    for (let i = 0; i < 30; i++) {
      await doPost('/auth/login', { ...SECRET_HEADERS, 'CF-Connecting-IP': `100.64.0.${i + 1}` }, { email: emailFor('Pessoa Distribuida'), password: 'errada' });
    }
    const r = await doPost('/auth/login', { ...SECRET_HEADERS, 'CF-Connecting-IP': '100.64.1.1' }, { email: emailFor('Pessoa Distribuida'), password: 'senhaboa123' });
    assert.strictEqual(r.status, 429);
  });

  // 5) /subscribe
  await test('/subscribe rejeita endpoint http, sem chaves ou lixo; aceita subscription válida', async () => {
    const t = await cadastra('Pessoa Push');
    const ok = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'AAAA', auth: 'BBBB' } };
    for (const ruim of [
      { endpoint: 'http://push.example.test/abc', keys: ok.keys },
      { endpoint: 'não é url', keys: ok.keys },
      { endpoint: ok.endpoint },
      { endpoint: ok.endpoint, keys: { p256dh: 1, auth: 2 } },
      { endpoint: 'https://x.test/' + 'a'.repeat(1100), keys: ok.keys },
    ]) {
      const r = await doPost('/subscribe', comSessao(t), { subscription: ruim });
      assert.strictEqual(r.status, 400, JSON.stringify(ruim).slice(0, 60));
    }
    const bom = await doPost('/subscribe', comSessao(t), { subscription: ok });
    assert.strictEqual(bom.status, 200);
  });

  // 6) anexos
  const tAnexo = await cadastra('Pessoa Anexo');
  const chamadoAnexo = await (await doPost('/api/tasks', comSessao(tAnexo), { name: 'Com anexos', custom_fields: tipoOk })).json();
  const anexoForm = (nome, tipo, conteudo = 'bytes') => { const f = new FormData(); f.append('attachment', new File([conteudo], nome, { type: tipo })); return f; };
  const subir = (nome, tipo, conteudo) => worker.fetch(req('POST', `/api/tasks/${chamadoAnexo.id}/attachment`, { headers: { 'X-App-Secret': 'shared-secret', 'X-Session-Token': tAnexo }, body: anexoForm(nome, tipo, conteudo) }), hEnv);
  await test('anexo HTML/SVG é servido como download (octet-stream + attachment + nosniff + CSP)', async () => {
    const up = await subir('pagina.html', 'text/html', '<script>alert(1)</script>');
    assert.strictEqual(up.status, 200);
    const { id } = await up.json();
    const r = await worker.fetch(req('GET', `/api/anexos/${id}`, { headers: comSessao(tAnexo) }), hEnv);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('Content-Type'), 'application/octet-stream');
    assert.ok(r.headers.get('Content-Disposition').startsWith('attachment;'));
    assert.strictEqual(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.ok(r.headers.get('Content-Security-Policy').includes('sandbox'));
  });
  await test('anexo PNG continua aparecendo inline', async () => {
    const up = await subir('foto ç.png', 'image/png');
    const { id } = await up.json();
    const r = await worker.fetch(req('GET', `/api/anexos/${id}`, { headers: comSessao(tAnexo) }), hEnv);
    assert.strictEqual(r.headers.get('Content-Type'), 'image/png');
    assert.ok(r.headers.get('Content-Disposition').startsWith('inline;'));
    assert.ok(r.headers.get('Content-Disposition').includes("filename*=UTF-8''foto%20%C3%A7.png"));
  });
  await test('limite de 5 anexos por chamado', async () => {
    for (let i = 0; i < 3; i++) await subir(`extra${i}.png`, 'image/png'); // já tem 2 -> 5
    const r = await subir('sexto.png', 'image/png');
    assert.strictEqual(r.status, 400);
  });
  await test('se o INSERT do anexo falhar, o arquivo não fica órfão no R2', async () => {
    const t = await cadastra('Pessoa Orfao');
    const c = await (await doPost('/api/tasks', comSessao(t), { name: 'Orfão', custom_fields: tipoOk })).json();
    const antes = hEnv.ANEXOS._store ? hEnv.ANEXOS._store.size : null;
    const prep = hEnv.CHAMADOS_DB.prepare.bind(hEnv.CHAMADOS_DB);
    hEnv.CHAMADOS_DB.prepare = (sql) => {
      if (/INSERT INTO chamado_anexos/.test(sql)) return { bind: () => ({ run: async () => { throw new Error('D1 fora (simulado)'); } }) };
      return prep(sql);
    };
    let r;
    try {
      r = await worker.fetch(req('POST', `/api/tasks/${c.id}/attachment`, { headers: { 'X-App-Secret': 'shared-secret', 'X-Session-Token': t }, body: anexoForm('a.png', 'image/png') }), hEnv);
    } finally { hEnv.CHAMADOS_DB.prepare = prep; }
    assert.strictEqual(r.status, 500);
    if (antes !== null) assert.strictEqual(hEnv.ANEXOS._store.size, antes, 'objeto no R2 deveria ter sido apagado');
  });
  await test('TI abre os anexos pelo admin (lista + arquivo); sem segredo dá 403', async () => {
    const lista = await worker.fetch(req('GET', `/admin/tasks/${chamadoAnexo.id}/anexos`, { headers: ADM }), hEnv);
    assert.strictEqual(lista.status, 200);
    const { anexos } = await lista.json();
    assert.strictEqual(anexos.length, 5);
    assert.ok(anexos[0].url.includes('/admin/anexos/'));
    const arq = await worker.fetch(req('GET', `/admin/anexos/${anexos[0].id}`, { headers: ADM }), hEnv);
    assert.strictEqual(arq.status, 200);
    assert.strictEqual(arq.headers.get('X-Content-Type-Options'), 'nosniff');
    const sem = await worker.fetch(req('GET', `/admin/anexos/${anexos[0].id}`, {}), hEnv);
    assert.strictEqual(sem.status, 403);
    const semLista = await worker.fetch(req('GET', `/admin/tasks/${chamadoAnexo.id}/anexos`, {}), hEnv);
    assert.strictEqual(semLista.status, 403);
  });

  // 7) renomear solicitante (conta "Outros" -> conta de TI/testes)
  await test('renomear cascateia: solicitantes, chamados, senha e push; sessão antiga morre', async () => {
    await d1CreateSolicitante(hEnv, 'Outros', null);
    const c = await d1CreateChamado(hEnv, { name: 'Teste antigo', status: 'aberto', priority: 3, tipo: 0, setor: 0, solicitante: 'Outros', due_date: Date.now() + 1000 });
    await hEnv.SUBSCRIPTIONS.put('usub_Outros', '{"endpoint":"https://x.test/"}');
    await hEnv.SUBSCRIPTIONS.put('auth_Outros', '{"algo":"x"}');
    const sem = await doPost(`/admin/solicitantes/Outros/renomear`, {}, { novoNome: 'TI Testes' });
    assert.strictEqual(sem.status, 403);
    const ruimEmail = await doPost(`/admin/solicitantes/Outros/renomear`, ADM, { novoNome: 'TI Testes', email: 'x@gmail.com' });
    assert.strictEqual(ruimEmail.status, 400);
    const r = await doPost(`/admin/solicitantes/Outros/renomear`, ADM, { novoNome: 'TI Testes', email: 'ti.testes@institutosaovicente.com.br' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await d1GetChamado(hEnv, c.id)).solicitante, 'TI Testes');
    const sol = await hEnv.CHAMADOS_DB.prepare('SELECT name, email FROM solicitantes WHERE email = ?').bind('ti.testes@institutosaovicente.com.br').first();
    assert.strictEqual(sol.name, 'TI Testes');
    assert.ok(await hEnv.SUBSCRIPTIONS.get('auth_TI Testes'));
    assert.ok(!(await hEnv.SUBSCRIPTIONS.get('auth_Outros')));
    assert.ok(await hEnv.SUBSCRIPTIONS.get('usub_TI Testes'));
    const dup = await doPost(`/admin/solicitantes/${encodeURIComponent('Pessoa Alvo')}/renomear`, ADM, { novoNome: 'TI Testes' });
    assert.strictEqual(dup.status, 409);
    const inexistente = await doPost(`/admin/solicitantes/Fantasma/renomear`, ADM, { novoNome: 'Qualquer Um' });
    assert.strictEqual(inexistente.status, 404);
  });

  // 7a) transferir chamados entre solicitantes (2026-11-13)
  await test('transferir-chamados: exige admin, valida contas e move só os chamados da origem', async () => {
    await d1CreateSolicitante(hEnv, 'Conta Origem', null);
    await d1CreateSolicitante(hEnv, 'Conta Destino', null);
    const a = await d1CreateChamado(hEnv, { name: 'A', status: 'aberto', priority: 3, tipo: 0, setor: 0, solicitante: 'Conta Origem', due_date: Date.now() + 1000 });
    const b = await d1CreateChamado(hEnv, { name: 'B', status: 'aberto', priority: 3, tipo: 0, setor: 0, solicitante: 'Conta Origem', due_date: Date.now() + 1000 });
    const outro = await d1CreateChamado(hEnv, { name: 'C', status: 'aberto', priority: 3, tipo: 0, setor: 0, solicitante: 'Conta Destino', due_date: Date.now() + 1000 });
    const rota = `/admin/solicitantes/${encodeURIComponent('Conta Origem')}/transferir-chamados`;
    assert.strictEqual((await doPost(rota, {}, { para: 'Conta Destino' })).status, 403);
    assert.strictEqual((await doPost(rota, ADM, {})).status, 400);
    assert.strictEqual((await doPost(rota, ADM, { para: 'Conta Origem' })).status, 400);
    assert.strictEqual((await doPost(rota, ADM, { para: 'Fantasma' })).status, 404);
    const r = await doPost(rota, ADM, { para: 'Conta Destino' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).transferidos, 2);
    assert.strictEqual((await d1GetChamado(hEnv, a.id)).solicitante, 'Conta Destino');
    assert.strictEqual((await d1GetChamado(hEnv, b.id)).solicitante, 'Conta Destino');
    assert.strictEqual((await d1GetChamado(hEnv, outro.id)).solicitante, 'Conta Destino');
    assert.strictEqual((await doPost(`/admin/solicitantes/Fantasma/transferir-chamados`, ADM, { para: 'Conta Destino' })).status, 404);
    await hEnv.CHAMADOS_DB.prepare("DELETE FROM chamados WHERE solicitante = 'Conta Destino'").run();
    await hEnv.CHAMADOS_DB.prepare("DELETE FROM solicitantes WHERE name IN ('Conta Origem','Conta Destino')").run();
  });

  // 7b) excluir solicitante (2026-11-11)
  await test('excluir solicitante: exige admin, trava se tem chamados, apaga tudo com apagarChamados', async () => {
    await d1CreateSolicitante(hEnv, 'Descartavel', null);
    const c = await d1CreateChamado(hEnv, { name: 'Teste', status: 'aberto', priority: 3, tipo: 0, setor: 0, solicitante: 'Descartavel', due_date: Date.now() + 1000 });
    const outro = await d1CreateChamado(hEnv, { name: 'De outra pessoa', status: 'aberto', priority: 3, tipo: 0, setor: 0, solicitante: 'Pessoa Alvo', due_date: Date.now() + 1000 });
    await hEnv.SUBSCRIPTIONS.put('auth_Descartavel', '{"algo":"x"}');
    await hEnv.SUBSCRIPTIONS.put('usub_Descartavel', '{"endpoint":"https://x.test/"}');
    assert.strictEqual((await doPost('/admin/solicitantes/Descartavel/excluir', {}, {})).status, 403);
    const trava = await doPost('/admin/solicitantes/Descartavel/excluir', ADM, {});
    assert.strictEqual(trava.status, 409);
    assert.strictEqual((await trava.json()).chamados, 1);
    assert.ok(await d1GetChamado(hEnv, c.id), 'sem apagarChamados nada some');
    const ok = await doPost('/admin/solicitantes/Descartavel/excluir', ADM, { apagarChamados: true });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).chamadosApagados, 1);
    assert.ok(!(await d1GetChamado(hEnv, c.id)));
    assert.ok(await d1GetChamado(hEnv, outro.id), 'chamado de outra pessoa continua');
    assert.ok(!(await hEnv.CHAMADOS_DB.prepare('SELECT name FROM solicitantes WHERE name = ?').bind('Descartavel').first()));
    assert.ok(!(await hEnv.SUBSCRIPTIONS.get('auth_Descartavel')));
    assert.ok(!(await hEnv.SUBSCRIPTIONS.get('usub_Descartavel')));
    assert.strictEqual((await doPost('/admin/solicitantes/Descartavel/excluir', ADM, {})).status, 404);
  });
  await test('excluir solicitante sem chamados apaga direto, sem precisar de apagarChamados', async () => {
    await d1CreateSolicitante(hEnv, 'Sem Chamados', null);
    const r = await doPost('/admin/solicitantes/Sem%20Chamados/excluir', ADM, {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).chamadosApagados, 0);
  });

  // 8) número sequencial legível do chamado (2026-11-11)
  console.log('--- número do chamado ---');
  await test('chamados novos recebem numero 1, 2, 3… e ele aparece em /api/my-tasks', async () => {
    const nEnv = { ...hEnv, CHAMADOS_DB: freshD1(), SUBSCRIPTIONS: makeMockKV() };
    const a = await d1CreateChamado(nEnv, { name: 'A', priority: 3, tipo: 0, setor: 0, solicitante: 'Fulano' });
    const b = await d1CreateChamado(nEnv, { name: 'B', priority: 3, tipo: 0, setor: 0, solicitante: 'Fulano' });
    const c = await d1CreateChamado(nEnv, { name: 'C', priority: 3, tipo: 0, setor: 0, solicitante: 'Fulano' });
    assert.deepStrictEqual([a.numero, b.numero, c.numero], [1, 2, 3]);
    assert.strictEqual((await d1GetChamado(nEnv, b.id)).numero, 2);
    assert.strictEqual((await d1GetChamado(nEnv, a.id)).numero, 1);
    assert.strictEqual((await d1GetChamado(nEnv, c.id)).numero, 3);
  });
  await test('o número chega ao solicitante pela API (/api/tasks e /api/my-tasks)', async () => {
    const t = await cadastra('Pessoa Numero');
    const criado = await doPost('/api/tasks', comSessao(t), { name: 'Com número', custom_fields: tipoOk });
    assert.strictEqual(criado.status, 200);
    const corpo = await criado.json();
    assert.ok(Number.isInteger(corpo.numero) && corpo.numero > 0, 'resposta da criação traz o numero');
    const lista = await (await worker.fetch(req('GET', '/api/my-tasks', { headers: comSessao(t) }), hEnv)).json();
    assert.strictEqual(lista.tasks.find(x => x.id === corpo.id).numero, corpo.numero);
  });
  await test('migração do número: exige admin, numera os antigos por data de abertura e é idempotente', async () => {
    const mEnv = { ...hEnv, CHAMADOS_DB: freshD1(), SUBSCRIPTIONS: makeMockKV() };
    const t0 = Date.now() - 100000;
    await seedChamadoComId(mEnv, 'z-mais-novo', { name: 'Novo', priority: 3, tipo: 0, setor: 0, solicitante: 'X', date_created: t0 + 2000 });
    await seedChamadoComId(mEnv, 'a-mais-antigo', { name: 'Antigo', priority: 3, tipo: 0, setor: 0, solicitante: 'X', date_created: t0 });
    await seedChamadoComId(mEnv, 'm-meio', { name: 'Meio', priority: 3, tipo: 0, setor: 0, solicitante: 'X', date_created: t0 + 1000 });
    const sem = await worker.fetch(req('POST', '/admin/migrate-schema-chamados-numero', { headers: {} }), mEnv);
    assert.strictEqual(sem.status, 403);
    const r1 = await worker.fetch(req('POST', '/admin/migrate-schema-chamados-numero', { headers: ADM }), mEnv);
    assert.strictEqual(r1.status, 200);
    const num = async (id) => (await d1GetChamado(mEnv, id)).numero;
    assert.deepStrictEqual([await num('a-mais-antigo'), await num('m-meio'), await num('z-mais-novo')], [1, 2, 3]);
    // um chamado novo depois da migração continua a sequência; rodar de novo não renumera nada
    const novo = await d1CreateChamado(mEnv, { name: 'Depois', priority: 3, tipo: 0, setor: 0, solicitante: 'X' });
    assert.strictEqual(novo.numero, 4);
    const r2 = await worker.fetch(req('POST', '/admin/migrate-schema-chamados-numero', { headers: ADM }), mEnv);
    assert.strictEqual(r2.status, 200);
    assert.deepStrictEqual([await num('a-mais-antigo'), await num('m-meio'), await num('z-mais-novo'), await num(novo.id)], [1, 2, 3, 4]);
  });
  await test('migração do número: chamado criado ANTES dela (entre deploy e migração) não colide com os antigos', async () => {
    const gEnv = { ...hEnv, CHAMADOS_DB: freshD1(), SUBSCRIPTIONS: makeMockKV() };
    const t0 = Date.now() - 100000;
    await seedChamadoComId(gEnv, 'velho-1', { name: 'V1', priority: 3, tipo: 0, setor: 0, solicitante: 'X', date_created: t0 });
    await seedChamadoComId(gEnv, 'velho-2', { name: 'V2', priority: 3, tipo: 0, setor: 0, solicitante: 'X', date_created: t0 + 1000 });
    const entreOsDois = await d1CreateChamado(gEnv, { name: 'Criado no intervalo', priority: 3, tipo: 0, setor: 0, solicitante: 'X' });
    assert.strictEqual(entreOsDois.numero, 1); // MAX de NULLs = 0, então começa em 1
    await worker.fetch(req('POST', '/admin/migrate-schema-chamados-numero', { headers: ADM }), gEnv);
    const numeros = [(await d1GetChamado(gEnv, 'velho-1')).numero, (await d1GetChamado(gEnv, 'velho-2')).numero, (await d1GetChamado(gEnv, entreOsDois.id)).numero];
    assert.strictEqual(new Set(numeros).size, 3, `números repetidos: ${numeros}`);
    assert.deepStrictEqual(numeros.slice(0, 2), [2, 3]);
  });

  await test('deploy antes da migração: sem a coluna numero, abrir chamado ainda funciona (sem número)', async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
    raw.exec('ALTER TABLE chamados DROP COLUMN numero');
    const sEnv = { ...hEnv, CHAMADOS_DB: makeD1FromSqlite(raw), SUBSCRIPTIONS: makeMockKV() };
    const c = await d1CreateChamado(sEnv, { name: 'Sem coluna', priority: 3, tipo: 0, setor: 0, solicitante: 'X', assignee_id: 170628721 });
    assert.strictEqual(c.numero, null);
    assert.strictEqual((await d1GetChamado(sEnv, c.id)).name, 'Sem coluna');
    // e a migração, rodada depois, cria a coluna e numera
    const r = await worker.fetch(req('POST', '/admin/migrate-schema-chamados-numero', { headers: ADM }), sEnv);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await d1GetChamado(sEnv, c.id)).numero, 1);
  });

  // ---------------- Inventário de equipamentos (2026-11-23) ----------------
  const eqEnv = () => ({ ...hEnv, CHAMADOS_DB: freshD1(), SUBSCRIPTIONS: makeMockKV(), SOLICITACOES_ATIVO: 'true' });
  const eqPost = (env, path, body, headers = ADM) => worker.fetch(req('POST', path, { headers, body: JSON.stringify(body) }), env);
  const eqGet = (env, path, headers = ADM) => worker.fetch(req('GET', path, { headers }), env);

  await test('equipamentos: criar exige admin e tipo, e a lista mostra o que foi criado', async () => {
    const env = eqEnv();
    assert.strictEqual((await eqPost(env, '/admin/equipamentos', { tipo: 'impressora' }, {})).status, 403);
    assert.strictEqual((await eqPost(env, '/admin/equipamentos', { marca: 'Brother' })).status, 400);
    const c = await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 0001', marca: 'Brother', modelo: 'HL-1', origem: 'locado', fornecedor: 'Locadora X', setor: 1, local: 'Sala 3' });
    assert.strictEqual(c.status, 201);
    const lista = await (await eqGet(env, '/admin/equipamentos')).json();
    assert.strictEqual(lista.equipamentos.length, 1);
    assert.strictEqual(lista.equipamentos[0].tombamento, 'F 0001');
    assert.strictEqual(lista.equipamentos[0].origem, 'locado');
    assert.strictEqual(lista.equipamentos[0].chamadosTotal, 0);
    assert.strictEqual((await eqGet(env, '/admin/equipamentos', {})).status, 403);
  });
  await test('equipamentos: valores inválidos são recusados e tombamento repetido dá 409', async () => {
    const env = eqEnv();
    for (const corpo of [{ tipo: 'geladeira' }, { tipo: 'outro', origem: 'roubado' }, { tipo: 'outro', status: 'quebradão' }, { tipo: 'outro', setor: 'x' }, { tipo: 'outro', marca: 'a'.repeat(61) }, { tipo: 'outro', modelo: 5 }]) {
      assert.strictEqual((await eqPost(env, '/admin/equipamentos', corpo)).status, 400, JSON.stringify(corpo).slice(0, 60));
    }
    assert.strictEqual((await eqPost(env, '/admin/equipamentos', { tipo: 'monitor', tombamento: 'F 7' })).status, 201);
    assert.strictEqual((await eqPost(env, '/admin/equipamentos', { tipo: 'monitor', tombamento: 'F 7' })).status, 409);
    // vários sem tombamento são permitidos
    assert.strictEqual((await eqPost(env, '/admin/equipamentos', { tipo: 'monitor' })).status, 201);
    assert.strictEqual((await eqPost(env, '/admin/equipamentos', { tipo: 'monitor' })).status, 201);
  });
  await test('equipamentos: editar muda só o que veio, 404 se não existe, ativo:false some da lista', async () => {
    const env = eqEnv();
    const { id } = await (await eqPost(env, '/admin/equipamentos', { tipo: 'computador', marca: 'Dell', local: 'Recepção' })).json();
    assert.strictEqual((await eqPost(env, `/admin/equipamentos/${id}`, { status: 'manutencao' })).status, 200);
    let e = (await (await eqGet(env, '/admin/equipamentos')).json()).equipamentos[0];
    assert.strictEqual(e.status, 'manutencao');
    assert.strictEqual(e.marca, 'Dell');
    assert.strictEqual(e.local, 'Recepção');
    assert.strictEqual((await eqPost(env, `/admin/equipamentos/${id}`, { local: null })).status, 200);
    e = (await (await eqGet(env, '/admin/equipamentos')).json()).equipamentos[0];
    assert.strictEqual(e.local, null);
    assert.strictEqual((await eqPost(env, `/admin/equipamentos/${id}`, {})).status, 400);
    assert.strictEqual((await eqPost(env, '/admin/equipamentos/nao-existe', { marca: 'X' })).status, 404);
    assert.strictEqual((await eqPost(env, `/admin/equipamentos/${id}`, { ativo: false })).status, 200);
    assert.strictEqual((await (await eqGet(env, '/admin/equipamentos')).json()).equipamentos.length, 0);
  });
  await test('equipamentos: o solicitante só vê os em uso, sem número de série, e precisa de sessão', async () => {
    const env = eqEnv();
    await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 1', numero_serie: 'SECRETO-123' });
    await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 2', status: 'baixado' });
    const sem = await worker.fetch(req('GET', '/api/equipamentos', { headers: SECRET_HEADERS }), env);
    assert.strictEqual(sem.status, 401);
    await d1CreateSolicitante(env, 'Pessoa Equip', emailFor('Pessoa Equip'));
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '10.9.9.9' }, body: JSON.stringify({ email: emailFor('Pessoa Equip'), nome: 'Pessoa Equip', password: 'senhaboa123' }) }), env);
    const token = (await reg.json()).token;
    const r = await worker.fetch(req('GET', '/api/equipamentos', { headers: comSessao(token) }), env);
    assert.strictEqual(r.status, 200);
    const { equipamentos } = await r.json();
    assert.deepStrictEqual(equipamentos.map(x => x.tombamento), ['F 1']);
    assert.ok(!('numero_serie' in equipamentos[0]), 'não expõe nº de série ao solicitante');
  });
  await test('chamado com equipamento: vincula, conta no inventário e recusa equipamento inválido ou baixado', async () => {
    const env = eqEnv();
    const { id: eqId } = await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 10' })).json();
    const { id: baixadoId } = await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 11', status: 'baixado' })).json();
    await d1CreateSolicitante(env, 'Pessoa Vinculo', emailFor('Pessoa Vinculo'));
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '10.8.8.8' }, body: JSON.stringify({ email: emailFor('Pessoa Vinculo'), nome: 'Pessoa Vinculo', password: 'senhaboa123' }) }), env);
    const h = comSessao((await reg.json()).token);
    const abre = (extra) => worker.fetch(req('POST', '/api/tasks', { headers: h, body: JSON.stringify({ name: 'Imp', custom_fields: tipoOk, ...extra }) }), env);

    const ruim = await abre({ equipamento_id: 'nao-existe' });
    assert.strictEqual(ruim.status, 400);
    assert.strictEqual((await abre({ equipamento_id: baixadoId })).status, 400);
    assert.strictEqual((await abre({ equipamento_id: 12345 })).status, 400);
    // pedido recusado não consome o throttle de 60s
    const ok = await abre({ equipamento_id: eqId });
    assert.strictEqual(ok.status, 200);
    const corpo = await ok.json();
    assert.strictEqual(corpo.equipamento_id, eqId);
    assert.strictEqual((await d1GetChamado(env, corpo.id)).equipamento_id, eqId);
    const e = (await (await eqGet(env, '/admin/equipamentos')).json()).equipamentos.find(x => x.id === eqId);
    assert.deepStrictEqual([e.chamadosTotal, e.chamadosAbertos, e.chamados30d], [1, 1, 1]);
    // chamado de 40 dias atrás conta no total, mas não na reincidência de 30 dias
    await env.CHAMADOS_DB.prepare('UPDATE chamados SET date_created = ? WHERE id = ?').bind(Date.now() - 40 * 24 * 3600 * 1000, corpo.id).run();
    const e2 = (await (await eqGet(env, '/admin/equipamentos')).json()).equipamentos.find(x => x.id === eqId);
    assert.deepStrictEqual([e2.chamadosTotal, e2.chamados30d], [1, 0]);
    // sem equipamento continua funcionando (opcional)
    await env.SUBSCRIPTIONS.delete('throttle_create_Pessoa Vinculo');
    const sem = await (await abre({})).json();
    assert.strictEqual(sem.equipamento_id, null);
  });
  await test('chamado criado pelo admin também aceita equipamento', async () => {
    const env = eqEnv();
    const { id: eqId } = await (await eqPost(env, '/admin/equipamentos', { tipo: 'monitor' })).json();
    await d1CreateSolicitante(env, 'Pessoa Admin Eq', emailFor('Pessoa Admin Eq'));
    const r = await eqPost(env, '/admin/tasks', { name: 'Monitor sem imagem', solicitante: 'Pessoa Admin Eq', tipo: 6, equipamento_id: eqId });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).equipamento_id, eqId);
    assert.strictEqual((await eqPost(env, '/admin/tasks', { name: 'X', solicitante: 'Pessoa Admin Eq', equipamento_id: 'fantasma' })).status, 400);
  });
  await test('migração de equipamentos: cria tabela e coluna num banco antigo, exige admin e é idempotente', async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
    raw.exec('DROP INDEX idx_chamados_equipamento; ALTER TABLE chamados DROP COLUMN equipamento_id; DROP TABLE equipamentos;');
    const env = { ...hEnv, CHAMADOS_DB: makeD1FromSqlite(raw), SUBSCRIPTIONS: makeMockKV() };
    // deploy antes da migração: abrir chamado sem equipamento continua funcionando
    const antes = await d1CreateChamado(env, { name: 'Antes', priority: 3, tipo: 0, setor: 0, solicitante: 'X' });
    assert.ok(antes.id);
    assert.strictEqual((await eqPost(env, '/admin/migrate-schema-equipamentos', {}, {})).status, 403);
    assert.strictEqual((await eqPost(env, '/admin/migrate-schema-equipamentos', {})).status, 200);
    assert.strictEqual((await eqPost(env, '/admin/migrate-schema-equipamentos', {})).status, 200);
    const c = await eqPost(env, '/admin/equipamentos', { tipo: 'rede', tombamento: 'SW-1' });
    assert.strictEqual(c.status, 201);
    const { id } = await c.json();
    const novo = await d1CreateChamado(env, { name: 'Depois', priority: 3, tipo: 0, setor: 0, solicitante: 'X', equipamento_id: id });
    assert.strictEqual(novo.equipamento_id, id);
    assert.strictEqual((await d1GetChamado(env, antes.id)).equipamento_id, null);
  });

  // ---------------- Toners (2026-11-23) ----------------
  async function tonerEnv() {
    const env = eqEnv();
    const imp = await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 1' })).json();
    const mon = await (await eqPost(env, '/admin/equipamentos', { tipo: 'monitor', tombamento: 'F 2' })).json();
    return { env, imp: imp.id, mon: mon.id };
  }

  await test('toners: cadastrar exige admin, código e uma impressora do inventário', async () => {
    const { env, imp, mon } = await tonerEnv();
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-1' }, {})).status, 403);
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: imp })).status, 400);
    assert.strictEqual((await eqPost(env, '/admin/toners', { codigo: 'TN-1' })).status, 400);
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: 'fantasma', codigo: 'TN-1' })).status, 400);
    const monitor = await eqPost(env, '/admin/toners', { equipamento_id: mon, codigo: 'TN-1' });
    assert.strictEqual(monitor.status, 400);
    assert.match((await monitor.json()).error, /impressora/);
    for (const corpo of [{ cor: 'verde' }, { capacidade_paginas: -5 }, { capacidade_paginas: 1.5 }, { ciclo_dias_padrao: 99999 }, { codigo: 'x'.repeat(41) }]) {
      assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-1', ...corpo })).status, 400, JSON.stringify(corpo));
    }
    const ok = await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-1060', cor: 'preto', capacidade_paginas: 2600, ciclo_dias_padrao: 45 });
    assert.strictEqual(ok.status, 201);
    const lista = await (await eqGet(env, '/admin/toners')).json();
    assert.strictEqual(lista.toners.length, 1);
    assert.strictEqual(lista.toners[0].codigo, 'TN-1060');
    assert.strictEqual(lista.toners[0].tombamento, 'F 1');
    assert.ok('ip' in lista.toners[0] && 'local' in lista.toners[0] && 'setor' in lista.toners[0], 'a lista traz onde a impressora está');
    assert.deepStrictEqual(lista.toners[0].recargas, []);
    assert.strictEqual((await eqGet(env, '/admin/toners', {})).status, 403);
  });
  await test('toners: recarga entra na lista em ordem, valida a data e "desfazer" apaga só a mais recente', async () => {
    const { env, imp } = await tonerEnv();
    const { id } = await (await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-9' })).json();
    const D = 86400000, agora = Date.now();
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga`, {}, {})).status, 403);
    assert.strictEqual((await eqPost(env, '/admin/toners/nao-existe/recarga', {})).status, 404);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga`, { feita_em: agora + 5 * D })).status, 400);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga`, { feita_em: 'ontem' })).status, 400);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga`, { feita_em: agora - 60 * D, autor: 'Everson' })).status, 201);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga`, { feita_em: agora - 30 * D })).status, 201);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga`, {})).status, 201); // sem corpo útil = agora
    let rec = (await (await eqGet(env, '/admin/toners')).json()).toners[0].recargas;
    assert.strictEqual(rec.length, 3);
    assert.ok(rec[0] < rec[1] && rec[1] < rec[2], 'em ordem cronológica');
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga/desfazer`, {}, {})).status, 403);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga/desfazer`, {})).status, 200);
    const depois = (await (await eqGet(env, '/admin/toners')).json()).toners[0].recargas;
    assert.deepStrictEqual(depois, rec.slice(0, 2));
    await eqPost(env, `/admin/toners/${id}/recarga/desfazer`, {});
    await eqPost(env, `/admin/toners/${id}/recarga/desfazer`, {});
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}/recarga/desfazer`, {})).status, 404);
  });
  await test('toners: editar muda só o que veio, ativo:false some da lista, 404 se não existe', async () => {
    const { env, imp } = await tonerEnv();
    const { id } = await (await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-5', ciclo_dias_padrao: 30 })).json();
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}`, { cor: 'ciano' })).status, 200);
    let t = (await (await eqGet(env, '/admin/toners')).json()).toners[0];
    assert.deepStrictEqual([t.cor, t.codigo, t.ciclo_dias_padrao], ['ciano', 'TN-5', 30]);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}`, { ciclo_dias_padrao: null })).status, 200);
    t = (await (await eqGet(env, '/admin/toners')).json()).toners[0];
    assert.strictEqual(t.ciclo_dias_padrao, null);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}`, { codigo: '' })).status, 400);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}`, {})).status, 400);
    assert.strictEqual((await eqPost(env, '/admin/toners/nao-existe', { cor: 'preto' })).status, 404);
    assert.strictEqual((await eqPost(env, `/admin/toners/${id}`, { ativo: false })).status, 200);
    assert.strictEqual((await (await eqGet(env, '/admin/toners')).json()).toners.length, 0);
  });
  await test('migração de toners: cria as tabelas num banco antigo, exige admin e é idempotente', async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
    raw.exec('DROP TABLE toner_recargas; DROP TABLE toners;');
    const env = { ...hEnv, CHAMADOS_DB: makeD1FromSqlite(raw), SUBSCRIPTIONS: makeMockKV() };
    assert.strictEqual((await eqPost(env, '/admin/migrate-schema-toners', {}, {})).status, 403);
    assert.strictEqual((await eqPost(env, '/admin/migrate-schema-toners', {})).status, 200);
    assert.strictEqual((await eqPost(env, '/admin/migrate-schema-toners', {})).status, 200);
    const imp = await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora' })).json();
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: imp.id, codigo: 'TN-X' })).status, 201);
  });

  // ---------------- Leitura de toners pelo IP (agente na rede interna, 2026-11-23) ----------------
  const AG = { 'X-Agente-Secret': 'segredo-do-agente' };
  const agEnv = () => ({ ...eqEnv(), TONER_AGENT_SECRET: 'segredo-do-agente' });
  async function agenteCenario() {
    const env = agEnv();
    const imp = (await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 1', ip: '192.168.0.10' })).json()).id;
    await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 2' }); // sem IP: o agente não consulta
    await eqPost(env, '/admin/equipamentos', { tipo: 'monitor', tombamento: 'F 3', ip: '192.168.0.11' }); // não é impressora
    await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-P', cor: 'preto' });
    await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-C', cor: 'ciano' });
    return { env, imp };
  }

  await test('IP do equipamento: valida o formato, normaliza e pode ser limpo', async () => {
    const env = eqEnv();
    for (const ip of ['abc', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-4', 'a.b.c.d', 123]) {
      assert.strictEqual((await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', ip })).status, 400, String(ip));
    }
    const { id } = await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', ip: ' 192.168.001.010 ' })).json();
    let e = (await (await eqGet(env, '/admin/equipamentos')).json()).equipamentos[0];
    assert.strictEqual(e.ip, '192.168.1.10');
    assert.strictEqual((await eqPost(env, `/admin/equipamentos/${id}`, { ip: null })).status, 200);
    e = (await (await eqGet(env, '/admin/equipamentos')).json()).equipamentos[0];
    assert.strictEqual(e.ip, null);
  });
  await test('IP não vaza para o solicitante (GET /api/equipamentos)', async () => {
    const env = eqEnv();
    await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 1', ip: '10.0.0.5' });
    await d1CreateSolicitante(env, 'Pessoa Ip', emailFor('Pessoa Ip'));
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '10.7.7.7' }, body: JSON.stringify({ email: emailFor('Pessoa Ip'), nome: 'Pessoa Ip', password: 'senhaboa123' }) }), env);
    const r = await worker.fetch(req('GET', '/api/equipamentos', { headers: comSessao((await reg.json()).token) }), env);
    assert.ok(!JSON.stringify(await r.json()).includes('10.0.0.5'));
  });
  await test('agente: sem segredo, com segredo errado ou com o Worker sem TONER_AGENT_SECRET dá 403', async () => {
    const { env } = await agenteCenario();
    const get = (e, h) => worker.fetch(req('GET', '/agente/impressoras', { headers: h }), e);
    const post = (e, h) => worker.fetch(req('POST', '/agente/leituras', { headers: h, body: JSON.stringify({ leituras: [] }) }), e);
    for (const h of [{}, { 'X-Agente-Secret': 'errado' }, ADM, { 'X-Admin-Secret': 'segredo-do-agente' }]) {
      assert.strictEqual((await get(env, h)).status, 403);
      assert.strictEqual((await post(env, h)).status, 403);
    }
    const semConfig = { ...env, TONER_AGENT_SECRET: undefined };
    assert.strictEqual((await get(semConfig, { 'X-Agente-Secret': 'undefined' })).status, 403);
    assert.strictEqual((await get(semConfig, {})).status, 403);
    assert.strictEqual((await get(env, AG)).status, 200);
  });
  await test('agente: a lista traz só impressoras ativas com IP, e as cores que têm toner cadastrado', async () => {
    const { env, imp } = await agenteCenario();
    const { impressoras } = await (await worker.fetch(req('GET', '/agente/impressoras', { headers: AG }), env)).json();
    assert.strictEqual(impressoras.length, 1);
    assert.strictEqual(impressoras[0].id, imp);
    assert.strictEqual(impressoras[0].ip, '192.168.0.10');
    assert.deepStrictEqual(impressoras[0].cores.sort(), ['ciano', 'preto']);
  });
  await test('agente: leitura grava o nível no toner da cor certa, com a hora do servidor, e a lista de toners mostra', async () => {
    const { env, imp } = await agenteCenario();
    const antes = Date.now();
    const r = await worker.fetch(req('POST', '/agente/leituras', { headers: AG, body: JSON.stringify({ leituras: [{ equipamento_id: imp, consultado_em: 1, suprimentos: [{ cor: 'preto', nivel: 18 }, { cor: 'ciano', nivel: 0 }] }] }) }), env);
    assert.strictEqual(r.status, 200);
    const corpo = await r.json();
    assert.strictEqual(corpo.atualizados, 2);
    assert.deepStrictEqual(corpo.ignorados, []);
    const toners = (await (await eqGet(env, '/admin/toners')).json()).toners;
    const preto = toners.find(x => x.cor === 'preto');
    assert.strictEqual(preto.nivel_percentual, 18);
    assert.ok(preto.nivel_lido_em >= antes, 'usa a hora do servidor, não o consultado_em do agente');
    assert.strictEqual(toners.find(x => x.cor === 'ciano').nivel_percentual, 0);
  });
  await test('agente: cor sem toner cadastrado, impressora desconhecida e valores absurdos são ignorados e apontados', async () => {
    const { env, imp } = await agenteCenario();
    const post = (leituras) => worker.fetch(req('POST', '/agente/leituras', { headers: AG, body: JSON.stringify({ leituras }) }), env);
    const r = await (await post([
      { equipamento_id: imp, suprimentos: [{ cor: 'magenta', nivel: 50 }, { cor: 'preto', nivel: 101 }, { cor: 'preto', nivel: -1 }, { cor: 'preto', nivel: 12.5 }, { cor: 'verde', nivel: 10 }, { cor: 'preto', nivel: 40 }] },
      { equipamento_id: 'fantasma', suprimentos: [{ cor: 'preto', nivel: 10 }] },
      { suprimentos: [] },
    ])).json();
    assert.strictEqual(r.atualizados, 1);
    assert.strictEqual(r.ignorados.length, 7);
    assert.ok(r.ignorados.some(i => i.cor === 'magenta' && /sem toner/.test(i.motivo)));
    assert.ok(r.ignorados.some(i => i.equipamento_id === 'fantasma'));
    const preto = (await (await eqGet(env, '/admin/toners')).json()).toners.find(x => x.cor === 'preto');
    assert.strictEqual(preto.nivel_percentual, 40);
    // corpo inválido e lista grande demais
    assert.strictEqual((await worker.fetch(req('POST', '/agente/leituras', { headers: AG, body: '{}' }), env)).status, 400);
    assert.strictEqual((await post(Array.from({ length: 201 }, () => ({ equipamento_id: imp, suprimentos: [] })))).status, 400);
  });
  await test('migrações de equipamentos e toners acrescentam as colunas novas em bancos já migrados', async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
    raw.exec('ALTER TABLE equipamentos DROP COLUMN ip; ALTER TABLE toners DROP COLUMN nivel_percentual; ALTER TABLE toners DROP COLUMN nivel_lido_em;');
    const env = { ...hEnv, CHAMADOS_DB: makeD1FromSqlite(raw), SUBSCRIPTIONS: makeMockKV() };
    for (const rota of ['/admin/migrate-schema-equipamentos', '/admin/migrate-schema-toners', '/admin/migrate-schema-equipamentos', '/admin/migrate-schema-toners']) {
      assert.strictEqual((await eqPost(env, rota, {})).status, 200, rota);
    }
    const imp = await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', ip: '10.1.1.1' })).json();
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: imp.id, codigo: 'T', cor: 'preto' })).status, 201);
    env.TONER_AGENT_SECRET = 'segredo-do-agente';
    const r = await (await worker.fetch(req('POST', '/agente/leituras', { headers: AG, body: JSON.stringify({ leituras: [{ equipamento_id: imp.id, suprimentos: [{ cor: 'preto', nivel: 33 }] }] }) }), env)).json();
    assert.strictEqual(r.atualizados, 1);
  });

  console.log('--- papéis do painel: admin vê tudo, operador só os dele (2026-11-24) ---');
  {
    const EV = 170628721, HE = 200498355;
    const pEnv = { ...env, OPERADOR_SECRETS: JSON.stringify({ [EV]: 'chave-everson' }), SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    const ADM = { 'X-Admin-Secret': 'admin-secret' };
    const OPE = { 'X-Admin-Secret': 'chave-everson' };
    const mk = async (nome, assignee) => (await d1CreateChamado(pEnv, { name: nome, priority: 3, tipo: 0, setor: 0, solicitante: 'Fulano', status: 'aberto', assignee_id: assignee, assignee_ids: [assignee] })).id;
    const idEv = await mk('do Everson', EV);
    const idHe = await mk('do Henrique', HE);
    const get = (p, h) => worker.fetch(req('GET', p, { headers: h }), pEnv);
    const post = (p, h, b) => worker.fetch(req('POST', p, { headers: h, body: JSON.stringify(b) }), pEnv);

    await test('/admin/me diz o papel de cada chave', async () => {
      assert.deepStrictEqual(await (await get('/admin/me', ADM)).json(), { role: 'admin', operadorId: HE });
      assert.deepStrictEqual(await (await get('/admin/me', OPE)).json(), { role: 'operador', operadorId: EV });
      assert.strictEqual((await get('/admin/me', { 'X-Admin-Secret': 'errada' })).status, 403);
    });
    await test('cada um vê só os seus (admin = Henrique, operador = Everson), mesmo pedindo outro filtro', async () => {
      const a = await (await get('/admin/tasks', ADM)).json();
      assert.deepStrictEqual(a.tasks.map(t => t.name), ['do Henrique']);
      assert.deepStrictEqual((await (await get('/admin/tasks?operador=' + EV, ADM)).json()).tasks.map(t => t.name), ['do Henrique']);
      const o = await (await get('/admin/tasks', OPE)).json();
      assert.deepStrictEqual(o.tasks.map(t => t.name), ['do Everson']);
      const forjado = await (await get('/admin/tasks?operador=' + HE, OPE)).json();
      assert.deepStrictEqual(forjado.tasks.map(t => t.name), ['do Everson'], 'filtro da URL não pode abrir os chamados do outro');
    });
    await test('métricas são gerais: o operador vê o mesmo agregado', async () => {
      const a = await (await get('/admin/metrics', ADM)).json();
      const o = await (await get('/admin/metrics', OPE)).json();
      assert.strictEqual(o.total, a.total);
    });
    await test('operador não altera, comenta nem abre anexos de chamado alheio (403)', async () => {
      assert.strictEqual((await post('/admin/tasks/' + idHe, OPE, { status: 'em atendimento' })).status, 403);
      assert.strictEqual((await get('/admin/tasks/' + idHe + '/eventos', OPE)).status, 403);
      assert.strictEqual((await post('/admin/tasks/' + idHe + '/eventos', OPE, { autor: 'Everson', texto: 'oi' })).status, 403);
      assert.strictEqual((await get('/admin/tasks/' + idHe + '/anexos', OPE)).status, 403);
      assert.strictEqual((await d1GetChamado(pEnv, idHe)).status, 'aberto');
    });
    await test('operador altera o chamado dele; a nota sai sempre com o nome dele', async () => {
      assert.strictEqual((await post('/admin/tasks/' + idEv, OPE, { status: 'em atendimento' })).status, 200);
      assert.strictEqual((await d1GetChamado(pEnv, idEv)).status, 'em atendimento');
      const r = await post('/admin/tasks/' + idEv + '/eventos', OPE, { autor: 'Henrique', texto: 'tentando assinar como o outro' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).evento.autor, 'Everson');
    });
    await test('ação em lote do operador pula o que não é dele', async () => {
      const r = await (await post('/admin/tasks/bulk', OPE, { ids: [idEv, idHe], status: 'pendente' })).json();
      assert.strictEqual(r.sucesso, 1);
      assert.strictEqual((await d1GetChamado(pEnv, idHe)).status, 'aberto');
    });
    await test('operador não acessa Usuários, solicitantes, exclusão nem criação pela TI (403)', async () => {
      assert.strictEqual((await get('/admin/users', OPE)).status, 403);
      assert.strictEqual((await get('/admin/solicitantes', OPE)).status, 403);
      assert.strictEqual((await get('/admin/presenca', OPE)).status, 403);
      assert.strictEqual((await post('/admin/tasks/' + idEv + '/delete', OPE, {})).status, 403);
      assert.strictEqual((await worker.fetch(req('POST', '/admin/tasks', { headers: { ...OPE, 'X-Test-Raw': '1' }, body: JSON.stringify({ name: 'x', solicitante: 'Fulano', assigneeId: EV }) }), pEnv)).status, 403);
    });
    await test('operador usa inventário (equipamentos/toners)', async () => {
      assert.strictEqual((await get('/admin/equipamentos', OPE)).status, 200);
      assert.strictEqual((await get('/admin/toners', OPE)).status, 200);
    });
    await test('chave de operador inexistente em OPERADOR_SECRETS não vira acesso; sem a variável só o admin entra', async () => {
      const semVar = { ...pEnv, OPERADOR_SECRETS: undefined };
      assert.strictEqual((await worker.fetch(req('GET', '/admin/tasks', { headers: OPE }), semVar)).status, 403);
      assert.strictEqual((await worker.fetch(req('GET', '/admin/tasks', { headers: ADM }), semVar)).status, 200);
    });
    await test('atendente é obrigatório e único: sem ninguém, os dois ou desconhecido dá 400', async () => {
      const sessao = await (async () => {
        const nome = 'Pessoa Atendente';
        await d1CreateSolicitante(pEnv, nome, emailFor(nome));
        const r = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ email: emailFor(nome), password: 'senhasegura1', nome }) }), pEnv);
        return (await r.json()).token;
      })();
      const cria = async (assignees) => {
        await pEnv.SUBSCRIPTIONS.delete('throttle_create_Pessoa Atendente');
        return worker.fetch(req('POST', '/api/tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': sessao, 'X-Test-Raw': '1' }, body: JSON.stringify({ name: 'x', assignees }) }), pEnv);
      };
      assert.strictEqual((await cria(undefined)).status, 400);
      assert.strictEqual((await cria([])).status, 400);
      assert.strictEqual((await cria([EV, HE])).status, 400);
      assert.strictEqual((await cria([999])).status, 400);
      assert.strictEqual((await cria([HE])).status, 200);
    });
    await test('TI cria chamado só com atendente válido', async () => {
      const cria = (b) => worker.fetch(req('POST', '/admin/tasks', { headers: { ...ADM, 'X-Test-Raw': '1' }, body: JSON.stringify({ name: 'y', solicitante: 'Fulano', ...b }) }), pEnv);
      await d1CreateSolicitante(pEnv, 'Fulano', emailFor('Fulano')).catch(() => {});
      assert.strictEqual((await cria({})).status, 400);
      assert.strictEqual((await cria({ assigneeId: 5 })).status, 400);
      assert.strictEqual((await cria({ assigneeId: HE })).status, 200);
    });
  }

  await test('GET /admin/tasks informa quantos anexos cada chamado tem (tag de anexo)', async () => {
    const aEnv = { ...env, SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    const mk = async (nome) => (await d1CreateChamado(aEnv, { name: nome, priority: 3, tipo: 0, setor: 0, solicitante: 'F', status: 'aberto', assignee_id: 200498355, assignee_ids: [200498355] })).id;
    const com = await mk('com anexo'); const sem = await mk('sem anexo');
    for (const n of [1, 2]) await aEnv.CHAMADOS_DB.prepare('INSERT INTO chamado_anexos (id, chamado_id, r2_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('ax' + n, com, 'k' + n, 'f' + n + '.png', 'image/png', 10, Date.now()).run();
    const j = await (await worker.fetch(req('GET', '/admin/tasks', { headers: { 'X-Admin-Secret': 'admin-secret' } }), aEnv)).json();
    assert.strictEqual(j.tasks.find(x => x.id === com).anexos_count, 2);
    assert.strictEqual(j.tasks.find(x => x.id === sem).anexos_count, 0);
  });
  await test('import-anexo-url: só admin, só host da ClickUp, chamado precisa existir', async () => {
    const aEnv = { ...env, SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    const c = await d1CreateChamado(aEnv, { name: 'x', priority: 3, tipo: 0, setor: 0, solicitante: 'F', status: 'aberto', assignee_id: 200498355, assignee_ids: [200498355] });
    const ia = (h, b) => worker.fetch(req('POST', '/admin/import-anexo-url', { headers: h, body: JSON.stringify(b) }), aEnv);
    const A = { 'X-Admin-Secret': 'admin-secret' };
    const ok = { chamado_id: c.id, url: 'https://t1.p.clickup-attachments.com/a/b.png', filename: 'b.png' };
    assert.strictEqual((await ia({}, ok)).status, 403);
    assert.strictEqual((await ia(A, { ...ok, url: 'https://evil.example.com/b.png' })).status, 400);
    assert.strictEqual((await ia(A, { ...ok, url: 'http://t1.p.clickup-attachments.com/b.png' })).status, 400);
    assert.strictEqual((await ia(A, { ...ok, url: 'https://clickup-attachments.com.evil.com/b.png' })).status, 400);
    assert.strictEqual((await ia(A, { ...ok, chamado_id: 'nao-existe' })).status, 404);
  });
  // ---------------- Banco que nunca rodou a migração do inventário (24/11/2026) ----------------
  // Bug de produção: o código foi publicado antes da migração e as abas Inventário e Toners ficaram
  // "Não foi possível carregar". Agora as rotas criam o esquema sozinhas no primeiro uso.
  const bancoSemInventario = () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
    raw.exec('DROP INDEX idx_chamados_equipamento; ALTER TABLE chamados DROP COLUMN equipamento_id; DROP TABLE toner_recargas; DROP TABLE toners; DROP TABLE equipamentos;');
    return { ...hEnv, CHAMADOS_DB: makeD1FromSqlite(raw), SUBSCRIPTIONS: makeMockKV(), TONER_AGENT_SECRET: 'segredo-do-agente' };
  };

  await test('banco sem migração: as telas de admin abrem (listas vazias) e o primeiro cadastro já funciona', async () => {
    const env = bancoSemInventario();
    assert.deepStrictEqual(await (await eqGet(env, '/admin/equipamentos')).json(), { equipamentos: [] });
    assert.deepStrictEqual(await (await eqGet(env, '/admin/toners')).json(), { toners: [] });
    const imp = await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 1', ip: '10.0.0.1' });
    assert.strictEqual(imp.status, 201);
    const { id } = await imp.json();
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: id, codigo: 'TN-1', cor: 'preto' })).status, 201);
    assert.strictEqual((await eqGet(env, '/admin/toners')).status, 200);
  });
  await test('banco sem migração: rotas do agente e a lista do solicitante também se preparam sozinhas', async () => {
    const env = bancoSemInventario();
    const lista = await worker.fetch(req('GET', '/agente/impressoras', { headers: AG }), env);
    assert.strictEqual(lista.status, 200);
    assert.deepStrictEqual((await lista.json()).impressoras, []);
    const env2 = bancoSemInventario();
    const post = await worker.fetch(req('POST', '/agente/leituras', { headers: AG, body: JSON.stringify({ leituras: [] }) }), env2);
    assert.strictEqual(post.status, 200);
    const env3 = bancoSemInventario();
    await d1CreateSolicitante(env3, 'Pessoa Sem Migracao', emailFor('Pessoa Sem Migracao'));
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '10.6.6.6' }, body: JSON.stringify({ email: emailFor('Pessoa Sem Migracao'), nome: 'Pessoa Sem Migracao', password: 'senhaboa123' }) }), env3);
    const r = await worker.fetch(req('GET', '/api/equipamentos', { headers: comSessao((await reg.json()).token) }), env3);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).equipamentos, []);
  });
  await test('banco sem migração: abrir chamado continua funcionando (equipamento inexistente é recusado, não quebra)', async () => {
    const env = bancoSemInventario();
    await d1CreateSolicitante(env, 'Pessoa Chamado Antigo', emailFor('Pessoa Chamado Antigo'));
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '10.5.5.5' }, body: JSON.stringify({ email: emailFor('Pessoa Chamado Antigo'), nome: 'Pessoa Chamado Antigo', password: 'senhaboa123' }) }), env);
    const h = comSessao((await reg.json()).token);
    const abre = (extra) => worker.fetch(req('POST', '/api/tasks', { headers: h, body: JSON.stringify({ name: 'Imp', custom_fields: tipoOk, ...extra }) }), env);
    assert.strictEqual((await abre({})).status, 200);
    await env.SUBSCRIPTIONS.delete('throttle_create_Pessoa Chamado Antigo');
    assert.strictEqual((await abre({ equipamento_id: 'fantasma' })).status, 400);
  });
  await test('erro inesperado vira resposta 500 em JSON, com CORS (antes: página 1101 sem CORS)', async () => {
    const quebrado = { ...hEnv, SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: { prepare() { throw new Error('banco fora do ar'); }, batch() { throw new Error('banco fora do ar'); } } };
    const r = await worker.fetch(req('GET', '/admin/tasks', { headers: { ...ADM, Origin: 'https://chamados.institutosaovicente.com.br' } }), quebrado);
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://chamados.institutosaovicente.com.br');
    assert.deepStrictEqual(await r.json(), { error: 'erro interno do servidor' });
  });

  // ---------------- Filtros do Dashboard (24/11/2026) ----------------
  async function cenarioMetricas() {
    const env = eqEnv();
    const EV = 170628721, HE = 200498355;
    const mk = (d) => d1CreateChamado(env, { priority: 3, tipo: 0, setor: 0, ...d });
    await mk({ name: 'A', priority: 1, tipo: 0, setor: 0, solicitante: 'Ana', assignee_id: EV });
    await mk({ name: 'B', priority: 3, tipo: 1, setor: 1, solicitante: 'Bia', assignee_id: HE, status: 'encerrado' });
    await mk({ name: 'C', priority: 3, tipo: 0, setor: 1, solicitante: 'Ana', assignee_ids: [EV, HE], assignee_id: EV, status: 'pendente' });
    return { env, EV, HE };
  }
  const metricas = async (env, qs = '') => (await eqGet(env, `/admin/metrics${qs}`)).json();

  await test('métricas sem filtro contam tudo e trazem o volume por prioridade e por operador', async () => {
    const { env, EV, HE } = await cenarioMetricas();
    const m = await metricas(env);
    assert.strictEqual(m.total, 3);
    assert.deepStrictEqual(m.porPrioridade, { 1: 1, 3: 2 });
    assert.deepStrictEqual(m.porOperador, { [EV]: 2, [HE]: 2 }, 'chamado com 2 atendentes conta para os dois');
  });
  await test('métricas: cada filtro isolado devolve só os chamados certos', async () => {
    const { env, EV, HE } = await cenarioMetricas();
    const total = async (qs) => (await metricas(env, qs)).total;
    assert.strictEqual(await total(`?operador=${EV}`), 2);
    assert.strictEqual(await total(`?operador=${HE}`), 2, 'achado mesmo quando não é o primeiro atendente');
    assert.strictEqual(await total('?setor=1'), 2);
    assert.strictEqual(await total('?tipo=0'), 2);
    assert.strictEqual(await total('?prioridade=1'), 1);
    assert.strictEqual(await total('?prioridade=3'), 2);
    assert.strictEqual(await total('?status=pendente'), 1);
    assert.strictEqual(await total('?status=ENCERRADO'), 1, 'status aceita maiúsculas');
    assert.strictEqual(await total('?solicitante=Ana'), 2);
    assert.strictEqual(await total('?solicitante=Fulano%20Inexistente'), 0);
  });
  await test('métricas: filtros se combinam (E) e os agregados acompanham o recorte', async () => {
    const { env, HE } = await cenarioMetricas();
    const m = await metricas(env, `?tipo=0&operador=${HE}`);
    assert.strictEqual(m.total, 1, 'só o chamado C é do tipo 0 E do Henrique');
    assert.deepStrictEqual(m.porStatus, { pendente: 1 });
    assert.deepStrictEqual(m.porSetor, { 1: 1 });
    assert.strictEqual((await metricas(env, '?setor=7')).total, 0);
    const vazio = await metricas(env, '?setor=7');
    assert.deepStrictEqual([vazio.porStatus, vazio.porPrioridade, vazio.porOperador], [{}, {}, {}], 'recorte vazio mantém a estrutura');
    // período + filtro juntos
    assert.strictEqual((await metricas(env, `?prioridade=3&desde=${Date.now() + 86400000}`)).total, 0);
  });
  await test('métricas: filtro inválido dá 400 (nunca é ignorado em silêncio) e o operador também filtra', async () => {
    const { env } = await cenarioMetricas();
    for (const qs of ['?setor=abc', '?tipo=-1', '?prioridade=9', '?prioridade=0', '?operador=0', '?operador=1.5', '?status=lixo', '?setor=%20', '?tipo=0x10', '?prioridade=1e0', '?setor=%2B1']) {
      assert.strictEqual((await eqGet(env, `/admin/metrics${qs}`)).status, 400, qs);
    }
    assert.strictEqual((await eqGet(env, '/admin/metrics?setor=', ADM)).status, 200, 'valor vazio = sem filtro');
    assert.strictEqual((await eqGet(env, '/admin/metrics?setor=1', {})).status, 403);
    const comOperador = { ...env, OPERADOR_SECRETS: JSON.stringify({ 170628721: 'chave-do-everson' }) };
    const r = await worker.fetch(req('GET', '/admin/metrics?prioridade=1', { headers: { 'X-Admin-Secret': 'chave-do-everson' } }), comOperador);
    assert.strictEqual(r.status, 200, 'o Everson (operador) usa os filtros do Dashboard');
    assert.strictEqual((await r.json()).total, 1);
  });

  // ---------------- Pendências do revisor (25/11/2026) ----------------
  const EVERSON = { 'X-Admin-Secret': 'chave-do-everson' };
  const comOperadores = (env) => ({ ...env, OPERADOR_SECRETS: JSON.stringify({ 170628721: 'chave-do-everson' }) });

  await test('agente: 5 erros por IP bloqueiam por 15 min (padrão do admin), acertar zera, sem cabeçalho não conta, outro IP não é afetado', async () => {
    const env = agEnv();
    const get = (h, ip = '1.1.1.1') => worker.fetch(req('GET', '/agente/impressoras', { headers: { ...h, 'CF-Connecting-IP': ip } }), env);
    const ERR = { 'X-Agente-Secret': 'errado' };
    for (let n = 0; n < 5; n++) assert.strictEqual((await get(ERR)).status, 403);
    assert.strictEqual((await get(AG)).status, 403, 'bloqueado: nem o segredo certo passa durante o bloqueio');
    assert.strictEqual((await get(AG, '2.2.2.2')).status, 200, 'outro IP não é afetado');
    assert.ok(await env.SUBSCRIPTIONS.get('agentefail_1.1.1.1'), 'contador gravado por IP, com expiração');
    // acertar antes do limite zera o contador
    for (let n = 0; n < 4; n++) await get(ERR, '3.3.3.3');
    assert.strictEqual((await get(AG, '3.3.3.3')).status, 200);
    assert.strictEqual(await env.SUBSCRIPTIONS.get('agentefail_3.3.3.3'), null);
    for (let n = 0; n < 4; n++) assert.strictEqual((await get(ERR, '3.3.3.3')).status, 403);
    assert.strictEqual((await get(AG, '3.3.3.3')).status, 200, 'depois de zerar, 4 erros não bloqueiam');
    // requisição SEM o cabeçalho não conta como tentativa
    for (let n = 0; n < 12; n++) await get({}, '4.4.4.4');
    assert.strictEqual((await get(AG, '4.4.4.4')).status, 200);
    // o POST de leituras usa o mesmo contador
    const post = (h, ip) => worker.fetch(req('POST', '/agente/leituras', { headers: { ...h, 'CF-Connecting-IP': ip }, body: JSON.stringify({ leituras: [] }) }), env);
    for (let n = 0; n < 5; n++) await post(ERR, '5.5.5.5');
    assert.strictEqual((await post(AG, '5.5.5.5')).status, 403);
  });
  await test('agente: segredo de tamanho diferente ou parecido não passa (comparação completa)', async () => {
    const env = agEnv();
    for (const tentativa of ['segredo-do-agent', 'segredo-do-agentee', 'segredo-do-agentX', 'Segredo-do-agente']) {
      assert.strictEqual((await worker.fetch(req('GET', '/agente/impressoras', { headers: { 'X-Agente-Secret': tentativa, 'CF-Connecting-IP': `9.9.9.${tentativa.length}` } }), env)).status, 403, tentativa);
    }
  });

  await test('solicitante: conta externa não vê o inventário e ninguém vê rede/outro (só impressora, computador, monitor, notebook)', async () => {
    const env = eqEnv();
    for (const [tipo, tomb] of [['impressora', 'I1'], ['computador', 'C1'], ['rede', 'R1'], ['outro', 'O1']]) await eqPost(env, '/admin/equipamentos', { tipo, tombamento: tomb });
    const entra = async (nome, ip) => {
      await d1CreateSolicitante(env, nome, emailFor(nome));
      const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': ip }, body: JSON.stringify({ email: emailFor(nome), nome, password: 'senhaboa123' }) }), env);
      return comSessao((await reg.json()).token);
    };
    const interno = await entra('Pessoa Interna Eq', '10.1.1.1');
    const externo = await entra('Pessoa Externa Eq', '10.1.1.2');
    await env.CHAMADOS_DB.prepare(`UPDATE solicitantes SET origem = 'externo' WHERE name = ?`).bind('Pessoa Externa Eq').run();
    const ver = async (h) => (await (await worker.fetch(req('GET', '/api/equipamentos', { headers: h }), env)).json()).equipamentos.map(e => e.tombamento);
    assert.deepStrictEqual(await ver(interno), ['C1', 'I1']);
    assert.deepStrictEqual(await ver(externo), []);
  });

  await test('toner: uma impressora não tem dois toners ativos da mesma cor (criar, editar e reativar dão 409)', async () => {
    const { env, imp } = await tonerEnv();
    const novo = (corpo) => eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-X', ...corpo });
    const a = await novo({ cor: 'preto' });
    assert.strictEqual(a.status, 201);
    const idA = (await a.json()).id;
    const repetido = await novo({ cor: 'preto' });
    assert.strictEqual(repetido.status, 409);
    assert.match((await repetido.json()).error, /já tem um toner dessa cor/);
    const b = await novo({ cor: 'ciano' });
    assert.strictEqual(b.status, 201);
    const idB = (await b.json()).id;
    assert.strictEqual((await eqPost(env, `/admin/toners/${idB}`, { cor: 'preto' })).status, 409, 'editar a cor para uma que já existe');
    // tirar o primeiro da lista libera a cor; reativá-lo com o outro ativo volta a dar 409
    assert.strictEqual((await eqPost(env, `/admin/toners/${idA}`, { ativo: false })).status, 200);
    assert.strictEqual((await eqPost(env, `/admin/toners/${idB}`, { cor: 'preto' })).status, 200);
    assert.strictEqual((await eqPost(env, `/admin/toners/${idA}`, { ativo: true })).status, 409);
    // toners da MESMA cor em impressoras diferentes são normais
    const outra = (await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 99' })).json()).id;
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: outra, codigo: 'TN-X', cor: 'preto' })).status, 201);
  });

  await test('ativo precisa ser booleano de verdade ("false" em texto dá 400)', async () => {
    const { env, imp } = await tonerEnv();
    const t = (await (await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-A' })).json()).id;
    for (const ativo of ['false', 'true', 0, 1, null, '']) {
      assert.strictEqual((await eqPost(env, `/admin/equipamentos/${imp}`, { ativo })).status, 400, `equip ${JSON.stringify(ativo)}`);
      assert.strictEqual((await eqPost(env, `/admin/toners/${t}`, { ativo })).status, 400, `toner ${JSON.stringify(ativo)}`);
    }
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}`, { ativo: false })).status, 200);
  });

  await test('impressora desativada ou baixada: seus toners saem da lista e o agente não grava mais neles', async () => {
    const env = { ...eqEnv(), TONER_AGENT_SECRET: 'segredo-do-agente' };
    const imp = (await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 1', ip: '10.0.0.1' })).json()).id;
    await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-1', cor: 'preto' });
    const leitura = (nivel) => worker.fetch(req('POST', '/agente/leituras', { headers: AG, body: JSON.stringify({ leituras: [{ equipamento_id: imp, suprimentos: [{ cor: 'preto', nivel }] }] }) }), env).then(r => r.json());
    assert.strictEqual((await leitura(50)).atualizados, 1);
    for (const [corpo, volta] of [[{ status: 'baixado' }, { status: 'ativo' }], [{ ativo: false }, { ativo: true }]]) {
      assert.strictEqual((await eqPost(env, `/admin/equipamentos/${imp}`, corpo)).status, 200);
      assert.strictEqual((await (await eqGet(env, '/admin/toners')).json()).toners.length, 0, 'toner some da lista junto com a impressora');
      const r = await leitura(7);
      assert.strictEqual(r.atualizados, 0);
      assert.strictEqual((await env.CHAMADOS_DB.prepare('SELECT nivel_percentual AS n FROM toners').first()).n, 50, 'o nível antigo não foi sobrescrito');
      assert.strictEqual((await eqPost(env, `/admin/equipamentos/${imp}`, volta)).status, 200);
      assert.strictEqual((await (await eqGet(env, '/admin/toners')).json()).toners.length, 1, 'volta quando a impressora volta');
    }
  });

  await test('recarga: operador assina sempre como ele mesmo; admin pode informar o autor, e sem informar vale o nome dele', async () => {
    const base = await tonerEnv();
    const env = comOperadores(base.env);
    const t = (await (await eqPost(env, '/admin/toners', { equipamento_id: base.imp, codigo: 'TN-R' })).json()).id;
    const autores = async () => (await env.CHAMADOS_DB.prepare('SELECT autor FROM toner_recargas ORDER BY rowid').all()).results.map(r => r.autor);
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}/recarga`, { autor: 'Henrique' }, EVERSON)).status, 201);
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}/recarga`, { autor: 'Alguém da TI' })).status, 201);
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}/recarga`, {})).status, 201);
    assert.deepStrictEqual(await autores(), ['Everson', 'Alguém da TI', 'Henrique']);
  });

  await test('desfazer recarga: com a data da que a pessoa via só apaga se ainda for a mais recente (senão 409)', async () => {
    const { env, imp } = await tonerEnv();
    const t = (await (await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-D' })).json()).id;
    const D = 86400000, agora = Date.now(), A = agora - 30 * D, B = agora - 5 * D;
    await eqPost(env, `/admin/toners/${t}/recarga`, { feita_em: A });
    await eqPost(env, `/admin/toners/${t}/recarga`, { feita_em: B });
    const total = async () => (await env.CHAMADOS_DB.prepare('SELECT COUNT(*) AS n FROM toner_recargas').first()).n;
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}/recarga/desfazer`, { feita_em: A })).status, 409, 'A não é mais a mais recente');
    assert.strictEqual(await total(), 2);
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}/recarga/desfazer`, { feita_em: B })).status, 200);
    // duplo clique: o segundo pedido ainda carrega a data B, que já não existe, e NÃO apaga a A
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}/recarga/desfazer`, { feita_em: B })).status, 409);
    assert.strictEqual(await total(), 1);
    assert.strictEqual((await eqPost(env, `/admin/toners/${t}/recarga/desfazer`, {})).status, 200, 'sem a data mantém o comportamento antigo');
  });

  await test('push de teste: operador só testa o próprio aparelho', async () => {
    const env = comOperadores(eqEnv());
    const sub = (operadorId) => JSON.stringify({ endpoint: 'https://fake-push-endpoint.test/x', keys: { p256dh: 'p', auth: 'a' }, operadorId });
    await env.SUBSCRIPTIONS.put('adminsub_aparelho-henrique', sub(200498355));
    await env.SUBSCRIPTIONS.put('adminsub_aparelho-everson', sub(170628721));
    const testar = (id, h) => worker.fetch(req('POST', '/admin/subscribe/test', { headers: h, body: JSON.stringify({ id }) }), env);
    assert.strictEqual((await testar('aparelho-henrique', EVERSON)).status, 403, 'Everson não dispara no aparelho do Henrique');
    assert.notStrictEqual((await testar('aparelho-everson', EVERSON)).status, 403, 'no próprio aparelho passa da checagem de dono');
    assert.notStrictEqual((await testar('aparelho-henrique', ADM)).status, 403, 'o admin segue podendo');
  });

  await test('esquema do inventário: confere a coluna antes de alterar (nenhum "duplicate column" no log) e o índice único de toner existe', async () => {
    const env = eqEnv();
    const erros = [];
    const original = console.error;
    console.error = (...a) => erros.push(a.join(' '));
    try {
      const raw = new DatabaseSync(':memory:');
      raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
      const env2 = { ...env, CHAMADOS_DB: makeD1FromSqlite(raw) };
      assert.strictEqual((await eqPost(env2, '/admin/migrate-schema-equipamentos', {})).status, 200);
      assert.strictEqual((await eqPost(env2, '/admin/migrate-schema-equipamentos', {})).status, 200);
      const idx = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_toners_equip_cor_ativo'`).get();
      assert.ok(idx, 'índice único (impressora + cor) criado');
    } finally {
      console.error = original;
    }
    assert.deepStrictEqual(erros, []);
  });

  await test('toner: checagem prévia de cor repetida (mensagem de reativar própria) e impressora baixada não recebe toner', async () => {
    const { env, imp } = await tonerEnv();
    const a = (await (await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-A', cor: 'preto' })).json()).id;
    await eqPost(env, `/admin/toners/${a}`, { ativo: false });
    const b = await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-B', cor: 'preto' });
    assert.strictEqual(b.status, 201);
    const reativar = await eqPost(env, `/admin/toners/${a}`, { ativo: true });
    assert.strictEqual(reativar.status, 409);
    assert.match((await reativar.json()).error, /não dá para reativar/);
    const dup = await eqPost(env, '/admin/toners', { equipamento_id: imp, codigo: 'TN-C', cor: 'preto' });
    assert.match((await dup.json()).error, /já tem um toner dessa cor/);
    assert.strictEqual((await eqPost(env, '/admin/toners/nao-existe', { cor: 'ciano' })).status, 404);
    const baixada = (await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 77', status: 'baixado' })).json()).id;
    assert.strictEqual((await eqPost(env, '/admin/toners', { equipamento_id: baixada, codigo: 'TN-Z' })).status, 400);
  });

  await test('chamado: conta externa não vincula equipamento, e o solicitante só vincula impressora/computador/monitor/notebook (a TI vincula qualquer)', async () => {
    const env = eqEnv();
    const imp = (await (await eqPost(env, '/admin/equipamentos', { tipo: 'impressora', tombamento: 'F 1' })).json()).id;
    const rede = (await (await eqPost(env, '/admin/equipamentos', { tipo: 'rede', tombamento: 'SW 1' })).json()).id;
    const entra = async (nome, ip) => {
      await d1CreateSolicitante(env, nome, emailFor(nome));
      const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': ip }, body: JSON.stringify({ email: emailFor(nome), nome, password: 'senhaboa123' }) }), env);
      return comSessao((await reg.json()).token);
    };
    const interno = await entra('Pessoa Vincula Int', '10.2.2.1');
    const externo = await entra('Pessoa Vincula Ext', '10.2.2.2');
    await env.CHAMADOS_DB.prepare(`UPDATE solicitantes SET origem = 'externo' WHERE name = ?`).bind('Pessoa Vincula Ext').run();
    const abre = (h, equipamento_id) => worker.fetch(req('POST', '/api/tasks', { headers: h, body: JSON.stringify({ name: 'Imp', custom_fields: tipoOk, equipamento_id }) }), env);
    assert.strictEqual((await abre(externo, imp)).status, 400, 'externo não vincula');
    assert.strictEqual((await abre(interno, rede)).status, 400, 'solicitante não vincula rede');
    assert.strictEqual((await abre(interno, imp)).status, 200);
    const adm = await eqPost(env, '/admin/tasks', { name: 'Switch fora do ar', solicitante: 'Pessoa Vincula Int', equipamento_id: rede });
    assert.strictEqual(adm.status, 200, 'a TI vincula qualquer tipo');
  });

  // ---------------- Avaliação mensal da TI (25/11/2026) ----------------
  const RESP_OK = { tempo_resposta: 5, primeiro_atendimento: 4, conhecimento: 5, cordialidade: 5, equipamentos: 3, comunicacao: 4, recomendacao: 9 };
  const sessaoDe = async (env, nome, ip) => {
    await d1CreateSolicitante(env, nome, emailFor(nome));
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': ip }, body: JSON.stringify({ email: emailFor(nome), nome, password: 'senhaboa123' }) }), env);
    return comSessao((await reg.json()).token);
  };
  const avaliar = (env, h, corpo) => worker.fetch(req('POST', '/api/avaliacao-mensal', { headers: h, body: JSON.stringify(corpo) }), env);
  const minha = async (env, h) => (await worker.fetch(req('GET', '/api/avaliacao-mensal', { headers: h }), env)).json();

  await test('competência é o mês de Fortaleza (UTC-3): virada de mês e de ano', async () => {
    assert.strictEqual(competenciaAtual(Date.UTC(2026, 10, 1, 2, 59, 59)), '2026-10', '31/10 23:59:59 em Fortaleza ainda é outubro');
    assert.strictEqual(competenciaAtual(Date.UTC(2026, 10, 1, 3, 0, 0)), '2026-11');
    assert.strictEqual(competenciaAtual(Date.UTC(2027, 0, 1, 2, 59, 0)), '2026-12', 'virada de ano');
    assert.strictEqual(competenciaAtual(Date.UTC(2027, 0, 1, 3, 0, 0)), '2027-01');
    assert.match(competenciaAtual(), /^\d{4}-(0[1-9]|1[0-2])$/);
  });
  await test('avaliação mensal: exige o segredo do app e a sessão; começa como "não respondida"', async () => {
    const env = eqEnv();
    assert.strictEqual((await worker.fetch(req('GET', '/api/avaliacao-mensal', { headers: {} }), env)).status, 403);
    assert.strictEqual((await worker.fetch(req('GET', '/api/avaliacao-mensal', { headers: SECRET_HEADERS }), env)).status, 401);
    assert.strictEqual((await worker.fetch(req('POST', '/api/avaliacao-mensal', { headers: SECRET_HEADERS, body: JSON.stringify({ respostas: RESP_OK }) }), env)).status, 401);
    const h = await sessaoDe(env, 'Pessoa Avalia A', '10.3.3.1');
    const r = await minha(env, h);
    assert.deepStrictEqual([r.competencia, r.respondida, r.respostas, r.comentario], [competenciaAtual(), false, null, null]);
  });
  await test('avaliação mensal: grava, aparece de volta e reenviar no mesmo mês SOBRESCREVE (uma linha só)', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Avalia B', '10.3.3.2');
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK, comentario: '  muito bom  ' })).status, 200);
    let r = await minha(env, h);
    assert.strictEqual(r.respondida, true);
    assert.deepStrictEqual(r.respostas, RESP_OK);
    assert.strictEqual(r.comentario, 'muito bom', 'comentário sem espaços nas pontas');
    assert.strictEqual((await avaliar(env, h, { respostas: { ...RESP_OK, recomendacao: 2 } })).status, 200);
    r = await minha(env, h);
    assert.strictEqual(r.respostas.recomendacao, 2);
    assert.strictEqual(r.comentario, null, 'reenviar sem comentário limpa o anterior');
    assert.strictEqual((await env.CHAMADOS_DB.prepare('SELECT COUNT(*) AS n FROM avaliacoes_mensais').first()).n, 1);
    // outra pessoa não enxerga a avaliação dela
    const outra = await sessaoDe(env, 'Pessoa Avalia C', '10.3.3.3');
    assert.strictEqual((await minha(env, outra)).respondida, false);
  });
  await test('avaliação mensal: acompanha a troca de nome e some na exclusão da pessoa', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Muda Nome', '10.3.3.8');
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK })).status, 200);
    const nomes = async () => (await env.CHAMADOS_DB.prepare('SELECT solicitante FROM avaliacoes_mensais').all()).results.map((r) => r.solicitante);
    const adm = (rota, corpo) => worker.fetch(req('POST', rota, { headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify(corpo) }), env);
    // sobra antiga no nome de destino não impede a troca
    await env.CHAMADOS_DB.prepare('INSERT INTO avaliacoes_mensais (solicitante, competencia, respostas, created_at) VALUES (?, ?, ?, ?)')
      .bind('Pessoa Nome Novo', competenciaAtual(), '{}', 1).run();
    assert.strictEqual((await adm(`/admin/solicitantes/${encodeURIComponent('Pessoa Muda Nome')}/renomear`, { novoNome: 'Pessoa Nome Novo' })).status, 200);
    assert.deepStrictEqual(await nomes(), ['Pessoa Nome Novo']);
    assert.strictEqual((await adm(`/admin/solicitantes/${encodeURIComponent('Pessoa Nome Novo')}/excluir`, {})).status, 200);
    assert.deepStrictEqual(await nomes(), []);
  });
  await test('avaliação mensal: conta externa não lê respostas que sobraram com o mesmo nome', async () => {
    const env = eqEnv();
    const reg = await worker.fetch(req('POST', '/auth/register-externo', {
      headers: { ...SECRET_HEADERS, 'CF-Connecting-IP': '10.3.3.9' },
      body: JSON.stringify({ name: 'Pessoa De Fora', email: 'pessoa.de.fora@gmail.com', password: 'senhaboa123' }),
    }), env);
    const h = comSessao((await reg.json()).token);
    await minha(env, h); // cria a tabela
    await env.CHAMADOS_DB.prepare('INSERT INTO avaliacoes_mensais (solicitante, competencia, respostas, comentario, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('Pessoa De Fora', competenciaAtual(), JSON.stringify(RESP_OK), 'segredo', 1).run();
    const r = await minha(env, h);
    assert.deepStrictEqual([r.elegivel, r.respondida, r.respostas, r.comentario], [false, false, null, null]);
  });
  await test('avaliação mensal: cada nota é validada (1-5, recomendação 0-10, inteiros) e nada é gravado se alguma falhar', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Avalia D', '10.3.3.4');
    const ruins = [
      undefined, null, 'texto', [], {},
      ...['tempo_resposta', 'primeiro_atendimento', 'conhecimento', 'cordialidade', 'equipamentos', 'comunicacao'].flatMap(k => [0, 6, 1.5, '3', null].map(v => ({ ...RESP_OK, [k]: v }))),
      ...[-1, 11, 5.5, '9', null].map(v => ({ ...RESP_OK, recomendacao: v })),
    ];
    for (const respostas of ruins) assert.strictEqual((await avaliar(env, h, { respostas })).status, 400, JSON.stringify(respostas));
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK, comentario: 'x'.repeat(1001) })).status, 400);
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK, comentario: 123 })).status, 400);
    assert.strictEqual((await worker.fetch(req('POST', '/api/avaliacao-mensal', { headers: h, body: 'não é json' }), env)).status, 400);
    assert.strictEqual((await env.CHAMADOS_DB.prepare('SELECT COUNT(*) AS n FROM avaliacoes_mensais').first()).n, 0);
    // limites válidos: 1, 5, 0 e 10, comentário de 1000
    assert.strictEqual((await avaliar(env, h, { respostas: { ...RESP_OK, tempo_resposta: 1, conhecimento: 5, recomendacao: 0 }, comentario: 'x'.repeat(1000) })).status, 200);
    assert.strictEqual((await avaliar(env, h, { respostas: { ...RESP_OK, recomendacao: 10 } })).status, 200);
  });
  await test('avaliação mensal: banco que nunca teve a tabela funciona (criada no primeiro uso)', async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
    raw.exec('DROP TABLE avaliacoes_mensais;');
    const env = { ...hEnv, CHAMADOS_DB: makeD1FromSqlite(raw), SUBSCRIPTIONS: makeMockKV() };
    const h = await sessaoDe(env, 'Pessoa Avalia E', '10.3.3.5');
    assert.strictEqual((await minha(env, h)).respondida, false);
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK })).status, 200);
    assert.strictEqual((await eqGet(env, '/admin/avaliacoes-mensais')).status, 200);
  });

  await test('resumo da TI: participação, médias, NPS e comentários SEM nome; só quem é da TI vê', async () => {
    const env = comOperadores(eqEnv());
    const a = await sessaoDe(env, 'Pessoa Resumo A', '10.4.4.1');
    const b = await sessaoDe(env, 'Pessoa Resumo B', '10.4.4.2');
    const c = await sessaoDe(env, 'Pessoa Resumo C', '10.4.4.3');
    await sessaoDe(env, 'Pessoa Resumo D', '10.4.4.4'); // interna, não respondeu
    await sessaoDe(env, 'Pessoa Resumo Ext', '10.4.4.5');
    await env.CHAMADOS_DB.prepare(`UPDATE solicitantes SET origem = 'externo' WHERE name = 'Pessoa Resumo Ext'`).run();
    const todas = (n) => ({ tempo_resposta: n, primeiro_atendimento: n, conhecimento: n, cordialidade: n, equipamentos: n, comunicacao: n });
    await avaliar(env, a, { respostas: { ...todas(5), recomendacao: 10 } });
    await avaliar(env, b, { respostas: { ...todas(4), recomendacao: 8 } });
    await avaliar(env, c, { respostas: { ...todas(2), recomendacao: 3 }, comentario: 'demora para responder' });

    const r = await (await eqGet(env, '/admin/avaliacoes-mensais')).json();
    assert.strictEqual(r.competencia, competenciaAtual());
    assert.strictEqual(r.respondentes, 3);
    assert.strictEqual(r.elegiveis, 4, 'só internos ativos contam (o externo fica de fora)');
    assert.strictEqual(r.participacaoPercent, 75);
    assert.ok(Object.values(r.medias).every(m => m === 3.7), JSON.stringify(r.medias));
    assert.strictEqual(r.mediaGeral, 3.7);
    assert.deepStrictEqual(r.nps, { valor: 0, promotores: 1, neutros: 1, detratores: 1 });
    assert.deepStrictEqual(r.comentarios, ['demora para responder']);
    assert.ok(!JSON.stringify(r).includes('Pessoa Resumo'), 'nenhum nome aparece no resumo');
    assert.deepStrictEqual(r.meses[0], { competencia: competenciaAtual(), respondentes: 3 });
    // o operador (Everson) também vê; sem chave não
    assert.strictEqual((await worker.fetch(req('GET', '/admin/avaliacoes-mensais', { headers: EVERSON }), env)).status, 200);
    assert.strictEqual((await eqGet(env, '/admin/avaliacoes-mensais', {})).status, 403);
  });
  await test('resumo da TI: mês pedido, mês sem respostas, competência inválida e escolha do mês padrão', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Resumo F', '10.4.5.1');
    await avaliar(env, h, { respostas: RESP_OK });
    // um mês antigo com resposta de outra pessoa
    await d1CreateSolicitante(env, 'Pessoa Antiga', emailFor('Pessoa Antiga'));
    await env.CHAMADOS_DB.prepare(`INSERT INTO avaliacoes_mensais (solicitante, competencia, respostas, comentario, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind('Pessoa Antiga', '2026-09', JSON.stringify({ ...RESP_OK, recomendacao: 0 }), null, Date.now()).run();
    const vazio = await (await eqGet(env, '/admin/avaliacoes-mensais?competencia=2026-08')).json();
    assert.deepStrictEqual([vazio.respondentes, vazio.medias.tempo_resposta, vazio.mediaGeral, vazio.nps, vazio.comentarios], [0, null, null, null, []]);
    assert.ok(vazio.meses.some(m => m.competencia === '2026-08'), 'o mês pedido aparece no seletor mesmo sem respostas');
    const setembro = await (await eqGet(env, '/admin/avaliacoes-mensais?competencia=2026-09')).json();
    assert.deepStrictEqual([setembro.respondentes, setembro.nps.valor], [1, -100]);
    for (const ruim of ['2026-13', '2026-00', '26-09', 'setembro', '2026-9', '2026-09-01']) {
      assert.strictEqual((await eqGet(env, `/admin/avaliacoes-mensais?competencia=${ruim}`)).status, 400, ruim);
    }
    // padrão: o mês atual (tem resposta) vem antes do antigo; a lista traz os dois
    const padrao = await (await eqGet(env, '/admin/avaliacoes-mensais')).json();
    assert.strictEqual(padrao.competencia, competenciaAtual());
    assert.ok(padrao.meses.some(m => m.competencia === '2026-09'));
    // sem nenhuma resposta no mês atual, o padrão cai no mais recente que tenha
    await env.CHAMADOS_DB.prepare(`DELETE FROM avaliacoes_mensais WHERE competencia = ?`).bind(competenciaAtual()).run();
    const cai = await (await eqGet(env, '/admin/avaliacoes-mensais')).json();
    assert.strictEqual(cai.competencia, '2026-09');
    assert.strictEqual(cai.meses[0].competencia, competenciaAtual(), 'o mês atual continua na lista, mesmo vazio');
  });

  console.log('--- descoberta automática de impressoras e toners (2026-11-25) ---');
  {
    const desc = (env, h, impressoras) => worker.fetch(req('POST', '/agente/descobertas', { headers: h, body: JSON.stringify({ impressoras }) }), env);
    const lista = async (env) => (await (await worker.fetch(req('GET', '/admin/equipamentos', { headers: { 'X-Admin-Secret': 'admin-secret' } }), env)).json()).equipamentos;
    const toners = async (env) => (await (await worker.fetch(req('GET', '/admin/toners', { headers: { 'X-Admin-Secret': 'admin-secret' } }), env)).json()).toners;
    const mono = { ip: '192.0.2.103', marca: 'Lexmark', modelo: 'MX622adhe', numero_serie: 'SERIE-A', suprimentos: [{ cor: 'preto', nivel: 42, codigo: '56F4U0E' }] };
    await test('sem segredo do agente (ou com o de admin) não cadastra nada', async () => {
      const env = agEnv();
      assert.strictEqual((await desc(env, {}, [mono])).status, 403);
      assert.strictEqual((await desc(env, ADM, [mono])).status, 403);
      assert.strictEqual((await lista(env)).length, 0);
    });
    await test('cadastra impressora e toner sozinho, com nível; repetir não duplica', async () => {
      const env = agEnv();
      const r = await (await desc(env, AG, [mono])).json();
      assert.deepStrictEqual([r.criadas, r.atualizadas, r.toners_criados], [1, 0, 1]);
      const r2 = await (await desc(env, AG, [{ ...mono, suprimentos: [{ cor: 'preto', nivel: 30, codigo: '56F4U0E' }] }])).json();
      assert.deepStrictEqual([r2.criadas, r2.atualizadas, r2.toners_criados, r2.toners_atualizados], [0, 1, 0, 1]);
      const eqs = await lista(env);
      assert.strictEqual(eqs.length, 1);
      assert.deepStrictEqual([eqs[0].ip, eqs[0].modelo, eqs[0].numero_serie], ['192.0.2.103', 'MX622adhe', 'SERIE-A']);
      const ts = await toners(env);
      assert.deepStrictEqual([ts.length, ts[0].codigo, ts[0].nivel_percentual], [1, '56F4U0E', 30]);
    });
    await test('impressora que mudou de IP é reconhecida pela série; o que a TI editou não é sobrescrito', async () => {
      const env = agEnv();
      await desc(env, AG, [mono]);
      const id = (await lista(env))[0].id;
      await worker.fetch(req('POST', '/admin/equipamentos/' + id, { headers: { 'X-Admin-Secret': 'admin-secret' }, body: JSON.stringify({ tipo: 'impressora', modelo: 'Nome da TI', ip: '192.0.2.103' }) }), env);
      await desc(env, AG, [{ ...mono, ip: '192.0.2.150' }]);
      const eqs = await lista(env);
      assert.strictEqual(eqs.length, 1, 'não pode virar duas impressoras');
      assert.deepStrictEqual([eqs[0].ip, eqs[0].modelo], ['192.0.2.150', 'Nome da TI']);
    });
    await test('dados inválidos são ignorados sem derrubar o lote', async () => {
      const env = agEnv();
      const r = await (await desc(env, AG, [{ ip: 'abc', suprimentos: [] }, { ...mono, suprimentos: [{ cor: 'verde', nivel: 5 }, { cor: 'preto', nivel: 300 }] }])).json();
      assert.strictEqual(r.ignoradas.length, 1);
      assert.strictEqual(r.criadas, 1);
      const ts = await toners(env);
      assert.deepStrictEqual([ts.length, ts[0].nivel_percentual], [1, null], 'nível fora de 0-100 não é gravado');
      assert.strictEqual((await desc(env, AG, [])).status, 400);
    });
  }
  await test('avaliação mensal: conta externa não avalia (403), não vê a faixa e as respostas dela não entram no resumo', async () => {
    const env = eqEnv();
    const interno = await sessaoDe(env, 'Pessoa Int Aval', '10.5.5.1');
    const externo = await sessaoDe(env, 'Pessoa Ext Aval', '10.5.5.2');
    await env.CHAMADOS_DB.prepare(`UPDATE solicitantes SET origem = 'externo' WHERE name = 'Pessoa Ext Aval'`).run();
    assert.strictEqual((await minha(env, externo)).elegivel, false);
    assert.strictEqual((await minha(env, interno)).elegivel, true);
    assert.strictEqual((await avaliar(env, externo, { respostas: RESP_OK })).status, 403);
    assert.strictEqual((await avaliar(env, interno, { respostas: RESP_OK })).status, 200);
    // mesmo que uma resposta de externo/desativado já exista no banco, ela não entra no resumo
    const antes = await sessaoDe(env, 'Pessoa Virou Ext', '10.5.5.3');
    const desat = await sessaoDe(env, 'Pessoa Desativada', '10.5.5.4');
    await avaliar(env, antes, { respostas: { ...RESP_OK, recomendacao: 0 } });
    await avaliar(env, desat, { respostas: { ...RESP_OK, recomendacao: 0 } });
    await env.CHAMADOS_DB.prepare(`UPDATE solicitantes SET origem = 'externo' WHERE name = 'Pessoa Virou Ext'`).run();
    await env.CHAMADOS_DB.prepare(`UPDATE solicitantes SET ativo = 0 WHERE name = 'Pessoa Desativada'`).run();
    const r = await (await eqGet(env, '/admin/avaliacoes-mensais')).json();
    assert.strictEqual(r.respondentes, 1);
    assert.strictEqual(r.nps.valor, 100, 'só a resposta da pessoa interna e ativa (recomendação 9)');
    assert.ok(r.participacaoPercent <= 100);
    assert.deepStrictEqual(r.meses[0], { competencia: competenciaAtual(), respondentes: 1 });
  });
  await test('avaliação mensal: se o mês virou com o formulário aberto, o envio é recusado (409) em vez de gravar no mês errado', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Mes Virou', '10.5.6.1');
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK, competencia: '2020-01' })).status, 409);
    assert.strictEqual((await env.CHAMADOS_DB.prepare('SELECT COUNT(*) AS n FROM avaliacoes_mensais').first()).n, 0);
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK, competencia: competenciaAtual() })).status, 200);
    assert.strictEqual((await avaliar(env, h, { respostas: RESP_OK })).status, 200, 'sem a competência continua valendo o mês atual');
  });
  await test('resumo da TI: comentários só com 3+ respondentes, em ordem alfabética (sem pista de quem/quando); linha corrompida é ignorada', async () => {
    const env = eqEnv();
    const pessoas = [];
    for (const [i, nome] of ['Pessoa Anon A', 'Pessoa Anon B', 'Pessoa Anon C'].entries()) pessoas.push(await sessaoDe(env, nome, `10.5.7.${i + 1}`));
    await avaliar(env, pessoas[0], { respostas: RESP_OK, comentario: 'zebra: tudo certo' });
    await avaliar(env, pessoas[1], { respostas: RESP_OK, comentario: 'abacaxi: demorou' });
    // com 2 respondentes o comentário é praticamente identificável: fica oculto
    let r = await (await eqGet(env, '/admin/avaliacoes-mensais')).json();
    assert.deepStrictEqual([r.respondentes, r.comentarios, r.comentariosOcultos], [2, [], true]);
    await avaliar(env, pessoas[2], { respostas: RESP_OK, comentario: 'mamão: bom' });
    r = await (await eqGet(env, '/admin/avaliacoes-mensais')).json();
    assert.deepStrictEqual(r.comentarios, ['abacaxi: demorou', 'mamão: bom', 'zebra: tudo certo'], 'ordem alfabética, não por horário');
    assert.strictEqual(r.comentariosOcultos, false);
    // linhas corrompidas (JSON inválido, null, faltando nota, nota fora da faixa) não derrubam nem entram na conta
    for (const [i, lixo] of ['não é json', 'null', '{"tempo_resposta":5}', JSON.stringify({ ...RESP_OK, conhecimento: 9 })].entries()) {
      const nome = `Pessoa Lixo ${'ABCD'[i]}`;
      await d1CreateSolicitante(env, nome, emailFor(nome));
      await env.CHAMADOS_DB.prepare(`INSERT INTO avaliacoes_mensais (solicitante, competencia, respostas, comentario, created_at) VALUES (?, ?, ?, ?, ?)`).bind(nome, competenciaAtual(), lixo, 'não deveria aparecer', Date.now()).run();
    }
    // as 4 linhas ruins EXISTEM e pertencem a pessoas internas ativas (sem a validação do resumo entrariam na conta)
    const visiveisAoJoin = (await env.CHAMADOS_DB.prepare(
      `SELECT COUNT(*) AS n FROM avaliacoes_mensais a JOIN solicitantes s ON s.name = a.solicitante AND s.ativo = 1 AND s.origem = 'interno' WHERE a.competencia = ?`
    ).bind(competenciaAtual()).first()).n;
    assert.strictEqual(visiveisAoJoin, 7);
    const depois = await eqGet(env, '/admin/avaliacoes-mensais');
    assert.strictEqual(depois.status, 200);
    const corpo = await depois.json();
    assert.strictEqual(corpo.respondentes, 3, 'só as 3 respostas válidas contam');
    assert.ok(!corpo.comentarios.includes('não deveria aparecer'));
    assert.strictEqual(corpo.medias.tempo_resposta, 5);
  });
  await test('resumo da TI: as médias por pergunta e a média geral conferem com a conta feita à mão', async () => {
    const env = eqEnv();
    // 3 pessoas: médias por pergunta 4,3333 (mostra 4,3) e 3,6667 (mostra 3,7); a geral é (4,3333*3 + 3,6667*3)/6 = 4,0
    const vals = [[5, 4], [4, 4], [4, 3]]; // [notas das 3 primeiras perguntas, notas das 3 últimas] por pessoa
    for (const [i, [a, b]] of vals.entries()) {
      const h = await sessaoDe(env, `Pessoa Media ${'ABC'[i]}`, `10.5.8.${i + 1}`);
      await avaliar(env, h, { respostas: { tempo_resposta: a, primeiro_atendimento: a, conhecimento: a, cordialidade: b, equipamentos: b, comunicacao: b, recomendacao: 9 } });
    }
    const r = await (await eqGet(env, '/admin/avaliacoes-mensais')).json();
    assert.deepStrictEqual([r.medias.tempo_resposta, r.medias.cordialidade], [4.3, 3.7]);
    assert.strictEqual(r.mediaGeral, 4);
  });

  // ---------------- Solicitações (25/11/2026) ----------------
  const pedir = (env, h, corpo) => worker.fetch(req('POST', '/api/solicitacoes', { headers: h, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) }), env);
  const meusPedidos = async (env, h) => (await (await worker.fetch(req('GET', '/api/solicitacoes', { headers: h }), env)).json()).solicitacoes;
  const PEDIDO = { categoria: 'equipamento', item: 'Mouse sem fio', quantidade: 2, justificativa: 'O meu parou de clicar.' };
  const mudar = (env, id, corpo, h = ADM) => eqPost(env, `/admin/solicitacoes/${id}/status`, corpo, h);
  const listaAdmin = async (env, qs = '', h = ADM) => (await worker.fetch(req('GET', `/admin/solicitacoes${qs}`, { headers: h }), env)).json();

  await test('solicitações: desligado (padrão do ISV) as quatro rotas respondem 404 e nada é criado', async () => {
    const env = { ...eqEnv(), SOLICITACOES_ATIVO: undefined };
    const h = await sessaoDe(env, 'Pessoa Solic Off', '10.6.0.1');
    assert.strictEqual((await pedir(env, h, PEDIDO)).status, 404);
    assert.strictEqual((await worker.fetch(req('GET', '/api/solicitacoes', { headers: h }), env)).status, 404);
    assert.strictEqual((await worker.fetch(req('GET', '/admin/solicitacoes', { headers: ADM }), env)).status, 404);
    assert.strictEqual((await eqPost(env, '/admin/solicitacoes/qualquer/status', { status: 'em_analise' })).status, 404);
    for (const v of ['false', '0', '']) assert.strictEqual((await pedir({ ...env, SOLICITACOES_ATIVO: v }, h, PEDIDO)).status, 404);
    assert.strictEqual((await pedir({ ...env, SOLICITACOES_ATIVO: 'true' }, h, PEDIDO)).status, 201);
  });
  await test('solicitações: criar exige segredo do app, sessão e pessoa interna', async () => {
    const env = eqEnv();
    assert.strictEqual((await worker.fetch(req('POST', '/api/solicitacoes', { headers: {}, body: JSON.stringify(PEDIDO) }), env)).status, 403);
    assert.strictEqual((await worker.fetch(req('POST', '/api/solicitacoes', { headers: SECRET_HEADERS, body: JSON.stringify(PEDIDO) }), env)).status, 401);
    assert.strictEqual((await worker.fetch(req('GET', '/api/solicitacoes', { headers: SECRET_HEADERS }), env)).status, 401);
    const externo = await sessaoDe(env, 'Pessoa Solic Ext', '10.6.1.1');
    await env.CHAMADOS_DB.prepare(`UPDATE solicitantes SET origem = 'externo' WHERE name = 'Pessoa Solic Ext'`).run();
    assert.strictEqual((await pedir(env, externo, PEDIDO)).status, 403);
    assert.strictEqual((await worker.fetch(req('GET', '/api/solicitacoes', { headers: externo }), env)).status, 403);
    const interno = await sessaoDe(env, 'Pessoa Solic Int', '10.6.1.2');
    const r = await pedir(env, interno, PEDIDO);
    assert.strictEqual(r.status, 201);
    const { id, numero } = await r.json();
    assert.ok(id && numero === 1);
    const [meu] = await meusPedidos(env, interno);
    assert.deepStrictEqual([meu.categoria, meu.item, meu.quantidade, meu.status, meu.solicitante], ['equipamento', 'Mouse sem fio', 2, 'pendente', 'Pessoa Solic Int']);
  });
  await test('solicitações: o solicitante só vê os pedidos dele, e os números são sequenciais', async () => {
    const env = eqEnv();
    const a = await sessaoDe(env, 'Pessoa Solic A', '10.6.2.1');
    const b = await sessaoDe(env, 'Pessoa Solic B', '10.6.2.2');
    await pedir(env, a, { ...PEDIDO, item: 'Teclado' });
    await pedir(env, b, { ...PEDIDO, item: 'Monitor' });
    await pedir(env, a, { ...PEDIDO, item: 'Cabo HDMI', categoria: 'material' });
    assert.deepStrictEqual((await meusPedidos(env, a)).map(s => s.item).sort(), ['Cabo HDMI', 'Teclado']);
    assert.deepStrictEqual((await meusPedidos(env, b)).map(s => s.item), ['Monitor']);
    assert.deepStrictEqual((await listaAdmin(env)).solicitacoes.map(s => s.numero).sort(), [1, 2, 3]);
  });
  await test('solicitações: cada campo é validado e nada é gravado se algum falhar', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Solic Val', '10.6.3.1');
    const ruins = [
      { ...PEDIDO, categoria: 'viagem' }, { ...PEDIDO, categoria: undefined }, { ...PEDIDO, item: '' }, { ...PEDIDO, item: '   ' },
      { ...PEDIDO, item: 'x'.repeat(121) }, { ...PEDIDO, item: 5 }, { ...PEDIDO, justificativa: '' }, { ...PEDIDO, justificativa: 'x'.repeat(1001) },
      ...[0, 1000, 1.5, '2', -1, null].map(q => ({ ...PEDIDO, quantidade: q })),
      ...[-1, 100, 'x', 1.5].map(s => ({ ...PEDIDO, setor: s })),
    ];
    for (const corpo of ruins) assert.strictEqual((await pedir(env, h, corpo)).status, 400, JSON.stringify(corpo).slice(0, 80));
    assert.strictEqual((await pedir(env, h, 'não é json')).status, 400);
    assert.strictEqual((await meusPedidos(env, h)).length, 0);
    // limites válidos
    assert.strictEqual((await pedir(env, h, { ...PEDIDO, item: 'x'.repeat(120), quantidade: 999, justificativa: 'y'.repeat(1000), setor: 3 })).status, 201);
    assert.strictEqual((await pedir(env, h, { categoria: 'autorizacao', item: 'Acesso à pasta Financeiro', justificativa: 'Preciso conferir as notas.' })).status, 201, 'quantidade padrão 1 e setor opcional');
    assert.strictEqual((await meusPedidos(env, h)).find(s => s.categoria === 'autorizacao').quantidade, 1);
  });
  await test('solicitações: o mesmo pedido em menos de 1 min é duplo clique (409) e há teto de 20 pendentes por pessoa (429)', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Solic Dup', '10.6.4.1');
    assert.strictEqual((await pedir(env, h, PEDIDO)).status, 201);
    assert.strictEqual((await pedir(env, h, PEDIDO)).status, 409);
    assert.strictEqual((await pedir(env, h, { ...PEDIDO, item: 'Outro item' })).status, 201, 'item diferente não é repetição');
    assert.strictEqual((await pedir(env, h, { ...PEDIDO, categoria: 'material' })).status, 201, 'categoria diferente não é repetição');
    // chega a 20 pendentes (pedidos antigos, para não cair na regra do duplo clique)
    for (let i = 0; i < 17; i++) {
      await env.CHAMADOS_DB.prepare(`INSERT INTO solicitacoes (id, numero, categoria, item, quantidade, justificativa, solicitante, status, created_at, updated_at) VALUES (?, ?, 'material', ?, 1, 'x', 'Pessoa Solic Dup', 'pendente', ?, ?)`)
        .bind(`antigo-${i}`, 100 + i, `Item antigo ${i}`, Date.now() - 3_600_000, Date.now() - 3_600_000).run();
    }
    const cheio = await pedir(env, h, { ...PEDIDO, item: 'Item novo depois do teto' });
    assert.strictEqual(cheio.status, 429);
    assert.match((await cheio.json()).error, /20 pedidos/);
    // quem já tem pedidos atendidos volta a poder pedir
    await env.CHAMADOS_DB.prepare(`UPDATE solicitacoes SET status = 'entregue' WHERE id = 'antigo-0'`).run();
    assert.strictEqual((await pedir(env, h, { ...PEDIDO, item: 'Item novo depois do teto' })).status, 201);
  });

  await test('solicitações (TI): lista só para staff, com filtros validados e o selo de pendentes independente do filtro', async () => {
    const env = comOperadores(eqEnv());
    const a = await sessaoDe(env, 'Pessoa Solic Lista A', '10.6.5.1');
    const b = await sessaoDe(env, 'Pessoa Solic Lista B', '10.6.5.2');
    const id1 = (await (await pedir(env, a, { ...PEDIDO, item: 'Notebook', categoria: 'equipamento' })).json()).id;
    await pedir(env, b, { ...PEDIDO, item: 'Pasta de rede', categoria: 'autorizacao' });
    await pedir(env, b, { ...PEDIDO, item: 'Fonte do PC', categoria: 'peca' });
    await mudar(env, id1, { status: 'em_analise' });
    assert.strictEqual((await worker.fetch(req('GET', '/admin/solicitacoes', { headers: {} }), env)).status, 403);
    const tudo = await listaAdmin(env);
    assert.strictEqual(tudo.solicitacoes.length, 3);
    assert.strictEqual(tudo.pendentes, 2, 'só as que esperam a primeira resposta');
    assert.deepStrictEqual((await listaAdmin(env, '?categoria=peca')).solicitacoes.map(s => s.item), ['Fonte do PC']);
    const so = await listaAdmin(env, '?status=em_analise');
    assert.deepStrictEqual(so.solicitacoes.map(s => s.item), ['Notebook']);
    assert.strictEqual(so.pendentes, 2, 'o selo não muda com o filtro');
    assert.strictEqual((await listaAdmin(env, '', EVERSON)).solicitacoes.length, 3, 'o operador também atende solicitações');
    for (const qs of ['?status=lixo', '?categoria=viagem']) assert.strictEqual((await worker.fetch(req('GET', `/admin/solicitacoes${qs}`, { headers: ADM }), env)).status, 400, qs);
  });
  await test('solicitações (TI): andamento em etapas, transições inválidas recusadas, rejeitar exige motivo e reabrir limpa o motivo', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Solic Fluxo', '10.6.6.1');
    const id = (await (await pedir(env, h, PEDIDO)).json()).id;
    const estado = async () => (await meusPedidos(env, h))[0];
    // pular etapa ou voltar do fim não pode
    for (const [para, de] of [['aprovado', 'pendente'], ['em_transito', 'pendente'], ['entregue', 'pendente'], ['pendente', 'pendente']]) {
      assert.strictEqual((await mudar(env, id, { status: para })).status, 400, `${de} -> ${para}`);
    }
    assert.strictEqual((await mudar(env, id, { status: 'lixo' })).status, 400);
    assert.strictEqual((await mudar(env, 'nao-existe', { status: 'em_analise' })).status, 404);
    assert.strictEqual((await mudar(env, id, { status: 'em_analise' }, {})).status, 403);
    // rejeitar sem motivo é recusado; com motivo grava
    assert.strictEqual((await mudar(env, id, { status: 'rejeitado' })).status, 400);
    assert.strictEqual((await mudar(env, id, { status: 'rejeitado', motivo: 'x'.repeat(501) })).status, 400);
    assert.strictEqual((await mudar(env, id, { status: 'rejeitado', motivo: '  Sem verba neste mês.  ' })).status, 200);
    let s = await estado();
    assert.deepStrictEqual([s.status, s.motivo_rejeicao, s.nota_ti], ['rejeitado', 'Sem verba neste mês.', null]);
    // reabrir limpa o motivo da rejeição (o recado da TI continua)
    assert.strictEqual((await mudar(env, id, { status: 'pendente' })).status, 200);
    assert.strictEqual((await estado()).motivo_rejeicao, null);
    // o caminho feliz até o fim, com recado que quem pediu lê
    assert.strictEqual((await mudar(env, id, { status: 'em_analise' })).status, 200);
    assert.strictEqual((await mudar(env, id, { status: 'aprovado', motivo: 'Compra autorizada.' })).status, 200);
    assert.strictEqual((await mudar(env, id, { status: 'em_transito', motivo: 'Chega na sexta.' })).status, 200);
    assert.strictEqual((await estado()).nota_ti, 'Chega na sexta.');
    assert.strictEqual((await mudar(env, id, { status: 'entregue' })).status, 200);
    s = await estado();
    assert.deepStrictEqual([s.status, s.nota_ti], ['entregue', 'Chega na sexta.'], 'sem recado novo o anterior fica');
    assert.strictEqual((await mudar(env, id, { status: 'pendente' })).status, 400, 'entregue é o fim');
    // aprovado pode ir direto a entregue (autorização não tem entrega física)
    const id2 = (await (await pedir(env, h, { categoria: 'autorizacao', item: 'Acesso ao sistema X', justificativa: 'Trabalho novo.' })).json()).id;
    for (const st of ['em_analise', 'aprovado', 'entregue']) assert.strictEqual((await mudar(env, id2, { status: st })).status, 200, st);
  });
  await test('solicitações (TI): cada mudança entra no histórico com o nome de quem fez (o operador assina como ele mesmo)', async () => {
    const env = comOperadores(eqEnv());
    const h = await sessaoDe(env, 'Pessoa Solic Hist', '10.6.7.1');
    const id = (await (await pedir(env, h, PEDIDO)).json()).id;
    await mudar(env, id, { status: 'em_analise', motivo: 'Vou ver o estoque.' }, EVERSON);
    await mudar(env, id, { status: 'aprovado' });
    const ev = (await env.CHAMADOS_DB.prepare(`SELECT de_status, para_status, autor, texto FROM solicitacao_eventos WHERE solicitacao_id = ? ORDER BY rowid`).bind(id).all()).results;
    assert.deepStrictEqual(ev.map(e => [e.de_status, e.para_status, e.autor, e.texto]), [
      [null, 'pendente', 'Pessoa Solic Hist', null],
      ['pendente', 'em_analise', 'Everson', 'Vou ver o estoque.'],
      ['em_analise', 'aprovado', 'Henrique', null],
    ]);
  });
  await test('solicitações (TI): se outro operador mexeu no meio, a mudança é recusada (409) e não deixa histórico falso', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Solic Corrida', '10.6.8.1');
    const id = (await (await pedir(env, h, PEDIDO)).json()).id;
    const db = env.CHAMADOS_DB;
    let primeiro = false; // só arma depois do aquecimento (o primeiro batch de um banco novo é o que cria as tabelas)
    // simula o outro operador: logo antes da gravação, o pedido já foi para "aprovado" por outra pessoa
    const env2 = { ...env, CHAMADOS_DB: { prepare: (...a) => db.prepare(...a), batch: async (s) => {
      if (primeiro) { primeiro = false; await db.prepare(`UPDATE solicitacoes SET status = 'em_analise', updated_at = ? WHERE id = ?`).bind(Date.now() + 5, id).run(); }
      return db.batch(s);
    } } };
    await listaAdmin(env2); // aquece: o esquema já está garantido para este banco
    primeiro = true;
    const r = await mudar(env2, id, { status: 'em_analise' });
    assert.strictEqual(r.status, 409);
    assert.match((await r.json()).error, /mudou enquanto você olhava/);
    const eventos = (await db.prepare(`SELECT COUNT(*) AS n FROM solicitacao_eventos WHERE solicitacao_id = ?`).bind(id).first()).n;
    assert.strictEqual(eventos, 1, 'só o evento da criação: a mudança perdida não gravou histórico');
  });
  await test('solicitações: falha no push de quem pediu não derruba a mudança de etapa', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Solic Push', '10.6.9.1');
    const id = (await (await pedir(env, h, PEDIDO)).json()).id;
    await env.SUBSCRIPTIONS.put('usub_Pessoa Solic Push', JSON.stringify({ endpoint: 'https://fake-push-endpoint.test/x', keys: { p256dh: 'invalida', auth: 'invalida' } }));
    assert.strictEqual((await mudar(env, id, { status: 'em_analise' })).status, 200);
    assert.strictEqual((await meusPedidos(env, h))[0].status, 'em_analise');
  });
  await test('solicitações: banco que nunca teve as tabelas funciona (criadas no primeiro uso)', async () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8'));
    raw.exec('DROP TABLE solicitacao_eventos; DROP TABLE solicitacoes;');
    const env = { ...hEnv, CHAMADOS_DB: makeD1FromSqlite(raw), SUBSCRIPTIONS: makeMockKV(), SOLICITACOES_ATIVO: 'true' };
    assert.deepStrictEqual((await listaAdmin(env)).solicitacoes, []);
    const h = await sessaoDe(env, 'Pessoa Solic Nova', '10.6.10.1');
    assert.strictEqual((await pedir(env, h, PEDIDO)).status, 201);
    assert.strictEqual((await meusPedidos(env, h)).length, 1);
  });
  await test('solicitações: renomear, transferir e excluir o solicitante levam os pedidos junto', async () => {
    const env = eqEnv();
    const a = await sessaoDe(env, 'Pessoa Casc Um', '10.6.9.1');
    await pedir(env, a, PEDIDO);
    await d1CreateSolicitante(env, 'Pessoa Casc Dois', null);
    const conta = async (nome) => (await env.CHAMADOS_DB.prepare('SELECT COUNT(*) n FROM solicitacoes WHERE solicitante = ?').bind(nome).first()).n;
    assert.strictEqual((await eqPost(env, '/admin/solicitantes/' + encodeURIComponent('Pessoa Casc Um') + '/renomear', { novoNome: 'Pessoa Casc Renomeada' })).status, 200);
    assert.deepStrictEqual([await conta('Pessoa Casc Um'), await conta('Pessoa Casc Renomeada')], [0, 1]);
    assert.strictEqual((await eqPost(env, '/admin/solicitantes/' + encodeURIComponent('Pessoa Casc Renomeada') + '/transferir-chamados', { para: 'Pessoa Casc Dois' })).status, 200);
    assert.deepStrictEqual([await conta('Pessoa Casc Renomeada'), await conta('Pessoa Casc Dois')], [0, 1]);
    assert.strictEqual((await eqPost(env, '/admin/solicitantes/' + encodeURIComponent('Pessoa Casc Dois') + '/excluir', {})).status, 200);
    assert.strictEqual(await conta('Pessoa Casc Dois'), 0);
    assert.strictEqual((await env.CHAMADOS_DB.prepare('SELECT COUNT(*) n FROM solicitacao_eventos').first()).n, 0);
  });
  await test('solicitações: voltar a pendente ou rejeitar não deixa recado nem motivo velho aparecendo', async () => {
    const env = eqEnv();
    const h = await sessaoDe(env, 'Pessoa Nota Ti', '10.6.9.2');
    const { id } = await (await pedir(env, h, PEDIDO)).json();
    assert.strictEqual((await mudar(env, id, { status: 'em_analise' })).status, 200);
    assert.strictEqual((await mudar(env, id, { status: 'aprovado', motivo: 'chega na sexta' })).status, 200);
    assert.strictEqual((await mudar(env, id, { status: 'rejeitado', motivo: 'sem verba' })).status, 200);
    let [s] = await meusPedidos(env, h);
    assert.deepStrictEqual([s.nota_ti, s.motivo_rejeicao], ['chega na sexta', 'sem verba']);
    assert.strictEqual((await mudar(env, id, { status: 'pendente' })).status, 200);
    [s] = await meusPedidos(env, h);
    assert.deepStrictEqual([s.nota_ti, s.motivo_rejeicao], [null, null]);
  });

  // Alerta de SLA por push (Cron). Relógio simulado: 2026-11-25 é uma quarta-feira.
  const SLA_EVERSON = 170628721, SLA_HENRIQUE = 200498355;
  const emFortaleza = (iso) => Date.parse(iso + '-03:00');
  const QUARTA_10H = emFortaleza('2026-11-25T10:00:00');
  const MIN = 60000;
  async function slaEnv({ aparelhos = [['eve', SLA_EVERSON], ['hen', SLA_HENRIQUE]] } = {}) {
    const e = { ...env, SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    for (const [nome, operadorId] of aparelhos) {
      await e.SUBSCRIPTIONS.put(`adminsub_sla-${nome}`, JSON.stringify({ endpoint: `https://fake-push-endpoint.test/sla-${nome}`, keys: FAKE_PUSH_KEYS, operadorId }));
    }
    return e;
  }
  const chamadoSla = (e, id, due, extra = {}) => seedChamadoComId(e, id, {
    name: 'Título sigiloso', description: 'Descrição sigilosa', solicitante: 'Pessoa Sigilosa', priority: 1, tipo: 0, setor: 0,
    status: 'aberto', assignee_id: SLA_EVERSON, assignee_ids: [SLA_EVERSON], due_date: due, ...extra,
  });
  async function rodar(e, agora) {
    adminPushCalls.length = 0;
    const r = await alertarSla(e, agora);
    return { avisos: r.avisos, quem: adminPushCalls.map(c => c.url.split('/sla-')[1]).sort() };
  }

  await test('alerta de SLA: perto do prazo avisa só o atendente, e não repete', async () => {
    const e = await slaEnv();
    await chamadoSla(e, 'sla-1', QUARTA_10H + 10 * MIN);
    assert.deepStrictEqual((await rodar(e, QUARTA_10H)).quem, ['eve']);
    assert.deepStrictEqual((await rodar(e, QUARTA_10H + 5 * MIN)).quem, []);
  });
  await test('alerta de SLA: vencido avisa o atendente e o admin; prazo novo volta a avisar', async () => {
    const e = await slaEnv();
    await chamadoSla(e, 'sla-2', QUARTA_10H - MIN, { status: 'em atendimento' });
    assert.deepStrictEqual((await rodar(e, QUARTA_10H)).quem, ['eve', 'hen']);
    assert.deepStrictEqual((await rodar(e, QUARTA_10H + 5 * MIN)).quem, []);
    await e.CHAMADOS_DB.prepare('UPDATE chamados SET due_date = ? WHERE id = ?').bind(QUARTA_10H + 20 * MIN, 'sla-2').run();
    assert.deepStrictEqual((await rodar(e, QUARTA_10H + 10 * MIN)).quem, ['eve']);
  });
  await test('alerta de SLA: pendente, encerrado, prazo distante e atraso muito antigo não avisam', async () => {
    const e = await slaEnv();
    await chamadoSla(e, 'sla-p', QUARTA_10H - MIN, { status: 'pendente' });
    await chamadoSla(e, 'sla-e', QUARTA_10H - MIN, { status: 'encerrado' });
    await chamadoSla(e, 'sla-d', QUARTA_10H + 16 * MIN);
    await chamadoSla(e, 'sla-v', QUARTA_10H - 5 * 24 * 60 * MIN);
    assert.deepStrictEqual((await rodar(e, QUARTA_10H)).quem, []);
  });
  await test('alerta de SLA: só seg a sex das 07h às 18h de Fortaleza', async () => {
    const e = await slaEnv();
    for (const iso of ['2026-11-25T06:59:00', '2026-11-25T18:00:00', '2026-11-28T10:00:00', '2026-11-29T10:00:00']) {
      const agora = emFortaleza(iso);
      await chamadoSla(e, `sla-${iso}`, agora - MIN);
      assert.deepStrictEqual((await rodar(e, agora)).quem, [], iso);
    }
  });
  await test('alerta de SLA: o que venceu na sexta à noite sai na segunda de manhã', async () => {
    const e = await slaEnv();
    await chamadoSla(e, 'sla-fds', emFortaleza('2026-11-27T18:30:00'));
    assert.deepStrictEqual((await rodar(e, emFortaleza('2026-11-30T07:00:00'))).quem, ['eve', 'hen']);
  });
  await test('alerta de SLA: no máximo 5 avisos por rodada, o resto vai na seguinte', async () => {
    const e = await slaEnv();
    for (let i = 0; i < 7; i++) await chamadoSla(e, `sla-m${i}`, QUARTA_10H + (i + 1) * MIN);
    assert.strictEqual((await rodar(e, QUARTA_10H)).avisos, 5);
    assert.strictEqual((await rodar(e, QUARTA_10H)).avisos, 2);
    assert.strictEqual((await rodar(e, QUARTA_10H)).avisos, 0);
  });
  await test('alerta de SLA: sem aparelho ou com falha no envio não marca; inscrição morta é apagada', async () => {
    const e = await slaEnv({ aparelhos: [] });
    await chamadoSla(e, 'sla-s', QUARTA_10H + 10 * MIN);
    assert.strictEqual((await rodar(e, QUARTA_10H)).avisos, 0);
    await e.SUBSCRIPTIONS.put('adminsub_sla-eve', JSON.stringify({ endpoint: 'https://fake-push-endpoint.test/sla-eve', keys: FAKE_PUSH_KEYS, operadorId: SLA_EVERSON }));
    failingPushEndpoints.set('https://fake-push-endpoint.test/sla-eve', 500);
    try {
      await rodar(e, QUARTA_10H);
      assert.deepStrictEqual((await e.SUBSCRIPTIONS.list({ prefix: 'slaalert_' })).keys, []);
      failingPushEndpoints.set('https://fake-push-endpoint.test/sla-eve', 410);
      await rodar(e, QUARTA_10H);
      assert.strictEqual(await e.SUBSCRIPTIONS.get('adminsub_sla-eve'), null);
    } finally {
      failingPushEndpoints.delete('https://fake-push-endpoint.test/sla-eve');
    }
  });
  await test('alerta de SLA: aparelho quebrado não trava os outros, e o teto vale por envio', async () => {
    const e = await slaEnv();
    for (let i = 0; i < 6; i++) await chamadoSla(e, `sla-q${i}`, QUARTA_10H - (i + 1) * MIN);
    failingPushEndpoints.set('https://fake-push-endpoint.test/sla-eve', 403);
    try {
      const r = await rodar(e, QUARTA_10H);
      assert.deepStrictEqual(r.quem, ['eve', 'hen', 'hen', 'hen', 'hen']);
    } finally {
      failingPushEndpoints.delete('https://fake-push-endpoint.test/sla-eve');
    }
    const muitos = await slaEnv({ aparelhos: ['a', 'b', 'c', 'd'].map(n => [n, SLA_EVERSON]) });
    for (let i = 0; i < 5; i++) await chamadoSla(muitos, `sla-n${i}`, QUARTA_10H + (i + 1) * MIN);
    assert.strictEqual((await rodar(muitos, QUARTA_10H)).quem.length, 8);
  });
  await test('alerta de SLA: o texto leva número e prazo, nunca título, descrição ou solicitante', async () => {
    // O corpo do push é cifrado; confere o payload montado antes de cifrar.
    const e = await slaEnv();
    await chamadoSla(e, 'sla-t', QUARTA_10H - MIN);
    const vistos = [];
    const encodeReal = TextEncoder.prototype.encode;
    TextEncoder.prototype.encode = function (s) { if (String(s).includes('"type":"sla"')) vistos.push(String(s)); return encodeReal.call(this, s); };
    try { await alertarSla(e, QUARTA_10H); } finally { TextEncoder.prototype.encode = encodeReal; }
    const corpos = vistos.map(v => JSON.parse(v).body).sort();
    assert.deepStrictEqual(corpos, [
      'Chamado sem número passou do prazo (era 09:59)',
      'Chamado sem número passou do prazo (era 09:59) (atendente: Everson)',
    ]);
    assert.ok(!vistos.some(v => /sigilos/i.test(v)));
  });
  await test('alerta de SLA: o handler scheduled usa o horário do evento e não lança', async () => {
    const e = await slaEnv();
    await chamadoSla(e, 'sla-c', QUARTA_10H + 10 * MIN);
    adminPushCalls.length = 0;
    await worker.scheduled({ scheduledTime: QUARTA_10H }, e, {});
    assert.strictEqual(adminPushCalls.length, 1);
    await worker.scheduled({ scheduledTime: QUARTA_10H }, { ...e, CHAMADOS_DB: null }, {});
  });

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed > 0 ? 1 : 0);
})();
