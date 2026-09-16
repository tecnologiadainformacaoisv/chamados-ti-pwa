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

  // Login por e-mail (2026-09-16, pedido da diretoria) — a tela ganhou edição de
  // e-mail inline, status de cadastro (cruzando GET /admin/users) e "Resetar senha".
  test("mostra status 'Já acessou' pra quem tem senha, 'Aguardando 1º acesso' pra quem não tem", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ solicitantes: [
          { name: "Já Registrou", email: "ja.registrou@institutosaovicente.com.br", ativo: 1, created_at: Date.now() },
          { name: "Nunca Entrou", email: null, ativo: 1, created_at: Date.now() },
        ] }),
      })
    })
    await page.route("**/admin/users", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, users: [{ name: "Já Registrou", createdAt: Date.now(), lastLoginAt: Date.now() }] }) })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    await expect(page.locator("tr", { hasText: "Já Registrou" }).getByText("Já acessou")).toBeVisible()
    await expect(page.locator("tr", { hasText: "Nunca Entrou" }).getByText("Aguardando 1º acesso")).toBeVisible()
    // Só quem já registrou ganha o botão de resetar senha.
    await expect(page.locator("tr", { hasText: "Já Registrou" }).getByRole("button", { name: "Resetar senha" })).toBeVisible()
    await expect(page.locator("tr", { hasText: "Nunca Entrou" }).getByRole("button", { name: "Resetar senha" })).not.toBeVisible()
  })

  test("editar e-mail: clica, digita, salva, chama a rota certa", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ solicitantes: [{ name: "Fulano Ativo", email: null, ativo: 1, created_at: Date.now() }] }) })
    })
    let posted: Record<string, unknown> | null = null
    await page.route(/\/admin\/solicitantes\/[^/]+\/email$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      posted = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    await page.getByRole("button", { name: "sem e-mail cadastrado" }).click()
    await page.locator("tr").getByPlaceholder("pessoa@institutosaovicente.com.br").fill("fulano@institutosaovicente.com.br")
    await page.getByRole("button", { name: "Salvar e-mail" }).click()
    await expect.poll(() => posted).toEqual({ email: "fulano@institutosaovicente.com.br" })
  })

  test("editar e-mail fora do domínio mostra o erro do servidor, sem fechar a edição", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ solicitantes: [{ name: "Fulano Ativo", email: null, ativo: 1, created_at: Date.now() }] }) })
    })
    await page.route(/\/admin\/solicitantes\/[^/]+\/email$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "e-mail precisa ser do domínio @institutosaovicente.com.br" }) })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    await page.getByRole("button", { name: "sem e-mail cadastrado" }).click()
    await page.locator("tr").getByPlaceholder("pessoa@institutosaovicente.com.br").fill("fulano@gmail.com")
    await page.getByRole("button", { name: "Salvar e-mail" }).click()
    await expect(page.getByText(/precisa ser do domínio/)).toBeVisible()
    await expect(page.locator("tr").getByPlaceholder("pessoa@institutosaovicente.com.br")).toBeVisible() // continua editando
  })

  test("resetar senha: confirma, chama a rota certa, mostra feedback", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ solicitantes: [{ name: "Já Registrou", email: "ja.registrou@institutosaovicente.com.br", ativo: 1, created_at: Date.now() }] }) })
    })
    await page.route("**/admin/users", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, users: [{ name: "Já Registrou", createdAt: Date.now(), lastLoginAt: Date.now() }] }) })
    })
    let called = false
    await page.route(/\/admin\/users\/[^/]+\/reset-senha$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      called = true
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    page.on("dialog", (d) => d.accept())
    await page.getByRole("button", { name: "Resetar senha" }).click()
    await expect.poll(() => called).toBe(true)
    await expect(page.getByText(/Senha de Já Registrou resetada/)).toBeVisible()
  })

  test("resetar senha: cancelar a confirmação não chama o servidor", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route("**/admin/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ solicitantes: [{ name: "Já Registrou", email: "ja.registrou@institutosaovicente.com.br", ativo: 1, created_at: Date.now() }] }) })
    })
    await page.route("**/admin/users", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, users: [{ name: "Já Registrou", createdAt: Date.now(), lastLoginAt: Date.now() }] }) })
    })
    let called = false
    await page.route(/\/admin\/users\/[^/]+\/reset-senha$/, (route) => { called = true; return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }) })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Usuários")
    page.on("dialog", (d) => d.dismiss())
    await page.getByRole("button", { name: "Resetar senha" }).click()
    await page.waitForTimeout(300)
    expect(called).toBe(false)
  })
})
