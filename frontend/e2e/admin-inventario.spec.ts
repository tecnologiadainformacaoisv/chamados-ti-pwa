import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn, abrirSecaoAdmin } from "./helpers/fixtures"

// Inventário de equipamentos (2026-11-23, ideia do estudo do OS800).
const equipamentos = () => [
  { id: "e1", tombamento: "F 0001", tipo: "impressora", marca: "Brother", modelo: "HL-1222", numero_serie: "SN-1", origem: "locado", fornecedor: "Locadora X", setor: 1, local: "Sala 3", status: "ativo", observacao: null, chamadosTotal: 3, chamadosAbertos: 1 },
  { id: "e2", tombamento: "F 0002", tipo: "monitor", marca: "BPC", modelo: "20WV", numero_serie: null, origem: "patrimonio", fornecedor: null, setor: 0, local: "Recepção", status: "manutencao", observacao: null, chamadosTotal: 0, chamadosAbertos: 0 },
  { id: "e3", tombamento: null, tipo: "computador", marca: "Dell", modelo: null, numero_serie: null, origem: "patrimonio", fornecedor: null, setor: null, local: null, status: "reserva", observacao: null, chamadosTotal: 1, chamadosAbertos: 0 },
]

async function abrir(page: import("@playwright/test").Page, lista = equipamentos()) {
  await mockAdminRoutes(page, { equipamentos: lista })
  await gotoAdminLoggedIn(page)
  await abrirSecaoAdmin(page, "Inventário")
}

test.describe("Inventário", () => {
  test("lista os equipamentos com situação, origem e chamados", async ({ page }) => {
    await abrir(page)
    await expect(page.getByText("3 equipamentos")).toBeVisible()
    const card = page.getByRole("button", { name: /F 0001/ })
    await expect(card).toContainText("Brother · HL-1222")
    await expect(card).toContainText("Locado · Locadora X")
    await expect(card).toContainText("1 chamado aberto · 3 no total")
    await expect(page.getByRole("button", { name: /F 0002/ })).toContainText("Em manutenção")
    await expect(page.getByRole("button", { name: /sem etiqueta/ })).toContainText("1 chamado no histórico")
  })

  test("busca ignora acento e os filtros combinam; 'só com chamado aberto' esconde o resto", async ({ page }) => {
    await abrir(page)
    await page.getByPlaceholder(/Buscar por tombamento/).fill("recepcao")
    await expect(page.getByText("1 de 3 equipamentos")).toBeVisible()
    await expect(page.getByRole("button", { name: /F 0002/ })).toBeVisible()
    await page.getByPlaceholder(/Buscar por tombamento/).fill("")
    await page.getByLabel("Só com chamado aberto").check()
    await expect(page.getByText("1 de 3 equipamentos")).toBeVisible()
    await expect(page.getByRole("button", { name: /F 0001/ })).toBeVisible()
    await page.getByPlaceholder(/Buscar por tombamento/).fill("zzzz")
    await expect(page.getByText("Nenhum equipamento com esses filtros.")).toBeVisible()
  })

  test("inventário vazio orienta o que fazer", async ({ page }) => {
    await abrir(page, [])
    await expect(page.getByText(/Nenhum equipamento cadastrado ainda/)).toBeVisible()
  })

  test("cadastrar: envia só o que foi preenchido e o tipo escolhido", async ({ page }) => {
    await abrir(page)
    let enviado: Record<string, unknown> | null = null
    await page.route(/\/admin\/equipamentos$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      enviado = route.request().postDataJSON()
      return route.fulfill({ status: 201, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ id: "novo" }) })
    })
    await page.getByRole("button", { name: "Novo equipamento" }).click()
    const dialogo = page.getByRole("dialog")
    await dialogo.getByLabel("Tombamento (etiqueta)").fill("F 0099")
    await dialogo.getByLabel("Marca").fill("Epson")
    await dialogo.getByRole("button", { name: "Salvar" }).click()
    await expect(dialogo).toHaveCount(0)
    expect(enviado).toMatchObject({ tombamento: "F 0099", marca: "Epson", tipo: "impressora", origem: "patrimonio", status: "ativo", modelo: null, fornecedor: null, setor: null })
  })

  test("erro do servidor (tombamento repetido) aparece no formulário e ele fica aberto", async ({ page }) => {
    await abrir(page)
    await page.route(/\/admin\/equipamentos$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 409, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "já existe um equipamento com esse tombamento" }) })
    })
    await page.getByRole("button", { name: "Novo equipamento" }).click()
    const dialogo = page.getByRole("dialog")
    await dialogo.getByLabel("Tombamento (etiqueta)").fill("F 0001")
    await dialogo.getByRole("button", { name: "Salvar" }).click()
    await expect(dialogo.getByRole("alert")).toContainText("já existe um equipamento com esse tombamento")
  })

  test("editar abre preenchido e 'Remover da lista' pede confirmação e manda ativo:false", async ({ page }) => {
    await abrir(page)
    let enviado: Record<string, unknown> | null = null
    await page.route(/\/admin\/equipamentos\/e1$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      enviado = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true }) })
    })
    await page.getByRole("button", { name: /F 0001/ }).click()
    const dialogo = page.getByRole("dialog")
    await expect(dialogo.getByLabel("Tombamento (etiqueta)")).toHaveValue("F 0001")
    await expect(dialogo.getByLabel("Fornecedor")).toHaveValue("Locadora X")
    page.once("dialog", (d) => d.dismiss())
    await dialogo.getByRole("button", { name: "Remover da lista" }).click()
    expect(enviado).toBeNull()
    page.once("dialog", (d) => d.accept())
    await dialogo.getByRole("button", { name: "Remover da lista" }).click()
    await expect(dialogo).toHaveCount(0)
    expect(enviado).toMatchObject({ ativo: false })
  })
})
