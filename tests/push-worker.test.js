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

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { failed++; console.log(`FAIL  - ${name}\n        ${err.message}`); }
}

(async () => {
  const workerPath = pathToFileURL(path.join(__dirname, '..', 'push-worker.js')).href;
  const { default: worker, d1GetChamado, d1SetAssignees, d1CreateSolicitante, d1ListAnexos, d1CreateChamado, d1ListEventos } = await import(workerPath);

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
    solicitante: 'Michael Vasconcelos', assignee_id: 170628721, assignee_ids: [170628721],
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
    await d1CreateSolicitante(env, nome);
  }

  console.log('--- registro e login ---');
  let token;
  await test('registra senha nova com sucesso e já devolve token', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Michael Vasconcelos', password: 'senha123' }) }), env);
    if (res.status !== 200) throw new Error(`status ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.token) throw new Error('sem token na resposta');
    token = data.token;
  });
  await test('registrar de novo o mesmo nome falha com 409', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Michael Vasconcelos', password: 'outrasenha' }) }), env);
    assert.strictEqual(res.status, 409);
  });
  await test('senha curta demais é rejeitada', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Nova Pessoa', password: '12' }) }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('registrar com nome que não está na lista de solicitantes dá 403 (Fase M1, 2026-08-13)', async () => {
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Alguém Que Não Existe', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('login com senha certa funciona', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Michael Vasconcelos', password: 'senha123' }) }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('login com senha errada dá 401', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Michael Vasconcelos', password: 'errada' }) }), env);
    assert.strictEqual(res.status, 401);
  });
  await test('login pra nome sem senha cadastrada dá 404', async () => {
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Alguém Sem Conta', password: 'x' }) }), env);
    assert.strictEqual(res.status, 404);
  });
  await test('após 5 tentativas erradas, a 6ª fica bloqueada por lockout (429)', async () => {
    await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Ariele Santo', password: 'senhadaariele' }) }), env);
    for (let i = 0; i < 5; i++) {
      const r = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Ariele Santo', password: 'errada' }) }), env);
      assert.strictEqual(r.status, 401, `tentativa ${i + 1} deveria dar 401`);
    }
    const res = await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Ariele Santo', password: 'errada' }) }), env);
    assert.strictEqual(res.status, 429);
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
    const brunoRegister = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Bruno Guilherme', password: 'senhadobruno' }) }), env);
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
    await d1CreateSolicitante(solitaryEnv, 'Michael Vasconcelos');
    const reg = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Michael Vasconcelos', password: 'senha123' }) }), solitaryEnv);
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
  await test('sem SUBSCRIBE_SECRET no ambiente, /api/solicitantes fica bloqueado (não aberto)', async () => {
    const envSemSecret = { ...env, SUBSCRIBE_SECRET: undefined };
    const res = await worker.fetch(req('GET', '/api/solicitantes'), envSemSecret);
    assert.strictEqual(res.status, 403);
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
    await worker.fetch(req('POST', '/auth/login', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Michael Vasconcelos', password: 'senha123' }) }), env);
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
  await test('GET /api/solicitantes sem X-App-Secret dá 403', async () => {
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
    const res = await worker.fetch(req('GET', '/api/solicitantes', { headers: { 'X-App-Secret': solEnv.SUBSCRIBE_SECRET } }), solEnv);
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
    const res = await worker.fetch(req('GET', '/api/solicitantes', { headers: SECRET_HEADERS }), env);
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
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Carlos Eduardo' }),
    }), env);
    assert.strictEqual(res.status, 200);
    const res2 = await worker.fetch(req('GET', '/api/solicitantes', { headers: SECRET_HEADERS }), env);
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

    const publica = await worker.fetch(req('GET', '/api/solicitantes', { headers: SECRET_HEADERS }), env).then(r => r.json());
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
    const publica = await worker.fetch(req('GET', '/api/solicitantes', { headers: SECRET_HEADERS }), env).then(r => r.json());
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
    const res = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Carlos Eduardo', password: 'senhaboa123' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  // Fase M5 (2026-08-13): POST /admin/migrate-solicitantes removida (já rodou em
  // produção, ver CLAUDE.md) — sem rota, sem teste.

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
    solicitante: 'Michael Vasconcelos', assignee_id: 170628721, assignee_ids: [170628721],
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
    const res = await worker.fetch(req('GET', '/admin/tasks?operador=170628721', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { total, tasks } = await res.json();
    assert.strictEqual(total, 1);
    assert.strictEqual(tasks[0].id, 'task-michael-1');
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
    const res = await worker.fetch(req('GET', '/admin/tasks?operador=170628721', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    const { tasks } = await res.json();
    assert.deepStrictEqual(tasks[0].assignees.map(a => a.id), [170628721]);
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
    const everson = data.tempoMedioPorOperador['170628721'];
    assert.ok(everson, 'Everson deveria aparecer no tempo médio de atendimento');
    // D1 não guarda nome de operador, só o id (diferente da versão ClickUp-based, que
    // tinha `a.username` de graça) — o painel resolve id->nome via OPERADORES no cliente.
    assert.strictEqual(everson.nome, null);
    assert.strictEqual(everson.totalChamados, 1);
    assert.ok(everson.mediaMs > 0);
    assert.strictEqual(data.tempoMedioPorOperador['200498355'], undefined, 'chamado da Ariele não foi encerrado, não deveria contar tempo de atendimento pro Henrique');
  });

  // Fase A do roadmap pós-MVP-visual (2026-08-14): filtro de período opcional
  // (desde/ate, epoch ms). task-michael-1/task-ariele-1 foram criados agora (Date.now())
  // via seedChamadoComId — ajusta date_created direto no D1 pra ter datas conhecidas.
  await test('desde/ate filtram por date_created — chamado fora do intervalo não conta', async () => {
    await adminEnv.CHAMADOS_DB.prepare('UPDATE chamados SET date_created = ? WHERE id = ?').bind(1_000_000, 'task-michael-1').run();
    await adminEnv.CHAMADOS_DB.prepare('UPDATE chamados SET date_created = ? WHERE id = ?').bind(5_000_000, 'task-ariele-1').run();

    const res = await worker.fetch(req('GET', '/admin/metrics?desde=900000&ate=1100000', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.total, 1, 'só o chamado do Michael (date_created=1_000_000) deveria estar dentro do range');
  });
  await test('desde/ate inválido (não-numérico) devolve 400', async () => {
    const res = await worker.fetch(req('GET', '/admin/metrics?desde=nao-e-numero', { headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET } }), adminEnv);
    assert.strictEqual(res.status, 400);
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
      solicitante: 'Michael Vasconcelos', status: 'aberto', assignee_id: 170628721,
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
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'encerrado' })
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
  await test('assigneeId:null ("Sem atribuição") limpa assignee_id e a tabela de junção', async () => {
    const id = await criarChamadoTeste({ assignee_id: 170628721, assignee_ids: [170628721, 200498355] });
    const res = await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: null })
    }), env);
    assert.strictEqual(res.status, 200);
    const linha = await d1GetChamado(env, id);
    assert.strictEqual(linha.assignee_id, null);
    const { results } = await env.CHAMADOS_DB.prepare('SELECT assignee_id FROM chamado_assignees WHERE chamado_id = ?').bind(id).all();
    assert.deepStrictEqual(results, [], 'assigneeId:null deveria remover todo mundo da tabela de junção também');
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
    const id = await criarChamadoTeste({ assignee_id: 170628721, assignee_ids: [170628721] });
    await worker.fetch(req('POST', `/admin/tasks/${id}`, {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: 200498355 })
    }), env);
    const eventos = await d1ListEventos(env, id);
    const evOperador = eventos.find(e => e.tipo === 'operador');
    assert.ok(evOperador, 'deveria ter gravado um evento de troca de operador');
    assert.strictEqual(evOperador.de_valor, '170628721');
    assert.strictEqual(evOperador.para_valor, '200498355');
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
      solicitante: 'Michael Vasconcelos', status: 'aberto', assignee_id: 170628721,
    });

    const realBatch = atomicEnv.CHAMADOS_DB.batch.bind(atomicEnv.CHAMADOS_DB);
    atomicEnv.CHAMADOS_DB.batch = async () => { throw new Error('D1 indisponível (simulado)'); };
    try {
      const res = await worker.fetch(req('POST', `/admin/tasks/${created.id}`, {
        headers: { 'X-Admin-Secret': atomicEnv.ADMIN_SECRET },
        body: JSON.stringify({ assigneeId: 200498355 }),
      }), atomicEnv);
      assert.strictEqual(res.status, 400, 'D1 é a escrita agora — uma falha real deveria virar erro, não um 200 silencioso');
    } finally {
      atomicEnv.CHAMADOS_DB.batch = realBatch;
    }

    const after = await d1GetChamado(atomicEnv, created.id);
    assert.strictEqual(after.assignee_id, 170628721, 'assignee_id NÃO deveria ter mudado — o batch falhou, nada aplicou');
    const { results } = await atomicEnv.CHAMADOS_DB.prepare('SELECT assignee_id FROM chamado_assignees WHERE chamado_id = ?').bind(created.id).all();
    assert.deepStrictEqual(results.map(r => r.assignee_id), [170628721], 'tabela de junção também não deveria ter mudado — sem isso, ficaria mostrando o Henrique enquanto assignee_id ainda diz Everson (ou pior, vazia)');
  });

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed > 0 ? 1 : 0);
})();
