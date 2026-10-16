import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

// Login por e-mail (2026-09-16, pedido da diretoria: "não quer usuários vendo
// chamados de outros usuários") — substitui o <Select> de escolher o próprio nome
// numa lista. `#setup-email` (Input) no lugar de `[data-slot="select-trigger"]`.
test.describe("Login/cadastro do solicitante", () => {
  // Validação em português dentro da página (revisão de UX, 2026-10-16): o formulário usa
  // noValidate, então o balão nativo do navegador (em inglês, some sozinho) não aparece.
  test("mostra erro se tentar entrar sem e-mail/senha", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByText("Digite seu e-mail completo, por exemplo nome@institutosaovicente.com.br.")).toBeVisible()
  })

  test("e-mail incompleto e senha vazia mostram a orientação certa e levam o foco ao campo, sem chamar o servidor", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    let chamouLogin = false
    await page.route("**/auth/login", (route) => { chamouLogin = true; return route.fallback() })
    await page.goto("/")

    await page.locator("#setup-email").fill("fulano@")
    await page.locator("#setup-password").fill("senha12345")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByText("Digite seu e-mail completo")).toBeVisible()
    await expect(page.locator("#setup-email")).toBeFocused()

    await page.locator("#setup-email").fill("fulano@institutosaovicente.com.br")
    await page.locator("#setup-password").fill("")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByText("Digite sua senha.")).toBeVisible()
    await expect(page.locator("#setup-password")).toBeFocused()
    expect(chamouLogin).toBe(false)
  })

  // O mínimo de 8 caracteres vale pra CRIAR a senha (cadastro externo). No login normal
  // só se exige senha preenchida — quem já tem conta com senha antiga curta não fica
  // trancado fora; no primeiro acesso o servidor devolve a mensagem do mínimo.
  test("cadastro externo: senha com menos de 8 caracteres mostra a orientação, sem chamar o servidor", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    let chamouCadastro = false
    await page.route("**/auth/register-externo", (route) => { chamouCadastro = true; return route.fallback() })
    await page.goto("/")
    await page.getByRole("button", { name: "Não tenho e-mail institucional (visitante, parceiro ou fornecedor)" }).click()
    await page.locator("#setup-ext-name").fill("Maria da Silva")
    await page.locator("#setup-ext-email").fill("maria@email.com")
    await page.locator("#setup-ext-password").fill("curta")
    await page.getByRole("button", { name: "Cadastrar e entrar" }).click()
    await expect(page.getByText("A senha precisa ter pelo menos 8 caracteres.")).toBeVisible()
    expect(chamouCadastro).toBe(false)
  })

  test("login: senha antiga mais curta que 8 caracteres ainda chega ao servidor (não tranca quem já tem conta)", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    let senhaEnviada = ""
    await page.route("**/auth/login", (route) => {
      senhaEnviada = (route.request().postDataJSON() as { password?: string }).password ?? ""
      return route.fallback()
    })
    await page.goto("/")
    await page.locator("#setup-email").fill("fulano@institutosaovicente.com.br")
    await page.locator("#setup-password").fill("antiga1")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
    expect(senhaEnviada).toBe("antiga1")
  })

  test("o olho mostra e esconde a senha digitada (confere antes do primeiro acesso)", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    const campo = page.locator("#setup-password")
    await campo.fill("minhaSenha123")
    await expect(campo).toHaveAttribute("type", "password")
    await page.getByRole("button", { name: "Mostrar senha" }).click()
    await expect(campo).toHaveAttribute("type", "text")
    await page.getByRole("button", { name: "Esconder senha" }).click()
    await expect(campo).toHaveAttribute("type", "password")
    await expect(page.getByText("Primeiro acesso?")).toBeVisible()
  })

  test("enquanto o boot carrega, mostra 'Carregando…' em vez do formulário de login", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    // atrasa a lista de solicitantes (o boot depende dela) pra dar tempo de ver a tela de espera
    await page.route("**/api/solicitantes", async (route) => {
      await new Promise((r) => setTimeout(r, 1500))
      return route.fallback()
    })
    await page.goto("/")
    await expect(page.getByText("Carregando…")).toBeVisible()
    await expect(page.locator("#setup-email")).toHaveCount(0)
    await expect(page.locator("#setup-email")).toBeVisible({ timeout: 10_000 })
  })

  test("erro de boot mostra orientação em português, não o erro técnico", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/api/solicitantes", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }))
    await page.goto("/")
    await expect(page.getByText("Não foi possível conectar ao sistema.")).toBeVisible()
    await expect(page.getByText("Se continuar, fale com a TI.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Tentar de novo" })).toBeVisible()
  })

  test("primeiro acesso: login 404 cai pra registro automático", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    // Sobrescreve /auth/login pra simular "sem senha cadastrada" (404) — loginOrRegister
    // deve cair sozinho pro /auth/register (já mockado com sucesso pelos defaults).
    await page.route("**/auth/login", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }))
    await page.goto("/")

    await page.locator("#setup-email").fill("fulano@institutosaovicente.com.br")
    await page.locator("#setup-password").fill("senha12345")
    await page.getByRole("button", { name: "Entrar" }).click()

    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem("session_token"))).toBe("fake-session-token")
  })

  test("login normal entra direto na tela principal", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await page.locator("#setup-email").fill("ciclana@institutosaovicente.com.br")
    await page.locator("#setup-password").fill("senha12345")
    await page.getByRole("button", { name: "Entrar" }).click()
    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
  })

  test("senha errada mostra o erro devolvido pelo servidor", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/auth/login", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Senha incorreta." }) }))
    await page.goto("/")
    await page.locator("#setup-email").fill("fulano@institutosaovicente.com.br")
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
    await expect(page.locator("#setup-email")).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem("session_token"))).toBeNull()
  })

  test("cadastro externo: aparece o link, alterna pro formulário e volta pro normal", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await page.getByRole("button", { name: "Não tenho e-mail institucional (visitante, parceiro ou fornecedor)" }).click()
    await expect(page.locator("#setup-ext-name")).toBeVisible()
    await expect(page.locator("#setup-email")).not.toBeVisible()

    await page.getByRole("button", { name: /Tenho e-mail institucional/ }).click()
    await expect(page.locator("#setup-email")).toBeVisible()
    await expect(page.locator("#setup-ext-name")).not.toBeVisible()
  })

  test("cadastro externo: valida nome completo antes de enviar", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await page.getByRole("button", { name: "Não tenho e-mail institucional (visitante, parceiro ou fornecedor)" }).click()
    await page.locator("#setup-ext-name").fill("SóUmNome")
    await page.locator("#setup-ext-email").fill("visitante@gmail.com")
    await page.locator("#setup-ext-password").fill("senha12345")
    await page.getByRole("button", { name: "Cadastrar e entrar" }).click()
    await expect(page.getByText("Digite seu nome completo (nome e sobrenome)")).toBeVisible()
  })

  test("cadastro externo: preenche tudo (com telefone) e entra na tela principal", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await page.getByRole("button", { name: "Não tenho e-mail institucional (visitante, parceiro ou fornecedor)" }).click()
    await page.locator("#setup-ext-name").fill("Fornecedor Externo")
    await page.locator("#setup-ext-email").fill("fornecedor@gmail.com")
    await page.locator("#setup-ext-telefone").fill("85999998888")
    await page.locator("#setup-ext-password").fill("senha12345")
    await page.getByRole("button", { name: "Cadastrar e entrar" }).click()
    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
    await expect(page.getByText("Fornecedor Externo").first()).toBeVisible()
  })

  test("cadastro externo: erro do servidor (ex.: e-mail institucional) aparece no formulário", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/auth/register-externo", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "E-mail institucional detectado — use a tela de entrada normal, não o cadastro externo" }) })
    )
    await page.goto("/")
    await page.getByRole("button", { name: "Não tenho e-mail institucional (visitante, parceiro ou fornecedor)" }).click()
    await page.locator("#setup-ext-name").fill("Pessoa Falsa Interna")
    await page.locator("#setup-ext-email").fill("falso@institutosaovicente.com.br")
    await page.locator("#setup-ext-password").fill("senha12345")
    await page.getByRole("button", { name: "Cadastrar e entrar" }).click()
    await expect(page.getByText(/use a tela de entrada normal/)).toBeVisible()
  })

  test("erro ao carregar lista de solicitantes mostra tela de boot-error com retry", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    // Registrado DEPOIS dos defaults — tem prioridade (LIFO), sobrescreve só este endpoint.
    // A lista de nomes ainda é buscada no boot (usada só pra validar sessão salva, ver
    // use-session-auth.tsx) — deixou de alimentar um <Select>, mas o boot-error nesse
    // cenário continua valendo.
    await page.route("**/api/solicitantes", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
    })
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Tentar de novo" })).toBeVisible()
  })
})
