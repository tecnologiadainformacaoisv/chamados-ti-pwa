import { useEffect, useMemo, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

export type Comando = { id: string; rotulo: string; dica?: string; executar: () => void }

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

// Paleta de comandos (Ctrl+K, Fase 3 do redesign de UX, 2026-10-19): digita e executa, sem
// procurar botão. Os comandos vêm prontos da Gestão (mesmas ações que já existem na tela).
export function CommandPalette({
  aberto,
  onFechar,
  comandos,
}: {
  aberto: boolean
  onFechar: () => void
  comandos: Comando[]
}) {
  const [q, setQ] = useState("")
  const [sel, setSel] = useState(0)

  useEffect(() => {
    if (aberto) {
      setQ("")
      setSel(0)
    }
  }, [aberto])

  const lista = useMemo(() => {
    const t = semAcento(q.trim())
    return comandos.filter((c) => !t || semAcento(c.rotulo).includes(t)).slice(0, 12)
  }, [q, comandos])

  // lista encolheu (ex.: atualização trouxe menos chamados): mantém a seleção dentro dela
  useEffect(() => {
    if (sel > lista.length - 1) setSel(Math.max(0, lista.length - 1))
  }, [lista.length, sel])
  // o item ativo acompanha a seta pra baixo/cima quando a lista rola
  useEffect(() => {
    if (lista[sel]) document.getElementById(`paleta-${lista[sel].id}`)?.scrollIntoView({ block: "nearest" })
  }, [sel, lista])

  function executar(i: number) {
    const c = lista[i]
    if (!c) return
    onFechar()
    setTimeout(c.executar, 30)
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-lg" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Comandos</DialogTitle>
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="paleta-lista"
          aria-activedescendant={lista[sel] ? `paleta-${lista[sel].id}` : undefined}
          aria-label="Digite um comando ou o nome de um chamado"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setSel((s) => Math.min(lista.length - 1, s + 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setSel((s) => Math.max(0, s - 1))
            } else if (e.key === "Enter") {
              e.preventDefault()
              executar(sel)
            }
          }}
          placeholder="Digite um comando ou o nome de um chamado"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-base outline-none"
        />
        <ul id="paleta-lista" role="listbox" className="max-h-[50vh] overflow-auto p-1.5">
          {lista.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">Nenhum comando encontrado.</li>}
          {lista.map((c, i) => (
            <li
              key={c.id}
              id={`paleta-${c.id}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => executar(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 ${
                i === sel ? "bg-primary text-primary-foreground" : ""
              }`}
            >
              <span className="min-w-0 truncate">{c.rotulo}</span>
              {c.dica && <span className="shrink-0 text-xs opacity-75">{c.dica}</span>}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
