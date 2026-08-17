import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

test.describe("Alerta de chamado novo", () => {
  test("badge mostra a contagem de abertos já na primeira carga", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route(/\/admin\/tasks\?.*status=aberto/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 3, tasks: [makeTask({ id: "t1" }), makeTask({ id: "t2" }), makeTask({ id: "t3" })], truncated: false }) })
    })
    await gotoAdminLoggedIn(page)
    await expect(page.locator('[title*="chamado(s) aberto(s)"]')).toContainText("3")
  })

  test("primeira carga não dispara a caixa de alerta (só registra em silêncio)", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route(/\/admin\/tasks\?.*status=aberto/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, tasks: [makeTask({ id: "t1", name: "Já estava aberto antes" })], truncated: false }) })
    })
    await gotoAdminLoggedIn(page)
    await page.waitForTimeout(500)
    await expect(page.getByText("🔔 Chamado novo")).not.toBeVisible()
  })

  test("chamado novo (aparecendo num poll seguinte) dispara a caixa com 'Aceitar chamado'", async ({ page }) => {
    let call = 0
    await mockAdminRoutes(page)
    await page.route(/\/admin\/tasks\?.*status=aberto/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      call++
      const tasks = call === 1 ? [] : [makeTask({ id: "t-novo", name: "Chamado que acabou de chegar", solicitante: "Fulano de Tal" })]
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: tasks.length, tasks, truncated: false }) })
    })
    await gotoAdminLoggedIn(page)
    await expect(page.locator('[title="Atualizar"]')).toBeVisible()
    await page.locator('[title="Atualizar"]').click() // força o 2º poll sem esperar 20s

    await expect(page.getByText("🔔 Chamado novo")).toBeVisible()
    await expect(page.getByText("Chamado que acabou de chegar")).toBeVisible()

    let accepted: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t-novo$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      accepted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.getByRole("button", { name: "Aceitar chamado" }).click()
    await expect.poll(() => accepted).toEqual({ status: "em atendimento" })
    await expect(page.getByText("🔔 Chamado novo")).not.toBeVisible()
  })

  test("'Ver depois' fecha sem aceitar", async ({ page }) => {
    let call = 0
    await mockAdminRoutes(page)
    await page.route(/\/admin\/tasks\?.*status=aberto/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      call++
      const tasks = call === 1 ? [] : [makeTask({ id: "t-novo", name: "Chamado novo aqui" })]
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: tasks.length, tasks, truncated: false }) })
    })
    await gotoAdminLoggedIn(page)
    await page.locator('[title="Atualizar"]').click()
    await expect(page.getByText("🔔 Chamado novo")).toBeVisible()
    await page.getByRole("button", { name: "Ver depois" }).click()
    await expect(page.getByText("🔔 Chamado novo")).not.toBeVisible()
  })
})
