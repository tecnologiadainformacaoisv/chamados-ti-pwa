import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

// Fila de atendimento (2026-10-19): lista do protótipo, agora a visão padrão da Gestão.
const MIN = 60_000

test.describe("Gestão — fila de atendimento", () => {
  const tarefas = () => [
    makeTask({ id: "a1", name: "Impressora parada", status: { status: "aberto" }, priority: { priority: "urgent" }, due_date: Date.now() - 10 * MIN, solicitante: "Ana Lima", assignees: [{ id: 200498355 }] }),
    makeTask({ id: "b1", name: "Instalar programa", status: { status: "em atendimento" }, priority: { priority: "high" }, due_date: Date.now() + 10 * MIN, solicitante: "Beto Souza", assignees: [{ id: 170628721 }] }),
    makeTask({ id: "p1", name: "Aguardando fornecedor", status: { status: "pendente" }, assignees: [{ id: 170628721 }] }),
    makeTask({ id: "z1", name: "Chamado encerrado", status: { status: "encerrado" }, date_closed: Date.now() - 5 * MIN }),
  ]

  async function abrirFila(page: import("@playwright/test").Page, tasks = tarefas()) {
    await mockAdminRoutes(page, { tasks })
    await gotoAdminLoggedIn(page, undefined, false, "fila")
  }

  test("é a visão padrão e mostra prazo em linguagem de gente, sem os encerrados", async ({ page }) => {
    await abrirFila(page)
    const fila = page.getByRole("region", { name: "Fila de atendimento" })
    await expect(fila).toBeVisible()
    const a1 = fila.locator('[data-task-id="a1"]')
    await expect(a1).toContainText("atrasado")
    await expect(a1).toContainText("Ana Lima")
    await expect(fila.locator('[data-task-id="b1"]')).toContainText("vence em")
    await expect(fila.locator('[data-task-id="p1"]')).toContainText("em espera, prazo pausado")
    await expect(fila.locator('[data-task-id="z1"]')).toHaveCount(0)
    await fila.getByLabel("mostrar encerrados").check()
    await expect(fila.locator('[data-task-id="z1"]')).toBeVisible()
  })

  test("cada linha tem a próxima ação: Aceitar, Encerrar ou Retomar", async ({ page }) => {
    await abrirFila(page)
    const fila = page.getByRole("region", { name: "Fila de atendimento" })
    await expect(fila.locator('[data-task-id="a1"]').getByRole("button", { name: /^Aceitar:/ })).toBeVisible()
    await expect(fila.locator('[data-task-id="b1"]').getByRole("button", { name: /^Encerrar:/ })).toBeVisible()
    await expect(fila.locator('[data-task-id="p1"]').getByRole("button", { name: /^Retomar:/ })).toBeVisible()
  })

  test("Aceitar muda na hora e só envia depois da janela do Desfazer", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await page.route(/\/admin\/tasks\/a1$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      calls.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await abrirFila(page)
    const fila = page.getByRole("region", { name: "Fila de atendimento" })
    await fila.locator('[data-task-id="a1"]').getByRole("button", { name: /^Aceitar:/ }).click()
    await expect(fila.locator('[data-task-id="a1"]').getByRole("button", { name: /^Encerrar:/ })).toBeVisible()
    expect(calls).toHaveLength(0)
    await page.getByRole("button", { name: /Desfazer/ }).click()
    await expect(fila.locator('[data-task-id="a1"]').getByRole("button", { name: /^Aceitar:/ })).toBeVisible()
    expect(calls).toHaveLength(0)
  })

  test("Retomar aparece na hora, mesmo com o servidor lento", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await abrirFila(page)
    // registrada DEPOIS dos mocks padrão (a rota mais nova vence)
    await page.route(/\/admin\/tasks\/p1$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      calls.push(route.request().postDataJSON())
      await new Promise((r) => setTimeout(r, 3000)) // servidor devagar
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    const fila = page.getByRole("region", { name: "Fila de atendimento" })
    await fila.locator('[data-task-id="p1"]').getByRole("button", { name: /^Retomar:/ }).click()
    // a tela já mostra "Encerrar" (= em atendimento) bem antes dos 3 s do servidor
    await expect(fila.locator('[data-task-id="p1"]').getByRole("button", { name: /^Encerrar:/ })).toBeVisible({ timeout: 1000 })
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0]).toEqual({ status: "em atendimento" })
  })

  test("botões da fila mostram a mãozinha ao passar o mouse", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "sem mouse no celular")
    await abrirFila(page)
    const botao = page.getByRole("region", { name: "Fila de atendimento" }).locator('[data-task-id="a1"]').getByRole("button", { name: /^Aceitar:/ })
    expect(await botao.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer")
  })

  test("clicar na linha abre o resumo e Gerenciar abre o modal completo", async ({ page }) => {
    await abrirFila(page, [makeTask({ id: "d1", name: "Mouse quebrado", description: "O mouse parou de clicar.", text_content: "O mouse parou de clicar.", status: { status: "aberto" } })])
    const fila = page.getByRole("region", { name: "Fila de atendimento" })
    await fila.locator('[data-task-id="d1"]').getByText("Mouse quebrado").click()
    await expect(fila.getByText("O mouse parou de clicar.")).toBeVisible()
    await fila.getByRole("button", { name: "Gerenciar" }).click()
    await expect(page.getByRole("dialog")).toContainText("Mouse quebrado")
  })

  test("fila vazia orienta em vez de mostrar uma lista em branco", async ({ page }) => {
    await abrirFila(page, [])
    await expect(page.getByText("Ainda não há chamados.")).toBeVisible()
  })
})
