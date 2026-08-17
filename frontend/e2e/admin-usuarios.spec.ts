import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn, abrirSecaoAdmin } from "./helpers/fixtures"

test.describe("Usuários (gestão de solicitantes)", () => {
  test("lista ativos e inativos, com botão certo em cada linha", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ solicitantes: [{ name: "Fulano Ativo", ativo: 1, created_at: Date.now() }, { name: "Ciclana Inativa", ativo: 0, created_at: Date.now() }] }),
      })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    await expect(page.getByText("Fulano Ativo")).toBeVisible()
    await expect(page.locator("tr", { hasText: "Fulano Ativo" }).getByRole("button", { name: "Desativar" })).toBeVisible()
    await expect(page.locator("tr", { hasText: "Ciclana Inativa" }).getByRole("button", { name: "Reativar" })).toBeVisible()
  })

  test("adicionar solicitante novo chama POST com o nome certo", async ({ page }) => {
    await mockAdminRoutes(page)
    let posted: Record<string, unknown> | null = null
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: '{"solicitantes":[]}' })
      posted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    await page.getByPlaceholder("Nome completo").fill("Novo Colaborador")
    await page.getByRole("button", { name: "Adicionar" }).click()
    await expect.poll(() => posted).toEqual({ name: "Novo Colaborador" })
  })

  test("nome vazio mostra erro sem chamar o servidor", async ({ page }) => {
    await mockAdminRoutes(page)
    let called = false
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: '{"solicitantes":[]}' })
      called = true
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    await page.getByRole("button", { name: "Adicionar" }).click()
    await expect(page.getByText("Digite um nome.")).toBeVisible()
    expect(called).toBe(false)
  })

  test("desativar chama a rota certa com ativo:false", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ solicitantes: [{ name: "Fulano Ativo", ativo: 1, created_at: Date.now() }] }) })
    })
    let posted: Record<string, unknown> | null = null
    await page.route(/\/admin\/solicitantes\/[^/]+\/ativo/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      posted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    await page.getByRole("button", { name: "Desativar" }).click()
    await expect.poll(() => posted).toEqual({ ativo: false })
  })
})
