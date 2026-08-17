import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

test.describe("Banners do app do solicitante", () => {
  test("scrollbar nativa fica escondida (regressão 2026-08-17)", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    const scrollbarWidth = await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)
    expect(scrollbarWidth).toBe(0)
    expect(await page.evaluate(() => document.body.className)).toContain("app-solicitante")
  })

  test("banner de offline aparece/some com o evento online/offline", async ({ page, context }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByText("Sem conexão com a internet")).not.toBeVisible()

    await context.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event("offline")))
    await expect(page.getByText("Sem conexão com a internet")).toBeVisible()

    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event("online")))
    await expect(page.getByText("Sem conexão com a internet")).not.toBeVisible()
  })

  test("banner de instalar app aparece no beforeinstallprompt e some ao instalar", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByText("Instalar app")).not.toBeVisible()

    await page.evaluate(() => {
      class FakeBIP extends Event {
        constructor() { super("beforeinstallprompt", { cancelable: true }) }
        prompt() { return Promise.resolve() }
        get userChoice() { return Promise.resolve({ outcome: "accepted" }) }
      }
      window.dispatchEvent(new FakeBIP())
    })
    await expect(page.getByText("Instalar app")).toBeVisible()
    await page.getByRole("button", { name: "Instalar" }).click()
    await expect(page.getByText("Instalar app")).not.toBeVisible()
  })

  test("banner de instalar some ao clicar 'Agora não' sem instalar", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await page.evaluate(() => {
      class FakeBIP extends Event {
        constructor() { super("beforeinstallprompt", { cancelable: true }) }
        prompt() { return Promise.resolve() }
        get userChoice() { return Promise.resolve({ outcome: "dismissed" }) }
      }
      window.dispatchEvent(new FakeBIP())
    })
    await expect(page.getByText("Instalar app")).toBeVisible()
    await page.getByRole("button", { name: "Agora não" }).click()
    await expect(page.getByText("Instalar app")).not.toBeVisible()
  })
})

test.describe("Bottom-sheet mobile (regressão 2026-08-17)", () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test("modal do WhatsApp vira bottom-sheet full-width no mobile", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await page.locator('[data-slot="select-trigger"]').nth(0).click()
    await page.getByRole("option", { name: "Administrativo" }).click()
    await page.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: /Notebooks/ }).click()
    await page.getByRole("radio").first().click()
    await page.locator("textarea").first().fill("Teste bottom-sheet")
    await page.getByRole("button", { name: "Abrir Chamado" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    const viewport = page.viewportSize()!
    expect(box).not.toBeNull()
    expect(box!.x).toBeCloseTo(0, 0)
    expect(box!.width).toBeCloseTo(viewport.width, 0)
    expect(box!.y + box!.height).toBeCloseTo(viewport.height, 0)
  })
})
