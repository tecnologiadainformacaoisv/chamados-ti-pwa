import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

test.describe("Seletor de tema do painel", () => {
  test("começa claro, um clique vai para escuro e depois automático, e lembra a escolha", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    await gotoAdminLoggedIn(page)
    const html = page.locator("html")
    await expect(html).not.toHaveClass(/dark/)

    await page.getByRole("button", { name: /Tema atual: claro/ }).click()
    await expect(html).toHaveClass(/dark/)
    expect(await page.evaluate(() => localStorage.getItem("admin_tema"))).toBe("escuro")

    // a escolha sobrevive a recarregar a página (e já nasce escuro, sem piscar)
    await page.reload()
    await expect(html).toHaveClass(/dark/)

    await page.getByRole("button", { name: /Tema atual: escuro/ }).click()
    expect(await page.evaluate(() => localStorage.getItem("admin_tema"))).toBe("sistema")

    await page.getByRole("button", { name: /Tema atual: automático/ }).click()
    await expect(html).not.toHaveClass(/dark/)
    expect(await page.evaluate(() => localStorage.getItem("admin_tema"))).toBe("claro")
  })

  test("modo automático segue o tema do computador", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await page.addInitScript(() => localStorage.setItem("admin_tema", "sistema"))
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    await gotoAdminLoggedIn(page)
    await expect(page.locator("html")).toHaveClass(/dark/)
  })
})
