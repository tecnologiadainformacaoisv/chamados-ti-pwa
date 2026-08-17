import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, loginAdminViaGate, gotoAdminLoggedIn, ADMIN_SECRET } from "./helpers/fixtures"

test.describe("Login do painel de admin (gate)", () => {
  test("segredo certo entra no painel", async ({ page }) => {
    await mockAdminRoutes(page)
    await loginAdminViaGate(page)
    await expect(page.locator('input[type="password"]')).not.toBeVisible()
    await expect(page.getByRole("heading", { name: "Gestão" })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem("admin_secret"))).toBe(ADMIN_SECRET)
  })

  test("segredo errado mostra erro e não entra", async ({ page }) => {
    await mockAdminRoutes(page)
    await loginAdminViaGate(page, "segredo-errado")
    await expect(page.getByText(/Segredo de admin inválido/)).toBeVisible()
    await expect(page.getByRole("heading", { name: "Gestão" })).not.toBeVisible()
  })

  test("sessão salva com segredo válido pula direto pro painel", async ({ page }) => {
    await mockAdminRoutes(page)
    await gotoAdminLoggedIn(page)
    await expect(page.getByRole("heading", { name: "Gestão" })).toBeVisible()
  })

  test("sessão salva com segredo que virou inválido (revogado) volta pro gate e limpa localStorage", async ({ page }) => {
    await mockAdminRoutes(page)
    await gotoAdminLoggedIn(page, "segredo-que-foi-revogado")
    await expect(page.locator('input[type="password"]')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem("admin_secret"))).toBeNull()
  })

  test("sair confirma e volta pro gate", async ({ page }) => {
    await mockAdminRoutes(page)
    await gotoAdminLoggedIn(page)
    page.on("dialog", (d) => d.accept())
    await page.locator('[title="Sair"]').click()
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })
})
