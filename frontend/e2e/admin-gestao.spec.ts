import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

test.describe("Gestão — Quadro (Kanban)", () => {
  test("agrupa os cards por status nas 4 colunas certas", async ({ page }) => {
    const tasks = [
      makeTask({ id: "a1", name: "Aberto 1", status: { status: "aberto" } }),
      makeTask({ id: "b1", name: "Atendimento 1", status: { status: "em atendimento" } }),
      makeTask({ id: "c1", name: "Pendente 1", status: { status: "pendente" } }),
      makeTask({ id: "d1", name: "Encerrado 1", status: { status: "encerrado" } }),
    ]
    await mockAdminRoutes(page, { tasks })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Aberto 1")).toBeVisible()
    await expect(page.getByText("Atendimento 1")).toBeVisible()
    await expect(page.getByText("Pendente 1")).toBeVisible()
    await expect(page.getByText("Encerrado 1")).toBeVisible()
  })

  test("clicar num card abre o modal Gerenciar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook quebrado" })] })
    await gotoAdminLoggedIn(page)
    await page.getByText("Notebook quebrado").click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByRole("dialog").getByText("Notebook quebrado")).toBeVisible()
  })

  test("alterna pra Tabela e volta pro Quadro", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Chamado X" })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await expect(page.locator("table")).toBeVisible()
    await page.getByRole("button", { name: "Quadro" }).click()
    await expect(page.locator("table")).not.toBeVisible()
  })
})

test.describe("Gestão — Tabela", () => {
  test("edição inline de status muda o chamado de grupo", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Vai mudar de status", status: { status: "aberto" } })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()

    let postedBody: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      postedBody = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "t1", status: { status: "em atendimento" } }) })
    })

    const row = page.locator("tr", { hasText: "Vai mudar de status" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click() // Status é o 2º select da linha (Operador é o 1º)
    await page.getByRole("option", { name: "Em Atendimento" }).click()

    await expect.poll(() => postedBody).toEqual({ status: "em atendimento" })
  })

  test("busca por título filtra a lista visível", async ({ page }) => {
    await mockAdminRoutes(page, {
      tasks: [makeTask({ id: "t1", name: "Impressora sem tinta" }), makeTask({ id: "t2", name: "Rede lenta" })],
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await expect(page.getByText("Impressora sem tinta")).toBeVisible()
    await expect(page.getByText("Rede lenta")).toBeVisible()

    await page.getByPlaceholder("Buscar por título...").fill("impressora")
    await expect(page.getByText("Impressora sem tinta")).toBeVisible()
    await expect(page.getByText("Rede lenta")).not.toBeVisible()
  })

  test("seleção em lote muda status de vários chamados de uma vez", async ({ page }) => {
    await mockAdminRoutes(page, {
      tasks: [makeTask({ id: "t1", name: "Um", status: { status: "aberto" } }), makeTask({ id: "t2", name: "Dois", status: { status: "aberto" } })],
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()

    let bulkBody: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/bulk/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      bulkBody = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 2, sucesso: 2, falha: 0, results: [] }) })
    })

    await page.locator('tr:has-text("Um") input[type="checkbox"]').check()
    await page.locator('tr:has-text("Dois") input[type="checkbox"]').check()
    await expect(page.getByText("2 selecionados")).toBeVisible()

    // Barra flutuante de ação em lote — Select "Mudar status"
    await page.getByText("Mudar status").click()
    await page.getByRole("option", { name: "Encerrado" }).click()

    await expect.poll(() => bulkBody).toEqual({ ids: ["t1", "t2"], status: "encerrado" })
    await expect(page.getByText("2 chamados atualizados.")).toBeVisible()
  })

  test("grupo colapsa e expande, e lembra entre re-renders", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Chamado aberto", status: { status: "aberto" } })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await expect(page.getByText("Chamado aberto")).toBeVisible()
    await page.getByRole("button", { name: /Aberto/ }).first().click()
    await expect(page.getByText("Chamado aberto")).not.toBeVisible()
  })
})

test.describe("Gestão — Filtros", () => {
  test("badge de filtros ativos conta corretamente", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText(/\d+ filtros?/)).not.toBeVisible()
    await page.locator('[data-slot="select-trigger"]').first().click()
    await page.getByRole("option").nth(1).click()
    await expect(page.getByText("1 filtro")).toBeVisible()
  })

  test("truncated:true mostra o aviso de teto de páginas", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route(/\/admin\/tasks(\?.*)?$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, tasks: [], truncated: true }) })
    })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText(/bateu no teto de páginas/)).toBeVisible()
  })
})
