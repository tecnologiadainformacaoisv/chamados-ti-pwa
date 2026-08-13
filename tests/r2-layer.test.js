'use strict';
// Testes da camada de anexos R2 (Fase B4 do roadmap — ver push-worker.js, seção
// "CAMADA DE ANEXOS — CLOUDFLARE R2"). Sem dependências: mock em memória do
// binding R2 (mesma ideia do makeMockKV em tests/push-worker.test.js). Rodar
// com `node tests/r2-layer.test.js`.
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

async function toBytes(body) {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  // Fase M2 (2026-08-13, migração de saída da ClickUp): handleUploadAttachment/
  // handleAdminMigrateAnexos passam um ReadableStream (`file.stream()`/
  // `fileResp.body`) direto pro R2 real, que aceita — o mock precisa consumir o
  // stream inteiro em bytes pra guardar no Map em memória.
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
      const bytes = await toBytes(body);
      store.set(key, { bytes, httpMetadata: options?.httpMetadata || {} });
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return { key, size: entry.bytes.byteLength, httpMetadata: entry.httpMetadata, body: entry.bytes };
    },
    async delete(key) { store.delete(key); },
    _store: store, // só pra inspeção direta nos testes
  };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (err) { failed++; console.log(`FAIL  - ${name}\n        ${err.message}`); }
}

(async () => {
  const workerPath = pathToFileURL(path.join(__dirname, '..', 'push-worker.js')).href;
  const { r2UploadAnexo, r2GetAnexo, r2DeleteAnexo } = await import(workerPath);

  console.log('--- upload / get ---');
  await test('upload gera key com prefixo chamados/<id>/ e devolve size certo', async () => {
    const env = { ANEXOS: makeMockR2() };
    const result = await r2UploadAnexo(env, 'chamado-123', 'print.png', 'image/png', 'conteudo-fake');
    assert.ok(result.key.startsWith('chamados/chamado-123/'), 'key devia começar com o prefixo do chamado');
    assert.ok(result.key.endsWith('-print.png'), 'key devia terminar com o nome do arquivo');
    assert.strictEqual(result.size, Buffer.byteLength('conteudo-fake'));
    assert.strictEqual(result.contentType, 'image/png');
  });

  await test('get devolve o objeto certo (contentType, size, body)', async () => {
    const env = { ANEXOS: makeMockR2() };
    const up = await r2UploadAnexo(env, 'chamado-1', 'foto.jpg', 'image/jpeg', 'abc123');
    const got = await r2GetAnexo(env, up.key);
    assert.strictEqual(got.contentType, 'image/jpeg');
    assert.strictEqual(got.size, 6);
    assert.strictEqual(Buffer.from(got.body).toString(), 'abc123');
  });

  await test('get de key inexistente devolve null', async () => {
    const env = { ANEXOS: makeMockR2() };
    const got = await r2GetAnexo(env, 'chamados/nao-existe/qualquer-coisa.png');
    assert.strictEqual(got, null);
  });

  console.log('--- segurança do nome de arquivo ---');
  await test('nome com "../" (path traversal) é sanitizado pro basename', async () => {
    const env = { ANEXOS: makeMockR2() };
    const result = await r2UploadAnexo(env, 'chamado-1', '../../etc/passwd', 'text/plain', 'x');
    assert.ok(!result.key.includes('..'), 'key não deveria conter ".." depois de sanitizar');
    assert.ok(result.key.endsWith('-etcpasswd') || result.key.endsWith('-passwd'), `key inesperada: ${result.key}`);
  });

  await test('nome com barra invertida também é tratado como separador', async () => {
    const env = { ANEXOS: makeMockR2() };
    const result = await r2UploadAnexo(env, 'chamado-1', 'C:\\Windows\\System32\\evil.exe', 'application/octet-stream', 'x');
    assert.ok(result.key.endsWith('-evil.exe'), `key inesperada: ${result.key}`);
  });

  console.log('--- múltiplos anexos / delete ---');
  await test('dois uploads do mesmo chamado e mesmo nome geram keys diferentes (uuid)', async () => {
    const env = { ANEXOS: makeMockR2() };
    const a = await r2UploadAnexo(env, 'chamado-9', 'print.png', 'image/png', 'v1');
    const b = await r2UploadAnexo(env, 'chamado-9', 'print.png', 'image/png', 'v2');
    assert.notStrictEqual(a.key, b.key, 'uploads diferentes não deveriam colidir na mesma key');
    const gotA = await r2GetAnexo(env, a.key);
    const gotB = await r2GetAnexo(env, b.key);
    assert.strictEqual(Buffer.from(gotA.body).toString(), 'v1');
    assert.strictEqual(Buffer.from(gotB.body).toString(), 'v2');
  });

  await test('delete remove de verdade — get depois volta null', async () => {
    const env = { ANEXOS: makeMockR2() };
    const up = await r2UploadAnexo(env, 'chamado-1', 'temp.txt', 'text/plain', 'x');
    await r2DeleteAnexo(env, up.key);
    const got = await r2GetAnexo(env, up.key);
    assert.strictEqual(got, null);
  });

  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed > 0) process.exit(1);
})().catch(e => { console.error('FALHA GERAL:', e); process.exit(1); });
