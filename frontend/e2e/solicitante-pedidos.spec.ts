import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

// Solicitações (2026-11-25, ideia do estudo do OS800): aba "Pedidos" do app do solicitante.
const base = { quantidade: 1, setor: null, nota_ti: null, motivo_rejeicao: null, created_at: Date.now() - 3600000, updated_at: Date.now() - 1800000, solicitante: "Fulano de Tal" }
const pedidos = () => [
  { ...base, id: "s1", numero: 3, categoria: "equipamento", item: "Mouse sem fio", justificativa: "O meu quebrou", status: "em_transito", nota_ti: "Chega na sexta" },
  { ...base, id: "s2", numero: 2, categoria: "material", item: "Cabo HDMI", justificativa: "Sala de reunião", status: "rejeitado", motivo_rejeicao: "Já temos em estoque, procure a recepção" },
  { ...base, id: "s3", numero: 1, categoria: "peca", item: "Fonte do computador", justificativa: "Não liga", status: "entregue" },
]

test.describe("Pedidos (solicitante)", () => {
  test("lista os pedidos com andamento, recado da TI e motivo da rejeição", async ({ page }) => {
    await mockSolicitanteRoutes(page, { solicitacoes: pedidos() })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Pedidos/ }).click()
    const a = page.locator('[data-solicitacao-id="s1"]')
    await expect(a).toContainText("Mouse sem fio")
    await expect(a).toContainText("Recado da TI: Chega na sexta")
    await expect(a.getByRole("list", { name: /etapa 4 de 5, A caminho/ })).toBeVisible()
    await expect(page.locator('[data-solicitacao-id="s2"]')).toContainText("Já temos em estoque")
    // o solicitante não vê botões de ação da TI
    await expect(page.getByRole("button", { name: "Aprovar" })).toHaveCount(0)
  })

  test("o filtro de categoria e de situação esconde o resto", async ({ page }) => {
    await mockSolicitanteRoutes(page, { solicitacoes: pedidos() })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Pedidos/ }).click()
    await page.getByRole("tab", { name: /Materiais/ }).click()
    await expect(page.locator("[data-solicitacao-id]")).toHaveCount(1)
    await expect(page.locator('[data-solicitacao-id="s2"]')).toBeVisible()
  })

  test("sem pedidos mostra o convite e envia uma nova solicitação", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    const corpos: Record<string, unknown>[] = []
    await page.route("**/api/solicitacoes", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      corpos.push(route.request().postDataJSON())
      return route.fulfill({ status: 201, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ id: "n1", numero: 1 }) })
    })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Pedidos/ }).click()
    await expect(page.getByText(/Você ainda não fez nenhuma solicitação/)).toBeVisible()
    await page.getByRole("button", { name: "Nova solicitação" }).click()
    const d = page.getByRole("dialog")

    // enviar vazio diz o que falta e não chama o servidor
    await d.getByRole("button", { name: "Enviar pedido" }).click()
    await expect(d.getByRole("alert")).toContainText("Falta preencher: o que você precisa, o item, para quê.")
    expect(corpos).toHaveLength(0)

    await d.getByLabel(/O que você precisa/).click()
    await page.getByRole("option", { name: "Peça" }).click()
    await d.getByLabel(/Item/).fill("  Fonte 500W  ")
    await d.getByLabel("Qtde").fill("2")
    await d.getByLabel(/Para quê/).fill("A atual queimou")
    await d.getByRole("button", { name: "Enviar pedido" }).click()

    await expect(page.getByRole("status")).toContainText("Pedido #0001 enviado")
    expect(corpos).toEqual([{ categoria: "peca", item: "Fonte 500W", quantidade: 2, justificativa: "A atual queimou" }])
  })

  test("erro do servidor aparece no formulário e o pedido não some", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/api/solicitacoes", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 429, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "Você já tem 20 pedidos em andamento." }) })
    })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Pedidos/ }).click()
    await page.getByRole("button", { name: "Nova solicitação" }).click()
    const d = page.getByRole("dialog")
    await d.getByLabel(/O que você precisa/).click()
    await page.getByRole("option", { name: "Material" }).click()
    await d.getByLabel(/Item/).fill("Papel")
    await d.getByLabel(/Para quê/).fill("Acabou")
    await d.getByRole("button", { name: "Enviar pedido" }).click()
    await expect(d.getByRole("alert")).toContainText("20 pedidos")
    await expect(d).toBeVisible()
  })

  test("conta externa não vê a aba Pedidos", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/api/solicitacoes", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 403, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "Solicitações são para as pessoas da instituição." }) })
        : route.fallback(),
    )
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByRole("tab", { name: /Meus Chamados/ })).toBeVisible()
    await expect(page.getByRole("tab", { name: /Pedidos/ })).toHaveCount(0)
  })
})
