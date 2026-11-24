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

  // Sem nenhum chamado no período: uma mensagem só, em vez de 8 cartões "0" (UX 2026-10-16).
  test("sem chamados no período mostra uma mensagem só, não 8 cartões zerados", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 0, porStatus: {}, inicioOperacao: Date.UTC(2026, 9, 16, 12, 0, 0) }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText("Ainda sem chamados neste período.")).toBeVisible()
    await expect(page.getByText("Total de chamados")).toHaveCount(0)
    await expect(page.getByText(/Métricas contadas desde/)).toHaveCount(0)
  })

  // 2026-11-24: o corte em 16/10 foi removido; o padrão é TODOS os chamados, e a operação real vira atalho.
  test("conta todos os chamados desde o início e o atalho 'Só a operação' pede desde 16/10", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 488, inicioOperacao: Date.UTC(2026, 9, 16, 3, 0, 0) }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText("Contando todos os 488 chamados desde o início")).toBeVisible()
    await expect(page.getByText(/Métricas contadas desde/)).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Desde o início" })).toBeVisible()
    const pedido = page.waitForRequest((r) => /\/admin\/metrics\?.*desde=/.test(r.url()))
    await page.getByRole("button", { name: /Só a operação/ }).click()
    const url = new URL((await pedido).url())
    expect(Number(url.searchParams.get("desde"))).toBeGreaterThan(Date.UTC(2026, 9, 15))
    expect(Number(url.searchParams.get("desde"))).toBeLessThan(Date.UTC(2026, 9, 17))
    await expect(page.locator('input[type="date"]').first()).toHaveValue("2026-10-16")
    await page.getByRole("button", { name: "Desde o início" }).click()
    await expect(page.locator('input[type="date"]').first()).toHaveValue("")
  })

  // Satisfação (2026-09-21, "julgo essencial") — média das notas 1-5 dadas pelos
  // solicitantes, card novo na grade de métricas.
  test("card de satisfação mostra a média e o total de avaliações", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ satisfacao: { mediaNota: 4.3, totalAvaliacoes: 12 } }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText("4.3 ★")).toBeVisible()
    await expect(page.getByText("Satisfação média (12 avaliações)")).toBeVisible()
  })

  test("sem nenhuma avaliação ainda, mostra travessão em vez de 0 ou NaN", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ satisfacao: { mediaNota: null, totalAvaliacoes: 0 } }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText("Satisfação média (0 avaliações)")).toBeVisible()
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
    await expect(page.getByText(/Há mais chamados do que a tela consegue mostrar/)).toBeVisible()
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
