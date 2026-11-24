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

  // ---- Filtros do Dashboard (2026-11-24, "Everson ama filtros") ----
  const metricasDe = (url: string) => new URL(url).searchParams

  test("cada filtro vira parâmetro do pedido, aparece como etiqueta e some ao ser removido", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 18 }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    const pedido = (esperado: Record<string, string>) =>
      page.waitForRequest((r) => {
        if (!/\/admin\/metrics/.test(r.url())) return false
        const q = metricasDe(r.url())
        return Object.entries(esperado).every(([k, v]) => q.get(k) === v)
      })

    let p = pedido({ setor: "0" })
    await page.getByLabel("Setor").click()
    await page.getByRole("option", { name: "Administrativo" }).click()
    await p
    await expect(page.getByRole("button", { name: "Remover filtro Setor: Administrativo" })).toBeVisible()

    // um segundo filtro SOMA ao primeiro (E)
    p = pedido({ setor: "0", prioridade: "1" })
    await page.getByLabel("Prioridade").click()
    await page.getByRole("option", { name: "Urgente" }).click()
    await p
    await expect(page.getByText("Mostrando 18 chamados com o recorte aplicado.")).toBeVisible()

    p = pedido({ setor: "0", prioridade: "1", status: "pendente" })
    await page.getByLabel("Situação").click()
    await page.getByRole("option", { name: "Pendente" }).click()
    await p

    // remover UMA etiqueta tira só aquele filtro
    await page.getByRole("button", { name: "Remover filtro Prioridade: Urgente" }).click()
    await expect(page.getByRole("button", { name: /Remover filtro Prioridade/ })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Remover filtro Setor/ })).toBeVisible()

    // limpar tudo volta ao aviso de "todos os chamados"
    await page.getByRole("button", { name: "Limpar filtros" }).click()
    await expect(page.getByRole("button", { name: /Remover filtro/ })).toHaveCount(0)
    await expect(page.getByText("Contando todos os 18 chamados desde o início")).toBeVisible()
  })

  test("filtro por atendente (o que o Everson usa) manda o id do operador", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 18 }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    const pedido = page.waitForRequest((r) => /\/admin\/metrics/.test(r.url()) && metricasDe(r.url()).get("operador") === "170628721")
    await page.getByLabel("Atendente").click()
    await page.getByRole("option", { name: "Everson" }).click()
    await pedido
    await expect(page.getByRole("button", { name: "Remover filtro Atendente: Everson" })).toBeVisible()
  })

  test("clicar numa barra de volume liga o filtro e clicar de novo desliga", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 18 }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    const barra = page.getByRole("button", { name: /Filtrar só por "Notebooks"/ })
    const pedido = page.waitForRequest((r) => /\/admin\/metrics/.test(r.url()) && metricasDe(r.url()).get("tipo") === "0")
    await barra.click()
    await pedido
    await expect(page.getByRole("button", { name: "Remover filtro Tipo: Notebooks" })).toBeVisible()
    await page.getByRole("button", { name: /Tirar o filtro "Notebooks"/ }).click()
    await expect(page.getByRole("button", { name: /Remover filtro Tipo/ })).toHaveCount(0)
  })

  test("recorte sem nenhum chamado explica e oferece limpar os filtros", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 18 }) })
    // com algum filtro de setor, o servidor (mock) responde zero chamados
    await page.route(/\/admin\/metrics\?.*setor=/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(makeMetrics({ total: 0, porStatus: {}, porTipo: {}, porSetor: {}, porPrioridade: {}, porOperador: {} })) }),
    )
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await page.getByLabel("Setor").click()
    await page.getByRole("option", { name: "Diretoria" }).click()
    await expect(page.getByText("Nenhum chamado com esses filtros.")).toBeVisible()
    await page.getByRole("button", { name: "Limpar filtros" }).last().click()
    await expect(page.getByText("Nenhum chamado com esses filtros.")).toHaveCount(0)
    await expect(page.getByText("Contando todos os 18 chamados desde o início")).toBeVisible()
  })

  test("atalhos 'Este mês' e 'Mês passado' preenchem as datas no fuso local", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 18 }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    const h = new Date()
    const de = page.locator('input[type="date"]').first()
    const ate = page.locator('input[type="date"]').nth(1)
    await page.getByRole("button", { name: "Este mês" }).click()
    await expect(de).toHaveValue(iso(new Date(h.getFullYear(), h.getMonth(), 1)))
    await expect(ate).toHaveValue(iso(h))
    await page.getByRole("button", { name: "Mês passado" }).click()
    await expect(de).toHaveValue(iso(new Date(h.getFullYear(), h.getMonth() - 1, 1)))
    await expect(ate).toHaveValue(iso(new Date(h.getFullYear(), h.getMonth(), 0)))
  })

  test("o volume por prioridade e por atendente aparece no Dashboard", async ({ page }) => {
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 18, porPrioridade: { 1: 4, 2: 6, 3: 8 }, porOperador: { "170628721": 9, "200498355": 9 } }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await expect(page.getByText("Volume por prioridade")).toBeVisible()
    await expect(page.getByRole("button", { name: /Filtrar só por "Urgente"/ })).toContainText("4")
    await expect(page.getByText("Volume por atendente")).toBeVisible()
    await expect(page.getByRole("button", { name: /Filtrar só por "Everson"/ })).toContainText("9")
  })
})
