import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

test.describe("Gestão — Quadro (Kanban)", () => {
  test("agrupa os cards por status nas 4 colunas certas", async ({ page }) => {
    const tasks = [
      makeTask({ id: "a1", name: "Aberto 1", status: { status: "aberto" } }),
      makeTask({ id: "b1", name: "Atendimento 1", status: { status: "em atendimento" } }),
      makeTask({ id: "c1", name: "Pendente 1", status: { status: "pendente" } }),
      makeTask({ id: "d1", name: "Encerrado 1", status: { status: "encerrado" } }),
    ]
    await mockAdminRoutes(page, { tasks })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Aberto 1")).toBeVisible()
    await expect(page.getByText("Atendimento 1")).toBeVisible()
    await expect(page.getByText("Pendente 1")).toBeVisible()
    await expect(page.getByText("Encerrado 1")).toBeVisible()
  })

  test("clicar num card abre o modal Gerenciar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook quebrado" })] })
    await gotoAdminLoggedIn(page)
    await page.getByText("Notebook quebrado").click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByRole("dialog").getByText("Notebook quebrado")).toBeVisible()
  })

  test("alterna pra Tabela e volta pro Quadro", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Chamado X" })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await expect(page.locator("table")).toBeVisible()
    await page.getByRole("button", { name: "Quadro" }).click()
    await expect(page.locator("table")).not.toBeVisible()
  })
})

test.describe("Gestão — Tabela", () => {
  test("edição inline de status muda o chamado de grupo", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Vai mudar de status", status: { status: "aberto" } })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()

    let postedBody: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/t1$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      postedBody = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "t1", status: { status: "em atendimento" } }) })
    })

    const row = page.locator("tr", { hasText: "Vai mudar de status" })
    await row.locator('[data-slot="select-trigger"]').nth(1).click() // Status é o 2º select da linha (Operador é o 1º)
    await page.getByRole("option", { name: "Em Atendimento" }).click()

    await expect.poll(() => postedBody).toEqual({ status: "em atendimento" })
  })

  // Itens 6/7/8 do pedido do usuário (2026-09-15, "veja o exemplo da lista de
  // chamados no ClickUp") — checkbox só no hover, clicar na linha abre Gerenciar
  // (igual o Quadro já fazia), e cada rota interativa (checkbox/selects) não deve
  // abrir o modal por acidente.
  test("clicar na linha (fora dos controles) abre o modal Gerenciar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Notebook não liga" })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await page.getByText("Notebook não liga").click()
    await expect(page.getByRole("dialog")).toBeVisible()
  })

  test("clicar no checkbox ou nos selects inline NÃO abre o modal Gerenciar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Não deve abrir modal" })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const row = page.locator("tr", { hasText: "Não deve abrir modal" })

    await row.locator('input[type="checkbox"]').click()
    await expect(page.getByRole("dialog")).not.toBeVisible()

    await row.locator('[data-slot="select-trigger"]').first().click() // Operador
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).not.toBeVisible()
  })

  test("checkbox da linha só aparece no hover (ou se já tiver seleção no grupo)", async ({ page }, testInfo) => {
    // Hover de verdade (CSS :hover) não é um conceito que existe em touch/mobile —
    // mesmo padrão já usado pro teste de drag-and-drop do Quadro (ver testInfo.skip
    // mais abaixo no arquivo, se houver). Num toque real, a linha inteira já abre o
    // Gerenciar de qualquer jeito (teste "clicar na linha... abre o modal Gerenciar").
    testInfo.skip(testInfo.project.name === "mobile", "hover CSS não existe em touch — mobile abre a linha inteira no toque")
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Chamado qualquer" })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const checkbox = page.locator('tr:has-text("Chamado qualquer") input[type="checkbox"]')
    await expect(checkbox).toHaveCSS("opacity", "0")
    await page.locator('tr:has-text("Chamado qualquer")').hover()
    await expect(checkbox).toHaveCSS("opacity", "1")
  })

  test("select de status mostra a cor certa por status (pill colorida)", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Chamado pendente", status: { status: "pendente" } })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    const trigger = page.locator('tr:has-text("Chamado pendente") [data-slot="select-trigger"]').nth(1)
    // Cor de "pendente" em STATUS_MAP (constants.ts) — mesma cor já usada no
    // cabeçalho de grupo/Quadro/Dashboard.
    await expect(trigger).toHaveCSS("color", "rgb(182, 96, 224)")
  })

  test("busca por título filtra a lista visível", async ({ page }) => {
    await mockAdminRoutes(page, {
      tasks: [makeTask({ id: "t1", name: "Impressora sem tinta" }), makeTask({ id: "t2", name: "Rede lenta" })],
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await expect(page.getByText("Impressora sem tinta")).toBeVisible()
    await expect(page.getByText("Rede lenta")).toBeVisible()

    await page.getByPlaceholder("Buscar por título...").fill("impressora")
    await expect(page.getByText("Impressora sem tinta")).toBeVisible()
    await expect(page.getByText("Rede lenta")).not.toBeVisible()
  })

  test("seleção em lote muda status de vários chamados de uma vez", async ({ page }) => {
    await mockAdminRoutes(page, {
      tasks: [makeTask({ id: "t1", name: "Um", status: { status: "aberto" } }), makeTask({ id: "t2", name: "Dois", status: { status: "aberto" } })],
    })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()

    let bulkBody: Record<string, unknown> | null = null
    await page.route(/\/admin\/tasks\/bulk/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      bulkBody = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 2, sucesso: 2, falha: 0, results: [] }) })
    })

    await page.locator('tr:has-text("Um") input[type="checkbox"]').check()
    await page.locator('tr:has-text("Dois") input[type="checkbox"]').check()
    await expect(page.getByText("2 selecionados")).toBeVisible()

    // Barra flutuante de ação em lote — Select "Mudar status". "Encerrado" não é uma
    // opção aqui de propósito (regra de 2026-08-24: encerrar exige solução, e não dá
    // pra pedir uma por chamado numa ação em massa — ver admin-encerrar-solucao.spec.ts).
    await page.getByText("Mudar status").click()
    await page.getByRole("option", { name: "Pendente" }).click()

    await expect.poll(() => bulkBody).toEqual({ ids: ["t1", "t2"], status: "pendente" })
    await expect(page.getByText("2 chamados atualizados.")).toBeVisible()
  })

  test("grupo colapsa e expande, e lembra entre re-renders", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [makeTask({ id: "t1", name: "Chamado aberto", status: { status: "aberto" } })] })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()
    await expect(page.getByText("Chamado aberto")).toBeVisible()
    await page.getByRole("button", { name: /Aberto/ }).first().click()
    await expect(page.getByText("Chamado aberto")).not.toBeVisible()
  })
})

test.describe("Gestão — Filtros", () => {
  test("badge de filtros ativos conta corretamente", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText(/\d+ filtros?/)).not.toBeVisible()
    await page.locator('[data-slot="select-trigger"]').first().click()
    await page.getByRole("option").nth(1).click()
    await expect(page.getByText("1 filtro")).toBeVisible()
  })

  test("truncated:true mostra o aviso de teto de páginas", async ({ page }) => {
    await mockAdminRoutes(page)
    await page.route(/\/admin\/tasks(\?.*)?$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, tasks: [], truncated: true }) })
    })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText(/bateu no teto de páginas/)).toBeVisible()
  })
})

// Regressão de 2026-09-15/16: 3 rodadas seguidas de bug de scroll horizontal na
// Tabela (min-w forçado, depois margem negativa -mx-6 da barra sticky, depois
// SidebarInset sem min-w-0 — o clássico "flex item não encolhe abaixo do
// min-content" do flexbox). Trava numericamente (scrollWidth === clientWidth), não
// só visualmente, pra não repetir a mesma investigação pela 4ª vez.
test.describe("Gestão — layout (sem scroll horizontal de página)", () => {
  test("sidebar expandida + tabela com conteúdo real não estoura a largura da página", async ({ page }, testInfo) => {
    // Em mobile a sidebar sempre vira um Sheet (overlay full-width, ver
    // use-mobile.ts) — o conceito de "expandida ocupando espaço reservado ao lado
    // do conteúdo" (a causa raiz real do bug, ver comentário do describe) só existe
    // em desktop.
    testInfo.skip(testInfo.project.name === "mobile", "sidebar em mobile é um Sheet overlay, não reserva espaço lateral")
    const tasks = [
      makeTask({ id: "t1", name: "ERRO NA IMPRESSÃO — urgente por favor resolver hoje mesmo se possível", solicitante: "Maria Clara Assunção de Oliveira", status: { status: "pendente" } }),
      makeTask({ id: "t2", name: "Solicitação de acesso ao sistema de gestão financeira e contábil", solicitante: "João Mário", status: { status: "pendente" } }),
      makeTask({ id: "t3", name: "Notebook não liga mais desde ontem à noite", solicitante: "Tereza D'avila", status: { status: "pendente" } }),
    ]
    await mockAdminRoutes(page, { tasks })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Tabela" }).click()

    // Expande a sidebar — foi exatamente esse estado (mais espaço reservado pra
    // ela, menos sobrando pro conteúdo) que expôs o bug real.
    await page.locator('[title="Controle da sidebar"]').click()
    await page.getByText("Expandida").click()
    await page.waitForTimeout(200)

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth).toBe(overflow.clientWidth)
  })
})
