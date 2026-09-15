import { useEffect } from "react"
import { registerAdminSW } from "@/lib/admin-sw"

// Contagem de chamados abertos no ÍCONE DO APP (2026-09-15, pedido do usuário) — usa a
// Badging API (`navigator.setAppBadge`/`clearAppBadge`), que só tem efeito visual real
// quando a página está sendo executada como um PWA instalado (ver admin.html/
// admin-manifest.webmanifest/admin-sw.js) — chamar isso numa aba comum não instalada é
// um no-op silencioso, sem erro. Suporte de navegador é parcial (Chrome/Edge desktop,
// Chrome Android; Firefox/Safari não implementam ainda) — por isso o feature-detect
// (`"setAppBadge" in navigator`) e o try/catch: nunca deve quebrar o painel por causa
// de uma API best-effort.
//
// Registra o Service Worker do admin de forma INCONDICIONAL aqui (não só quando o
// admin ativa notificações push, ver use-admin-push-notifications.tsx) — a instalação
// do PWA exige uma registration ativa no escopo de admin.html desde o primeiro
// carregamento, senão o navegador nunca oferece "Instalar app" pra quem ainda não
// mexeu em notificação nenhuma. `register()` com a mesma URL+scope é idempotente, then
// não duplica nada quando o hook de push também registra depois.
export function useAdminAppBadge(count: number) {
  useEffect(() => {
    registerAdminSW().catch(() => {})
  }, [])

  useEffect(() => {
    if (!("setAppBadge" in navigator)) return
    const nav = navigator as Navigator & {
      setAppBadge: (n?: number) => Promise<void>
      clearAppBadge: () => Promise<void>
    }
    const p = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()
    p.catch(() => {}) // best-effort — API ainda instável em alguns navegadores
  }, [count])
}
