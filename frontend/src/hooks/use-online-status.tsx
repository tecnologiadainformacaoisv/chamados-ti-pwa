import { useEffect, useState } from "react"

// Porta setupOfflineBanner() de js/app.js — navigator.onLine + eventos
// online/offline da window. Achado 2026-08-17 (varredura completa css/style.css
// vs frontend/src pedida pelo usuário): nunca foi portado quando o app do
// solicitante virou React (Fase F1/F4, 2026-08-11) — CLAUDE.md já documentava
// "suporte offline básico" como feature entregue (v0.2.0), então isso era uma
// regressão real, não só estética.
export function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])

  return online
}
