import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

// Tela inicial do painel no celular e título do chamado na Fila (pedidos do usuário, 2026-11-26).
const MIN = 60_000
const LONGO = "A impressora da recepção não imprime nenhum documento desde cedo e fica piscando uma luz vermelha"

const tarefas = () => [
  makeTask({ id: "a1", name: "Impressora parada", status: { status: "aberto" }, due_date: Date.now() - 10 * MIN }),
  makeTask({ id: "a2", name: "Sem internet", status: { status: "aberto" }, due_date: Date.now() + 120 * MIN }),
  makeTask({ id: "b1", name: "Instalar programa", status: { status: "em atendimento" }, due_date: Date.now() + 60 * MIN }),
  makeTask({ id: "p1", name: "Aguardando fornecedor", status: { status: "pendente" } }),
]

async function abrir(page: import("@playwright/test").Page, tasks = tarefas()) {
  await mockAdminRoutes(page, { tasks })
  await gotoAdminLoggedIn(page, undefined, false, "fila", true)
}

test.describe("Tela inicial (celular)", () => {
  test.skip(({ isMobile }) => !isMobile, "só no celular")

  test("mostra os quatro números e tocar num deles abre a lista filtrada", async ({ page }) => {
    await abrir(page)
    const inicio = page.getByRole("region", { name: "Tela inicial" })
    await expect(inicio.getByRole("button", { name: "2 aguardando aceite" })).toBeVisible()
    await expect(inicio.getByRole("button", { name: "1 passaram do prazo" })).toBeVisible()
    await expect(inicio.getByRole("button", { name: "1 em atendimento" })).toBeVisible()
    await inicio.getByRole("button", { name: "1 em espera" }).click()
    const fila = page.getByRole("region", { name: "Fila de atendimento" })
    await expect(fila).toContainText("Aguardando fornecedor")
    await expect(fila).not.toContainText("Sem internet")
    await page.getByRole("button", { name: "Remover filtro: Em espera" }).click()
    await expect(fila).toContainText("Sem internet")
    await expect(page.getByRole("region", { name: "Ações pendentes" })).toHaveCount(0)
  })

  test("aparece uma vez por entrada: recarregar não mostra de novo", async ({ page }) => {
    await abrir(page)
    await page.getByRole("button", { name: "Ver chamados" }).click()
    await expect(page.getByRole("region", { name: "Fila de atendimento" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("region", { name: "Fila de atendimento" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Tela inicial" })).toHaveCount(0)
  })

  test("aberto por uma notificação vai direto para a lista", async ({ page }) => {
    await abrir(page)
    await expect(page.getByRole("region", { name: "Tela inicial" })).toBeVisible()
    await page.goto("/admin.html#aviso")
    await page.reload()
    await expect(page.getByRole("region", { name: "Fila de atendimento" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Tela inicial" })).toHaveCount(0)
  })

  test("o sino fecha a tela inicial", async ({ page }) => {
    await abrir(page)
    await expect(page.getByRole("region", { name: "Tela inicial" })).toBeVisible()
    await page.getByRole("button", { name: /Ver chamados abertos/ }).click()
    await expect(page.getByRole("region", { name: "Fila de atendimento" })).toBeVisible()
  })

  test("sem nada esperando, diz que está tudo em dia", async ({ page }) => {
    await abrir(page, [makeTask({ id: "f", name: "Fechado", status: { status: "encerrado" }, date_closed: Date.now() - MIN })])
    await expect(page.getByText("Tudo em dia")).toBeVisible()
    await expect(page.getByRole("button", { name: "Ver chamados" })).toBeVisible()
  })
})

test.describe("Computador não muda e o título aparece", () => {
  test("no computador não há tela inicial", async ({ page, isMobile }) => {
    test.skip(isMobile, "regra do computador")
    await abrir(page)
    await expect(page.getByRole("region", { name: "Fila de atendimento" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Tela inicial" })).toHaveCount(0)
  })

  test("estreitar a janela do computador não faz a tela inicial aparecer", async ({ page, isMobile }) => {
    test.skip(isMobile, "regra do computador")
    await abrir(page)
    await expect(page.getByRole("region", { name: "Fila de atendimento" })).toBeVisible()
    await page.setViewportSize({ width: 600, height: 800 })
    await expect(page.getByRole("group", { name: "Modo de visualização" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Tela inicial" })).toHaveCount(0)
  })

  test("título comprido continua visível na linha, depois do número", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "l1", name: LONGO, numero: 142, status: { status: "aberto" } })] })
    await gotoAdminLoggedIn(page, undefined, false, "fila")
    const titulo = page.locator('[data-task-id="l1"] button[aria-expanded]')
    await expect(titulo).toBeVisible()
    const caixa = await titulo.boundingBox()
    const linha = await page.locator('[data-task-id="l1"]').boundingBox()
    expect(caixa!.width).toBeGreaterThan(150)
    expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(linha!.x + linha!.width + 1)
  })
})
