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
const SOLUCAO_FIELD_ID = '16144175-845e-4e3c-baaa-a2517325cd43';
const MAX_ANEXO_BYTES = 10 * 1024 * 1024; // mesmo valor de push-worker.js (Fase M2)
const FAKE_OPTIONS = [
  { id: 'a1', name: 'Ariele Santo', orderindex: 1 },
  { id: 'a27', name: 'Michael Vasconcelos', orderindex: 27 },
  { id: 'a4', name: 'Bruno Guilherme', orderindex: 4 }, // existe na ClickUp, mas nunca abriu chamado (pra testar o fallback)
];
// Datas fixas (não Date.now()) pra métricas/SLA ficarem determinísticas nos testes de /admin/metrics.
const FAKE_DUE_DATE_MICHAEL = 1700000000000;
const FAKE_TASKS = [
  {
    id: 'task-michael-1', name: 'Chamado do Michael',
    status: { status: 'encerrado' }, priority: { priority: 'urgent' },
    assignees: [{ id: 170628721, username: 'Everson' }],
    due_date: FAKE_DUE_DATE_MICHAEL,
    date_closed: FAKE_DUE_DATE_MICHAEL - 60000,   // fechou 1min ANTES do prazo -> dentro do SLA
    start_date: FAKE_DUE_DATE_MICHAEL - 3600000,  // ~59min de atendimento até fechar
    custom_fields: [
      { id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } },
      { id: TIPO_FIELD_ID, value: 0 },
      { id: SETOR_FIELD_ID, value: 1 },
    ],
  },
  {
    id: 'task-ariele-1', name: 'Chamado da Ariele',
    status: { status: 'aberto' }, priority: { priority: 'normal' },
    assignees: [{ id: 200498355, username: 'Henrique' }],
    due_date: Date.now() - 60000, // prazo já vencido e ainda aberta -> atrasado
    custom_fields: [
      { id: SOLICITANTE_FIELD_ID, value: { orderindex: 1 } },
      { id: TIPO_FIELD_ID, value: 2 },
      { id: SETOR_FIELD_ID, value: 0 },
    ],
  },
];

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
  const { default: worker, d1GetChamado, d1SetAssignees, d1CreateSolicitante, d1ListAnexos } = await import(workerPath);

  let lastCreatePayload = null;
  let createdTaskCounter = 0; // cada POST de criação gera um id novo — evita colisão de
  // INSERT OR IGNORE no D1 entre testes diferentes que criam chamado (Fase B7: desde que
  // o mirror parou de exigir TIPO/SETOR, mais testes de criação passaram a espelhar de
  // verdade, e todos usar o mesmo id fixo fazia o 2º ser silenciosamente ignorado).
  let taskListCallCount = 0;
  let migrationTasksOverride = null; // usado só nos testes de POST /admin/migrate-d1
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/list/') && u.includes('/field')) {
      return new Response(JSON.stringify({ fields: [{ id: SOLICITANTE_FIELD_ID, type_config: { options: FAKE_OPTIONS } }] }), { status: 200 });
    }
    if (u.endsWith('/task/task-michael-1/attachment') || u.endsWith('/task/task-ariele-1/attachment')) {
      return new Response(JSON.stringify({ id: 'fake-attachment-id' }), { status: 200 });
    }
    if (u.endsWith('/task/task-michael-1')) return new Response(JSON.stringify(FAKE_TASKS[0]), { status: 200 });
    if (u.endsWith('/task/task-ariele-1'))  return new Response(JSON.stringify(FAKE_TASKS[1]), { status: 200 });
    if (u.includes('/list/') && /\/task(\?|$)/.test(u)) {
      if (opts?.method === 'POST') {
        lastCreatePayload = JSON.parse(opts.body);
        // Devolve no MESMO "shape" que a ClickUp real devolve pra task recém-criada —
        // status/priority como objeto aninhado, não os valores crus (number/string) que
        // foram mandados no corpo do POST. Precisa bater com esse shape porque
        // handleCreateTask (Fase B7) usa mapClickUpTaskToD1() em cima desta resposta pra
        // espelhar no D1 — um mock ingênuo (só ecoando o payload) já escondeu esse
        // exato tipo de incompatibilidade de shape antes de eu perceber e corrigir aqui.
        const PRIO_NUM_TO_NAME = { 1: 'urgent', 2: 'high', 3: 'normal' };
        createdTaskCounter++;
        const created = {
          id: `new-task-id-${createdTaskCounter}`,
          name: lastCreatePayload.name,
          description: lastCreatePayload.description ?? null,
          text_content: lastCreatePayload.description ?? null,
          status: { status: 'aberto' },
          priority: { priority: PRIO_NUM_TO_NAME[lastCreatePayload.priority] || 'normal' },
          assignees: (lastCreatePayload.assignees || []).map(id => ({ id, username: 'Operador' })),
          due_date: lastCreatePayload.due_date,
          date_created: Date.now(),
          custom_fields: lastCreatePayload.custom_fields,
        };
        return new Response(JSON.stringify(created), { status: 200 });
      }
      // Filtro por custom_fields (?custom_fields=...) não é mais usado por nenhuma rota —
      // GET /api/my-tasks passou a ler do D1 na Fase B7 (2026-08-12), sem round-trip pra
      // ClickUp nenhum. O que sobra aqui é só fetchAllTasks() (admin/tasks, admin/metrics,
      // migração), que sempre pede a lista inteira, sem esse filtro.
      taskListCallCount++;
      return new Response(JSON.stringify({ tasks: migrationTasksOverride || FAKE_TASKS }), { status: 200 });
    }
    return realFetch(url, opts);
  };

  const env = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1(), ANEXOS: makeMockR2() };
  const SECRET_HEADERS = { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'Content-Type': 'application/json' };
  let brunoToken; // Bruno nunca erra senha nem esbarra em throttle — usado pra testes que precisam de uma sessão "limpa"

  // Semeia o D1 com os 2 chamados fake (task-michael-1/task-ariele-1) ANTES de qualquer
  // teste — GET /api/my-tasks passou a ler do D1, não mais da ClickUp direto (Fase B7,
  // 2026-08-12), então os testes de isolamento logo abaixo precisam encontrar esses
  // chamados lá. Usa a mesma rota real de migração que a produção usa (POST
  // /admin/migrate-d1), não uma reimplementação paralela — `migrationTasksOverride`
  // ainda está null aqui, então pega o FAKE_TASKS default do mock de fetch.
  await worker.fetch(req('POST', '/admin/migrate-d1', {
    headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
  }), env);

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
  await test('forjar SOLICITANTE de outra pessoa ao criar é ignorado — servidor usa o da sessão', async () => {
    lastCreatePayload = null;
    const res = await worker.fetch(req('POST', '/api/tasks', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': token },
      body: JSON.stringify({ name: 'chamado forjado', custom_fields: [{ id: SOLICITANTE_FIELD_ID, value: 1 /* Ariele! */ }] })
    }), env);
    assert.strictEqual(res.status, 200);
    const sentField = lastCreatePayload.custom_fields.find(f => f.id === SOLICITANTE_FIELD_ID);
    assert.strictEqual(sentField.value, 27, 'SOLICITANTE devia ter sido forçado pro Michael (27)');
  });
  await test('criação sem sessão dá 401', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'x' }) }), env);
    assert.strictEqual(res.status, 401);
  });
  await test('chamado criado é espelhado no D1 (Fase B7, dual-write) — ClickUp continua sendo quem cria de verdade', async () => {
    await env.SUBSCRIPTIONS.delete('throttle_create_Michael Vasconcelos'); // testes anteriores já usaram o throttle de 60s do Michael
    lastCreatePayload = null;
    const res = await worker.fetch(req('POST', '/api/tasks', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': token },
      body: JSON.stringify({
        name: 'Chamado pra testar o espelho no D1',
        custom_fields: [
          { id: TIPO_FIELD_ID, value: 0 },
          { id: SETOR_FIELD_ID, value: 1 },
        ],
      })
    }), env);
    assert.strictEqual(res.status, 200);
    const created = await res.json();
    const mirrored = await d1GetChamado(env, created.id);
    assert.ok(mirrored, 'chamado criado na ClickUp deveria ter sido espelhado no D1 também');
    assert.strictEqual(mirrored.name, 'Chamado pra testar o espelho no D1');
    assert.strictEqual(mirrored.solicitante, 'Michael Vasconcelos', 'espelho deve usar o solicitante da sessão, igual a ClickUp');
    assert.strictEqual(mirrored.tipo, 0);
    assert.strictEqual(mirrored.setor, 1);
    assert.strictEqual(mirrored.status, 'aberto');
  });
  await test('forjar priority/due_date ao criar é ignorado — servidor recalcula pelo TIPO', async () => {
    // Usa uma sessão do Bruno (recém-registrado aqui), não a do Michael — ele acabou de criar
    // um chamado no teste anterior e cairia no throttle de 10s (429), que não é o que este
    // teste quer verificar. A Ariele não serve: ficou bloqueada pelo lockout do teste anterior.
    const brunoRegister = await worker.fetch(req('POST', '/auth/register', { headers: SECRET_HEADERS, body: JSON.stringify({ name: 'Bruno Guilherme', password: 'senhadobruno' }) }), env);
    brunoToken = (await brunoRegister.json()).token;
    lastCreatePayload = null;
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
    assert.strictEqual(lastCreatePayload.priority, 1, 'Notebooks é Urgente (1) — não deveria aceitar o 4 forjado');
    assert.ok(lastCreatePayload.due_date > before, 'due_date forjado (1) não deveria ter sido aceito');
    assert.ok(lastCreatePayload.due_date <= before + 3600000 + 5000, 'due_date deveria ser ~1h a partir de agora (Urgente)');
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

  console.log('--- POST /admin/migrate-schema-anexos e /admin/migrate-anexos (Fase M2, 2026-08-13) ---');
  await test('POST /admin/migrate-schema-anexos sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('cria a tabela chamado_anexos, idempotente rodando de novo', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res.status, 200);
    const res2 = await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    assert.strictEqual(res2.status, 200, 'rodar de novo não deveria falhar (CREATE ... IF NOT EXISTS)');
  });
  await test('POST /admin/migrate-anexos sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-anexos', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('migra os anexos de chamados reais da ClickUp pro R2, pula tasks sem anexo, é idempotente e paginado', async () => {
    const anexosEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1(), ANEXOS: makeMockR2() };
    await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { headers: { 'X-Admin-Secret': anexosEnv.ADMIN_SECRET } }), anexosEnv);

    const previousFetch = globalThis.fetch;
    let downloadCalls = 0;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/list/') && /\/task\?/.test(u) && opts?.method !== 'POST') {
        return new Response(JSON.stringify({
          tasks: [
            { id: 'com-anexo-1', name: 'Chamado com anexo' },
            { id: 'sem-anexo-1', name: 'Chamado sem anexo' },
          ],
        }), { status: 200 });
      }
      if (u.endsWith('/task/com-anexo-1')) {
        return new Response(JSON.stringify({
          id: 'com-anexo-1',
          attachments: [{ title: 'print-erro.png', url: 'https://fake-clickup-cdn.example/print-erro.png' }],
        }), { status: 200 });
      }
      if (u.endsWith('/task/sem-anexo-1')) {
        return new Response(JSON.stringify({ id: 'sem-anexo-1', attachments: [] }), { status: 200 });
      }
      if (u === 'https://fake-clickup-cdn.example/print-erro.png') {
        downloadCalls++;
        return new Response('bytes-do-print-de-erro', { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/migrate-anexos', {
        headers: { 'X-Admin-Secret': anexosEnv.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
      }), anexosEnv);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.totalTasks, 2);
      assert.strictEqual(data.processedTasks, 2);
      assert.strictEqual(data.tasksComAnexo, 1);
      assert.strictEqual(data.migrated, 1);
      assert.strictEqual(data.errors.length, 0);
      assert.strictEqual(data.hasMore, false);
      assert.strictEqual(downloadCalls, 1);

      const anexos = await d1ListAnexos(anexosEnv, 'com-anexo-1');
      assert.strictEqual(anexos.length, 1);
      assert.strictEqual(anexos[0].filename, 'print-erro.png');
      assert.ok(anexos[0].r2_key.startsWith('chamados/com-anexo-1/'));
      const semAnexo = await d1ListAnexos(anexosEnv, 'sem-anexo-1');
      assert.strictEqual(semAnexo.length, 0);

      // Idempotência: rodar de novo não baixa o arquivo de novo, marca como skipped.
      const res2 = await worker.fetch(req('POST', '/admin/migrate-anexos', {
        headers: { 'X-Admin-Secret': anexosEnv.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
      }), anexosEnv);
      const data2 = await res2.json();
      assert.strictEqual(data2.migrated, 0, 'rodar de novo não deveria migrar de novo');
      assert.strictEqual(data2.skipped, 1);
      assert.strictEqual(downloadCalls, 1, 'não deveria ter baixado o arquivo de novo na 2ª rodada');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
  await test('paginação (offset/limit) processa só a fatia pedida e reporta hasMore/nextOffset', async () => {
    const pagEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1(), ANEXOS: makeMockR2() };
    await worker.fetch(req('POST', '/admin/migrate-schema-anexos', { headers: { 'X-Admin-Secret': pagEnv.ADMIN_SECRET } }), pagEnv);

    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/list/') && /\/task\?/.test(u) && opts?.method !== 'POST') {
        return new Response(JSON.stringify({
          tasks: [{ id: 'pag-1', name: 'A' }, { id: 'pag-2', name: 'B' }, { id: 'pag-3', name: 'C' }],
        }), { status: 200 });
      }
      if (/\/task\/pag-\d$/.test(u)) {
        return new Response(JSON.stringify({ id: u.split('/').pop(), attachments: [] }), { status: 200 });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/migrate-anexos', {
        headers: { 'X-Admin-Secret': pagEnv.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: 0, limit: 2 }),
      }), pagEnv);
      const data = await res.json();
      assert.strictEqual(data.processedTasks, 2);
      assert.strictEqual(data.hasMore, true);
      assert.strictEqual(data.nextOffset, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  console.log('--- falha fechada se o Worker não tiver SUBSCRIBE_SECRET configurado ---');
  await test('sem SUBSCRIBE_SECRET no ambiente, /api/field fica bloqueado (não aberto)', async () => {
    const envSemSecret = { ...env, SUBSCRIBE_SECRET: undefined };
    const res = await worker.fetch(req('GET', '/api/field'), envSemSecret);
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
  await test('POST /admin/migrate-solicitantes copia a lista da ClickUp pro D1, idempotente', async () => {
    const solicitantesEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    const res = await worker.fetch(req('POST', '/admin/migrate-solicitantes', { headers: { 'X-Admin-Secret': solicitantesEnv.ADMIN_SECRET } }), solicitantesEnv);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    // FAKE_OPTIONS no topo do arquivo tem 3 nomes (Ariele Santo, Michael Vasconcelos, Bruno Guilherme)
    assert.strictEqual(data.total, 3);
    assert.strictEqual(data.migrated, 3);
    assert.strictEqual(data.skipped, 0);

    const res2 = await worker.fetch(req('POST', '/admin/migrate-solicitantes', { headers: { 'X-Admin-Secret': solicitantesEnv.ADMIN_SECRET } }), solicitantesEnv);
    const data2 = await res2.json();
    assert.strictEqual(data2.migrated, 0, 'rodar de novo não deveria migrar de novo');
    assert.strictEqual(data2.skipped, 3, 'rodar de novo deveria marcar os 3 como já migrados');
  });

  console.log('--- GET /api/my-tasks lê do D1, não bate na ClickUp (Fase B7, 2026-08-12) ---');
  await test('devolve o que o D1 tem pro solicitante, sem nenhuma chamada à ClickUp', async () => {
    // Bruno tem exatamente 1 chamado no D1 nesse ponto — o do teste "forjar priority/
    // due_date" lá em cima, que agora espelha com sucesso mesmo sem SETOR (Fase B7,
    // mesmo dia: tipo/setor ausentes viram NULL em vez de bloquear o mirror).
    taskListCallCount = 0;
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': brunoToken } }), env);
    assert.strictEqual(res.status, 200);
    const { tasks } = await res.json();
    assert.strictEqual(tasks.length, 1, 'Bruno tem 1 chamado espelhado no D1 (criado num teste anterior)');
    assert.strictEqual(taskListCallCount, 0, 'GET /api/my-tasks não deveria mais chamar a ClickUp nenhuma vez — lê só do D1');
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
  // 🚀 B7 parte 2, fase 2 (2026-08-12): /admin/tasks e /admin/metrics passaram a ler do
  // D1, não mais da ClickUp — env ISOLADO aqui (D1 próprio, não o `env` global) porque a
  // essa altura do arquivo o `env` compartilhado já acumulou chamados extras de outros
  // testes que criam/espelham no D1 ao longo do arquivo (dual-write desde a B7 parte 1);
  // ler do D1 exporia essa contagem, que os testes de ClickUp nunca viam (liam sempre
  // FAKE_TASKS, fixo). Semeado com a mesma rota real (POST /admin/migrate-d1) que a
  // produção usa — sem reimplementação paralela.
  const adminEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
  await worker.fetch(req('POST', '/admin/migrate-d1', {
    headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
  }), adminEnv);

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

  console.log('--- fetchAllTasks pagina de verdade e avisa (truncated) quando bate no teto (via POST /admin/migrate-d1, dryRun) ---');
  // fetchAllTasks continua sendo usada por /admin/migrate-d1 (leitura da ClickUp pra
  // migrar histórico) — só /admin/tasks e /admin/metrics deixaram de usá-la nesta fase.
  await test('bate no teto de 20 páginas e devolve truncated:true, sem perder chamado silenciosamente', async () => {
    const previousFetch = globalThis.fetch;
    let pagesRequested = 0;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/list/') && /\/task\?/.test(u) && opts?.method !== 'POST') {
        pagesRequested++;
        // Sempre devolve 100 itens cheios, sem last_page — simula volume maior que o teto
        // de fetchAllTasks (20 páginas x 100 = 2000), forçando o loop a esgotar as páginas.
        const batch = Array.from({ length: 100 }, (_, i) => ({
          id: `bulk-${pagesRequested}-${i}`,
          name: 'chamado em massa (teste de paginação)',
          status: { status: 'aberto' },
          assignees: [],
          custom_fields: [{ id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } }],
        }));
        return new Response(JSON.stringify({ tasks: batch }), { status: 200 });
      }
      return previousFetch(url, opts);
    };

    try {
      const res = await worker.fetch(req('POST', '/admin/migrate-d1', {
        headers: { 'X-Admin-Secret': adminEnv.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true }),
      }), adminEnv);
      const data = await res.json();
      assert.strictEqual(pagesRequested, 20, 'deveria ter parado exatamente no teto de 20 páginas');
      assert.strictEqual(data.total, 2000, 'deveria ter buscado as 20 páginas x 100 antes de parar');
      assert.strictEqual(data.truncated, true, 'deveria avisar que bateu no teto — sem esse aviso, chamado sumiria em silêncio');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

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

  console.log('--- POST /admin/tasks/:id — a TI passa a trabalhar por aqui em vez de abrir a ClickUp ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/task-michael-1', { body: JSON.stringify({ status: 'em atendimento' }) }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('status inválido dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/task-michael-1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'invalido' })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('corpo sem nada pra atualizar dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/task-michael-1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({})
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('muda status, escreve solução e reatribui operador — cada mudança chama o endpoint certo da ClickUp', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.endsWith('/task/task-update-1') && (!opts?.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ id: 'task-update-1', assignees: [{ id: 170628721, username: 'Everson' }] }), { status: 200 });
      }
      if (u.endsWith('/task/task-update-1') && opts.method === 'PUT') {
        return new Response(JSON.stringify({ id: 'task-update-1', ok: true }), { status: 200 });
      }
      if (u.includes('/task/task-update-1/field/') && opts.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return previousFetch(url, opts);
    };

    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/task-update-1', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
        body: JSON.stringify({ status: 'em atendimento', solucao: 'Reiniciei o notebook e atualizei o driver.', assigneeId: 200498355 })
      }), env);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.deepStrictEqual(data.updated, { status: 'em atendimento', solucao: true, assigneeId: 200498355 });

      const statusCall = calls.find(c => c.method === 'PUT' && c.body?.status === 'em atendimento');
      assert.ok(statusCall, 'deveria ter dado PUT com o status novo');

      const fieldCall = calls.find(c => c.url.includes('/field/') && c.method === 'POST');
      assert.ok(fieldCall, 'deveria ter dado POST no endpoint de campo customizado');
      assert.ok(fieldCall.url.includes(SOLUCAO_FIELD_ID), 'deveria usar o field_id da SOLUCAO');
      assert.strictEqual(fieldCall.body.value, 'Reiniciei o notebook e atualizei o driver.');

      const assigneeCall = calls.find(c => c.method === 'PUT' && c.body?.assignees);
      assert.ok(assigneeCall, 'deveria ter dado PUT trocando assignees');
      assert.deepStrictEqual(assigneeCall.body.assignees, { add: [200498355], rem: [170628721] }, 'deveria remover o Everson e adicionar o Henrique, não empilhar os dois');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
  await test('atualização admin espelha status/solução/operador no D1 (Fase B7, dual-write)', async () => {
    // task-michael-1 já está no D1 (semeado no início do arquivo) — diferente do
    // task-update-1 do teste acima, que nunca existiu lá (o mirror seria um no-op
    // silencioso nesse caso, sem linha nenhuma pra atualizar).
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/task/task-michael-1') && (!opts?.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ id: 'task-michael-1', assignees: [{ id: 170628721, username: 'Everson' }] }), { status: 200 });
      }
      if (u.endsWith('/task/task-michael-1') && opts.method === 'PUT') {
        return new Response(JSON.stringify({ id: 'task-michael-1', ok: true }), { status: 200 });
      }
      if (u.includes('/task/task-michael-1/field/') && opts.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/task-michael-1', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
        body: JSON.stringify({ status: 'pendente', solucao: 'Aguardando peça de reposição.', assigneeId: 170628721 })
      }), env);
      assert.strictEqual(res.status, 200);
      const mirrored = await d1GetChamado(env, 'task-michael-1');
      assert.strictEqual(mirrored.status, 'pendente');
      assert.strictEqual(mirrored.solucao, 'Aguardando peça de reposição.');
      assert.strictEqual(mirrored.assignee_id, 170628721);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
  await test('reatribuir pra quem já é o assignee não dispara PUT nenhum (nada pra mudar)', async () => {
    const previousFetch = globalThis.fetch;
    let putCalled = false;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/task/task-update-2') && (!opts?.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ id: 'task-update-2', assignees: [{ id: 170628721, username: 'Everson' }] }), { status: 200 });
      }
      if (u.endsWith('/task/task-update-2') && opts.method === 'PUT') {
        putCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/task-update-2', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: 170628721 })
      }), env);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(putCalled, false, 'já era o assignee — não deveria mandar PUT nenhum');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  await test('assigneeId:null ("Sem atribuição") remove quem estava atribuído', async () => {
    const previousFetch = globalThis.fetch;
    let sentPayload = null;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/task/task-update-3') && (!opts?.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ id: 'task-update-3', assignees: [{ id: 170628721, username: 'Everson' }, { id: 200498355, username: 'Henrique' }] }), { status: 200 });
      }
      if (u.endsWith('/task/task-update-3') && opts.method === 'PUT') {
        sentPayload = JSON.parse(opts.body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/task-update-3', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: null })
      }), env);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(sentPayload.assignees, { add: [], rem: [170628721, 200498355] }, 'deveria remover todo mundo que estava atribuído');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  console.log('--- validação de tipo/valor (achados do revisor 2026-08-07) ---');
  await test('solucao com tipo diferente de string dá 400 (não fica ok:true em silêncio)', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/task-michael-1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ solucao: 123 })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('assigneeId não numérico (nem null) dá 400', async () => {
    const res = await worker.fetch(req('POST', '/admin/tasks/task-michael-1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: 'nao-e-numero' })
    }), env);
    assert.strictEqual(res.status, 400);
  });
  await test('atualizar só o status de um chamado com 2 assignees NÃO manda PUT de assignee nenhum (preserva os dois)', async () => {
    // Este é o cenário do bug crítico encontrado pelo revisor: o front-end só deve mandar
    // "assigneeId" quando o admin realmente toca o campo — aqui simula exatamente o corpo
    // que o admin.js corrigido manda (sem a chave assigneeId), e confirma que o Worker não
    // toca nos assignees existentes (nem faz GET da task pra montar diff, já que a chave
    // nem está presente no body).
    const previousFetch = globalThis.fetch;
    let assigneeTouched = false;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/task/task-update-4') && opts?.method === 'PUT') {
        const payload = JSON.parse(opts.body);
        if (payload.assignees) assigneeTouched = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/task-update-4', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ status: 'pendente' })
      }), env);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(assigneeTouched, false, 'sem a chave assigneeId no body, o Worker não deveria nem tentar tocar nos assignees');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
  await test('falha ao salvar a solução reporta em "updated" o que já tinha sido aplicado antes (status)', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/task/task-update-5') && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 }); // status aplicado com sucesso
      }
      if (u.includes('/task/task-update-5/field/') && opts?.method === 'POST') {
        return new Response(JSON.stringify({ err: 'campo inválido' }), { status: 500 }); // solução falha
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/task-update-5', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
        body: JSON.stringify({ status: 'em atendimento', solucao: 'tentativa que vai falhar' })
      }), env);
      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.deepStrictEqual(data.updated, { status: 'em atendimento' }, 'deveria reportar que o status já tinha sido salvo antes da solução falhar');
    } finally {
      globalThis.fetch = previousFetch;
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
    const res = await worker.fetch(req('OPTIONS', '/api/field'), env);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'https://tecnologiadainformacaoisv.github.io');
  });
  await test('logout invalida a sessão', async () => {
    await worker.fetch(req('POST', '/auth/logout', { headers: { 'X-Session-Token': token } }), env);
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': token } }), env);
    assert.strictEqual(res.status, 401);
  });

  console.log('--- POST /admin/migrate-d1 (Fase B3 — migração de histórico pro D1) ---');
  const FAKE_MIGRATION_TASKS = [
    { // válido — deve migrar
      id: 'mig-1', name: 'Impressora não imprime',
      status: { status: 'aberto' }, priority: { priority: 'high' },
      assignees: [{ id: 170628721, username: 'Everson' }],
      due_date: 1700000000000, date_created: 1699999000000,
      custom_fields: [
        { id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } },
        { id: TIPO_FIELD_ID, value: 2 },
        { id: SETOR_FIELD_ID, value: 1 },
      ],
    },
    { // solicitante fora do campo atual — migra mesmo assim, com solicitante = '' (Fase
      // B7, 2026-08-12: mesmo tratamento dos 269 chamados de antes do app existir, ver
      // CLAUDE.md "Fase B3"/"Fase B7" — não é mais erro, prioriza ter o histórico completo).
      id: 'mig-2', name: 'Chamado órfão',
      status: { status: 'aberto' }, priority: { priority: 'normal' }, assignees: [],
      custom_fields: [
        { id: SOLICITANTE_FIELD_ID, value: { orderindex: 9999 } },
        { id: TIPO_FIELD_ID, value: 0 },
        { id: SETOR_FIELD_ID, value: 0 },
      ],
    },
    { // status fora dos 4 esperados — deve virar erro
      id: 'mig-3', name: 'Chamado com status estranho',
      status: { status: 'em revisao' }, priority: { priority: 'normal' }, assignees: [],
      custom_fields: [
        { id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } },
        { id: TIPO_FIELD_ID, value: 0 },
        { id: SETOR_FIELD_ID, value: 0 },
      ],
    },
    { // TIPO ausente — migra mesmo assim, com tipo = null (Fase B7, mesmo dia: mesmo
      // tratamento dos 12 chamados reais bem antigos sem custom_fields nenhum
      // preenchido — não é mais erro, coluna já não é NOT NULL, ver d1/schema.sql).
      id: 'mig-4', name: 'Chamado sem tipo',
      status: { status: 'aberto' }, priority: { priority: 'normal' }, assignees: [],
      custom_fields: [
        { id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } },
        { id: SETOR_FIELD_ID, value: 0 },
      ],
    },
  ];

  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-d1', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });

  await test('dryRun:true reporta as contagens certas sem gravar nada no D1', async () => {
    migrationTasksOverride = FAKE_MIGRATION_TASKS;
    const res = await worker.fetch(req('POST', '/admin/migrate-d1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    }), env);
    const data = await res.json();
    assert.strictEqual(data.dryRun, true);
    assert.strictEqual(data.total, 4);
    assert.strictEqual(data.migrated, 3, 'mig-1, mig-2 (solicitante vazio) e mig-4 (tipo nulo) já não são mais erro, Fase B7');
    assert.strictEqual(data.errors.length, 1);
    const found = await d1GetChamado(env, 'mig-1');
    assert.strictEqual(found, null, 'dryRun não deveria ter gravado nada de verdade no D1');
  });

  await test('migração de verdade grava mig-1, mig-2 (solicitante vazio) e mig-4 (tipo nulo), com os campos certos', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-d1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: '{}',
    }), env);
    const data = await res.json();
    assert.strictEqual(data.migrated, 3);
    assert.strictEqual(data.skipped, 0);
    assert.strictEqual(data.errors.length, 1);
    assert.deepStrictEqual(data.errors.map(e => e.id).sort(), ['mig-3']);

    const row = await d1GetChamado(env, 'mig-1');
    assert.ok(row, 'mig-1 deveria ter sido gravada no D1');
    assert.strictEqual(row.name, 'Impressora não imprime');
    assert.strictEqual(row.status, 'aberto');
    assert.strictEqual(row.priority, 2); // 'high' -> 2
    assert.strictEqual(row.tipo, 2);
    assert.strictEqual(row.setor, 1);
    assert.strictEqual(row.solicitante, 'Michael Vasconcelos');
    assert.strictEqual(row.assignee_id, 170628721);

    const orfao = await d1GetChamado(env, 'mig-2');
    assert.ok(orfao, 'mig-2 (solicitante fora do campo atual) deveria ter sido gravada mesmo assim');
    assert.strictEqual(orfao.solicitante, '', 'solicitante não resolvido vira string vazia, não bloqueia a migração (Fase B7)');

    const semTipo = await d1GetChamado(env, 'mig-4');
    assert.ok(semTipo, 'mig-4 (sem TIPO) deveria ter sido gravada mesmo assim');
    assert.strictEqual(semTipo.tipo, null, 'tipo ausente vira NULL de verdade (coluna já não é NOT NULL)');
    assert.strictEqual(semTipo.setor, 0);
  });

  await test('rodar de novo é idempotente — não duplica, marca como skipped', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-d1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' },
      body: '{}',
    }), env);
    const data = await res.json();
    assert.strictEqual(data.migrated, 0, 'já tinha migrado antes, não deveria contar de novo');
    assert.strictEqual(data.skipped, 3);
  });

  console.log('--- POST /admin/migrate-schema-nullable-tipo-setor (Fase B7, mesmo dia — recria a tabela pra permitir NULL em tipo/setor) ---');
  await test('sem X-Admin-Secret dá 403', async () => {
    const res = await worker.fetch(req('POST', '/admin/migrate-schema-nullable-tipo-setor', { body: '{}' }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('migra o schema preservando os dados já gravados, e continua idempotente rodando de novo', async () => {
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

    // agora tipo/setor ausentes não devem mais dar erro de constraint na hora de gravar
    // — mesmo caminho real (POST /admin/migrate-d1), não uma chamada direta às funções
    // internas, pra testar o fluxo de verdade.
    migrationTasksOverride = [{
      id: 'schema-v2-check', name: 'Chamado de teste pós-migração',
      status: { status: 'aberto' }, priority: { priority: 'normal' }, assignees: [],
      custom_fields: [{ id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } }],
    }];
    const resMig = await worker.fetch(req('POST', '/admin/migrate-d1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
    }), env);
    const dataMig = await resMig.json();
    assert.strictEqual(dataMig.errors.length, 0, 'sem TIPO nem SETOR não deveria mais dar erro depois da migração de schema');
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

  await test('migração de um chamado com 2+ operadores grava os dois na tabela de junção', async () => {
    migrationTasksOverride = [{
      id: 'multi-op-1', name: 'Chamado com dois operadores',
      status: { status: 'aberto' }, priority: { priority: 'normal' },
      assignees: [{ id: 170628721, username: 'Everson' }, { id: 200498355, username: 'Henrique' }],
      custom_fields: [
        { id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } },
        { id: TIPO_FIELD_ID, value: 0 },
        { id: SETOR_FIELD_ID, value: 0 },
      ],
    }];
    await worker.fetch(req('POST', '/admin/migrate-d1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
    }), env);

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

  await test('rodar a migração de novo também sincroniza operador de chamado que já existia (backfill)', async () => {
    // Simula o cenário real de produção: chamado já estava no D1 de antes desta tabela
    // existir (só com assignee_id, sem nada em chamado_assignees ainda).
    await worker.fetch(req('POST', '/admin/migrate-schema-chamado-assignees', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } }), env);
    await env.CHAMADOS_DB.prepare('DELETE FROM chamado_assignees WHERE chamado_id = ?').bind('multi-op-1').run();
    assert.deepStrictEqual(await assigneesDoChamado('multi-op-1'), [], 'pré-condição: tabela de junção limpa pra esse chamado');

    const res = await worker.fetch(req('POST', '/admin/migrate-d1', {
      headers: { 'X-Admin-Secret': env.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
    }), env);
    const data = await res.json();
    assert.strictEqual(data.skipped, 1, 'a linha principal já existia (INSERT OR IGNORE) — só os operadores são re-sincronizados');
    assert.deepStrictEqual(await assigneesDoChamado('multi-op-1'), [170628721, 200498355], 'rodar a migração de novo backfilla os operadores mesmo pra chamado que já estava no D1');
  });

  await test('atualização admin com operador único substitui a tabela de junção por completo', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/task/multi-op-1') && (!opts?.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ id: 'multi-op-1', assignees: [{ id: 170628721 }, { id: 200498355 }] }), { status: 200 });
      }
      if (u.endsWith('/task/multi-op-1') && opts.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/multi-op-1', {
        headers: { 'X-Admin-Secret': env.ADMIN_SECRET }, body: JSON.stringify({ assigneeId: 170628721 }),
      }), env);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await assigneesDoChamado('multi-op-1'), [170628721], 'painel de admin sempre colapsa pra 1 operador — junção deve refletir isso, sem sobrar o Henrique');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  console.log('--- atomicidade do espelho D1 em atualizações admin (achado do revisor, 2026-08-12) ---');
  await test('se o .batch() falhar no meio, nem status nem operador mudam no D1 — tudo ou nada, não fica um espelhado e o outro não', async () => {
    // Env isolado — não quer misturar com o dataset acumulado do resto do arquivo.
    const atomicEnv = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV(), CHAMADOS_DB: freshD1() };
    migrationTasksOverride = [{
      id: 'atomic-1', name: 'Chamado pra teste de atomicidade',
      status: { status: 'aberto' }, priority: { priority: 'normal' },
      assignees: [{ id: 170628721, username: 'Everson' }],
      custom_fields: [
        { id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } },
        { id: TIPO_FIELD_ID, value: 0 },
        { id: SETOR_FIELD_ID, value: 0 },
      ],
    }];
    await worker.fetch(req('POST', '/admin/migrate-d1', {
      headers: { 'X-Admin-Secret': atomicEnv.ADMIN_SECRET, 'Content-Type': 'application/json' }, body: '{}',
    }), atomicEnv);
    migrationTasksOverride = null;

    const before = await d1GetChamado(atomicEnv, 'atomic-1');
    assert.strictEqual(before.status, 'aberto');
    assert.strictEqual(before.assignee_id, 170628721);

    // Simula um erro transiente do D1 bem no meio da mutação (ex.: rede caiu entre o
    // request e a resposta do binding) — antes do fix, isso deixava `chamados` e
    // `chamado_assignees` divergirem silenciosamente (2 chamadas D1 separadas); depois
    // do fix, os dois vivem no mesmo .batch(), então ou aplicam juntos ou nenhum aplica.
    const realBatch = atomicEnv.CHAMADOS_DB.batch.bind(atomicEnv.CHAMADOS_DB);
    atomicEnv.CHAMADOS_DB.batch = async () => { throw new Error('D1 indisponível (simulado)'); };

    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/task/atomic-1') && (!opts?.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ id: 'atomic-1', assignees: [{ id: 170628721 }] }), { status: 200 });
      }
      if (u.endsWith('/task/atomic-1') && opts.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return previousFetch(url, opts);
    };
    try {
      const res = await worker.fetch(req('POST', '/admin/tasks/atomic-1', {
        headers: { 'X-Admin-Secret': atomicEnv.ADMIN_SECRET },
        body: JSON.stringify({ status: 'em atendimento', assigneeId: 200498355 }),
      }), atomicEnv);
      // A mutação na ClickUp (mockada) teve sucesso — o endpoint responde 200 mesmo com
      // o espelho D1 falhando (best-effort, nunca derruba a resposta pro usuário).
      assert.strictEqual(res.status, 200);
    } finally {
      globalThis.fetch = previousFetch;
      atomicEnv.CHAMADOS_DB.batch = realBatch;
    }

    const after = await d1GetChamado(atomicEnv, 'atomic-1');
    assert.strictEqual(after.status, 'aberto', 'status NÃO deveria ter mudado — o batch falhou, nada aplicou');
    assert.strictEqual(after.assignee_id, 170628721, 'assignee_id também não deveria ter mudado — mesma transação atômica que o status');
    const { results } = await atomicEnv.CHAMADOS_DB.prepare('SELECT assignee_id FROM chamado_assignees WHERE chamado_id = ?').bind('atomic-1').all();
    assert.deepStrictEqual(results.map(r => r.assignee_id), [170628721], 'tabela de junção também não deveria ter mudado — sem isso, ficaria mostrando o Henrique enquanto assignee_id ainda diz Everson (ou pior, vazia)');
  });

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed > 0 ? 1 : 0);
})();
