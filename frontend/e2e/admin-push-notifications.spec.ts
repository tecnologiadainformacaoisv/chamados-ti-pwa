import { test, expect } from "./helpers/fixtures"
import { mockAdminRoutes, gotoAdminLoggedIn } from "./helpers/fixtures"
import type { Page } from "@playwright/test"

// Diagnóstico de "chamados acontecendo e não estou sendo notificado" (2026-09-15) —
// antes disso não existia NENHUM teste pra esse fluxo: `serviceWorkers: "block"`
// (playwright.config.ts) impede registro de Service Worker real, e PushManager.subscribe
// de verdade exigiria bater num serviço de push real (FCM/Mozilla), inviável em CI. Em
// vez disso, este arquivo troca `navigator.serviceWorker`/`PushManager`/`Notification`
// inteiros por um stub simples via `addInitScript` — o código de produção
// (use-admin-push-notifications.tsx) roda de verdade por cima disso, só a camada do
// navegador é falsa. O que se testa aqui é exatamente o que motivou a mudança: o
// resultado da inscrição com o SERVIDOR agora é visível (ativo/erro), não mais
// silencioso (`.catch(console.warn)`).
async function stubPushApi(page: Page, opts: { permission?: NotificationPermission } = {}) {
  const permission = opts.permission ?? "granted"
  await page.addInitScript((perm) => {
    class FakeSubscription {
      endpoint = "https://fake-push-endpoint.test/e2e-device"
      toJSON() {
        return { endpoint: this.endpoint, keys: { p256dh: "fake-p256dh", auth: "fake-auth" } }
      }
      unsubscribe() {
        return Promise.resolve(true)
      }
    }
    const fakeReg = {
      active: {},
      installing: null,
      waiting: null,
      pushManager: {
        getSubscription: () => Promise.resolve(null),
        subscribe: () => Promise.resolve(new FakeSubscription()),
      },
    }
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => Promise.resolve(fakeReg),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })
    Object.defineProperty(window, "PushManager", { configurable: true, value: function FakePushManager() {} })
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class FakeNotification {
        static permission = perm
        static requestPermission() {
          return Promise.resolve(perm)
        }
      },
    })
  }, permission)
}

test.describe("Notificação push do admin — diagnóstico visível (2026-09-15)", () => {
  test("permissão já concedida + servidor confirma: não mostra barra nenhuma (tela limpa)", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await stubPushApi(page, { permission: "granted" })
    await gotoAdminLoggedIn(page)
    await expect(page.getByRole("heading", { name: "Linha do dia" })).toBeVisible()
    await expect(page.getByText("Notificações push ativas neste navegador.")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Testar notificação" })).toHaveCount(0)
  })

  test("permissão concedida mas o servidor rejeita a inscrição: mostra o erro, não fica em silêncio", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await page.route("**/admin/subscribe", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Erro HTTP 500" }) })
    })
    await stubPushApi(page, { permission: "granted" })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText(/Notificação não confirmada/)).toBeVisible()
    await expect(page.getByText("Notificações push ativas neste navegador.")).not.toBeVisible()
  })

  test("permissão 'default' (nunca pedida): mostra o banner de ativação, não o status", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await stubPushApi(page, { permission: "default" })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText(/Ative as notificações/)).toBeVisible()
    await expect(page.getByText("Notificações push ativas neste navegador.")).not.toBeVisible()
  })
})
