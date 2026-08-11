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
      };
      return stmt;
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

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { failed++; console.log(`FAIL  - ${name}\n        ${err.message}`); }
}

(async () => {
  const workerPath = pathToFileURL(path.join(__dirname, '..', 'push-worker.js')).href;
  const { d1CreateChamado, d1GetChamado, d1ListChamados, d1UpdateChamado, d1GetMetrics } = await import(workerPath);

  const baseChamado = {
    name: 'Notebook não liga', tipo: 0, setor: 1, solicitante: 'Michael Vasconcelos',
    priority: 1, due_date: Date.now() + 3600000,
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

  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed > 0) process.exit(1);
})().catch(e => { console.error('FALHA GERAL:', e); process.exit(1); });
