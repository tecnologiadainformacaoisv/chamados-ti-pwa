import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { fetchTasks, isSessionError, type Task } from "@/lib/api"
import { playNotificationSound } from "@/lib/sound"

const POLL_MS = 20_000

// Alerta de chamado novo pro admin (2026-08-13) — recria o "número flutuante" que a
// interface da ClickUp dava, agora que a TI não abre mais ela pra nada. Duas coisas
// distintas aqui, de propósito:
//   - `countAberto`: contagem TOTAL de chamados "aberto" (badge) — sempre a métrica
//     real, sobe na criação, desce sozinha quando aceito. Sem estado "lido/não lido".
//   - `fila`: só os que chegaram DEPOIS que este hook montou (comparado contra o
//     `Set` de ids já vistos) — é o que dispara som + a caixa de aceitar. A primeira
//     carga só REGISTRA os ids existentes, em silêncio (não alerta pra chamados que já
//     estavam abertos antes da TI abrir o painel).
export function useNovosChamados(secret: string, onSessionError: () => void) {
  const queryClient = useQueryClient()
  const knownIds = useRef<Set<string> | null>(null)
  const [fila, setFila] = useState<Task[]>([])

  const query = useQuery({
    queryKey: ["admin-open-count"],
    queryFn: () => fetchTasks(secret, { status: "aberto" }),
    refetchInterval: POLL_MS,
    enabled: !!secret,
  })

  useEffect(() => {
    if (isSessionError(query.error)) onSessionError()
  }, [query.error, onSessionError])

  useEffect(() => {
    const tasks = query.data?.tasks
    if (!tasks) return
    if (knownIds.current === null) {
      knownIds.current = new Set(tasks.map((t) => t.id))
      return
    }
    const novos = tasks.filter((t) => !knownIds.current!.has(t.id))
    if (novos.length) {
      for (const t of novos) knownIds.current!.add(t.id)
      playNotificationSound()
      setFila((prev) => [...prev, ...novos])
    }
  }, [query.data])

  // Reage na hora quando admin-sw.js avisa (push chegou com a aba aberta) — refetch
  // imediato em vez de esperar o próximo ciclo de poll (até 20s de atraso).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "NOVO_CHAMADO") {
        queryClient.invalidateQueries({ queryKey: ["admin-open-count"] })
      }
    }
    navigator.serviceWorker.addEventListener("message", onMessage)
    return () => navigator.serviceWorker.removeEventListener("message", onMessage)
  }, [queryClient])

  // Tira da fila visível — usado tanto pra "dispensar" (fechar sem agir, o chamado
  // continua contando no badge normalmente) quanto depois de aceitar com sucesso.
  const removerDaFila = useCallback((taskId: string) => {
    setFila((prev) => prev.filter((t) => t.id !== taskId))
  }, [])

  return {
    countAberto: query.data?.total ?? 0,
    fila,
    removerDaFila,
  }
}
