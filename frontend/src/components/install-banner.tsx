import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useInstallPrompt } from "@/hooks/use-install-prompt"

// Porta .install-banner de css/style.css/js/app.js — achado 2026-08-17
// (varredura completa pedida pelo usuário): nunca foi portado quando o app
// do solicitante virou React. Só existe no app do solicitante — admin.html
// nunca foi PWA (ver CLAUDE.md), não tem `beforeinstallprompt` nenhum lá.
export function InstallBanner() {
  const { visible, install, dismiss } = useInstallPrompt()
  if (!visible) return null
  return <BannerVisivel install={install} dismiss={dismiss} />
}

function BannerVisivel({ install, dismiss }: { install: () => void; dismiss: () => void }) {
  // Espaço no fim da página com a ALTURA REAL do banner (fixo, `flex-wrap`): o texto quebra
  // em 2-3 linhas em tela estreita, então um valor fixo cobria o botão "Abrir Chamado" em
  // alguns aparelhos e sobrava vão em outros (achado de UX 2026-10-16; revisão de código).
  const bannerRef = useRef<HTMLDivElement>(null)
  const [altura, setAltura] = useState(112)
  useEffect(() => {
    const el = bannerRef.current
    if (!el) return
    const medir = () => setAltura(el.offsetHeight)
    medir()
    const ro = new ResizeObserver(medir)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <>
      <div aria-hidden style={{ height: altura }} />
      <div
        ref={bannerRef}
        className="fixed inset-x-0 bottom-0 z-[200] flex flex-wrap items-center gap-3 border-t-2 border-border bg-card p-3.5 shadow-[0_-4px_20px_rgba(0,0,0,0.1)]"
      >
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          <strong className="text-foreground">Instalar o app</strong> – acesso rápido pela tela inicial do seu aparelho
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={dismiss}>Agora não</Button>
          <Button size="sm" onClick={install}>Instalar</Button>
        </div>
      </div>
    </>
  )
}
