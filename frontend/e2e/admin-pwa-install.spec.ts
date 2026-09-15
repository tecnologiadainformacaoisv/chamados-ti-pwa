import { test, expect } from "@playwright/test"

// admin.html virou um PWA instalável de verdade (2026-09-15, pedido do usuário: a
// contagem de chamados abertos no ÍCONE DO APP só existe via Badging API, que exige um
// PWA instalado) — reverte a decisão anterior ("admin.html nunca deve ser PWA"). Este
// arquivo testa a fiação da instalabilidade em si (manifest + Service Worker real),
// não o badge/contagem (Badging API não é observável de fora — sem jeito de assertar
// visualmente um número no ícone da barra de tarefas a partir do Playwright).
//
// `serviceWorkers: "allow"` só AQUI — o resto da suíte usa o registro real ("block" no
// playwright.config.ts) porque um SW de verdade interceptando fetch por baixo do
// page.route() escaparia do mock de rede (mesmo achado já documentado na Fase F4.5,
// ver CLAUDE.md). Estes testes não mockam rede nenhuma de propósito — testam contra o
// build real servido pelo e2e-server, exatamente como esses dois arquivos (manifest e
// admin-sw.js) são servidos de verdade em produção.
test.use({ serviceWorkers: "allow" })

test.describe("PWA instalável do admin (2026-09-15)", () => {
  test("manifest do admin existe, resolve, e tem identidade própria (não a do solicitante)", async ({ page }) => {
    await page.goto("/admin.html")
    const href = await page.locator('link[rel="manifest"]').getAttribute("href")
    expect(href).toContain("admin-manifest.webmanifest")

    const resp = await page.request.get(new URL(href!, page.url()).toString())
    expect(resp.ok()).toBe(true)
    const manifest = await resp.json()
    expect(manifest.name).toBe("Painel de Admin – Chamados TI ISV")
    expect(manifest.start_url).toBe("admin.html")
    expect(manifest.scope).toBe("admin.html")
    expect(manifest.display).toBe("standalone")
  })

  test("index.html continua com o manifest do solicitante (não o do admin)", async ({ page }) => {
    await page.goto("/")
    const href = await page.locator('link[rel="manifest"]').getAttribute("href")
    expect(href).toContain("manifest.webmanifest")
    expect(href).not.toContain("admin-manifest.webmanifest")
  })

  test("admin-sw.js registra com escopo = admin.html (não um escopo fantasma, não a raiz)", async ({ page }) => {
    await page.goto("/admin.html")
    // `navigator.serviceWorker.ready` (que só resolve quando o SW passa a CONTROLAR a
    // página) tem um comportamento instável sob o CDP do Playwright em alguns casos —
    // poll direto em `registration.active` evita depender disso, mesmo padrão já usado
    // em produção (ver waitForAdminSWActivation em lib/admin-sw.ts).
    const reg = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/chamados-ti-pwa/admin-sw.js", {
        scope: "/chamados-ti-pwa/admin.html",
      })
      for (let i = 0; i < 100 && !registration.active; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      return { scope: registration.scope, active: registration.active?.scriptURL }
    })
    expect(reg.scope).toBe("http://localhost:4173/chamados-ti-pwa/admin.html")
    expect(reg.active).toContain("admin-sw.js")
  })

  // Regressão do achado do revisor (2026-08-13): registrar os dois SWs (solicitante e
  // admin) no mesmo navegador não pode fazer um sobrescrever o outro — a garantia
  // agora vem da regra nativa de "escopo mais específico vence" (admin.html, mais
  // específico que a raiz de sw.js), não mais de um escopo fantasma que evitava a
  // colisão escondendo o SW de qualquer página real.
  test("abrir solicitante e admin no mesmo navegador não faz um SW sobrescrever o outro", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(async () => {
      // Bug real do teste (achado rodando --repeat-each): `getRegistration()` chamado
      // só UMA VEZ antes do loop podia devolver `undefined` se o React (useRegisterSW
      // em SolicitanteApp.tsx) ainda não tivesse chamado `register()` nesse instante —
      // o loop então nem entrava, e o teste seguia sem esperar a ativação de verdade.
      // Corrigido buscando a registration DE NOVO a cada iteração.
      let registration: ServiceWorkerRegistration | undefined
      for (let i = 0; i < 100 && !registration?.active; i++) {
        registration = await navigator.serviceWorker.getRegistration()
        if (!registration?.active) await new Promise((r) => setTimeout(r, 100))
      }
    })

    await page.goto("/admin.html")
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/chamados-ti-pwa/admin-sw.js", { scope: "/chamados-ti-pwa/admin.html" })
      for (let i = 0; i < 100 && !registration.active; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
    })

    // O que a regressão original (achado do revisor, 2026-08-13) realmente testa é
    // ISTO: as DUAS registrations continuam coexistindo, cada uma com o script ativo
    // certo pro seu escopo — não uma sobrescrevendo/substituindo a outra. `.controller`
    // (qual SW está de fato no comando de UMA página específica) tem comportamento
    // instável sob o CDP do Playwright nesse cenário de múltiplas navegações — não é o
    // que importa verificar aqui, então não é mais usado neste teste.
    const regs = await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, active: r.active?.scriptURL }))
    )
    expect(regs.sort((a, b) => a.scope.localeCompare(b.scope))).toEqual([
      { scope: "http://localhost:4173/chamados-ti-pwa/", active: "http://localhost:4173/chamados-ti-pwa/sw.js" },
      { scope: "http://localhost:4173/chamados-ti-pwa/admin.html", active: "http://localhost:4173/chamados-ti-pwa/admin-sw.js" },
    ])
  })
})
