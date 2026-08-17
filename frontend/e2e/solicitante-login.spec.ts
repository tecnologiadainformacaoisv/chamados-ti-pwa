import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

test.describe("Login/cadastro do solicitante", () => {
  test("mostra erro se tentar entrar sem nome/senha", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByText("Selecione seu nome para continuar")).toBeVisible()
  })

  test("primeiro acesso: login 404 cai pra registro automático", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    // Sobrescreve /auth/login pra simular "sem senha cadastrada" (404) — loginOrRegister
    // deve cair sozinho pro /auth/register (já mockado com sucesso pelos defaults).
    await page.route("**/auth/login", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }))
    await page.goto("/")

    await page.locator('[data-slot="select-trigger"]').click()
    await page.getByRole("option", { name: "Fulano de Tal" }).click()
    await page.locator("#setup-password").fill("senha12345")
    await page.getByRole("button", { name: "Entrar" }).click()

    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem("session_token"))).toBe("fake-session-token")
  })

  test("login normal entra direto na tela principal", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await page.locator('[data-slot="select-trigger"]').click()
    await page.getByRole("option", { name: "Ciclana Souza" }).click()
    await page.locator("#setup-password").fill("senha12345")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
  })

  test("senha errada mostra o erro devolvido pelo servidor", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/auth/login", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Senha incorreta." }) }))
    await page.goto("/")
    await page.locator('[data-slot="select-trigger"]').click()
    await page.getByRole("option", { name: "Fulano de Tal" }).click()
    await page.locator("#setup-password").fill("senhaerrada")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByText("Senha incorreta.")).toBeVisible()
  })

  test("sessão salva no localStorage pula direto pra tela principal (sem gate)", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page, "Fulano de Tal")
    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
    await expect(page.getByText("Fulano de Tal").first()).toBeVisible()
  })

  test("logout confirma e volta pro login, limpando a sessão", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    page.on("dialog", (d) => d.accept())
    await page.getByRole("button", { name: "Sair" }).click()
    await expect(page.locator("#setup-name")).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem("session_token"))).toBeNull()
  })

  test("erro ao carregar lista de solicitantes mostra tela de boot-error com retry", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    // Registrado DEPOIS dos defaults — tem prioridade (LIFO), sobrescreve só este endpoint.
    await page.route("**/api/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    })
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Tentar de novo" })).toBeVisible()
  })
})
