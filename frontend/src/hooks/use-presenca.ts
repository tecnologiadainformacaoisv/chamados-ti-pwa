import { useEffect } from "react"
import { sendPresence } from "@/lib/app-api"

// Sinal de vida da aba (heartbeat), pro painel de admin mostrar quem está online.
// Mecanismos padrão do navegador: setInterval (60 s), Page Visibility API
// (visibilitychange: aba em uso x aba em segundo plano), eventos `online` e `pageshow`
// (volta da rede / volta do cache de navegação) e pagehide + fetch keepalive (avisa que
// fechou). Cada aba tem seu `tabId`: fechar uma aba não derruba quem tem outra aberta.
// Falha de rede é ignorada de propósito; sessão morta (401) para os sinais.
const INTERVALO_MS = 60_000

export function usePresenca(sessionToken: string) {
  useEffect(() => {
    if (!sessionToken) return
    const tabId = crypto.randomUUID()
    let parado = false
    const visivel = () => document.visibilityState === "visible"
    const enviar = async (estado: { visivel?: boolean; saindo?: boolean }) => {
      const status = await sendPresence(sessionToken, { tabId, ts: Date.now(), ...estado })
      if (status === 401) parado = true
    }
    const ping = () => { if (!parado) void enviar({ visivel: visivel() }) }
    const aoSair = () => { void enviar({ saindo: true }) }

    ping()
    const id = window.setInterval(ping, INTERVALO_MS)
    document.addEventListener("visibilitychange", ping)
    window.addEventListener("online", ping)
    window.addEventListener("pageshow", ping)
    window.addEventListener("pagehide", aoSair)
    return () => {
      window.clearInterval(id)
      document.removeEventListener("visibilitychange", ping)
      window.removeEventListener("online", ping)
      window.removeEventListener("pageshow", ping)
      window.removeEventListener("pagehide", aoSair)
      aoSair() // logout ou troca de sessão: avisa na hora (se o token já morreu, só dá 401)
    }
  }, [sessionToken])
}
