import { useEffect, useState } from "react"

// Aviso com contagem regressiva do "Desfazer" (ver hooks/use-desfazer.tsx).
// A região `aria-live` fica SEMPRE montada (só o texto troca): muitos leitores de tela não anunciam uma
// região viva que já nasce com conteúdo. A barra visível não é `role="status"` pra não anunciar duas vezes.
// Atalho: tecla U desfaz enquanto o aviso estiver na tela (tratado em gestao-view.tsx).
export function DesfazerAviso({
  aviso,
  onDesfazer,
}: {
  aviso: { mensagem: string; ate: number } | null
  onDesfazer: () => void
}) {
  const [seg, setSeg] = useState(7)
  useEffect(() => {
    if (!aviso) return
    const atualizar = () => setSeg(Math.max(0, Math.ceil((aviso.ate - Date.now()) / 1000)))
    atualizar()
    const id = setInterval(atualizar, 250)
    return () => clearInterval(id)
  }, [aviso])

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {aviso ? `${aviso.mensagem}. Tecla U ou o botão Desfazer cancela.` : ""}
      </div>
      {aviso && (
        <div className="fixed bottom-6 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-lg bg-foreground px-4 py-2.5 text-sm text-background shadow-lg">
          <span className="min-w-0 truncate">{aviso.mensagem}</span>
          <span className="tabular-nums text-background/70" aria-hidden="true">{seg}s</span>
          <button
            type="button"
            onClick={onDesfazer}
            className="rounded border border-background/60 px-3 py-1 font-medium hover:bg-background/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-background"
          >
            Desfazer <kbd className="ml-1 rounded bg-background/20 px-1 text-xs">U</kbd>
          </button>
        </div>
      )}
    </>
  )
}
