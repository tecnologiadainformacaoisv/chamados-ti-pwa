// Service Worker só pro admin (feature de alerta de chamado novo, 2026-08-13). Arquivo
// estático, JS puro — de propósito NÃO passa pelo vite-plugin-pwa/Workbox do app de
// solicitantes (src/sw.ts). Registrado manualmente (ver use-admin-push-notifications.tsx
// e use-admin-app-badge.tsx), não via injectRegister.
//
// 🔄 2026-09-15: admin.html virou um PWA instalável de verdade (pedido do usuário: a
// contagem de chamados abertos no ícone do app só existe via Badging API, que exige um
// PWA instalado). Reverte a decisão anterior ("admin.html nunca deve ser PWA", ver
// histórico do CLAUDE.md) — mas continua um Service Worker DELIBERADAMENTE mínimo: SEM
// precache, SEM cache de nenhum asset (só os dois listeners de push já existentes + um
// `fetch` passivo, abaixo) — o incidente de cache de 2026-08-10 (lista de assets fixa
// desincronizando do build) foi causado exatamente por um SW cacheando agressivamente
// sem Workbox cuidando do hashing; não repetir isso aqui só porque virou instalável.
//
// 🛡️ Achado do revisor (2026-08-13, mesmo dia): admin-sw.js e sw.js vivem no MESMO
// diretório (index.html/admin.html são MPA, servidos lado a lado) — registrar os dois
// com o MESMO escopo faz um SUBSTITUIR o outro silenciosamente (só pode existir 1
// Service Worker Registration ativa por escopo exato; quem registra por último vence).
// Corrigido originalmente com um escopo "fantasma" que nenhuma página visitava — agora
// que este SW precisa CONTROLAR admin.html de verdade (exigência de instalabilidade),
// o escopo passou a ser `${base}admin.html` (o caminho do próprio admin.html) — mais
// ESPECÍFICO que o escopo de sw.js (`${base}`, a raiz), e a regra de "escopo mais
// específico vence" do próprio Service Worker (não uma convenção deste projeto) resolve
// a ambiguidade sozinha: admin.html é controlado por este SW, index.html continua
// controlado por sw.js, sem colisão nenhuma — sem precisar de escopo fantasma.
// `self.registration.scope` agora É literalmente a URL de admin.html (não precisa mais
// reconstruir nada a partir de um sub-caminho fake).
function getAdminUrl() {
  return self.registration.scope
}

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim())
})

// Passthrough deliberado — existe só pra satisfazer o critério de instalabilidade de
// alguns navegadores ("tem Service Worker com handler de fetch registrado"), sem
// interceptar/cachear nada de verdade (ver nota grande no topo do arquivo).
self.addEventListener("fetch", () => {})

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
