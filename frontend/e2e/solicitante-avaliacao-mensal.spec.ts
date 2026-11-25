import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

// Avaliação mensal da TI (2026-11-25, ideia do estudo do OS800): faixa no app do solicitante + formulário.
const CORS = { "access-control-allow-origin": "*" }

async function responderTudo(page: import("@playwright/test").Page, nota = "5", recomendacao = "10") {
  const grupos = page.getByRole("radiogroup")
  await expect(grupos).toHaveCount(7)
  for (let i = 0; i < 6; i++) await grupos.nth(i).getByRole("radio", { name: nota, exact: true }).click()
  await grupos.nth(6).getByRole("radio", { name: recomendacao, exact: true }).click()
}

test.describe("Avaliação mensal (solicitante)", () => {
  test("a faixa aparece quando o mês não foi avaliado e o fluxo completo envia as notas e agradece", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    const corpos: Record<string, unknown>[] = []
    await page.route("**/api/avaliacao-mensal", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      corpos.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ ok: true, competencia: "2026-11" }) })
    })
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByText("Como foi a TI em novembro?")).toBeVisible()
    await page.getByRole("button", { name: "Avaliar agora" }).click()
    const dialogo = page.getByRole("dialog")
    await expect(dialogo.getByRole("heading", { name: "Como foi a TI em novembro?" })).toBeVisible()

    // enviar sem responder: diz quantas perguntas faltam e não envia nada
    await dialogo.getByRole("button", { name: "Enviar avaliação" }).click()
    await expect(dialogo.getByRole("alert")).toContainText("Falta responder 7 perguntas.")
    expect(corpos).toHaveLength(0)

    await responderTudo(page, "4", "9")
    await dialogo.getByLabel(/Quer contar alguma coisa/).fill("  Atendimento rápido  ")
    await dialogo.getByRole("button", { name: "Enviar avaliação" }).click()

    await expect(page.getByText("Obrigado! Sua avaliação foi registrada.")).toBeVisible()
    await expect(dialogo).toHaveCount(0)
    await expect(page.getByText("Como foi a TI em novembro?")).toHaveCount(0)
    expect(corpos).toHaveLength(1)
    expect(corpos[0]).toMatchObject({
      respostas: { tempo_resposta: 4, primeiro_atendimento: 4, conhecimento: 4, cordialidade: 4, equipamentos: 4, comunicacao: 4, recomendacao: 9 },
    })
    expect(String(corpos[0].comentario).trim()).toBe("Atendimento rápido")
  })

  test("mês já avaliado: a faixa não aparece", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: true })
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByRole("button", { name: "Abrir Chamado" })).toBeVisible()
    await expect(page.getByText(/Como foi a TI em/)).toHaveCount(0)
  })

  test("'Agora não' esconde a faixa e ela continua escondida depois de recarregar (até o dia seguinte)", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Agora não" }).first().click()
    await expect(page.getByText(/Como foi a TI em/)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole("button", { name: "Abrir Chamado" })).toBeVisible()
    await expect(page.getByText(/Como foi a TI em/)).toHaveCount(0)
  })

  test("erro do servidor ao enviar aparece no formulário e as respostas não se perdem", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    await page.route("**/api/avaliacao-mensal", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", headers: CORS, body: JSON.stringify({ error: "Erro interno." }) })
    })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Avaliar agora" }).click()
    const dialogo = page.getByRole("dialog")
    await responderTudo(page)
    await dialogo.getByRole("button", { name: "Enviar avaliação" }).click()
    await expect(dialogo.getByRole("alert")).toContainText("Erro interno.")
    await expect(dialogo).toBeVisible()
    await expect(dialogo.getByRole("radio", { name: "5", exact: true }).first()).toHaveAttribute("aria-checked", "true")
  })

  test("se a consulta da avaliação falhar, a faixa some e o app continua normal", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await page.route("**/api/avaliacao-mensal", (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", headers: CORS, body: "{}" })
    })
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByRole("button", { name: "Abrir Chamado" })).toBeVisible()
    await expect(page.getByText(/Como foi a TI em/)).toHaveCount(0)
  })

  test("o formulário cabe na tela do celular (sem rolagem lateral)", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Avaliar agora" }).click()
    await expect(page.getByRole("radiogroup")).toHaveCount(7)
    const estouro = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(estouro).toBeLessThanOrEqual(0)
  })

  test("teclado: um botão por pergunta na ordem de Tab e as setas escolhem a nota", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Avaliar agora" }).click()
    const grupo = page.getByRole("radiogroup").first()
    // nada escolhido: só o primeiro botão entra na ordem de Tab
    await expect(grupo.locator('[role="radio"][tabindex="0"]')).toHaveCount(1)
    await grupo.getByRole("radio", { name: "1", exact: true }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(grupo.getByRole("radio", { name: "2", exact: true })).toHaveAttribute("aria-checked", "true")
    await expect(grupo.getByRole("radio", { name: "2", exact: true })).toBeFocused()
    await page.keyboard.press("End")
    await expect(grupo.getByRole("radio", { name: "5", exact: true })).toHaveAttribute("aria-checked", "true")
    await page.keyboard.press("ArrowRight") // volta ao 1 (circular)
    await expect(grupo.getByRole("radio", { name: "1", exact: true })).toHaveAttribute("aria-checked", "true")
    // com uma nota escolhida, só ELA fica na ordem de Tab
    await expect(grupo.locator('[role="radio"][tabindex="0"]')).toHaveCount(1)
    await expect(grupo.getByRole("radio", { name: "1", exact: true })).toHaveAttribute("tabindex", "0")
    // o grupo é anunciado com o nome da própria pergunta
    await expect(page.getByRole("radiogroup", { name: /respondeu rápido/ })).toBeVisible()
  })

  test("cada pergunta sem resposta diz 'Escolha uma nota.' depois de tentar enviar", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Avaliar agora" }).click()
    const dialogo = page.getByRole("dialog")
    await expect(dialogo.getByText("Escolha uma nota.")).toHaveCount(0)
    await dialogo.getByRole("button", { name: "Enviar avaliação" }).click()
    await expect(dialogo.getByText("Escolha uma nota.")).toHaveCount(7)
    await dialogo.getByRole("radiogroup").first().getByRole("radio", { name: "3", exact: true }).click()
    await expect(dialogo.getByText("Escolha uma nota.")).toHaveCount(6)
  })

  test("conta de fora da instituição não vê a faixa", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false, avaliacaoElegivel: false })
    await gotoSolicitanteLoggedIn(page)
    await expect(page.getByRole("button", { name: "Abrir Chamado" })).toBeVisible()
    await expect(page.getByText(/Como foi a TI em/)).toHaveCount(0)
  })

  test("mês virou com o formulário aberto: o servidor recusa e a tela explica, mantendo as respostas", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    let competenciaEnviada: unknown
    await page.route("**/api/avaliacao-mensal", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      competenciaEnviada = route.request().postDataJSON().competencia
      return route.fulfill({ status: 409, contentType: "application/json", headers: CORS, body: JSON.stringify({ error: "O mês virou enquanto você respondia. Abra a avaliação de novo para avaliar o mês atual." }) })
    })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Avaliar agora" }).click()
    const dialogo = page.getByRole("dialog")
    await responderTudo(page)
    await dialogo.getByRole("button", { name: "Enviar avaliação" }).click()
    await expect(dialogo.getByRole("alert")).toContainText("O mês virou")
    expect(competenciaEnviada).toBe("2026-11") // manda o mês que o formulário mostrou
    await expect(dialogo.getByRole("radio", { name: "5", exact: true }).first()).toHaveAttribute("aria-checked", "true")
  })

  test("depois de enviar, o foco vai para a mensagem de agradecimento (não se perde no corpo da página)", async ({ page }) => {
    await mockSolicitanteRoutes(page, { avaliacaoRespondida: false })
    await gotoSolicitanteLoggedIn(page)
    await page.getByRole("button", { name: "Avaliar agora" }).click()
    await responderTudo(page)
    await page.getByRole("dialog").getByRole("button", { name: "Enviar avaliação" }).click()
    await expect(page.getByRole("status").filter({ hasText: "Obrigado!" })).toBeFocused()
  })
})
