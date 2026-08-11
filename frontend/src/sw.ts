/// <reference lib="webworker" />
// Porta os handlers de push/notificationclick/fetch de sw.js — só o precache de assets
// muda: aqui é o Workbox (via `injectManifest`) quem monta a lista, com revisão por
// arquivo, em vez de uma lista de nomes fixos escrita à mão. Isso elimina a classe de
// bug do incidente de 2026-08-10 (cache de um arquivo que não existia mais/tinha nome
// diferente) — os nomes com hash do Vite nunca precisam ser mantidos à mão aqui.
import { precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim())
})

// Push notification recebida
self.addEventListener("push", (e) => {
  const payload = e.data?.json() ?? { title: "Chamados de TI – ISV", body: "Atualização recebida" }
  // `renotify` é padrão da Notifications API, mas o lib.dom desta versão do TS não
  // declara essa propriedade — objeto separado (em vez de literal inline) evita a
  // checagem de "excess property" sem precisar de cast em tudo.
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body,
    icon: "./icon.svg",
    badge: "./icon.svg",
    tag: `task-${payload.data?.task_id ?? "update"}`,
    renotify: true,
    data: payload.data ?? {},
  }
  e.waitUntil(self.registration.showNotification(payload.title, options))
})

// Clique na notificação → abre o chamado específico
self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const { task_id, status } = e.notification.data ?? {}
  const tab = status === "encerrado" ? "todos-chamados" : "meus-chamados"
  const target = task_id ? `${tab}:${task_id}` : tab

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      const appClient = list.find((c) => "url" in c && c.url.startsWith(self.registration.scope))
      if (appClient && "focus" in appClient) {
        // App já aberto: manda mensagem pra navegar até o chamado
        appClient.postMessage({ type: "OPEN_TASK", tab, task_id })
        return appClient.focus()
      }
      // App fechado: abre na aba/chamado certo via hash
      return self.clients.openWindow(`${self.registration.scope}#${target}`)
    }),
  )
})

// Mesmo bypass de fetch do sw.js — nunca deixar o Workbox/cache interceptar chamada de
// API (proxy do Worker) nem requisição não-GET (corpo só pode ser lido uma vez; era
// justamente isso que quebrava "Abrir Chamado" no incidente de 2026-08-10).
self.addEventListener("fetch", (e) => {
  const isApiCall = e.request.url.includes("workers.dev")
  if (isApiCall || e.request.method !== "GET") {
    e.respondWith(fetch(e.request))
  }
})
