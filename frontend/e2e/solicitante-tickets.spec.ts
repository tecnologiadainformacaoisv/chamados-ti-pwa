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

  // Nota de satisfação (2026-09-21, "julgo essencial") — 5 estrelas, só em chamado
  // encerrado.
  test("chamado aberto não mostra nenhum widget de avaliação", async ({ page }) => {
    const aberto = makeTask({ id: "t-sem-nota", status: { status: "aberto" } })
    await mockSolicitanteRoutes(page, { tasks: [aberto] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    await expect(page.getByText("Como foi o atendimento?")).not.toBeVisible()
  })

  test("chamado encerrado sem nota mostra o convite pra avaliar; clicar numa estrela envia a nota e atualiza o rótulo", async ({ page }) => {
    const encerrado = makeTask({ id: "t-avaliar", status: { status: "encerrado" }, date_closed: Date.now() })
    await mockSolicitanteRoutes(page, { tasks: [encerrado] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Histórico/ }).click()

    const card = page.locator('[data-task-id="t-avaliar"]')
    await expect(card.getByText("Como foi o atendimento?")).toBeVisible()
    const envio = page.waitForRequest((r) => r.url().includes("/nota") && r.method() === "POST")
    await card.getByRole("button", { name: "Avaliar com 4 estrelas" }).click()
    expect((await envio).postDataJSON()).toEqual({ nota: 4 })
    await expect(card.getByText("Sua avaliação:")).toBeVisible()
    await expect(card.getByRole("button", { name: "Avaliar com 4 estrelas" })).toHaveAttribute("aria-pressed", "true")
  })

  test("chamado já avaliado abre mostrando a nota preenchida, não o convite", async ({ page }) => {
    const avaliado = makeTask({ id: "t-ja-avaliado", status: { status: "encerrado" }, date_closed: Date.now(), nota: 3 })
    await mockSolicitanteRoutes(page, { tasks: [avaliado] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Histórico/ }).click()

    const card = page.locator('[data-task-id="t-ja-avaliado"]')
    await expect(card.getByText("Sua avaliação:")).toBeVisible()
    await expect(card.getByText("Como foi o atendimento?")).not.toBeVisible()
  })
})
