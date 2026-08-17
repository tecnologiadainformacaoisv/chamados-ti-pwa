import { test, expect, type Page, type Route } from "@playwright/test"
import { CORS_HEADERS, jsonRoute, makeMetrics, makeTask, SOLICITANTES } from "./mock-data"

// Helpers de mock reaproveitáveis — mesmo espírito dos scripts ad-hoc rodados nesta
// sessão inteira (scratchpad), só que agora fixados no repo.
//
// Ordem de registro importa MUITO no Playwright: o handler registrado por ÚLTIMO roda
// PRIMEIRO (LIFO) — `route.fallback()` passa a vez pro handler registrado ANTES dele.
// Por isso: 1) o "chão" (responde OPTIONS/preflight e ABORTA qualquer coisa não
// mapeada, pra uma rota esquecida falhar alto em vez de vazar pra rede real) é
// registrado PRIMEIRO (menor prioridade); 2) cada endpoint específico é registrado
// depois, checa o método esperado e usa `route.fallback()` (não `route.continue()`,
// que mandaria pra rede de verdade) quando não é o método dele.
const WORKER_HOST = "chamados-ti-push.tecnologiadainformacao-isv.workers.dev"
const ADMIN_SECRET = "fake-admin-secret"

async function installFloor(page: Page) {
  await page.route(`https://${WORKER_HOST}/**`, (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: CORS_HEADERS })
    }
    // Rota não mapeada por nenhum mock específico — aborta em vez de vazar pra rede
    // real (produção). Se um teste falhar aqui, falta um `page.route()` pra esse
    // endpoint, não um bug de verdade.
    console.warn(`[e2e] requisição sem mock: ${route.request().method()} ${route.request().url()}`)
    return route.abort("failed")
  })
}

function on(page: Page, pattern: string | RegExp, method: string, handler: (route: Route) => Promise<void> | void) {
  return page.route(pattern, (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    if (route.request().method() !== method) return route.fallback()
    return handler(route)
  })
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill(jsonRoute(body, status))
}

/** Mocks padrão pro app do SOLICITANTE — lista de nomes, sessão, my-tasks, criar chamado. */
export async function mockSolicitanteRoutes(
  page: Page,
  opts: { tasks?: ReturnType<typeof makeTask>[]; solicitantes?: string[] } = {}
) {
  await installFloor(page)
  const tasks = opts.tasks ?? []
  const solicitantes = opts.solicitantes ?? SOLICITANTES

  await on(page, "**/api/solicitantes", "GET", (route) => fulfillJson(route, { names: solicitantes }))
  await on(page, "**/auth/login", "POST", (route) => fulfillJson(route, { token: "fake-session-token", name: "Fulano de Tal" }))
  await on(page, "**/auth/register", "POST", (route) => fulfillJson(route, { token: "fake-session-token", name: "Fulano de Tal" }))
  await on(page, "**/auth/logout", "POST", (route) => fulfillJson(route, { ok: true }))
  await on(page, "**/api/my-tasks", "GET", (route) => fulfillJson(route, { tasks }))
  await on(page, /\/api\/tasks$/, "POST", (route) => fulfillJson(route, makeTask({ id: "task-novo", name: "Chamado recém-criado" })))
  await on(page, /\/api\/tasks\/[^/]+\/attachment/, "POST", (route) => fulfillJson(route, { ok: true }))
  // GET /api/tasks/:id — TicketCard chama isso pra CADA card renderizado, pra buscar
  // attachments (a listagem de /my-tasks não devolve isso). Sem esse mock, todo card
  // dispararia uma requisição sem handler (abortada pelo "chão" acima).
  await on(page, /\/api\/tasks\/[^/]+$/, "GET", (route) => {
    const id = route.request().url().split("/").pop()
    const found = tasks.find((t) => t.id === id)
    return fulfillJson(route, found ? { ...found, attachments: found.attachments ?? [] } : makeTask({ id, attachments: [] }))
  })
  // GET /api/anexos/:id — servido como bytes reais (1x1 PNG), não JSON, pro AnexoModal
  // conseguir montar um object URL de verdade a partir do blob.
  await on(page, /\/api\/anexos\/[^/]+$/, "GET", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: CORS_HEADERS,
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    })
  )
}

/** Autentica e navega o app do solicitante já logado (localStorage pré-semeado). */
export async function gotoSolicitanteLoggedIn(page: Page, userName = "Fulano de Tal") {
  await page.addInitScript((name) => {
    localStorage.setItem("session_token", "fake-session-token")
    localStorage.setItem("user_name", name)
  }, userName)
  await page.goto("/")
}

/** Mocks padrão pro PAINEL DE ADMIN — auth, tasks, metrics, solicitantes, eventos. */
export async function mockAdminRoutes(
  page: Page,
  opts: {
    tasks?: ReturnType<typeof makeTask>[]
    metrics?: ReturnType<typeof makeMetrics>
    eventos?: unknown[]
    secret?: string
  } = {}
) {
  await installFloor(page)
  const tasks = opts.tasks ?? []
  const metrics = opts.metrics ?? makeMetrics({ total: tasks.length })
  const eventos = opts.eventos ?? []
  const secret = opts.secret ?? ADMIN_SECRET

  await on(page, "**/admin/users", "GET", (route) => {
    const header = route.request().headers()["x-admin-secret"]
    if (header !== secret) return fulfillJson(route, { error: "forbidden" }, 403)
    return fulfillJson(route, { total: 1, users: [{ name: "Henrique", createdAt: Date.now(), lastLoginAt: Date.now() }] })
  })
  await on(page, /\/admin\/tasks(\?.*)?$/, "GET", (route) => {
    const url = new URL(route.request().url())
    const status = url.searchParams.get("status")
    const filtered = status ? tasks.filter((t) => (t as { status: { status: string } }).status.status === status) : tasks
    return fulfillJson(route, { total: filtered.length, tasks: filtered, truncated: false })
  })
  await on(page, /\/admin\/tasks\/[^/]+\/eventos/, "GET", (route) => fulfillJson(route, { eventos }))
  await on(page, /\/admin\/tasks\/[^/]+\/eventos/, "POST", (route) => fulfillJson(route, { evento: { id: "ev-nova", tipo: "nota", autor: "x", texto: "y", de_valor: null, para_valor: null, created_at: Date.now() } }))
  await on(page, /\/admin\/tasks\/bulk/, "POST", (route) => fulfillJson(route, { total: 0, sucesso: 0, falha: 0, results: [] }))
  await on(page, /\/admin\/tasks\/[^/]+$/, "POST", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    return fulfillJson(route, makeTask({ status: { status: body.status ?? "aberto" } }))
  })
  await on(page, /\/admin\/metrics/, "GET", (route) => fulfillJson(route, metrics))
  await on(page, "**/admin/solicitantes", "GET", (route) => fulfillJson(route, { solicitantes: SOLICITANTES.map((name) => ({ name, ativo: 1, created_at: Date.now() })) }))
  await on(page, "**/admin/solicitantes", "POST", (route) => fulfillJson(route, { ok: true }))
  await on(page, /\/admin\/solicitantes\/[^/]+\/ativo/, "POST", (route) => fulfillJson(route, { ok: true }))
  await on(page, "**/admin/subscribe", "POST", (route) => fulfillJson(route, { ok: true }))
  await on(page, "**/api/solicitantes", "GET", (route) => fulfillJson(route, { names: SOLICITANTES }))
}

/** Faz login no gate do admin (fluxo real de UI, não pula pra frente). */
export async function loginAdminViaGate(page: Page, secret = ADMIN_SECRET) {
  await page.goto("/admin.html")
  await page.locator("input").first().fill(secret)
  await page.locator('button[type="submit"]').click()
}

/** Pula direto pro admin autenticado (localStorage pré-semeado) — usado quando o
 * teste não é sobre o próprio login. */
export async function gotoAdminLoggedIn(page: Page, secret = ADMIN_SECRET) {
  await page.addInitScript((s) => {
    localStorage.setItem("admin_secret", s)
  }, secret)
  await page.goto("/admin.html")
}

/** Abre uma seção da sidebar do admin (Gestão/Dashboard/Usuários) — em viewport
 * mobile (<768px, ver use-mobile.ts) a sidebar vira um Sheet escondido por padrão,
 * então precisa abrir o trigger antes do item de nav ficar clicável; em desktop ela
 * já está lá (só em modo ícone, mas presente), o trigger não existe/não faz efeito. */
export async function abrirSecaoAdmin(page: Page, nome: "Gestão" | "Dashboard" | "Usuários") {
  const item = page.getByRole("button", { name: nome })
  const eraMobile = !(await item.isVisible().catch(() => false))
  if (eraMobile) {
    await page.locator('[data-slot="sidebar-trigger"]').click()
  }
  await item.click()
  // No mobile a sidebar é um Sheet por cima do conteúdo (ver use-mobile.ts, breakpoint
  // 768px) — escolher a seção não fecha ele sozinho, ficando cobrindo o resto da tela
  // (formulário/tabela por baixo ficam inalcançáveis pro clique). Escape fecha o Sheet
  // (comportamento padrão do Radix Dialog por baixo dele); não faz nada em desktop
  // (sidebar lá não é um overlay, não tem o que fechar).
  if (eraMobile) await page.keyboard.press("Escape")
}

export { ADMIN_SECRET }
export { test, expect }
