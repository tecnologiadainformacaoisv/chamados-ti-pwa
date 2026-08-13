// Service Worker MÍNIMO só pro admin (feature de alerta de chamado novo, 2026-08-13).
// Arquivo estático, JS puro — de propósito NÃO passa pelo vite-plugin-pwa/Workbox do
// app de solicitantes (src/sw.ts). admin.html nunca deve ser um PWA instalável (ver
// CLAUDE.md, "Painel de admin") — um Service Worker só de push (sem precache, sem
// manifest, sem install-ability) é uma capacidade diferente disso, mas pra não
// arriscar essa distinção sendo mal-entendida no futuro, o admin ganha o SEU PRÓPRIO
// arquivo, registrado manualmente (ver use-admin-push-notifications.tsx), em vez de
// reaproveitar sw.js do app de solicitantes.
//
// 🛡️ Achado do revisor (2026-08-13, mesmo dia): admin-sw.js e sw.js vivem no MESMO
// diretório (index.html/admin.html são MPA, servidos lado a lado) — registrar os dois
// com o escopo padrão (o diretório inteiro) faz um SUBSTITUIR o outro silenciosamente
// (só pode existir 1 Service Worker Registration ativa por escopo; quem registra por
// último vence). Corrigido registrando este SW com um escopo PRÓPRIO, deliberadamente
// diferente do escopo de sw.js (ver `scope` em use-admin-push-notifications.tsx) — um
// sub-caminho que nenhuma página realmente visita, só pra reservar um "namespace"
// separado no registro de Service Workers do navegador. Isso funciona porque push/
// notificação NÃO dependem deste SW "controlar" a página admin.html (controle de
// página só importa pra interceptar fetch, que este SW nunca faz) — só precisam da
// registration existir e estar ativa. `getAdminUrl()` reconstrói a URL real de
// admin.html a partir desse escopo fake, já que `self.registration.scope` não aponta
// mais pra lá.
//
// Sem `self.__WB_MANIFEST`/`precacheAndRoute` — nada aqui é cacheado, só os dois
// listeners abaixo.

function getAdminUrl() {
  return self.registration.scope.replace(/admin-push-scope\/?$/, "admin.html")
}

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
  const adminUrl = getAdminUrl()
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title, options),
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const client of list) {
          // `includeUncontrolled: true` traz TODO cliente da mesma origem, inclusive
          // abas do app de solicitantes (index.html) — filtra só as do admin, senão
          // manda NOVO_CHAMADO pra quem não sabe o que fazer com isso (inofensivo, mas
          // sem sentido).
          if ("url" in client && client.url.startsWith(adminUrl)) {
            client.postMessage({ type: "NOVO_CHAMADO", data: payload.data ?? {} })
          }
        }
      }),
    ])
  )
})

// Clique na notificação → foca a aba do admin já aberta, ou abre uma nova.
self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const adminUrl = getAdminUrl()
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const appClient = list.find((c) => "url" in c && c.url.startsWith(adminUrl))
      if (appClient && "focus" in appClient) return appClient.focus()
      return self.clients.openWindow(adminUrl)
    })
  )
})
