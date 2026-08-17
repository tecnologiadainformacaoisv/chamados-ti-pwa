import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

async function abrirModal(page: import("@playwright/test").Page) {
  await page.getByText("Notebook não liga", { exact: false }).first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
}

test.describe("Modal 'Gerenciar' — edição", () => {
  test("salvar status/solução chama POST /admin/tasks/:id com o body certo", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    await gotoAdminLoggedIn(page)
    await abrirModal(page)

    let posted: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      posted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "t1" }) })
    })

    await page.getByRole("dialog").locator('[data-slot="select-trigger"]').first().click()
    await page.getByRole("option", { name: "Pendente" }).click()
    await page.getByPlaceholder("Descreva a solução aplicada...").fill("Fonte trocada.")
    await page.getByRole("button", { name: "Salvar" }).click()

    await expect.poll(() => posted).toEqual({ status: "pendente", solucao: "Fonte trocada." })
    await expect(page.getByRole("dialog")).not.toBeVisible()
  })

  test("não toca no operador não manda assigneeId (evita apagar 2º operador)", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", assignees: [{ id: 170628721 }, { id: 200498355 }] })] })
    await gotoAdminLoggedIn(page)
    await abrirModal(page)
    await expect(page.getByText(/2 operadores atribuídos/)).toBeVisible()

    let posted: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      posted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.getByRole("button", { name: "Salvar" }).click()
    await expect.poll(() => posted).not.toBeNull()
    expect(posted!).not.toHaveProperty("assigneeId")
  })

  // Sem teste de "status desconhecido" via UI de propósito — `byStatus` (Kanban/Tabela)
  // já descarta silenciosamente qualquer chamado com status fora dos 4 conhecidos
  // antes dele aparecer em qualquer lista, então não tem card/linha pra clicar e abrir
  // o modal com esse estado (achado do revisor em 2026-08-14, já documentado no
  // CLAUDE.md — caminho defensivo no TaskModal que não é alcançável nesta view hoje).

  test("erro ao salvar mostra alerta e mantém o modal aberto", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Falha ao salvar no banco." }) })
    })
    await gotoAdminLoggedIn(page)
    await abrirModal(page)
    await page.getByRole("button", { name: "Salvar" }).click()
    await expect(page.getByText("Falha ao salvar no banco.")).toBeVisible()
    await expect(page.getByRole("dialog")).toBeVisible()
  })

  test("cancelar fecha sem salvar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    await gotoAdminLoggedIn(page)
    await abrirModal(page)
    await page.getByRole("button", { name: "Cancelar" }).click()
    await expect(page.getByRole("dialog")).not.toBeVisible()
  })
})

test.describe("Modal 'Gerenciar' — histórico e notas", () => {
  test("mostra timeline com evento automático e nota manual", async ({ page }) => {
    const eventos = [
      { id: "e1", chamado_id: "t1", tipo: "status", autor: null, texto: null, de_valor: "aberto", para_valor: "em atendimento", created_at: Date.now() - 60000 },
      { id: "e2", chamado_id: "t1", tipo: "nota", autor: "Henrique", texto: "Já entrei em contato com o solicitante.", de_valor: null, para_valor: null, created_at: Date.now() },
    ]
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })], eventos })
    await gotoAdminLoggedIn(page)
    await abrirModal(page)
    await expect(page.getByText(/Status mudou de/)).toBeVisible()
    await expect(page.getByText("Já entrei em contato com o solicitante.")).toBeVisible()
    await expect(page.getByText("Henrique", { exact: true })).toBeVisible()
  })

  test("adiciona nota nova e ela aparece na lista", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    let notaPostada: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t1\/eventos/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() === "GET") {
        const eventos = notaPostada ? [{ id: "ev-1", chamado_id: "t1", tipo: "nota", ...notaPostada, de_valor: null, para_valor: null, created_at: Date.now() }] : []
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ eventos }) })
      }
      notaPostada = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ evento: {} }) })
    })
    await gotoAdminLoggedIn(page)
    await abrirModal(page)
    await expect(page.getByText("Nenhum evento ainda.")).toBeVisible()

    await page.locator('[data-slot="dialog-content"] [data-slot="select-trigger"]').last().click()
    await page.getByRole("option", { name: "Henrique" }).click()
    await page.getByPlaceholder(/Escrever nota interna/).fill("Aguardando peça chegar.")
    await page.getByRole("button", { name: "Adicionar nota" }).click()

    await expect(page.getByText("Aguardando peça chegar.")).toBeVisible()
  })

  test("erro ao adicionar nota mostra alerta (não fica engolido em silêncio)", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    await page.route(/\/admin\/tasks\/t1\/eventos/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: '{"eventos":[]}' })
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Erro ao gravar nota." }) })
    })
    await gotoAdminLoggedIn(page)
    await abrirModal(page)
    await page.locator('[data-slot="dialog-content"] [data-slot="select-trigger"]').last().click()
    await page.getByRole("option", { name: "Everson" }).click()
    await page.getByPlaceholder(/Escrever nota interna/).fill("Teste")
    await page.getByRole("button", { name: "Adicionar nota" }).click()
    await expect(page.getByText("Erro ao gravar nota.")).toBeVisible()
  })
})
