import { useEffect, useState } from "react"

// Evento não-padrão (ainda não faz parte do lib.dom.d.ts do TS) — mesmo shape
// usado em js/app.js (deferredInstallPrompt).
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

// Porta setupInstallBanner()/deferredInstallPrompt de js/app.js — achado
// 2026-08-17 (varredura completa pedida pelo usuário): nunca foi portado
// quando o app do solicitante virou React. Diferente do vanilla (que só
// verificava o evento uma vez, em initApp — se o navegador disparasse
// beforeinstallprompt depois disso, o banner nunca aparecia), aqui o listener
// fica montado o app inteiro, então funciona não importa quando o evento
// chegar.
export function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    function onBeforeInstall(e: Event) {
      e.preventDefault()
      setPromptEvent(e as BeforeInstallPromptEvent)
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall)
  }, [])

  async function install() {
    if (!promptEvent) return
    await promptEvent.prompt()
    await promptEvent.userChoice
    setPromptEvent(null)
  }

  function dismiss() {
    setDismissed(true)
  }

  return {
    visible: !!promptEvent && !dismissed,
    install,
    dismiss,
  }
}
