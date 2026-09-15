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
  test("permissão já concedida + servidor confirma: mostra 'Notificações push ativas'", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await stubPushApi(page, { permission: "granted" })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Notificações push ativas neste navegador.")).toBeVisible()
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

  test("botão 'Testar notificação' funciona: dispara POST /admin/subscribe/test e mostra 'Teste chegou'", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    let testCalled = false
    await page.route("**/admin/subscribe/test", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      testCalled = true
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' })
    })
    await stubPushApi(page, { permission: "granted" })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Notificações push ativas neste navegador.")).toBeVisible()

    await page.getByRole("button", { name: "Testar notificação" }).click()
    await expect.poll(() => testCalled).toBe(true)
    await expect(page.getByText("Teste chegou")).toBeVisible()
  })

  test("botão 'Testar notificação' mostra falha quando o servidor rejeita o teste", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await page.route("**/admin/subscribe/test", (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback()
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: 'nenhuma inscrição salva pra esse device — clique em "Ativar" primeiro' }) })
    })
    await stubPushApi(page, { permission: "granted" })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText("Notificações push ativas neste navegador.")).toBeVisible()

    await page.getByRole("button", { name: "Testar notificação" }).click()
    await expect(page.getByText(/Notificação não confirmada/)).toBeVisible()
  })

  test("permissão 'default' (nunca pedida): mostra o banner de ativação, não o status", async ({ page }) => {
    await mockAdminRoutes(page, { tasks: [] })
    await stubPushApi(page, { permission: "default" })
    await gotoAdminLoggedIn(page)
    await expect(page.getByText(/Ative as notificações/)).toBeVisible()
    await expect(page.getByText("Notificações push ativas neste navegador.")).not.toBeVisible()
  })
})
