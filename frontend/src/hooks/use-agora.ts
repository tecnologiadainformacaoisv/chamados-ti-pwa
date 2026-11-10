import { useEffect, useState } from "react"

// Relógio leve: devolve "agora" (ms) e atualiza a cada `ms`. Pausa quando a aba está escondida (não gasta
// bateria/CPU em segundo plano) e atualiza na hora em que a pessoa volta.
export function useAgora(ms = 30_000): number {
  const [agora, setAgora] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => setAgora(Date.now())
    const id = setInterval(() => document.visibilityState === "visible" && tick(), ms)
    const aoVoltar = () => document.visibilityState === "visible" && tick()
    document.addEventListener("visibilitychange", aoVoltar)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", aoVoltar)
    }
  }, [ms])
  return agora
}
