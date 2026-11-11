import { useState } from "react"
import { Share, X } from "lucide-react"
import { Button } from "@/components/ui/button"

const DISMISS_KEY = "ios_install_hint_dismissed"

function ehIosNoNavegador(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  // iPadOS 13+ se apresenta como Mac; o toque múltiplo o denuncia.
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  if (!ios) return false
  const instalado =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches
  return !instalado
}

function jaDispensado(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

// iPhone/iPad não disparam `beforeinstallprompt`, então o banner "Instalar o app" nunca aparece
// por lá, e no iOS as notificações só funcionam com o app na Tela de Início. Este aviso ensina o
// caminho manual (2026-11-11, pré-implantação). Só aparece no Safari do iOS, fora do app instalado.
export function IosInstallHint() {
  const [visivel, setVisivel] = useState(() => ehIosNoNavegador() && !jaDispensado())
  if (!visivel) return null

  function dispensar() {
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      // sem armazenamento: o aviso volta na próxima visita, sem problema
    }
    setVisivel(false)
  }

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-accent/10 px-4 py-3 text-sm" role="note">
      <div className="min-w-0 text-foreground">
        <p className="m-0 mb-1 flex items-center gap-2 font-bold">
          <Share className="h-4 w-4 shrink-0" aria-hidden="true" /> Instale o app no seu iPhone
        </p>
        <p className="m-0 text-muted-foreground">
          Toque em <strong className="text-foreground">Compartilhar</strong> e depois em{" "}
          <strong className="text-foreground">Adicionar à Tela de Início</strong>. Só assim você recebe os avisos
          quando o seu chamado for atualizado.
        </p>
      </div>
      <Button size="icon-sm" variant="ghost" onClick={dispensar} aria-label="Fechar aviso de instalação">
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
