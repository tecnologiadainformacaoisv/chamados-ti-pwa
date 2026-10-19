import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

// Fase 2 do redesign de UX (2026-10-19): "Linha do dia" na Gestão. Só desktop: no celular ela começa
// recolhida e a régua rola na horizontal.
const MIN = 60_000

test.describe("Gestão — linha do dia", () => {
  test.beforeEach(async ({ page }, info) => {
    void page
    test.skip(info.project.name === "mobile", "no celular a linha do dia começa recolhida")
  })

  const tarefas = () => [
    makeTask({ id: "a1", name: "Impressora parada", status: { status: "aberto" }, priority: { priority: "urgent" }, due_date: Date.now() - 10 * MIN }),
    makeTask({ id: "b1", name: "Instalar programa", status: { status: "em atendimento" }, priority: { priority: "high" }, due_date: Date.now() + 90 * MIN }),
    makeTask({ id: "z1", name: "Chamado já encerrado", status: { status: "encerrado" }, due_date: Date.now() + 30 * MIN }),
  ]

  test("mostra só chamados em andamento, o 'agora' e o resumo", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page, undefined, true)
    const linha = page.getByRole("region", { name: "Linha do dia" })
    await expect(linha).toBeVisible()
    await expect(linha.getByText("2 em andamento, 1 atrasado")).toBeVisible()
    await expect(linha.locator('[data-barra-id="a1"]')).toHaveAttribute("data-atrasado", "sim")
    await expect(linha.locator('[data-barra-id="b1"]')).toHaveAttribute("data-atrasado", "nao")
    await expect(linha.locator('[data-barra-id="z1"]')).toHaveCount(0)
    // o "agora" só aparece dentro do expediente (08h às 18h); fora dele a régua avisa
    const h = new Date().getHours()
    if (h >= 8 && h < 18) await expect(linha.getByTestId("agora")).toHaveCount(1)
    else {
      await expect(linha.getByTestId("agora")).toHaveCount(0)
      await expect(linha.getByText(/Fora do expediente/)).toBeVisible()
    }
  })

  test("clicar na barra abre o chamado", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page, undefined, true)
    await page.locator('[data-barra-id="b1"]').click()
    await expect(page.getByRole("dialog")).toContainText("Instalar programa")
  })

  test("recolher e expandir lembra a escolha", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page, undefined, true)
    const botao = page.getByRole("button", { name: /Linha do dia/ })
    await expect(botao).toHaveAttribute("aria-expanded", "true")
    await botao.click()
    await expect(botao).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator('[data-barra-id="a1"]')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole("button", { name: /Linha do dia/ })).toHaveAttribute("aria-expanded", "false")
  })

  test("sem prazo aparece numa lista à parte, sem quebrar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "s1", name: "Sem prazo ainda", status: { status: "aberto" }, due_date: null })] })
    await gotoAdminLoggedIn(page, undefined, true)
    const linha = page.getByRole("region", { name: "Linha do dia" })
    await expect(linha.getByText("Sem prazo definido (1):")).toBeVisible()
    await linha.getByRole("button", { name: "Sem prazo ainda" }).click()
    await expect(page.getByRole("dialog")).toContainText("Sem prazo ainda")
  })
})
