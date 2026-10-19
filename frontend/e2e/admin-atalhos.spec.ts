import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn, abrirSecaoAdmin } from "./helpers/fixtures"
import { makeTask } from "./helpers/mock-data"

// Fase 3 do redesign de UX (2026-10-19): atalhos, "Desfazer" seguro, botão Aceitar, filtros rápidos
// e paleta Ctrl+K. Só desktop: no celular não há teclado e a Tabela não existe.
const MIN = 60_000

test.describe("Gestão — atalhos, desfazer e paleta", () => {
  test.beforeEach(async ({ page }, info) => {
    void page
    test.skip(info.project.name === "mobile", "teclado e Tabela só existem no desktop")
  })

  const tarefas = () => [
    makeTask({ id: "a1", name: "Atrasado urgente", status: { status: "aberto" }, priority: { priority: "urgent" }, due_date: Date.now() - 10 * MIN }),
    makeTask({ id: "a2", name: "Normal aberto", status: { status: "aberto" }, priority: { priority: "normal" }, due_date: Date.now() + 120 * MIN }),
    makeTask({ id: "b1", name: "Em atendimento agora", status: { status: "em atendimento" }, priority: { priority: "high" }, due_date: Date.now() + 20 * MIN }),
  ]

  async function mockPost(page: import("@playwright/test").Page, id: string, calls: Array<Record<string, unknown>>) {
    await page.route(new RegExp("/admin/tasks/" + id + "$"), (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "POST") return route.fallback()
      calls.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
  }

  test("J e K movem o foco na ordem de urgência e mostram o destaque", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j")
    await expect(page.locator('[data-task-id="a1"]')).toHaveClass(/ring-primary/)
    await page.keyboard.press("j")
    await expect(page.locator('[data-task-id="a2"]')).toHaveClass(/ring-primary/)
    await page.keyboard.press("k")
    await expect(page.locator('[data-task-id="a1"]')).toHaveClass(/ring-primary/)
  })

  test("Enter aceita o chamado aberto: muda na hora, mas só envia depois de 7 s", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j")
    const t0 = Date.now()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("status").filter({ hasText: "Chamado aceito: Atrasado urgente" })).toBeVisible()
    // aparece na coluna Em atendimento imediatamente...
    await expect(page.locator('[data-status="em atendimento"] [data-task-id="a1"]')).toBeVisible()
    // ...mas só é enviado depois da janela de 7 s (esperar 3 s e conferir que nada saiu antes)
    await page.waitForTimeout(3000)
    expect(calls).toHaveLength(0)
    await expect.poll(() => calls.length, { timeout: 12_000 }).toBe(1)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(6000)
    expect(calls[0]).toEqual({ status: "em atendimento" })
  })

  test("Desfazer cancela o envio e devolve o chamado pra coluna Aberto", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j")
    await page.keyboard.press("Enter")
    await expect(page.locator('[data-status="em atendimento"] [data-task-id="a1"]')).toBeVisible()
    await page.getByRole("button", { name: "Desfazer" }).click()
    await expect(page.locator('[data-status="aberto"] [data-task-id="a1"]')).toBeVisible()
    await page.waitForTimeout(8000)
    expect(calls).toHaveLength(0)
  })

  test("botão Aceitar no card faz o mesmo, com 1 clique", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a2", calls)
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Aceitar chamado: Normal aberto" }).click()
    await expect(page.locator('[data-status="em atendimento"] [data-task-id="a2"]')).toBeVisible()
    await expect.poll(() => calls.length, { timeout: 12_000 }).toBe(1)
    expect(calls[0]).toEqual({ status: "em atendimento" })
  })

  test("só chamado aberto tem botão Aceitar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page)
    await expect(page.getByRole("button", { name: /^Aceitar chamado:/ })).toHaveCount(2)
  })

  test("E abre o popup de solução pro chamado com foco", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Em atendimento agora")).toBeVisible()
    await page.keyboard.press("k") // da última pra trás: começa em "Em atendimento agora"
    await page.keyboard.press("e")
    await expect(page.getByPlaceholder("Descreva a solução aplicada...")).toBeVisible()
  })

  test("/ foca a busca, e digitar j ali não mexe no foco dos chamados", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("/")
    await expect(page.locator("#busca-chamados")).toBeFocused()
    await page.keyboard.type("jj")
    await expect(page.locator("#busca-chamados")).toHaveValue("jj")
    await expect(page.locator('[class*="ring-primary"][data-task-id]')).toHaveCount(0)
  })

  test("chip Atrasados mostra só o que passou do prazo", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page)
    await page.getByRole("button", { name: "Atrasados", exact: true }).click()
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await expect(page.getByText("Normal aberto")).toHaveCount(0)
    await expect(page.getByText("Em atendimento agora")).toHaveCount(0)
    await page.getByRole("button", { name: "Atrasados e até 1 h" }).click()
    await expect(page.getByText("Em atendimento agora")).toBeVisible() // vence em 20 min
    await expect(page.getByText("Atrasado urgente")).toBeVisible() // o chip inclui quem já passou do prazo
    await expect(page.getByText("Normal aberto")).toHaveCount(0) // só em 2 h
    await page.getByRole("button", { name: "Todos" }).click()
    await expect(page.getByText("Normal aberto")).toBeVisible()
  })

  test("Ctrl+K abre a paleta, filtra e executa o comando com Enter", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("Control+k")
    const campo = page.getByRole("combobox", { name: /Digite um comando/ })
    await expect(campo).toBeFocused()
    await campo.fill("atrasados")
    await page.keyboard.press("Enter")
    await expect(page.getByRole("button", { name: "Atrasados", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByText("Normal aberto")).toHaveCount(0)
  })

  test("a paleta acha um chamado pelo título e abre o modal Gerenciar", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: tarefas() })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Normal aberto")).toBeVisible()
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox", { name: /Digite um comando/ }).fill("normal aberto")
    await page.keyboard.press("Enter")
    await expect(page.getByRole("dialog").getByText("Normal aberto")).toBeVisible()
  })

  test("com um diálogo aberto os atalhos não disparam", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await page.getByText("Atrasado urgente").first().click() // abre o modal Gerenciar
    await expect(page.getByRole("dialog")).toBeVisible()
    // com o modal aberto, J não pode mover o foco dos chamados que estão por baixo
    await page.keyboard.press("j")
    await page.keyboard.press("j")
    await page.waitForTimeout(300)
    await expect(page.locator('[class*="ring-primary"][data-task-id]')).toHaveCount(0)
    await expect(page.getByRole("dialog")).toHaveCount(1)
    await expect(page.getByRole("status").filter({ hasText: "Chamado aceito" })).toHaveCount(0)
    expect(calls).toHaveLength(0)
  })

  // ---- cenários de risco apontados na revisão de código (19/10) ----

  test("trocar de seção dentro dos 7 s não perde a ação: o envio acontece na hora", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j")
    await page.keyboard.press("Enter")
    await expect(page.getByRole("button", { name: /^Desfazer/ })).toBeVisible()
    await abrirSecaoAdmin(page, "Dashboard")
    await expect.poll(() => calls.length, { timeout: 4000 }).toBe(1)
  })

  test("duas ações seguidas: a primeira é enviada na hora, a segunda espera a própria janela", async ({ page }) => {
    const c1: Array<Record<string, unknown>> = []
    const c2: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", c1)
    await mockPost(page, "a2", c2)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.getByRole("button", { name: "Aceitar chamado: Atrasado urgente" }).click()
    await page.getByRole("button", { name: "Aceitar chamado: Normal aberto" }).click()
    await expect.poll(() => c1.length, { timeout: 3000 }).toBe(1) // a primeira saiu quando a segunda começou
    expect(c2).toHaveLength(0)
    await expect.poll(() => c2.length, { timeout: 12_000 }).toBe(1)
  })

  test("atualização automática dentro da janela não desfaz o chamado aceito na tela", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() }) // o GET devolve sempre o estado original (aberto)
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j")
    await page.keyboard.press("Enter")
    await expect(page.locator('[data-status="em atendimento"] [data-task-id="a1"]')).toBeVisible()
    await page.locator('[title="Atualizar"]').click() // força um refetch no meio da janela
    await page.waitForTimeout(800)
    await expect(page.locator('[data-status="em atendimento"] [data-task-id="a1"]')).toBeVisible()
  })

  test("tecla U desfaz enquanto o aviso está na tela", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j")
    await page.keyboard.press("Enter")
    await expect(page.locator('[data-status="em atendimento"] [data-task-id="a1"]')).toBeVisible()
    await page.keyboard.press("u")
    await expect(page.locator('[data-status="aberto"] [data-task-id="a1"]')).toBeVisible()
    await expect(page.getByRole("button", { name: /^Desfazer/ })).toHaveCount(0)
  })

  test("com um Select aberto, as teclas escolhem opção e não disparam os atalhos", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j") // foco no primeiro chamado
    await page.getByRole("combobox").filter({ hasText: "Operador: Todos" }).click()
    await expect(page.getByRole("option").first()).toBeVisible()
    await page.keyboard.press("e")
    await page.keyboard.press("Enter") // escolhe a opção do Select, não aceita o chamado
    await page.waitForTimeout(500)
    await expect(page.getByPlaceholder("Descreva a solução aplicada...")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /^Desfazer/ })).toHaveCount(0)
    expect(calls).toHaveLength(0)
  })

  test("foco escondido por um filtro não recebe Enter", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await mockAdminRoutes(page, { tasks: tarefas() })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j") // foco no "Atrasado urgente"
    await page.getByPlaceholder("Buscar por título ou solicitante...").fill("Normal aberto") // esconde o chamado em foco
    await page.getByRole("heading", { name: "Gestão" }).click() // tira o foco do campo
    await page.keyboard.press("Enter")
    await page.waitForTimeout(400)
    await expect(page.getByRole("button", { name: /^Desfazer/ })).toHaveCount(0)
    expect(calls).toHaveLength(0)
  })

  test("se o chamado já mudou de status no servidor, o envio atrasado não é feito", async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    let respondeEncerrado = false
    await mockAdminRoutes(page, { tasks: tarefas() })
    await page.route(/\/admin\/tasks(\?.*)?$/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      if (route.request().method() !== "GET" || !respondeEncerrado) return route.fallback()
      const mudou = tarefas().map((t) => (t.id === "a1" ? { ...t, status: { status: "em atendimento" } } : t))
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: mudou.length, tasks: mudou, truncated: false }) })
    })
    await mockPost(page, "a1", calls)
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Atrasado urgente")).toBeVisible()
    await page.keyboard.press("j")
    await page.keyboard.press("Enter")
    respondeEncerrado = true // "outra pessoa" já aceitou: o servidor passa a devolver o chamado em atendimento
    await page.locator('[title="Atualizar"]').click()
    await page.waitForTimeout(8500)
    expect(calls).toHaveLength(0)
    await expect(page.getByText(/já mudou de status enquanto você aceitava/)).toBeVisible()
  })
})
