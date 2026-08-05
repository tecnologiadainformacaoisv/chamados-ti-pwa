'use strict';
// Testes do push-worker.js — foco na autenticação e no isolamento entre solicitantes
// (o motivo de tudo isso existir: ninguém pode ver/criar chamado como outra pessoa).
// Sem dependências: usa import() nativo + fetch/Response do Node. Mocka fetch e o KV —
// NUNCA toca na API real da ClickUp. Rodar com `node tests/push-worker.test.js`.
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const SOLICITANTE_FIELD_ID = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const TIPO_FIELD_ID = '47e475fe-e911-40cd-b4a2-23625fbf57f1';
const FAKE_OPTIONS = [
  { id: 'a1', name: 'Ariele Santo', orderindex: 1 },
  { id: 'a27', name: 'Michael Vasconcelos', orderindex: 27 },
  { id: 'a4', name: 'Bruno Guilherme', orderindex: 4 }, // existe na ClickUp, mas nunca abriu chamado (pra testar o fallback)
];
const FAKE_TASKS = [
  { id: 'task-michael-1', name: 'Chamado do Michael', custom_fields: [{ id: SOLICITANTE_FIELD_ID, value: { orderindex: 27 } }] },
  { id: 'task-ariele-1', name: 'Chamado da Ariele', custom_fields: [{ id: SOLICITANTE_FIELD_ID, value: { orderindex: 1 } }] },
];

function makeMockKV() {
  const store = new Map();
  return {
    get: async k => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async k => store.delete(k),
    // Mock simplificado do KV.list({prefix}) real da Cloudflare — sem paginação (nosso volume é pequeno).
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
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
  const { default: worker } = await import(workerPath);

  let lastCreatePayload = null;
  let taskListCallCount = 0;
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
        return new Response(JSON.stringify({ id: 'new-task-id', ...lastCreatePayload }), { status: 200 });
      }
      taskListCallCount++;
      const cfRaw = new URL(u).searchParams.get('custom_fields');
      if (cfRaw) {
        const wantIdx = JSON.parse(cfRaw)[0].value;
        return new Response(JSON.stringify({ tasks: FAKE_TASKS.filter(t => t.custom_fields[0].value.orderindex === wantIdx) }), { status: 200 });
      }
      return new Response(JSON.stringify({ tasks: FAKE_TASKS }), { status: 200 });
    }
    return realFetch(url, opts);
  };

  const env = { CLICKUP_API_KEY: 'fake', SUBSCRIBE_SECRET: 'shared-secret', ADMIN_SECRET: 'admin-secret', SUBSCRIPTIONS: makeMockKV() };
  const SECRET_HEADERS = { 'X-App-Secret': env.SUBSCRIBE_SECRET, 'Content-Type': 'application/json' };
  let brunoToken; // Bruno nunca erra senha nem esbarra em throttle — usado pra testes que precisam de uma sessão "limpa"

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

  console.log('--- upload de anexo também respeita quem é dono do chamado ---');
  await test('Michael consegue anexar arquivo no chamado dele', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/attachment', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': token, 'Content-Type': 'multipart/form-data; boundary=x' },
      body: 'fake-file-bytes',
    }), env);
    assert.strictEqual(res.status, 200);
  });
  await test('Michael NÃO consegue anexar arquivo no chamado da Ariele (403)', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-ariele-1/attachment', {
      headers: { ...SECRET_HEADERS, 'X-Session-Token': token, 'Content-Type': 'multipart/form-data; boundary=x' },
      body: 'fake-file-bytes',
    }), env);
    assert.strictEqual(res.status, 403);
  });
  await test('upload de anexo sem sessão dá 401', async () => {
    const res = await worker.fetch(req('POST', '/api/tasks/task-michael-1/attachment', { headers: SECRET_HEADERS, body: 'x' }), env);
    assert.strictEqual(res.status, 401);
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

  console.log('--- fallback de /api/my-tasks só dispara quando o nome não é encontrado, não em "zero chamados" ---');
  await test('pessoa com nome encontrado e zero chamados NÃO aciona a busca completa da lista (rate limit)', async () => {
    taskListCallCount = 0;
    const res = await worker.fetch(req('GET', '/api/my-tasks', { headers: { ...SECRET_HEADERS, 'X-Session-Token': brunoToken } }), env);
    assert.strictEqual(res.status, 200);
    const { tasks } = await res.json();
    assert.strictEqual(tasks.length, 0, 'Bruno realmente não tem nenhum chamado nos dados fake');
    assert.strictEqual(taskListCallCount, 1, 'nome encontrado deveria fazer só 1 chamada de listagem (a filtrada), sem cair no fallback de buscar tudo');
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

  console.log(`\n${passed} passaram, ${failed} falharam`);
  process.exit(failed > 0 ? 1 : 0);
})();
