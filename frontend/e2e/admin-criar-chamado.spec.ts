import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

// "Adicionar Chamado" inline na Tabela (2026-09-15, pedido do usuário, mesma mecânica
// da ClickUp) — POST /admin/tasks (rota nova, ver handleAdminCreateTask em
// push-worker.js). Só existe no grupo "Aberto" de propósito — ver comentário no
// próprio handler pro porquê (todo chamado sempre nasce aberto).
test.describe("Adicionar Chamado inline (Tabela)", () => {
  async function irParaTabela(page: import("@playwright/test").Page) {
    await page.getByRole("button", { name: "Tabela" }).click()
  }

  test("botão só aparece no grupo Aberto, não nos outros", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Chamado pendente", status: { status: "pendente" } })] })
    await gotoAdminLoggedIn(page)
    await irParaTabela(page)
    const botoes = page.getByRole("button", { name: "Adicionar Chamado" })
    await expect(botoes).toHaveCount(1)
    // confirma que o único está dentro do grupo Aberto, não Pendente
    const grupoAberto = page.locator("tr", { hasText: "Aberto" }).first()
    await expect(grupoAberto).toBeVisible()
  })

  test("preenche e cria: manda o POST certo, fecha o popover, limpa o formulário", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    let posted: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      posted = route.request().postDataJSON()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeTask({ id: "novo-1", name: posted!.name as string, solicitante: posted!.solicitante as string })),
      })
    })
    await gotoAdminLoggedIn(page)
    await irParaTabela(page)

    await page.getByRole("button", { name: "Adicionar Chamado" }).click()
    await page.getByLabel("Título").fill("Impressora sem tinta")
    await page.locator('[data-slot="popover-content"] [data-slot="select-trigger"]').first().click()
    await page.getByRole("option", { name: "Fulano de Tal" }).click()
    await page.getByRole("button", { name: "Criar" }).click()

    await expect.poll(() => posted).toEqual({ name: "Impressora sem tinta", solicitante: "Fulano de Tal" })
    // popover fecha sozinho depois do sucesso
    await expect(page.getByLabel("Título")).not.toBeVisible()
  })

  test("Criar fica desabilitado sem título/solicitante preenchidos", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await gotoAdminLoggedIn(page)
    await irParaTabela(page)
    await page.getByRole("button", { name: "Adicionar Chamado" }).click()
    await expect(page.getByRole("button", { name: "Criar" })).toBeDisabled()
    await page.getByLabel("Título").fill("Só o título")
    await expect(page.getByRole("button", { name: "Criar" })).toBeDisabled()
  })

  test("erro do servidor mostra a mensagem no popover e mantém aberto", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await page.route(/\/admin\/tasks$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "solicitante não encontrado ou inativo" }) })
    })
    await gotoAdminLoggedIn(page)
    await irParaTabela(page)
    await page.getByRole("button", { name: "Adicionar Chamado" }).click()
    await page.getByLabel("Título").fill("Impressora sem tinta")
    await page.locator('[data-slot="popover-content"] [data-slot="select-trigger"]').first().click()
    await page.getByRole("option", { name: "Fulano de Tal" }).click()
    await page.getByRole("button", { name: "Criar" }).click()

    await expect(page.getByText("solicitante não encontrado ou inativo")).toBeVisible()
    await expect(page.getByLabel("Título")).toBeVisible() // continua aberto
  })
})
