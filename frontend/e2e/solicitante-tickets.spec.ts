import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"
import { makeTask, makeTaskWithAnexo } from "./helpers/mock-data"

test.describe("Meus Chamados / Histórico", () => {
  test("lista vazia mostra estado vazio nas duas abas", async ({ page }) => {
    await mockSolicitanteRoutes(page, { tasks: [] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    await expect(page.getByText("Nenhum chamado em aberto.")).toBeVisible()
    await page.getByRole("tab", { name: /Histórico/ }).click()
    await expect(page.getByText("Nenhum chamado encerrado ainda.")).toBeVisible()
  })

  test("chamado aberto aparece em Meus Chamados, encerrado aparece no Histórico", async ({ page }) => {
    const aberto = makeTask({ id: "t-aberto", name: "Impressora atolada", status: { status: "aberto" } })
    const encerrado = makeTask({ id: "t-encerrado", name: "Senha resetada", status: { status: "encerrado" }, date_closed: Date.now() })
    await mockSolicitanteRoutes(page, { tasks: [aberto, encerrado] })
    await gotoSolicitanteLoggedIn(page)

    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    await expect(page.locator('[data-task-id="t-aberto"]')).toBeVisible()
    await expect(page.locator('[data-task-id="t-encerrado"]')).not.toBeVisible()

    await page.getByRole("tab", { name: /Histórico/ }).click()
    await expect(page.locator('[data-task-id="t-encerrado"]')).toBeVisible()
  })

  test("contador nas abas reflete a quantidade certa", async ({ page }) => {
    const tasks = [
      makeTask({ id: "a1", status: { status: "aberto" } }),
      makeTask({ id: "a2", status: { status: "em atendimento" } }),
      makeTask({ id: "e1", status: { status: "encerrado" } }),
    ]
    await mockSolicitanteRoutes(page, { tasks })
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByRole("tab", { name: /Meus Chamados/ }).locator(".count-pill")).toHaveText("2")
    await expect(page.getByRole("tab", { name: /Histórico/ }).locator(".count-pill")).toHaveText("1")
  })

  test("chamado atrasado mostra o banner de atraso", async ({ page }) => {
    const atrasado = makeTask({ id: "t-atrasado", status: { status: "aberto" }, due_date: Date.now() - 3600_000 })
    await mockSolicitanteRoutes(page, { tasks: [atrasado] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    const card = page.locator('[data-task-id="t-atrasado"]')
    await expect(card).toBeVisible()
    await expect(card.locator("text=/⚠/")).toBeVisible()
  })

  test("chamado encerrado com solução mostra a caixa 'Solução aplicada'", async ({ page }) => {
    const encerrado = makeTask({
      id: "t-sol",
      status: { status: "encerrado" },
      date_closed: Date.now(),
      custom_fields: [
        { id: "47e475fe-e911-40cd-b4a2-23625fbf57f1", value: 0 },
        { id: "c1ca88de-4b01-4933-93ff-24494bed59e2", value: 0 },
        { id: "16144175-845e-4e3c-baaa-a2517325cd43", value: "Trocado o cabo de energia." },
      ],
    })
    await mockSolicitanteRoutes(page, { tasks: [encerrado] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Histórico/ }).click()
    await expect(page.getByText("Solução aplicada")).toBeVisible()
    await expect(page.getByText("Trocado o cabo de energia.")).toBeVisible()
  })

  test("clicar no anexo abre o modal e carrega a imagem", async ({ page }) => {
    const comAnexo = makeTaskWithAnexo({ status: { status: "aberto" } })
    await mockSolicitanteRoutes(page, { tasks: [comAnexo] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    await page.getByRole("button", { name: "print.png" }).click()
    await expect(page.getByRole("dialog").getByRole("img")).toBeVisible()
  })

  test("link do WhatsApp aponta pro número do operador certo", async ({ page }) => {
    const task = makeTask({ id: "t-wa", status: { status: "aberto" }, assignees: [{ id: 170628721, username: "Everson" }] })
    await mockSolicitanteRoutes(page, { tasks: [task] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    const link = page.locator('[data-task-id="t-wa"]').getByRole("link", { name: /WhatsApp/ })
    await expect(link).toHaveAttribute("href", /5585989304648/)
  })
})
