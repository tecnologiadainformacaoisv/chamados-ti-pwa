// Backend LOCAL de desenvolvimento (2026-11-10): roda o push-worker.js REAL (mesmo código que está em
// produção) num servidor HTTP em Node, com banco SQLite em arquivo, KV e R2 em memória. Serve pra
// ver e testar a tela do solicitante e a do admin juntas, em tempo real, sem tocar em dado de
// produção (nada aqui chega na Cloudflare). Só Node nativo, zero dependência.
//
//   node scripts/dev-backend.mjs            -> sobe em http://localhost:8787
//   node scripts/dev-backend.mjs --reset    -> apaga o banco de teste e recria com os dados de exemplo
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const AQUI = import.meta.dirname
const RAIZ = path.resolve(AQUI, '..', '..')
export const PORTA = Number(process.env.DEV_BACKEND_PORT || 8787)
// Mesmos valores que o frontend usa (APP_SHARED_SECRET é público por design) e uma chave de admin só de teste.
export const APP_SECRET = 'isv-chamados-2k26-9fQ3vM7xZp'
export const ADMIN_SECRET = 'admin-teste-local'
export const SENHA_TESTE = 'teste1234'

function makeKV() {
  const store = new Map()
  return {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v, opts) => {
      // o KV real exige TTL >= 60 s: reproduz pra não esconder bug que só apareceria em produção
      if (opts && opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error('KV: expirationTtl precisa ser >= 60')
      store.set(k, v)
    },
    delete: async (k) => store.delete(k),
    list: async ({ prefix = '' } = {}) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  }
}

function makeD1(db) {
  return {
    prepare(sql) {
      let bound = []
      const stmt = {
        bind(...p) { bound = p; return stmt },
        async run() { const i = db.prepare(sql).run(...bound); return { success: true, meta: { changes: i.changes, last_row_id: i.lastInsertRowid } } },
        async first() { const r = db.prepare(sql).get(...bound); return r === undefined ? null : r },
        async all() { return { results: db.prepare(sql).all(...bound), success: true } },
        _sql: sql,
        _params: () => bound,
      }
      return stmt
    },
    async batch(statements) {
      const out = []
      db.exec('BEGIN')
      try {
        for (const s of statements) out.push(db.prepare(s._sql).run(...s._params()))
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      return out.map((i) => ({ success: true, meta: { changes: i.changes, last_row_id: i.lastInsertRowid } }))
    },
  }
}

function makeR2() {
  const store = new Map()
  const bytesDe = async (b) => (b instanceof Uint8Array ? b : new Uint8Array(await new Response(b).arrayBuffer()))
  return {
    async put(key, body, options) { const bytes = await bytesDe(body); store.set(key, { bytes, httpMetadata: options?.httpMetadata || {} }); return { key, size: bytes.byteLength } },
    async get(key) { const e = store.get(key); return e ? { key, size: e.bytes.byteLength, httpMetadata: e.httpMetadata, body: e.bytes } : null },
    async delete(key) { store.delete(key) },
  }
}

const MIN = 60_000
const OPERADOR = { everson: 170628721, henrique: 200498355 }
const SOLICITANTES = [
  ['Ana Paula Lima', 'ana.lima@institutosaovicente.com.br'],
  ['Sérgio Lima', 'sergio.lima@institutosaovicente.com.br'],
  ['Joana Alves', 'joana.alves@institutosaovicente.com.br'],
  ['Levy Perdigão', 'levy.perdigao@institutosaovicente.com.br'],
  ['Marta Dias', 'marta.dias@institutosaovicente.com.br'],
]

// Dados de exemplo relativos a "agora", pra linha do dia e os prazos aparecerem vivos (atrasado, vence logo, etc.).
function semear(db) {
  const agora = Date.now()
  for (const [nome, email] of SOLICITANTES) {
    db.prepare("INSERT OR IGNORE INTO solicitantes (name, email, ativo, created_at, origem) VALUES (?, ?, 1, ?, 'interno')").run(nome, email, agora)
  }
  // [título, solicitante, status, prioridade(1 urgente,2 alta,3 normal), tipo, setor, operador, abertoHáMin, início(min atrás)|null, prazoEmMin|null, descrição]
  const chamados = [
    ['Instalar scanner', 'Sérgio Lima', 'em atendimento', 3, 1, 3, OPERADOR.everson, 70, 50, -5, 'Scanner novo na mesa 4.'],
    ['Impressora com cores erradas', 'Joana Alves', 'em atendimento', 2, 1, 0, OPERADOR.henrique, 90, 15, 15, 'Sai tudo amarelado.'],
    ['Sem acesso ao sistema de prestação de contas', 'Levy Perdigão', 'aberto', 1, 7, 4, OPERADOR.everson, 20, null, 40, 'Aparece "acesso negado" desde cedo.'],
    ['Acesso ao Claude da empresa', 'Levy Perdigão', 'aberto', 2, 7, 4, OPERADOR.henrique, 35, null, 205, 'Preciso para os arquivos da prestação de contas.'],
    ['Arte para placa de porta', 'Marta Dias', 'aberto', 3, 6, 5, OPERADOR.everson, 10, null, 26 * 60, 'Placa A4 "Sala de reunião 2".'],
    ['Plugin do navegador', 'Ana Paula Lima', 'pendente', 3, 2, 1, OPERADOR.henrique, 180, 120, null, 'Aguardando liberação do fornecedor.'],
    ['Troca de mouse', 'Ana Paula Lima', 'encerrado', 3, 1, 1, OPERADOR.henrique, 300, 280, null, 'O mouse parou de clicar.'],
  ]
  for (const [nome, sol, status, prio, tipo, setor, op, aberto, inicio, prazo, desc] of chamados) {
    const id = crypto.randomUUID()
    const criado = agora - aberto * MIN
    const start = inicio == null ? null : agora - inicio * MIN
    const due = prazo == null ? null : agora + prazo * MIN
    const fechado = status === 'encerrado' ? agora - 260 * MIN : null
    db.prepare(
      'INSERT INTO chamados (id, name, description, status, priority, tipo, setor, solicitante, solucao, assignee_id, due_date, date_created, date_closed, start_date, created_at, updated_at, nota) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(id, nome, desc, status, prio, tipo, setor, sol, status === 'encerrado' ? 'Mouse trocado e testado.' : null, op, due, criado, fechado, start, criado, criado, status === 'encerrado' ? 4 : null)
    db.prepare('INSERT INTO chamado_assignees (chamado_id, assignee_id) VALUES (?, ?)').run(id, op)
  }
}

export async function iniciarBackend({ reset = false, silencioso = false } = {}) {
  const pasta = path.join(AQUI, '..', '.dev-data')
  fs.mkdirSync(pasta, { recursive: true })
  const arquivo = path.join(pasta, 'dev.db')
  if (reset) for (const f of [arquivo, arquivo + '-wal', arquivo + '-shm']) fs.rmSync(f, { force: true })
  const db = new DatabaseSync(arquivo)
  db.exec(fs.readFileSync(path.join(RAIZ, 'd1', 'schema.sql'), 'utf8'))
  const jaTem = db.prepare('SELECT COUNT(*) AS n FROM solicitantes').get().n
  if (!jaTem) semear(db)

  const worker = (await import(pathToFileURL(path.join(RAIZ, 'push-worker.js')).href)).default
  const env = { SUBSCRIBE_SECRET: APP_SECRET, ADMIN_SECRET, SUBSCRIPTIONS: makeKV(), CHAMADOS_DB: makeD1(db), ANEXOS: makeR2() }

  const servidor = http.createServer(async (req, res) => {
    try {
      const partes = []
      for await (const p of req) partes.push(p)
      const corpo = Buffer.concat(partes)
      const url = `http://localhost:${PORTA}${req.url}`
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) || !corpo.length ? undefined : corpo })
      const resp = await worker.fetch(request, env, { waitUntil: (p) => Promise.resolve(p).catch(() => {}) })
      const out = Object.fromEntries(resp.headers.entries())
      // o Worker só libera as origens de produção; em desenvolvimento reflete quem chamou (localhost)
      const origem = req.headers.origin
      if (origem) { out['access-control-allow-origin'] = origem; out['vary'] = 'Origin' }
      res.writeHead(resp.status, out)
      res.end(Buffer.from(await resp.arrayBuffer()))
    } catch (e) {
      console.error('[dev-backend]', e)
      res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin || '*' })
      res.end(JSON.stringify({ error: String(e && e.message) }))
    }
  })
  await new Promise((ok, falha) => { servidor.once('error', falha); servidor.listen(PORTA, '127.0.0.1', ok) })
  if (!silencioso) console.log(`[dev-backend] Worker real rodando em http://localhost:${PORTA} (banco: frontend/.dev-data/dev.db)`)
  return servidor
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  iniciarBackend({ reset: process.argv.includes('--reset') }).catch((e) => { console.error(e); process.exit(1) })
}
