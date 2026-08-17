import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn, abrirSecaoAdmin } from "./helpers/fixtures"
import { makeMetrics } from "./helpers/mock-data"

test.describe("Dashboard", () => {
  test("mostra os cards de métrica com os números certos", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 42 }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText("42", { exact: true })).toBeVisible()
  })

  test("SLA vazio (nenhum chamado com prazo) mostra mensagem, não gráfico quebrado", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ sla: { dentroDoSla: 0, atrasado: 0, dentroDoSlaPercent: null, atrasadoPercent: null } }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText("Nenhum chamado com prazo definido ainda.")).toBeVisible()
  })

  test("atalho 'Hoje' refaz a busca com desde/ate preenchidos", async ({ page }) => {
    await mockAdminRoutes(page)
    let lastUrl = ""
    await page.route(/\/admin\/metrics/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      lastUrl = route.request().url()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeMetrics({ total: 1 })) })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await page.getByRole("button", { name: "Hoje" }).click()
    await expect.poll(() => lastUrl).toMatch(/desde=\d+&ate=\d+/)
  })

  test("truncated:true mostra o aviso no dashboard também", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ truncated: true }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText(/bateu no teto de páginas/)).toBeVisible()
  })

  test("erro do servidor mostra alerta em vez de tela em branco", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route(/\/admin\/metrics/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Erro ao calcular métricas." }) })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    // TanStack Query tenta de novo 3x com backoff (AdminApp.tsx) antes de desistir —
    // timeout maior que o padrão pra não ficar flaky.
    await expect(page.getByText("Erro ao calcular métricas.")).toBeVisible({ timeout: 15_000 })
  })
})
