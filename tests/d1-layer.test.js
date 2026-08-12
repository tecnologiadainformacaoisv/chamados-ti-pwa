'use strict';
// Testes da camada de dados D1 (Fase B2 do roadmap — ver push-worker.js, seção
// "CAMADA DE DADOS — CLOUDFLARE D1"). Sem dependências: usa node:sqlite (nativo,
// experimental desde o Node 22) rodando o MESMO schema real (d1/schema.sql) num
// banco em memória, envolvido por um adaptador fino que imita a interface do
// binding D1 da Cloudflare (prepare().bind().run()/.first()/.all()) — as funções
// testadas aqui são as mesmas que rodam contra o D1 de verdade, só trocando o
// motor SQLite por trás. Rodar com `node tests/d1-layer.test.js`.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

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
          const results = db.prepare(sql).all(...boundParams);
          return { results, success: true };
        },
        _sql: sql,
        _params: () => boundParams,
      };
      return stmt;
    },
    // Suporte a múltiplos operadores (B7 parte 2, fase 1) — .batch() do binding D1 real
    // manda N statements num round-trip só (1 subrequest, não N). O achado de produção
    // que motivou isso: `POST /admin/migrate-d1` estourava o teto de subrequests por
    // invocação do Worker (~1000 no plano pago) fazendo DELETE+INSERT sequencial por
    // chamado — ver comentário em d1SetAssignees em push-worker.js.
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await db.prepare(stmt._sql).run(...stmt._params()));
      }
      return results.map(info => ({ success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }));
    },
  };
}

function freshEnv() {
  const db = new DatabaseSync(':memory:');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'd1', 'schema.sql'), 'utf8');
  // node:sqlite .exec() roda múltiplas statements separadas por ; de uma vez — mesmo
  // arquivo que é aplicado no D1 real via `wrangler d1 execute --file=d1/schema.sql`.
  db.exec(schemaSql);
  return { CHAMADOS_DB: makeD1FromSqlite(db) };
}

// Mock simples de KV (Map em memória) — só pros testes de d1TransitionStatus (Fase B5),
// que usa env.SUBSCRIPTIONS pra guardar a pausa de SLA e a inscrição de push.
function makeMockKV() {
  const store = new Map();
  return {
    get: async k => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async k => store.delete(k),
  };
}

const SOLICITANTE_FIELD_ID = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const FAKE_SOLICITANTE_OPTIONS = [{ id: 'a27', name: 'Michael Vasconcelos', orderindex: 27 }];

function freshEnvComAutomacao(vapidPrivateJwk) {
  return { ...freshEnv(), SUBSCRIPTIONS: makeMockKV(), CLICKUP_API_KEY: 'fake', VAPID_PRIVATE_JWK: vapidPrivateJwk };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { failed++; console.log(`FAIL  - ${name}\n        ${err.message}`); }
}

(async () => {
  const workerPath = pathToFileURL(path.join(__dirname, '..', 'push-worker.js')).href;
  const { d1CreateChamado, d1GetChamado, d1ListChamados, d1UpdateChamado, d1GetMetrics, d1TransitionStatus } = await import(workerPath);

  const baseChamado = {
    name: 'Notebook não liga', tipo: 0, setor: 1, solicitante: 'Michael Vasconcelos',
    priority: 1, due_date: Date.now() + 3600000,
  };

  // Par VAPID descartável só pra createVapidJwt (dentro de sendWebPush, chamada por
  // d1TransitionStatus) não falhar ao assinar — mesma técnica usada nesta sessão pra
  // gerar o par VAPID real do projeto (crypto.subtle nativo, sem dependência nova).
  const vapidKeyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapidPrivateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey));

  // Mock de fetch só pro que d1TransitionStatus precisa: getSolicitanteMaps (lista de
  // campo da ClickUp) e o endpoint de push em si (sendWebPush) — nunca toca rede real.
  let lastPushCall = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/list/') && u.includes('/field')) {
      return new Response(JSON.stringify({ fields: [{ id: SOLICITANTE_FIELD_ID, type_config: { options: FAKE_SOLICITANTE_OPTIONS } }] }), { status: 200 });
    }
    if (u.startsWith('https://fake-push-endpoint.test/')) {
      lastPushCall = { url: u, headers: opts.headers, body: opts.body };
      if (u.endsWith('/falha')) return new Response('endpoint fora do ar', { status: 410 });
      return new Response('', { status: 201 });
    }
    return realFetch(url, opts);
  };

  console.log('--- criar / buscar ---');
  await test('cria chamado com defaults certos (status aberto, date_closed/start_date null)', async () => {
    const env = freshEnv();
    const row = await d1CreateChamado(env, baseChamado);
    assert.ok(row.id, 'devia gerar um id');
    assert.strictEqual(row.status, 'aberto');
    assert.strictEqual(row.date_closed, null);
    assert.strictEqual(row.start_date, null);
    assert.strictEqual(row.name, baseChamado.name);
    assert.strictEqual(row.solicitante, baseChamado.solicitante);
    assert.ok(row.date_created > 0 && row.created_at === row.date_created && row.updated_at === row.date_created);
  });

  await test('status inválido na criação lança erro (não grava linha nenhuma)', async () => {
    const env = freshEnv();
    await assert.rejects(() => d1CreateChamado(env, { ...baseChamado, status: 'em revisao' }));
    const { results } = await env.CHAMADOS_DB.prepare('SELECT * FROM chamados').all();
    assert.strictEqual(results.length, 0);
  });

  await test('busca por id existente devolve o registro; id inexistente devolve null', async () => {
    const env = freshEnv();
    const created = await d1CreateChamado(env, baseChamado);
    const found = await d1GetChamado(env, created.id);
    assert.strictEqual(found.name, baseChamado.name);
    const notFound = await d1GetChamado(env, 'id-que-nao-existe');
    assert.strictEqual(notFound, null);
  });

  console.log('--- listar com filtros ---');
  async function seedTresChamados(env) {
    const a = await d1CreateChamado(env, { ...baseChamado, name: 'A', solicitante: 'Ariele Santo', setor: 0, tipo: 1, status: 'aberto' });
    await new Promise(r => setTimeout(r, 2)); // garante date_created diferente pra testar ORDER BY
    const b = await d1CreateChamado(env, { ...baseChamado, name: 'B', solicitante: 'Michael Vasconcelos', setor: 1, tipo: 0, status: 'em atendimento', assignee_id: 170628721 });
    await new Promise(r => setTimeout(r, 2));
    const c = await d1CreateChamado(env, { ...baseChamado, name: 'C', solicitante: 'Michael Vasconcelos', setor: 1, tipo: 0, status: 'encerrado', assignee_id: 200498355 });
    return { a, b, c };
  }

  await test('lista sem filtro devolve todos, mais recente primeiro', async () => {
    const env = freshEnv();
    const { a, b, c } = await seedTresChamados(env);
    const list = await d1ListChamados(env);
    assert.strictEqual(list.length, 3);
    assert.deepStrictEqual(list.map(t => t.id), [c.id, b.id, a.id]);
  });

  await test('filtro por status', async () => {
    const env = freshEnv();
    await seedTresChamados(env);
    const list = await d1ListChamados(env, { status: 'em atendimento' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'B');
  });

  await test('filtro por setor + tipo juntos (AND, não OR)', async () => {
    const env = freshEnv();
    await seedTresChamados(env);
    const list = await d1ListChamados(env, { setor: 1, tipo: 0 });
    assert.strictEqual(list.length, 2); // B e C
  });

  await test('filtro por operador (assigneeId)', async () => {
    const env = freshEnv();
    await seedTresChamados(env);
    const list = await d1ListChamados(env, { assigneeId: 170628721 });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'B');
  });

  await test('filtro por solicitante', async () => {
    const env = freshEnv();
    await seedTresChamados(env);
    const list = await d1ListChamados(env, { solicitante: 'Ariele Santo' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'A');
  });

  // 🛡️ Regressão real de produção (2026-08-12, B7 parte 2 fase 2): `withAssignees`
  // busca os assignees de todos os chamados retornados via `IN (...)` — com volume
  // real (454 chamados), a versão original mandava todos os ids numa query só e
  // estourava o limite de variáveis bindáveis do SQLite/D1 ("error code: 1101", 500
  // puro em produção). Corrigido com paginação em pedaços de 50 — este teste teria
  // pego isso antes do deploy (60 chamados > qualquer teto razoável de 1 pedaço só).
  await test('withAssignees não quebra com volume acima do tamanho de 1 lote (60 chamados)', async () => {
    const env = freshEnv();
    for (let i = 0; i < 60; i++) {
      await d1CreateChamado(env, { ...baseChamado, name: `Bulk ${i}`, assignee_id: 170628721 });
    }
    const list = await d1ListChamados(env, { withAssignees: true });
    assert.strictEqual(list.length, 60);
    assert.ok(list.every(row => Array.isArray(row.assignee_ids) && row.assignee_ids.includes(170628721)), 'todo chamado deveria ter o assignee_ids populado, mesmo fora do 1º pedaço de 50');
  });

  console.log('--- atualizar ---');
  await test('atualiza só o campo enviado (solucao) — não mexe em status/assignee', async () => {
    const env = freshEnv();
    const created = await d1CreateChamado(env, { ...baseChamado, assignee_id: 170628721 });
    const updated = await d1UpdateChamado(env, created.id, { solucao: 'Trocado o carregador' });
    assert.strictEqual(updated.solucao, 'Trocado o carregador');
    assert.strictEqual(updated.status, 'aberto');
    assert.strictEqual(updated.assignee_id, 170628721);
    assert.ok(updated.updated_at >= created.updated_at);
  });

  await test('atualizar status pra valor inválido lança erro', async () => {
    const env = freshEnv();
    const created = await d1CreateChamado(env, baseChamado);
    await assert.rejects(() => d1UpdateChamado(env, created.id, { status: 'em revisao' }));
  });

  await test('assigneeId: null remove a atribuição', async () => {
    const env = freshEnv();
    const created = await d1CreateChamado(env, { ...baseChamado, assignee_id: 170628721 });
    const updated = await d1UpdateChamado(env, created.id, { assigneeId: null });
    assert.strictEqual(updated.assignee_id, null);
  });

  await test('patch vazio devolve o registro sem alterar nada', async () => {
    const env = freshEnv();
    const created = await d1CreateChamado(env, baseChamado);
    const updated = await d1UpdateChamado(env, created.id, {});
    assert.strictEqual(updated.updated_at, created.updated_at);
  });

  console.log('--- métricas ---');
  await test('agrega total, porStatus, porTipo, porSetor corretamente', async () => {
    const env = freshEnv();
    await seedTresChamados(env);
    const m = await d1GetMetrics(env);
    assert.strictEqual(m.total, 3);
    assert.deepStrictEqual(m.porStatus, { aberto: 1, 'em atendimento': 1, encerrado: 1 });
    assert.deepStrictEqual(m.porTipo, { 1: 1, 0: 2 });
    assert.deepStrictEqual(m.porSetor, { 0: 1, 1: 2 });
  });

  await test('SLA: closed dentro do prazo conta em dentroDoSla, atrasado conta em atrasado', async () => {
    const env = freshEnv();
    // fechado 1min ANTES do prazo -> dentro do SLA
    const dentro = await d1CreateChamado(env, { ...baseChamado, status: 'encerrado', due_date: 1000000 });
    await d1UpdateChamado(env, dentro.id, { dateClosed: 940000 }); // due_date - 60000
    // fechado bem DEPOIS do prazo -> atrasado
    const atrasadoRow = await d1CreateChamado(env, { ...baseChamado, status: 'encerrado', due_date: 1000000 });
    await d1UpdateChamado(env, atrasadoRow.id, { dateClosed: 2000000 });

    const m = await d1GetMetrics(env);
    assert.strictEqual(m.sla.dentroDoSla, 1);
    assert.strictEqual(m.sla.atrasado, 1);
    assert.strictEqual(m.sla.dentroDoSlaPercent, 50);
  });

  await test('tempoMedioPorOperador: soma/conta certo pra encerrados com start_date e date_closed', async () => {
    const env = freshEnv();
    const t1 = await d1CreateChamado(env, { ...baseChamado, status: 'encerrado', assignee_id: 170628721 });
    await d1UpdateChamado(env, t1.id, { startDate: 1000, dateClosed: 1000 + 600000 }); // 10min
    const t2 = await d1CreateChamado(env, { ...baseChamado, status: 'encerrado', assignee_id: 170628721 });
    await d1UpdateChamado(env, t2.id, { startDate: 2000, dateClosed: 2000 + 1200000 }); // 20min

    const m = await d1GetMetrics(env);
    const dado = m.tempoMedioPorOperador['170628721'];
    assert.ok(dado, 'devia ter agregado o operador 170628721');
    assert.strictEqual(dado.totalChamados, 2);
    assert.strictEqual(dado.mediaMs, 900000); // média de 10min e 20min = 15min
  });

  await test('encerrado sem start_date/date_closed não entra na média (dado incompleto)', async () => {
    const env = freshEnv();
    await d1CreateChamado(env, { ...baseChamado, status: 'encerrado', assignee_id: 170628721 });
    const m = await d1GetMetrics(env);
    assert.strictEqual(m.tempoMedioPorOperador['170628721'], undefined);
  });

  console.log('--- automação de SLA embutida (Fase B5) ---');
  await test('"em atendimento" define start_date e due_date pela prioridade', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    const created = await d1CreateChamado(env, { ...baseChamado, priority: 2 }); // Alta = 30min padrão
    const before = Date.now();
    const updated = await d1TransitionStatus(env, created.id, 'em atendimento');
    assert.ok(updated.start_date >= before);
    assert.strictEqual(updated.due_date, updated.start_date + 30 * 60000);
  });

  await test('"encerrado" define date_closed mesmo sem start_date (pulou "em atendimento")', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    const created = await d1CreateChamado(env, baseChamado); // status 'aberto', nunca passou por em atendimento
    const updated = await d1TransitionStatus(env, created.id, 'encerrado');
    assert.strictEqual(updated.start_date, null);
    assert.ok(updated.date_closed > 0);
  });

  await test('"pendente" grava o início da pausa no KV', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    const created = await d1CreateChamado(env, baseChamado);
    await d1TransitionStatus(env, created.id, 'pendente');
    const pending = await env.SUBSCRIPTIONS.get(`d1_pending_start_${created.id}`);
    assert.ok(pending, 'devia ter gravado o início da pausa');
  });

  await test('sair de "pendente" adia o due_date pelo tempo pausado e limpa o KV', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    const created = await d1CreateChamado(env, { ...baseChamado, due_date: 1000000 });
    // simula que a pausa começou 5min atrás
    await env.SUBSCRIPTIONS.put(`d1_pending_start_${created.id}`, String(Date.now() - 5 * 60000));
    await d1UpdateChamado(env, created.id, { status: 'pendente' }); // estado real: já está pendente
    const updated = await d1TransitionStatus(env, created.id, 'aberto');
    assert.ok(updated.due_date >= 1000000 + 5 * 60000 - 1000, 'due_date devia ter sido adiado ~5min');
    const pendingDepois = await env.SUBSCRIPTIONS.get(`d1_pending_start_${created.id}`);
    assert.strictEqual(pendingDepois, null, 'chave de pausa devia ter sido apagada');
  });

  await test('status inválido lança erro', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    const created = await d1CreateChamado(env, baseChamado);
    await assert.rejects(() => d1TransitionStatus(env, created.id, 'em revisao'));
  });

  await test('chamado inexistente lança erro', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    await assert.rejects(() => d1TransitionStatus(env, 'id-que-nao-existe', 'encerrado'));
  });

  console.log('--- push embutido ---');
  await test('envia push quando existe inscrição pro solicitante', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    await env.SUBSCRIPTIONS.put('u_27', JSON.stringify({
      endpoint: 'https://fake-push-endpoint.test/abc',
      keys: { p256dh: 'BMgcsTAUEhUr-dau-LaPhTHktmCZ90q4GXFF6CX0p3IvmeB51v68JqZLeuKrO3swUcSXKiNhQ6Ur5I74fm6tp2Q', auth: 'dGVzdC1hdXRoLTE2Yg' },
    }));
    lastPushCall = null;
    const created = await d1CreateChamado(env, baseChamado);
    await d1TransitionStatus(env, created.id, 'em atendimento'); // tem notificação (NOTIFY_STATUSES)
    assert.ok(lastPushCall, 'devia ter chamado o endpoint de push');
    assert.strictEqual(lastPushCall.url, 'https://fake-push-endpoint.test/abc');
    assert.ok(lastPushCall.headers.Authorization?.startsWith('vapid '), 'devia mandar o header VAPID');
    // corpo vai criptografado (aes128gcm) — não dá pra ler o payload de volta aqui sem
    // reimplementar a decriptação; a cifra em si já é código existente, não desta fase.
  });

  await test('sem inscrição, não tenta enviar push — transição completa normalmente', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    lastPushCall = null;
    const created = await d1CreateChamado(env, baseChamado);
    const updated = await d1TransitionStatus(env, created.id, 'em atendimento');
    assert.strictEqual(lastPushCall, null);
    assert.strictEqual(updated.status, 'em atendimento');
  });

  await test('falha ao enviar push não derruba a transição de status', async () => {
    const env = freshEnvComAutomacao(vapidPrivateJwk);
    await env.SUBSCRIPTIONS.put('u_27', JSON.stringify({
      endpoint: 'https://fake-push-endpoint.test/falha',
      keys: { p256dh: 'BMgcsTAUEhUr-dau-LaPhTHktmCZ90q4GXFF6CX0p3IvmeB51v68JqZLeuKrO3swUcSXKiNhQ6Ur5I74fm6tp2Q', auth: 'dGVzdC1hdXRoLTE2Yg' },
    }));
    const created = await d1CreateChamado(env, baseChamado);
    const updated = await d1TransitionStatus(env, created.id, 'em atendimento'); // não deve lançar
    assert.strictEqual(updated.status, 'em atendimento');
  });

  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed > 0) process.exit(1);
})().catch(e => { console.error('FALHA GERAL:', e); process.exit(1); });
