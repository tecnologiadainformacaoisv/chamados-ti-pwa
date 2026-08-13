// Service Worker MÍNIMO só pro admin (feature de alerta de chamado novo, 2026-08-13).
// Arquivo estático, JS puro — de propósito NÃO passa pelo vite-plugin-pwa/Workbox do
// app de solicitantes (src/sw.ts). admin.html nunca deve ser um PWA instalável (ver
// CLAUDE.md, "Painel de admin") — um Service Worker só de push (sem precache, sem
// manifest, sem install-ability) é uma capacidade diferente disso, mas pra não
// arriscar essa distinção sendo mal-entendida no futuro, o admin ganha o SEU PRÓPRIO
// arquivo, registrado manualmente (ver use-admin-push-notifications.tsx), em vez de
// reaproveitar sw.js do app de solicitantes.
//
// Sem `self.__WB_MANIFEST`/`precacheAndRoute` — nada aqui é cacheado, só os dois
// listeners abaixo.

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim())
})

// Push notification recebida — mostra a notificação do SO E avisa qualquer aba do
// admin já aberta na hora (postMessage), pra ela reagir sem esperar o próximo ciclo
// de poll de use-novos-chamados.tsx (mesma ideia do OPEN_TASK que sw.ts já usa pro
// lado solicitante, só que aqui é "novo chamado" em vez de "abrir chamado").
self.addEventListener("push", (e) => {
  const payload = e.data?.json() ?? { title: "Chamados de TI – ISV", body: "Novo chamado" }
  const options = {
    body: payload.body,
    icon: "./icon.svg",
    badge: "./icon.svg",
    tag: `admin-${payload.data?.task_id ?? "novo-chamado"}`,
    renotify: true,
    data: payload.data ?? {},
  }
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title, options),
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const client of list) client.postMessage({ type: "NOVO_CHAMADO", data: payload.data ?? {} })
      }),
    ])
  )
})

// Clique na notificação → foca a aba do admin já aberta, ou abre uma nova.
self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const appClient = list.find((c) => "url" in c && c.url.startsWith(self.registration.scope))
      if (appClient && "focus" in appClient) return appClient.focus()
      return self.clients.openWindow(self.registration.scope)
    })
  )
})
