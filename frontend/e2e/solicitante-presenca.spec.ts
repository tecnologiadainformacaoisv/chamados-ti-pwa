import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

// Heartbeat de presença (2026-11-17): a aba do solicitante avisa o servidor que está aberta,
// pra o painel de admin mostrar "online". Usa a Page Visibility API pra distinguir aba em uso
// de aba em segundo plano.
test.describe("Presença (heartbeat do solicitante)", () => {
  test("manda sinal ao abrir, com a sessão e visivel: true", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    const sinais: { visivel?: boolean; saindo?: boolean; token?: string }[] = []
    await page.route("**/api/presence", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      sinais.push({ ...(route.request().postDataJSON() as object), token: route.request().headers()["x-session-token"] })
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    })
    await gotoSolicitanteLoggedIn(page)
    await expect.poll(() => sinais.length).toBeGreaterThan(0)
    expect(sinais[0]).toMatchObject({ visivel: true, token: "fake-session-token" })
  })

  test("ao esconder a aba manda visivel: false na hora", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    const sinais: { visivel?: boolean }[] = []
    await page.route("**/api/presence", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      sinais.push(route.request().postDataJSON() as { visivel?: boolean })
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    })
    await gotoSolicitanteLoggedIn(page)
    await expect.poll(() => sinais.length).toBeGreaterThan(0)
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await expect.poll(() => sinais.some((s) => s.visivel === false)).toBe(true)
  })
})
