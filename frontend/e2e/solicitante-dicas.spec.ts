import { test, expect } from "./helpers/fixtures"
import { mockSolicitanteRoutes, gotoSolicitanteLoggedIn } from "./helpers/fixtures"

// Frases reais (reescritas) do histórico: cada uma tem de cair na dica certa.
const CASOS: [string, string | null][] = [
  ["Papel preso na impressora", "Papel preso na impressora"],
  ["Obstrução na HP, de novo", "Papel preso na impressora"],
  ["Impressora dando erro no tonner", "Toner acabando ou impressão clara"],
  ["Impressões saindo com listras", "Impressão com listras, manchas ou cor errada"],
  ["Não estou conseguindo imprimir", "A impressora não imprime"],
  ["Impressora parada", "A impressora não imprime"],
  ["Scanner não funciona", "Problema para escanear"],
  ["Wi-Fi não funciona", "Sem internet ou Wi-Fi"],
  ["Site do banco fora do ar", "Site que não abre ou dá erro"],
  ["Não estou conseguindo acessar o Omie", "OMIE, Zappy ou outra plataforma com problema"],
  ["Notebook não está ligando", "Computador ou notebook não liga"],
  ["Meu notebook travando muito", "Computador lento ou travando"],
  ["Mouse parando de funcionar", "Mouse ou teclado falhando"],
  ["Meu microfone não ativa", "Microfone ou som não funciona"],
  ["E-mail com armazenamento cheio", "E-mail ou Drive cheio"],
  ["Símbolos no Word que não sei apagar", "Símbolos estranhos ou linhas vermelhas no Word"],
  ["Ajustar planilha para impressão", "Planilha saindo cortada ou fora de ordem"],
  ["Preciso de um acesso ao Claude", null],
  ["Criação de pesquisa de satisfação", null],
  ["Criar acesso no Omie", null],
  // perigo: nada de "teste outra tomada"
  ["Caiu água no notebook e não liga", "Pare e chame a TI"],
  ["Cheiro de queimado na impressora", "Pare e chame a TI"],
  // pedidos sem defeito e assuntos parecidos não mostram dica
  ["Liberar acesso a um site", null],
  ["Instalar o Chrome", null],
  ["Preciso de acesso à internet", null],
  ["Comprar toner", null],
  ["Instalar scanner na diretoria", null],
  ["Atualizar meu telefone na assinatura", null],
  ["Telefone não funciona", null],
  ["Evento da escola católica", null],
  ["Ar condicionado não liga", null],
  ["Sistema abrindo tela em branco", null],
  ["Tela com listras no monitor", null],
  ["Memória do computador cheia", null],
  ["Cartucho de tinta da Epson", "Impressão com listras, manchas ou cor errada"],
  ["Impressora não liga", "A impressora não imprime"],
]

test.describe("Dicas antes de abrir o chamado", () => {
  test("cada descrição leva à dica certa, e pedido de acesso não mostra dica", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    const campo = page.locator("textarea").first()
    const dicas = page.getByRole("region", { name: "Dicas antes de abrir o chamado" })
    for (const [texto, titulo] of CASOS) {
      await campo.fill(texto)
      if (titulo) await expect(dicas.locator("summary").first(), texto).toHaveText(titulo)
      else await expect(dicas, texto).toHaveCount(0)
    }
  })

  test("a primeira dica vem aberta, no máximo duas, e o chamado continua podendo ser aberto", async ({ page }) => {
    await mockSolicitanteRoutes(page)
    await gotoSolicitanteLoggedIn(page)
    await page.locator('[data-slot="select-trigger"]').nth(0).click()
    await page.getByRole("option", { name: "Administrativo" }).click()
    await page.locator('[data-slot="select-trigger"]').nth(1).click()
    await page.getByRole("option", { name: /Multifuncionais/ }).click()
    await page.getByRole("radio").first().click()
    await page.locator("textarea").first().fill("Impressora não imprime, papel preso e toner fraco")
    const dicas = page.getByRole("region", { name: "Dicas antes de abrir o chamado" })
    await expect(dicas.locator("details")).toHaveCount(2)
    await expect(dicas.locator("details").first()).toHaveAttribute("open", "")
    await expect(dicas.locator("details").nth(1)).not.toHaveAttribute("open", "")
    await page.getByRole("button", { name: "Abrir Chamado" }).click()
    await expect(page.getByRole("heading", { name: "Chamado aberto!" }).last()).toBeVisible()
  })
})
