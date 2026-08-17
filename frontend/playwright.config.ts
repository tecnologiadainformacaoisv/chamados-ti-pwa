import { defineConfig, devices } from "@playwright/test"

// Suíte E2E permanente (2026-08-17) — pedido explícito do usuário depois de uma sessão
// inteira achando regressão visual só reativamente (print → investigação → fix). Roda
// contra `vite preview` (build real, não dev server — mais fiel ao que vai pro GitHub
// Pages).
//
// Achado escrevendo isto: `npm run build` sempre invoca `vite build` (nunca `vite dev`),
// e `command` pro Vite é `'build'` em QUALQUER `vite build`, então o `base` de produção
// (`/chamados-ti-pwa/`, ver vite.config.ts) fica GRAVADO nos caminhos de asset do
// `index.html`/`admin.html` dentro de `dist/` — `vite preview` só serve esse dist
// estático depois, não reescreve nada. Testar em `baseURL: 'http://localhost:4173/'`
// puro dava 404 em todo asset. `baseURL` aqui aponta pro subpath de propósito — é
// literalmente o mesmo truque de "estagiar num subpath" que os scripts ad-hoc desta
// sessão inteira fizeram manualmente no scratchpad, só que fixado na config em vez de
// repetido em cada script.
//
// Não bloqueia o deploy (decisão explícita do usuário, 2026-08-17) — roda numa workflow
// separada (.github/workflows/e2e-frontend.yml), sem `needs:` nenhum ligando ao
// deploy-frontend.yml. Serve como um segundo par de olhos automático, não um gate.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  timeout: 30_000,

  use: {
    baseURL: "http://localhost:4173/chamados-ti-pwa/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // As mesmas rotas do app usam SW real (registerType:autoUpdate, ver vite.config.ts) —
    // bloqueado aqui por padrão: um SW real interceptando fetch por baixo do
    // page.route() já causou um problema documentado na Fase F4.5 (ver CLAUDE.md) —
    // mesmo motivo pelo qual os scripts ad-hoc desta sessão sempre bloquearam também.
    serviceWorkers: "block",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      // Viewport de celular, mas em Chromium (não no preset "iPhone 13" — esse usa
      // WebKit por padrão, e só o Chromium foi instalado, mesmo padrão usado a sessão
      // inteira nos scripts ad-hoc). 390px é a viewport que expôs o bug do modal em
      // bottom-sheet (2026-08-17) e está bem abaixo do breakpoint (600px) que
      // css/style.css sempre usou pro tratamento mobile do app do solicitante.
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
  ],

  webServer: {
    command: "npm run build && node scripts/e2e-server.mjs",
    url: "http://localhost:4173/chamados-ti-pwa/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
