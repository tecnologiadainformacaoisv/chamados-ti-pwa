// Guarda de regressão pro bug de 2026-08-17 ("Texto livre sem espaço estourava
// modais/cards em todo o front") — mesma string patológica do print real que motivou
// aquele fix, aplicada como título/descrição/solução/nome em todas as superfícies já
// corrigidas naquela rodada. Se qualquer uma delas voltar a vazar (min-w-0/break-words
// removido sem querer num futuro refactor), esse teste falha ANTES de virar print de
// produção de novo.
import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, mockAdminRoutes, gotoSolicitanteLoggedIn, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask, PATHOLOGICAL_STRING } from "./helpers/mock-data"

function expectNoOverflow(box: { x: number; y: number; width: number; height: number } | null, viewport: { width: number; height: number }) {
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(-1)
  expect(box!.y).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
}

test.describe("Regressão: texto sem espaço não estoura layout", () => {
  test("card do solicitante (TicketCard) não vaza", async ({ page }) => {
    const task = makeTask({
      id: "t-overflow",
      name: PATHOLOGICAL_STRING,
      description: PATHOLOGICAL_STRING,
      text_content: PATHOLOGICAL_STRING,
      solicitante: PATHOLOGICAL_STRING.slice(0, 60),
    })
    await mockSolicitanteRoutes(page, { tasks: [task] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    const card = page.locator('[data-task-id="t-overflow"]')
    await expect(card).toBeVisible()
    expectNoOverflow(await card.boundingBox(), page.viewportSize()!)
  })

  test("card do Kanban (admin) não vaza", async ({ page }) => {
    const task = makeTask({ id: "t-overflow", name: PATHOLOGICAL_STRING, status: { status: "aberto" } })
    await mockAdminRoutes(page, { tasks: [task] })
    await gotoAdminLoggedIn(page)
    const card = page.locator(".cursor-grab").first()
    await expect(card).toBeVisible()
    expectNoOverflow(await card.boundingBox(), page.viewportSize()!)
  })

  test("modal 'Gerenciar' (admin) não vaza, mesmo com erro de save", async ({ page }) => {
    const task = makeTask({ id: "t-overflow", name: PATHOLOGICAL_STRING, description: PATHOLOGICAL_STRING, status: { status: "aberto" } })
    await mockAdminRoutes(page, { tasks: [task] })
    // erro do servidor também é texto livre sem espaço (URL/id/stack são candidatos reais)
    await page.route(/\/admin\/tasks\/[^/]+$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: PATHOLOGICAL_STRING }) })
    })
    await gotoAdminLoggedIn(page)
    await page.locator(".cursor-grab").first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    expectNoOverflow(await dialog.boundingBox(), page.viewportSize()!)

    await page.getByRole("button", { name: "Salvar" }).click()
    await expect(page.getByRole("alert")).toBeVisible()
    expectNoOverflow(await dialog.boundingBox(), page.viewportSize()!)
  })

  test("popup 'Chamado novo' (admin) não vaza — o bug original reportado", async ({ page }) => {
    let call = 0
    await mockAdminRoutes(page)
    await page.route(/\/admin\/tasks\?.*status=aberto/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      call++
      const tasks = call === 1 ? [] : [makeTask({ id: "t-overflow", name: PATHOLOGICAL_STRING, status: { status: "aberto" } })]
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: tasks.length, tasks, truncated: false }) })
    })
    await gotoAdminLoggedIn(page)
    await expect(page.locator('[title="Atualizar"]')).toBeVisible()
    // Força um novo poll (o hook usa refetchInterval de 20s — o botão "Atualizar"
    // do header invalida TODAS as queries na hora, sem precisar esperar).
    await page.locator('[title="Atualizar"]').click()

    const dialog = page.getByRole("dialog").filter({ hasText: "Chamado novo" })
    await expect(dialog).toBeVisible()
    expectNoOverflow(await dialog.boundingBox(), page.viewportSize()!)
  })
})
