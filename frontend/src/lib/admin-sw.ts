// Registro do Service Worker do admin (admin-sw.js, arquivo estático em public/) —
// extraído pra cá em 2026-09-15 porque passou a ter DOIS consumidores: o hook de push
// (use-admin-push-notifications.tsx, já existia) e o hook do badge no ícone do app
// (use-admin-app-badge.tsx, novo) — os dois precisam da MESMA registration ativa, e
// `navigator.serviceWorker.register()` com a mesma URL+scope é idempotente (devolve a
// registration existente em vez de duplicar), então não tem problema os dois chamarem.
//
// 🔄 2026-09-15: admin.html virou um PWA instalável de verdade (ver admin-sw.js pro
// porquê) — o escopo deixou de ser um sub-caminho "fantasma" e passou a ser o próprio
// `admin.html`, mais ESPECÍFICO que o escopo de sw.js (a raiz) — a regra do próprio
// Service Worker de "escopo mais específico vence" evita a colisão descrita no achado
// do revisor de 2026-08-13, sem precisar de escopo fake.
export async function registerAdminSW(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null
  const base = import.meta.env.BASE_URL
  return navigator.serviceWorker.register(`${base}admin-sw.js`, { scope: `${base}admin.html` })
}

// Espera a registration ficar ativa. Como o escopo agora inclui admin.html de verdade,
// `navigator.serviceWorker.ready` funcionaria também — mas resolver direto na própria
// registration evita qualquer ambiguidade com o SW do app de solicitantes numa aba que,
// por algum motivo, tenha os dois carregados (nunca deveria acontecer, mas é mais barato
// não depender disso).
export function waitForAdminSWActivation(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return Promise.resolve()
  const worker = reg.installing || reg.waiting
  if (!worker) return Promise.resolve()
  return new Promise((resolve) => {
    worker.addEventListener("statechange", function onStateChange() {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onStateChange)
        resolve()
      }
    })
  })
}
