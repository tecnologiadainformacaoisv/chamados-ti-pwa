import { useCallback, useEffect, useRef, useState } from "react"

export const DESFAZER_MS = 7000

type Acao = { apply: () => void; commit: () => void; rollback: () => void }
type Pendente = { commit: () => void; rollback: () => void; timer: ReturnType<typeof setTimeout> }

// "Desfazer" SEGURO (2026-10-19, Fase 3 do redesign de UX): a ação aparece na tela na hora
// (`apply`, otimista), mas só é ENVIADA ao servidor (`commit`) depois de 7 s. "Desfazer" antes
// disso cancela o envio e restaura a tela (`rollback`) — nada chega ao servidor.
//
// Por que atrasar o envio em vez de reverter depois: aceitar um chamado dispara notificação ao
// solicitante e recalcula campos de SLA (start_date/due_date), então uma reversão posterior não
// voltaria ao estado original de verdade.
//
// Regras: uma ação pendente por vez (a anterior é enviada na hora quando outra começa); sair da
// tela envia o que estiver pendente em vez de perder; fechar a aba nos 7 s avisa antes.
export function useDesfazer() {
  const [aviso, setAviso] = useState<{ mensagem: string; ate: number } | null>(null)
  const pend = useRef<Pendente | null>(null)

  const enviar = useCallback(() => {
    const p = pend.current
    if (!p) return
    clearTimeout(p.timer)
    pend.current = null
    setAviso(null)
    p.commit()
  }, [])

  const desfazer = useCallback(() => {
    const p = pend.current
    if (!p) return
    clearTimeout(p.timer)
    pend.current = null
    setAviso(null)
    p.rollback()
  }, [])

  const agendar = useCallback(
    (mensagem: string, acao: Acao) => {
      enviar()
      acao.apply()
      const timer = setTimeout(() => enviar(), DESFAZER_MS)
      pend.current = { commit: acao.commit, rollback: acao.rollback, timer }
      setAviso({ mensagem, ate: Date.now() + DESFAZER_MS })
    },
    [enviar]
  )

  useEffect(() => () => enviar(), [enviar])

  useEffect(() => {
    function aoSair(e: BeforeUnloadEvent) {
      if (!pend.current) return
      e.preventDefault()
      e.returnValue = ""
    }
    // aba oculta (trocou de aba, minimizou, celular) ou página saindo: envia na hora em vez de perder
    function aoOcultar() {
      if (document.visibilityState === "hidden") enviar()
    }
    window.addEventListener("beforeunload", aoSair)
    window.addEventListener("pagehide", enviar)
    document.addEventListener("visibilitychange", aoOcultar)
    return () => {
      window.removeEventListener("beforeunload", aoSair)
      window.removeEventListener("pagehide", enviar)
      document.removeEventListener("visibilitychange", aoOcultar)
    }
  }, [enviar])

  return { aviso, agendar, desfazer, enviar }
}
