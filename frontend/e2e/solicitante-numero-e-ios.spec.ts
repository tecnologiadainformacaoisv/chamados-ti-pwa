import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

// Pré-implantação (2026-11-11): número legível do chamado, fonte hospedada e aviso de
// instalação no iPhone.
test.describe("Número do chamado (app do solicitante)", () => {
  test("o cartão mostra 'Chamado #0142' e o link do WhatsApp cita o número", async ({ page }) => {
    await mockSolicitanteRoutes(page, { tasks: [makeTask({ id: "t-142", name: "Impressora parada", numero: 142 })] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    await expect(page.getByText("Chamado #0142")).toBeVisible()
    const href = await page.getByRole("link", { name: /Falar no WhatsApp/ }).getAttribute("href")
    expect(decodeURIComponent(href ?? "")).toContain("chamado de TI #0142")
  })

  test("chamado sem número (antigo) continua aparecendo normalmente, sem 'Chamado #'", async ({ page }) => {
    await mockSolicitanteRoutes(page, { tasks: [makeTask({ id: "t-velho", name: "Chamado antigo" })] })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("tab", { name: /Meus Chamados/ }).click()
    await expect(page.getByText("Chamado antigo")).toBeVisible()
    await expect(page.getByText(/Chamado #/)).toHaveCount(0)
  })
})

test.describe("Fonte hospedada", () => {
  test("a fonte vem do próprio site, sem chamar o Google Fonts", async ({ page }) => {
    const externos: string[] = []
    page.on("request", (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) externos.push(r.url()) })
    const fontes: string[] = []
    page.on("response", (r) => { if (/\/fonts\/atkinson-next-.*\.woff2/.test(r.url())) fontes.push(r.url()) })
    await mockSolicitanteRoutes(page)
    await page.goto("/")
    await expect(page.locator("#setup-email")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    expect(externos).toEqual([])
    expect(fontes.length).toBeGreaterThan(0)
  })
})

test.describe("Aviso de instalação no iPhone", () => {
  test.use({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" })

  test("aparece no Safari do iPhone, ensina o caminho e some depois de fechado", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByText("Instale o app no seu iPhone")).toBeVisible()
    await expect(page.getByText("Adicionar à Tela de Início")).toBeVisible()
    await page.getByRole("button", { name: "Fechar aviso de instalação" }).click()
    await expect(page.getByText("Instale o app no seu iPhone")).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
    await expect(page.getByText("Instale o app no seu iPhone")).toHaveCount(0)
  })
})

test.describe("Aviso de instalação fora do iPhone", () => {
  test("não aparece em navegador comum", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByRole("tab", { name: "Novo Chamado" })).toBeVisible()
    await expect(page.getByText("Instale o app no seu iPhone")).toHaveCount(0)
  })
})
