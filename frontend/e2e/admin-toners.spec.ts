import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn, abrirSecaoAdmin } from "./helpers/fixtures"

// Toners (2026-11-23): acompanhamento dos suprimentos do parque de impressão.
const DIA = 24 * 60 * 60 * 1000
const impressora = { id: "imp-1", tombamento: "F 0001", tipo: "impressora", marca: "Brother", modelo: "HL-1222", numero_serie: null, origem: "locado", fornecedor: null, setor: 1, local: "Sala 3", status: "ativo", observacao: null, chamadosTotal: 0, chamadosAbertos: 0 }

const toners = () => [
  // ciclo real de 45 dias e a última recarga foi há 45: no limite, crítico
  { id: "t-critico", equipamento_id: "imp-1", codigo: "TN-CRITICO", cor: "preto", capacidade_paginas: 2600, ciclo_dias_padrao: null, observacao: null, tombamento: "F 0001", marca: "Brother", modelo: "HL-1222", setor: 1, local: "Sala 3", recargas: [Date.now() - 90 * DIA, Date.now() - 45 * DIA] },
  // recarga recente, ciclo padrão de 45 dias: tranquilo
  { id: "t-ok", equipamento_id: "imp-1", codigo: "TN-OK", cor: "ciano", capacidade_paginas: null, ciclo_dias_padrao: 45, observacao: null, tombamento: "F 0001", marca: "Brother", modelo: "HL-1222", setor: 1, local: "Sala 3", recargas: [Date.now() - 5 * DIA] },
  // sem nenhuma recarga nem ciclo: sem histórico
  { id: "t-novo", equipamento_id: "imp-1", codigo: "TN-NOVO", cor: "amarelo", capacidade_paginas: null, ciclo_dias_padrao: null, observacao: null, tombamento: "F 0001", marca: "Brother", modelo: "HL-1222", setor: 1, local: "Sala 3", recargas: [] },
]

async function abrir(page: import("@playwright/test").Page, lista = toners(), equipamentos: Record<string, unknown>[] = [impressora]) {
  await mockAdminRoutes(page, { toners: lista, equipamentos })
  await gotoAdminLoggedIn(page)
  await abrirSecaoAdmin(page, "Toners")
}

const linhas = (page: import("@playwright/test").Page) => page.locator("ul.divide-y > li")

test.describe("Toners", () => {
  test("mostra os cartões de situação e a lista começa pelo mais urgente", async ({ page }) => {
    await abrir(page)
    await expect(page.getByRole("button", { name: /Crítico/ })).toContainText("1")
    await expect(page.getByRole("button", { name: /Atenção/ })).toContainText("0")
    await expect(page.getByRole("button", { name: /OK/ })).toContainText("1")
    await expect(linhas(page)).toHaveCount(3)
    await expect(linhas(page).first()).toContainText("TN-CRITICO")
    await expect(linhas(page).first()).toContainText("Crítico")
    // o título da linha é ONDE a impressora está; o código do cartucho fica numa linha menor
    await expect(linhas(page).first().locator("p").first()).toHaveText("Sala 3")
    await expect(linhas(page).first()).toContainText("Brother HL-1222 · Assistencial")
    await expect(linhas(page).first()).toContainText("Cartucho preto · cód. TN-CRITICO")
    await expect(linhas(page).last()).toContainText("TN-OK")
    await expect(page.getByText("Ciclo médio")).toBeVisible()
  })

  test("clicar num cartão filtra a lista e clicar de novo limpa", async ({ page }) => {
    await abrir(page)
    await page.getByRole("button", { name: /Crítico/ }).click()
    await expect(linhas(page)).toHaveCount(1)
    await expect(linhas(page).first()).toContainText("TN-CRITICO")
    await page.getByRole("button", { name: /Crítico/ }).click()
    await expect(linhas(page)).toHaveCount(3)
  })

  test("sem toner cadastrado orienta o que fazer", async ({ page }) => {
    await abrir(page, [])
    await expect(page.getByText(/Nenhum toner cadastrado/)).toBeVisible()
  })

  test("registrar recarga pede confirmação, usa o autor lembrado e só então envia", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("admin_nota_autor", "Everson"))
    await abrir(page)
    const corpos: Record<string, unknown>[] = []
    await page.route(/\/admin\/toners\/t-critico\/recarga$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      corpos.push(route.request().postDataJSON())
      return route.fulfill({ status: 201, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true }) })
    })
    const linha = linhas(page).first()
    page.once("dialog", (d) => d.dismiss())
    await linha.getByRole("button", { name: "Registrar recarga" }).click()
    expect(corpos).toHaveLength(0)
    page.once("dialog", (d) => d.accept())
    await linha.getByRole("button", { name: "Registrar recarga" }).click()
    await expect.poll(() => corpos.length).toBe(1)
    expect(corpos[0]).toMatchObject({ autor: "Everson" })
  })

  test("'Desfazer última' só aparece em toner com recarga e pede confirmação", async ({ page }) => {
    await abrir(page)
    await expect(linhas(page).filter({ hasText: "TN-NOVO" }).getByRole("button", { name: "Desfazer última" })).toHaveCount(0)
    let chamadas = 0
    let corpo: Record<string, unknown> = {}
    await page.route(/\/admin\/toners\/t-ok\/recarga\/desfazer$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      chamadas++
      corpo = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true }) })
    })
    const botao = linhas(page).filter({ hasText: "TN-OK" }).getByRole("button", { name: "Desfazer última" })
    page.once("dialog", (d) => d.dismiss())
    await botao.click()
    expect(chamadas).toBe(0)
    page.once("dialog", (d) => d.accept())
    await botao.click()
    await expect.poll(() => chamadas).toBe(1)
    // manda a data da recarga que estava vendo, para o servidor recusar se a lista mudou
    expect(typeof corpo.feita_em).toBe("number")
  })

  test("se a lista mudou, o servidor recusa o 'Desfazer' e a tela avisa", async ({ page }) => {
    await abrir(page)
    await page.route(/\/admin\/toners\/t-ok\/recarga\/desfazer$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 409, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "a lista mudou enquanto você olhava; atualize a tela e confira antes de desfazer" }) })
    })
    page.once("dialog", (d) => d.accept())
    await linhas(page).filter({ hasText: "TN-OK" }).getByRole("button", { name: "Desfazer última" }).click()
    await expect(page.getByRole("alert")).toContainText("a lista mudou")
  })

  test("toner repetido (mesma impressora e cor) mostra o erro do servidor no formulário", async ({ page }) => {
    await abrir(page)
    await page.route(/\/admin\/toners$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 409, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "esta impressora já tem um toner dessa cor; edite o que já existe" }) })
    })
    await page.getByRole("button", { name: "Novo toner" }).click()
    const dialogo = page.getByRole("dialog")
    await dialogo.locator("#toner-impressora").click()
    await page.getByRole("option", { name: /Sala 3/ }).click()
    await dialogo.getByLabel("Código do toner").fill("TN-2000")
    await dialogo.getByRole("button", { name: "Salvar" }).click()
    await expect(dialogo.getByRole("alert")).toContainText("já tem um toner dessa cor")
  })

  test("erro do servidor na recarga aparece na tela", async ({ page }) => {
    await abrir(page)
    await page.route(/\/admin\/toners\/t-ok\/recarga$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 400, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "data da recarga inválida" }) })
    })
    page.once("dialog", (d) => d.accept())
    await linhas(page).filter({ hasText: "TN-OK" }).getByRole("button", { name: "Registrar recarga" }).click()
    await expect(page.getByRole("alert")).toContainText("data da recarga inválida")
  })

  test("novo toner: escolhe a impressora do inventário e envia o cadastro", async ({ page }) => {
    await abrir(page)
    let enviado: Record<string, unknown> | null = null
    await page.route(/\/admin\/toners$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      enviado = route.request().postDataJSON()
      return route.fulfill({ status: 201, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ id: "novo" }) })
    })
    await page.getByRole("button", { name: "Novo toner" }).click()
    const dialogo = page.getByRole("dialog")
    await dialogo.getByRole("button", { name: "Salvar" }).click()
    await expect(dialogo.getByRole("alert")).toContainText("Escolha a impressora")
    await dialogo.locator("#toner-impressora").click()
    await page.getByRole("option", { name: /F 0001/ }).click()
    await dialogo.getByRole("button", { name: "Salvar" }).click()
    await expect(dialogo.getByRole("alert")).toContainText("código do toner")
    await dialogo.getByLabel("Código do toner").fill("TN-2000")
    await dialogo.getByLabel("Ciclo esperado (dias)").fill("30")
    await dialogo.getByRole("button", { name: "Salvar" }).click()
    await expect(dialogo).toHaveCount(0)
    expect(enviado).toMatchObject({ equipamento_id: "imp-1", codigo: "TN-2000", cor: "preto", ciclo_dias_padrao: 30, capacidade_paginas: null })
  })

  test("novo toner sem nenhuma impressora no inventário manda cadastrar a impressora antes", async ({ page }) => {
    await abrir(page, [], [])
    await page.getByRole("button", { name: "Novo toner" }).click()
    await expect(page.getByRole("dialog")).toContainText("Cadastre antes a impressora no Inventário")
  })

  test("editar abre preenchido e 'Remover da lista' manda ativo:false", async ({ page }) => {
    await abrir(page)
    let enviado: Record<string, unknown> | null = null
    await page.route(/\/admin\/toners\/t-ok$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      enviado = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true }) })
    })
    await linhas(page).filter({ hasText: "TN-OK" }).getByRole("button", { name: "Editar" }).click()
    const dialogo = page.getByRole("dialog")
    await expect(dialogo.getByLabel("Código do toner")).toHaveValue("TN-OK")
    await expect(dialogo.getByLabel("Ciclo esperado (dias)")).toHaveValue("45")
    page.once("dialog", (d) => d.accept())
    await dialogo.getByRole("button", { name: "Remover da lista" }).click()
    await expect(dialogo).toHaveCount(0)
    expect(enviado).toMatchObject({ ativo: false })
  })
})
