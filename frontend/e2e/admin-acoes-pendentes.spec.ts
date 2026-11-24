import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

// "O que atacar agora" (2026-11-23, ideia vinda do estudo do OS800): contagens clicáveis no topo da Gestão.
const MIN = 60_000
const DIA = 24 * 60 * MIN

test.describe("Gestão — O que atacar agora", () => {
  const tarefas = () => [
    makeTask({ id: "atr", name: "Atrasado com atendente", status: { status: "aberto" }, due_date: Date.now() - 10 * MIN, assignees: [{ id: 200498355 }] }),
    makeTask({ id: "logo", name: "Vence logo", status: { status: "em atendimento" }, due_date: Date.now() + 5 * MIN, assignees: [{ id: 170628721 }] }),
    makeTask({ id: "sem", name: "Aberto sem ninguem", status: { status: "aberto" }, due_date: Date.now() + 5 * 60 * MIN, assignees: [] }),
    makeTask({ id: "velho", name: "Pendente antigo", status: { status: "pendente" }, due_date: Date.now() - 9 * DIA, date_updated: Date.now() - 5 * DIA, assignees: [{ id: 170628721 }] }),
    makeTask({ id: "novo", name: "Pendente recente", status: { status: "pendente" }, date_updated: Date.now() - 2 * 60 * MIN, assignees: [{ id: 170628721 }] }),
    makeTask({ id: "fim", name: "Encerrado", status: { status: "encerrado" }, due_date: Date.now() - 2 * DIA, date_closed: Date.now() - DIA }),
  ]

  async function abrir(page: import("@playwright/test").Page, tasks = tarefas()) {
    await mockAdminRoutes(page, { tasks })
    await gotoAdminLoggedIn(page, undefined, false, "fila")
  }

  test("conta só o que importa: pendente e encerrado nunca contam como atrasado", async ({ page }) => {
    await abrir(page)
    const bloco = page.getByRole("region", { name: "Ações pendentes" })
    await expect(bloco).toContainText("1 chamado passou do prazo")
    await expect(bloco).toContainText("1 vence nos próximos minutos")
    await expect(bloco).toContainText("1 aberto sem atendente")
    await expect(bloco).toContainText("1 em espera há mais de 3 dias")
  })

  test("clicar numa linha filtra a lista e clicar de novo limpa", async ({ page }) => {
    await abrir(page)
    const bloco = page.getByRole("region", { name: "Ações pendentes" })
    const fila = page.getByRole("region", { name: "Fila de atendimento" })
    await bloco.getByRole("button", { name: /aberto sem atendente/ }).click()
    await expect(fila.locator('[data-task-id="sem"]')).toBeVisible()
    await expect(fila.locator('[data-task-id="atr"]')).toHaveCount(0)
    await bloco.getByRole("button", { name: /aberto sem atendente/ }).click()
    await expect(fila.locator('[data-task-id="atr"]')).toBeVisible()
  })

  test("sem nada atrasado mostra a mensagem tranquila", async ({ page }) => {
    await abrir(page, [makeTask({ id: "ok", name: "Tudo certo", status: { status: "em atendimento" }, due_date: Date.now() + 5 * 60 * MIN, assignees: [{ id: 200498355 }] })])
    await expect(page.getByRole("region", { name: "Ações pendentes" })).toContainText("Nada atrasado nem largado")
  })
})
