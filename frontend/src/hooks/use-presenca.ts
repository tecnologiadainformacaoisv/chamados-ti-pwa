import { useEffect } from "react"
import { sendPresence } from "@/lib/app-api"

// Sinal de vida da aba (heartbeat), pro painel de admin mostrar quem está online.
// Mecanismos padrão do navegador: setInterval (60 s), Page Visibility API
// (visibilitychange: aba em uso x aba em segundo plano), evento `online` (volta da rede)
// e pagehide + fetch keepalive (avisa que fechou). Falha de rede é ignorada de propósito.
const INTERVALO_MS = 60_000

export function usePresenca(sessionToken: string) {
  useEffect(() => {
    if (!sessionToken) return
    const visivel = () => document.visibilityState === "visible"
    const ping = () => { void sendPresence(sessionToken, { visivel: visivel() }) }
    const aoMudarVisibilidade = () => ping()
    const aoSair = () => { void sendPresence(sessionToken, { saindo: true }) }

    ping()
    const id = window.setInterval(ping, INTERVALO_MS)
    document.addEventListener("visibilitychange", aoMudarVisibilidade)
    window.addEventListener("online", ping)
    window.addEventListener("pagehide", aoSair)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", aoMudarVisibilidade)
      window.removeEventListener("online", ping)
      window.removeEventListener("pagehide", aoSair)
    }
  }, [sessionToken])
}
