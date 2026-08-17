import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

async function preencherFormBasico(page: import("@playwright/test").Page, tipoLabel: string) {
  // Setor
  await page.locator('[data-slot="select-trigger"]').nth(0).click()
  await page.getByRole("option", { name: "Administrativo" }).click()
  // Tipo
  await page.locator('[data-slot="select-trigger"]').nth(1).click()
  await page.getByRole("option", { name: new RegExp(tipoLabel) }).click()
  // Operador
  await page.getByRole("radio").first().click()
  // Descrição
  await page.locator("textarea").first().fill("Notebook não liga de jeito nenhum")
}

test.describe("Abrir chamado", () => {
  test("valida campos obrigatórios antes de enviar", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Abrir Chamado" }).click()
    await expect(page.getByText("Preencha todos os campos obrigatórios")).toBeVisible()
  })

  test("cria chamado e mostra SLA correto pro tipo Urgente (Notebooks)", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await preencherFormBasico(page, "Notebooks")
    await page.getByRole("button", { name: "Abrir Chamado" }).click()

    await expect(page.getByRole("heading", { name: "Chamado aberto!" }).last()).toBeVisible()
    // Notebooks (orderindex 0) -> CATEGORIA_PRIORIDADE[0] = 1 (Urgente) -> slaLabel "1 hora"
    await expect(page.getByText("Prazo de atendimento: 1 hora")).toBeVisible()
  })

  test("tipo Design mostra SLA de 24 horas (prioridade Normal)", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await preencherFormBasico(page, "Design")
    await page.getByRole("button", { name: "Abrir Chamado" }).click()
    await expect(page.getByText("Prazo de atendimento: 24 horas")).toBeVisible()
  })

  test("fechar o modal do WhatsApp volta pra aba Meus Chamados", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await preencherFormBasico(page, "Notebooks")
    await page.getByRole("button", { name: "Abrir Chamado" }).click()
    await expect(page.getByRole("heading", { name: "Chamado aberto!" }).last()).toBeVisible()
    await page.getByRole("button", { name: "Fechar" }).click()
    await expect(page.getByRole("heading", { name: "Chamado aberto!" }).last()).not.toBeVisible()
    await expect(page.getByRole("tab", { name: /Meus Chamados/ })).toHaveAttribute("aria-selected", "true")
  })

  test("erro do servidor ao criar chamado aparece no formulário", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/api/tasks", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Erro interno." }) })
    })
    await gotoSolicitanteLoggedIn(page)
    await preencherFormBasico(page, "Notebooks")
    await page.getByRole("button", { name: "Abrir Chamado" }).click()
    await expect(page.getByText("Erro interno.")).toBeVisible()
  })

  test("anexo maior que 10MB é rejeitado no cliente, sem chamar upload", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    let uploadCalled = false
    await page.route("**/api/tasks/*/attachment", (route) => {
      uploadCalled = true
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await gotoSolicitanteLoggedIn(page)

    const bigFile = {
      name: "grande.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(11 * 1024 * 1024, 1),
    }
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Escolher arquivo" }).click(),
    ])
    await chooser.setFiles(bigFile)

    await expect(page.getByText(/acima de 10MB/)).toBeVisible()
    expect(uploadCalled).toBe(false)
  })

  test("contador de caracteres em Detalhes adicionais respeita o limite de 1000", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    const texto = "a".repeat(1200)
    await page.locator("textarea").nth(1).fill(texto)
    await expect(page.getByText("1000/1000")).toBeVisible()
  })
})
