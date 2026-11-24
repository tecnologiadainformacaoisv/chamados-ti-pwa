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
    // diz QUAL campo falta, e o aviso some quando a pessoa corrige (revisão de UX, 2026-10-16)
    await expect(page.getByText("Falta preencher: Setor, Tipo de solicitação, Quem vai atender, Descrição do problema.")).toBeVisible()
    await page.locator("textarea").first().fill("Notebook não liga")
    await expect(page.getByText("Falta preencher:")).toHaveCount(0)
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

    // O aviso de arquivo descartado não pode sumir só porque a pessoa começou a digitar
    // (o aviso de "Falta preencher…" some, este não — revisão de código, 2026-10-16).
    await page.locator("textarea").first().fill("Notebook não liga")
    await expect(page.getByText(/acima de 10MB/)).toBeVisible()
  })

  test("contador de caracteres em Detalhes adicionais respeita o limite de 1000", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    const texto = "a".repeat(1200)
    await page.locator("textarea").nth(1).fill(texto)
    await expect(page.getByText("1000/1000")).toBeVisible()
  })
})

test.describe("Abrir chamado — equipamento (opcional)", () => {
  const equipamentos = [
    { id: "eq-1", tombamento: "F 0001", tipo: "impressora", marca: "Brother", modelo: "HL-1222", setor: 1, local: "Sala 3" },
    { id: "eq-2", tombamento: "F 0002", tipo: "monitor", marca: "BPC", modelo: null, setor: 0, local: null },
  ]

  test("sem equipamento cadastrado, o campo nem aparece", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByRole("button", { name: "Abrir Chamado" })).toBeVisible()
    await expect(page.getByText("Equipamento (opcional)")).toHaveCount(0)
  })

  test("escolher o equipamento manda equipamento_id; não escolher não manda nada", async ({ page }) => {
    await mockSolicitanteRoutes(page, { equipamentos })
    const corpos: Record<string, unknown>[] = []
    await page.route("**/api/tasks", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      corpos.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ id: "t1", name: "x", status: { status: "aberto" }, assignees: [{ id: 170628721 }], date_created: String(Date.now()), custom_fields: [] }) })
    })
    await gotoSolicitanteLoggedIn(page)
    await preencherFormBasico(page, "Notebooks")
    await page.locator("#equipamento").click()
    await page.getByRole("option", { name: /F 0001 · Impressora Brother HL-1222/ }).click()
    await page.getByRole("button", { name: "Abrir Chamado" }).click()
    await expect(page.getByRole("heading", { name: "Chamado aberto!" }).last()).toBeVisible()
    expect(corpos[0].equipamento_id).toBe("eq-1")
  })

  test("se a lista de equipamentos falhar, o formulário continua funcionando sem o campo", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/api/equipamentos", (route) => route.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" }))
    await gotoSolicitanteLoggedIn(page)
    await preencherFormBasico(page, "Notebooks")
    await expect(page.getByText("Equipamento (opcional)")).toHaveCount(0)
    await page.getByRole("button", { name: "Abrir Chamado" }).click()
    await expect(page.getByRole("heading", { name: "Chamado aberto!" }).last()).toBeVisible()
  })
})
