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

  // Revisão de UX pra implantação (2026-10-16) — o Worker devolve a prioridade em inglês
  // (urgent/high/normal); o card comparava com o label em português e só "normal" aparecia.
  test("o card mostra a prioridade Urgente, Alta e Normal", async ({ page }) => {
    const tasks = [
      makeTask({ id: "p-urg", name: "Chamado urgente", priority: { priority: "urgent" } }),
      makeTask({ id: "p-alta", name: "Chamado alto", priority: { priority: "high" } }),
      makeTask({ id: "p-norm", name: "Chamado normal", priority: { priority: "normal" } }),
    ]
    await mockSolicitanteRoutes(page, { tasks })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    await expect(page.locator('[data-task-id="p-urg"]').getByText("Urgente", { exact: true })).toBeVisible()
    await expect(page.locator('[data-task-id="p-alta"]').getByText("Alta", { exact: true })).toBeVisible()
    await expect(page.locator('[data-task-id="p-norm"]').getByText("Normal", { exact: true })).toBeVisible()
  })

  test("'Atualizado há…' usa a última atualização, não a data de criação", async ({ page }) => {
    const criadoHa8h = Date.now() - 8 * 3600_000
    const task = makeTask({ id: "u1", status: { status: "em atendimento" }, date_created: criadoHa8h, date_updated: Date.now() - 60_000 })
    await mockSolicitanteRoutes(page, { tasks: [task] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    const card = page.locator('[data-task-id="u1"]')
    await expect(card.getByText(/Atualizado 1m atrás/)).toBeVisible()
    await expect(card.getByText(/Atualizado 8h atrás/)).toHaveCount(0)
  })

  test("depois de avaliar, agradece e marca a estrela escolhida", async ({ page }) => {
    const encerrado = makeTask({ id: "n1", status: { status: "encerrado" }, date_closed: Date.now() })
    await mockSolicitanteRoutes(page, { tasks: [encerrado] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Histórico/ }).click()
    await page.locator('[data-task-id="n1"]').getByRole("button", { name: "Avaliar com 5 estrelas" }).click()
    await expect(page.locator('[data-task-id="n1"]').getByText("Obrigado pela avaliação!")).toBeVisible()
  })
})

// Alvos de toque no celular (revisão de UX, 2026-10-16): abas, Sair, estrelas e o link do
// WhatsApp estavam abaixo de ~44px, fáceis de errar com o dedo. Só faz sentido no projeto mobile.
test.describe("Alvos de toque no celular", () => {
  test("abas, botão Sair, estrelas e link do WhatsApp têm pelo menos 40px de altura", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "medição só vale no viewport de celular")
    const tasks = [
      makeTask({ id: "t-aberto", status: { status: "aberto" } }),
      makeTask({ id: "t-enc", status: { status: "encerrado" }, date_closed: Date.now() }),
    ]
    await mockSolicitanteRoutes(page, { tasks })
    await gotoSolicitanteLoggedIn(page)
    const altura = async (loc: ReturnType<typeof page.locator>) => (await loc.first().boundingBox())!.height
    expect(await altura(page.getByRole("tab", { name: "Novo Chamado" }))).toBeGreaterThanOrEqual(44)
    expect(await altura(page.getByRole("button", { name: "Sair" }))).toBeGreaterThanOrEqual(44)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    expect(await altura(page.locator('[data-task-id="t-aberto"]').getByRole("link", { name: /WhatsApp/ }))).toBeGreaterThanOrEqual(40)
    await page.getByRole("tab", { name: /Histórico/ }).click()
    expect(await altura(page.locator('[data-task-id="t-enc"]').getByRole("button", { name: /Avaliar com 3 estrelas/ }))).toBeGreaterThanOrEqual(40)
  })
})
