import { test, expect } from "@playwright/test"
import { abrirSecaoAdmin, gotoAdminLoggedIn, mockAdminRoutes } from "./helpers/fixtures"
import { makeMetrics } from "./helpers/mock-data"

test.describe("Relatório mensal", () => {
  test("abre o mês fechado, em horário de Fortaleza, e na impressão sai só a folha", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-25T12:00:00-03:00"))
    await mockAdminRoutes(page, { metrics: makeMetrics({ total: 37 }) })
    const periodos: string[] = []
    page.on("request", (r) => {
      const u = new URL(r.url())
      if (u.pathname.endsWith("/admin/metrics") && u.searchParams.get("desde")) periodos.push(`${u.searchParams.get("desde")}-${u.searchParams.get("ate")}`)
    })
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await page.getByRole("button", { name: "Abrir relatório" }).click()

    const folha = page.getByRole("dialog", { name: "Relatório de outubro de 2026" })
    await expect(folha).toBeVisible()
    await expect(folha.getByRole("row", { name: /Chamados abertos no mês 37 37/ })).toBeVisible()
    await expect(folha.getByText("ninguém respondeu neste mês")).toBeVisible()
    expect(periodos).toContain(`${Date.parse("2026-10-01T00:00:00-03:00")}-${Date.parse("2026-11-01T00:00:00-03:00") - 1}`)
    expect(periodos).toContain(`${Date.parse("2026-09-01T00:00:00-03:00")}-${Date.parse("2026-10-01T00:00:00-03:00") - 1}`)

    await page.evaluate(() => { window.print = () => { document.body.dataset.imprimiu = document.title } })
    await folha.getByRole("button", { name: "Salvar em PDF" }).click()
    await expect(page.locator("body")).toHaveAttribute("data-imprimiu", "Relatorio-TI-2026-10")

    await page.emulateMedia({ media: "print" })
    await expect(page.locator("#root")).toBeHidden()
    await expect(folha.getByRole("button", { name: "Salvar em PDF" })).toBeHidden()
    await expect(folha.getByRole("heading", { name: /Relatório da TI/ })).toBeVisible()
    await page.emulateMedia({ media: "screen" })

    await page.keyboard.press("Escape")
    await expect(folha).toBeHidden()
    await expect(page.getByRole("button", { name: "Abrir relatório" })).toBeFocused()
  })

  test("se os números não carregam, avisa e não deixa gerar o PDF", async ({ page }) => {
    await mockAdminRoutes(page)
    await gotoAdminLoggedIn(page)
    await abrirSecaoAdmin(page, "Dashboard")
    await page.route("**/admin/metrics?*desde=*", (r) => r.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"error":"falhou"}' }))
    await page.getByRole("button", { name: "Abrir relatório" }).click()
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível carregar os números" })).toBeVisible({ timeout: 20000 })
    await expect(page.getByRole("button", { name: "Salvar em PDF" })).toBeDisabled()
  })
})
