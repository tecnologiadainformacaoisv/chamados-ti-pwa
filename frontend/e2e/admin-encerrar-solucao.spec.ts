// Regra de negócio (2026-08-24, pedido do usuário): a solução precisa ser descrita
// toda vez que um chamado é encerrado. Cobre os 3 caminhos que podem levar um
// chamado a "encerrado": seleção inline na Tabela (popup), arrastar no Quadro
// (popup, mesmo caminho de código — pedirStatus em gestao-view.tsx) e o modal
// "Gerenciar" (validação inline, sem popup — o campo já está na tela).
import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

test.describe("Encerrar exige solução — Tabela (select inline)", () => {
  test("selecionar Encerrado abre o popup pedindo solução, sem chamar o servidor ainda", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "em atendimento" } })] })
    let posted = false
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      posted = true
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()

    const row = page.locator("tr", { hasText: "Notebook não liga" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: "Encerrado" }).click()

    await expect(page.getByRole("heading", { name: "Encerrar chamado" })).toBeVisible()
    await page.waitForTimeout(200)
    expect(posted).toBe(false)
  })

  test("botão 'Encerrar chamado' fica desabilitado até preencher a solução", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "em atendimento" } })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const row = page.locator("tr", { hasText: "Notebook não liga" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: "Encerrado" }).click()

    const confirmar = page.getByRole("button", { name: "Encerrar chamado" })
    await expect(confirmar).toBeDisabled()
    await page.getByPlaceholder("Descreva a solução aplicada...").fill("Reiniciei o notebook.")
    await expect(confirmar).toBeEnabled()
  })

  test("confirmar manda status+solução juntos e fecha o popup", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "em atendimento" } })] })
    let posted: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      posted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const row = page.locator("tr", { hasText: "Notebook não liga" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: "Encerrado" }).click()
    await page.getByPlaceholder("Descreva a solução aplicada...").fill("Reiniciei o notebook e atualizei o driver.")
    await page.getByRole("button", { name: "Encerrar chamado" }).click()

    await expect.poll(() => posted).toEqual({ status: "encerrado", solucao: "Reiniciei o notebook e atualizei o driver." })
    // "Encerrar chamado" aparece tanto no título do popup quanto no botão de
    // confirmar — checar o dialog inteiro sumir evita ambiguidade de locator.
    await expect(page.getByRole("dialog", { name: "Encerrar chamado" })).not.toBeVisible()
  })

  test("cancelar não chama o servidor", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "em atendimento" } })] })
    let posted = false
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      posted = true
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const row = page.locator("tr", { hasText: "Notebook não liga" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: "Encerrado" }).click()
    await page.getByRole("button", { name: "Cancelar" }).click()
    await expect(page.getByRole("dialog", { name: "Encerrar chamado" })).not.toBeVisible()
    expect(posted).toBe(false)
  })

  test("popup pré-preenche a solução se o chamado já tinha uma escrita antes", async ({ page }) => {
    const task = makeTask({
      id: "t1", name: "Notebook não liga", status: { status: "em atendimento" },
      custom_fields: [
        { id: "47e475fe-e911-40cd-b4a2-23625fbf57f1", value: 0 },
        { id: "c1ca88de-4b01-4933-93ff-24494bed59e2", value: 0 },
        { id: "16144175-845e-4e3c-baaa-a2517325cd43", value: "Solução escrita antes, via o modal Gerenciar." },
      ],
    })
    await mockAdminRoutes(page, { tasks: [task] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const row = page.locator("tr", { hasText: "Notebook não liga" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: "Encerrado" }).click()
    await expect(page.getByPlaceholder("Descreva a solução aplicada...")).toHaveValue("Solução escrita antes, via o modal Gerenciar.")
  })

  test("erro do servidor mostra alerta e mantém o popup aberto", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "em atendimento" } })] })
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "não é possível encerrar um chamado sem preencher a solução" }) })
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const row = page.locator("tr", { hasText: "Notebook não liga" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: "Encerrado" }).click()
    await page.getByPlaceholder("Descreva a solução aplicada...").fill("x")
    await page.getByRole("button", { name: "Encerrar chamado" }).click()
    await expect(page.getByText("não é possível encerrar um chamado sem preencher a solução")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Encerrar chamado" })).toBeVisible()
  })

  test("mudar pra outro status (não Encerrado) continua sem popup nenhum", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "aberto" } })] })
    let posted: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      posted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const row = page.locator("tr", { hasText: "Notebook não liga" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: "Em Atendimento" }).click()
    await expect.poll(() => posted).toEqual({ status: "em atendimento" })
  })
})

test.describe("Encerrar exige solução — Quadro (arrastar)", () => {
  test("arrastar um card pra coluna Encerrado abre o mesmo popup", async ({ page }, testInfo) => {
    // Só desktop — no mobile o Quadro cai pra grid-cols-1 (kanban-board.tsx, <768px),
    // as 4 colunas empilham verticalmente e "Encerrado" fica fora da viewport;
    // dragTo() não rola a página durante o arraste, então nunca alcança o alvo. O
    // Quadro em si não é o padrão de uso mobile do admin (TI trabalha de desktop no
    // escritório) — a Tabela (testada acima, sem esse problema) já cobre o mesmo
    // caminho de código (pedirStatus em gestao-view.tsx).
    testInfo.skip(testInfo.project.name === "mobile", "drag-and-drop não alcança uma coluna fora da viewport quando o Quadro empilha em mobile")
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "aberto" } })] })
    await gotoAdminLoggedIn(page)
    const card = page.locator(".cursor-grab").first()
    const colunaEncerrado = page.locator('[data-status="encerrado"]')
    await card.dragTo(colunaEncerrado)
    await expect(page.getByRole("heading", { name: "Encerrar chamado" })).toBeVisible()
  })
})

test.describe("Encerrar exige solução — ação em lote", () => {
  test("'Encerrado' não aparece nas opções de status em massa", async ({ page }) => {
    await mockAdminRoutes(page, {
      tasks: [makeTask({ id: "t1", name: "Um", status: { status: "aberto" } }), makeTask({ id: "t2", name: "Dois", status: { status: "aberto" } })],
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await page.locator('tr:has-text("Um") input[type="checkbox"]').check()
    await page.getByText("Mudar status").click()
    await expect(page.getByRole("option", { name: "Encerrado" })).not.toBeVisible()
    await expect(page.getByRole("option", { name: "Aberto" })).toBeVisible()
  })
})

test.describe("Encerrar exige solução — modal 'Gerenciar'", () => {
  test("Salvar fica desabilitado com status Encerrado e solução vazia, com aviso visível", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga", status: { status: "em atendimento" } })] })
    await gotoAdminLoggedIn(page)
    await page.getByText("Notebook não liga").first().click()
    await page.getByRole("dialog").locator('[data-slot="select-trigger"]').first().click()
    await page.getByRole("option", { name: "Encerrado" }).click()

    await expect(page.getByText("Obrigatório pra encerrar o chamado.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Salvar" })).toBeDisabled()

    await page.getByPlaceholder("Descreva a solução aplicada...").fill("Resolvido.")
    await expect(page.getByRole("button", { name: "Salvar" })).toBeEnabled()
  })
})
