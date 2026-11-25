import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn, abrirSecaoAdmin } from "./helpers/fixtures"

// Solicitações (2026-11-25, ideia do estudo do OS800): fila da TI, 5 etapas.
const base = { quantidade: 1, setor: null, nota_ti: null, motivo_rejeicao: null, created_at: Date.now() - 3600000, updated_at: Date.now() - 1800000 }
const lista = () => [
  { ...base, id: "a1", numero: 2, categoria: "equipamento", item: "Monitor 24", justificativa: "Tela rachada", solicitante: "Ana Lima", status: "pendente" },
  { ...base, id: "a2", numero: 1, categoria: "material", item: "Cabo HDMI", justificativa: "Reunião", solicitante: "Joana Alves", status: "aprovado" },
]

async function abrir(page: import("@playwright/test").Page) {
  await mockAdminRoutes(page, { solicitacoes: lista() })
  await gotoAdminLoggedIn(page)
  await abrirSecaoAdmin(page, "Solicitações")
}

test.describe("Solicitações (admin)", () => {
  test("mostra os pedidos com o nome de quem pediu e só as ações permitidas", async ({ page }) => {
    await abrir(page)
    const a1 = page.locator('[data-solicitacao-id="a1"]')
    await expect(a1).toContainText("Monitor 24")
    await expect(a1).toContainText("Ana Lima")
    await expect(a1.getByRole("button", { name: "Começar análise" })).toBeVisible()
    await expect(a1.getByRole("button", { name: "Aprovar" })).toHaveCount(0)
    const a2 = page.locator('[data-solicitacao-id="a2"]')
    await expect(a2.getByRole("button", { name: "Marcar a caminho" })).toBeVisible()
  })

  test("mudar de etapa envia o status certo", async ({ page }) => {
    await abrir(page)
    const corpos: Record<string, unknown>[] = []
    await page.route("**/admin/solicitacoes/a1/status", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      corpos.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true }) })
    })
    await page.locator('[data-solicitacao-id="a1"]').getByRole("button", { name: "Começar análise" }).click()
    await expect.poll(() => corpos.length).toBe(1)
    expect(corpos[0]).toMatchObject({ status: "em_analise" })
  })

  test("rejeitar exige o motivo: cancelar o aviso não envia nada, com motivo envia", async ({ page }) => {
    await abrir(page)
    const corpos: Record<string, unknown>[] = []
    await page.route("**/admin/solicitacoes/a1/status", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      corpos.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true }) })
    })
    const botao = page.locator('[data-solicitacao-id="a1"]').getByRole("button", { name: /Rejeitar/ })
    page.once("dialog", (d) => d.dismiss())
    await botao.click()
    await page.waitForTimeout(300)
    expect(corpos).toHaveLength(0)

    page.once("dialog", (d) => d.accept("Já temos em estoque"))
    await botao.click()
    await expect.poll(() => corpos.length).toBe(1)
    expect(corpos[0]).toMatchObject({ status: "rejeitado" })
    expect(JSON.stringify(corpos[0])).toContain("Já temos em estoque")
  })

  test("a barra lateral mostra quantos pedidos esperam resposta", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "no celular a barra lateral é uma gaveta fechada")
    await abrir(page)
    await expect(page.getByRole("button", { name: /Solicitações\s*,\s*1 esperando resposta/ })).toBeVisible()
  })
})
