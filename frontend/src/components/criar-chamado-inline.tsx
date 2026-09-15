import { useEffect, useRef, useState } from "react"
import { Plus } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TIPOS, SETORES } from "@/lib/constants"
import type { CreateTaskPayload } from "@/lib/api"

// "Adicionar Chamado" inline na Tabela (2026-09-15, mesma mecânica da ClickUp, pedido
// do usuário) — só aparece no grupo "Aberto" de propósito (ver comentário em
// handleAdminCreateTask, push-worker.js): todo chamado sempre nasce aberto, então
// oferecer isso em Pendente/Encerrado criaria uma expectativa que o servidor recusa
// silenciosamente cumprir (o item apareceria no grupo errado depois de criado).
export function CriarChamadoInline({
  solicitantes,
  onCreate,
  creating,
  error,
}: {
  solicitantes: string[]
  onCreate: (payload: CreateTaskPayload) => void
  creating: boolean
  error: string | null
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [solicitante, setSolicitante] = useState("")
  const [tipo, setTipo] = useState("")
  const [setor, setSetor] = useState("")

  function resetAndClose() {
    setName("")
    setSolicitante("")
    setTipo("")
    setSetor("")
    setOpen(false)
  }

  function handleSubmit() {
    if (!name.trim() || !solicitante) return
    onCreate({
      name: name.trim(),
      solicitante,
      tipo: tipo ? Number(tipo) : undefined,
      setor: setor ? Number(setor) : undefined,
    })
  }

  // Fecha sozinho quando `creating` termina sem erro (sucesso) — detecta a borda
  // true→false em vez de reagir a `error` sozinho, pra não fechar o popover bem na
  // hora que o usuário precisa ver a mensagem de erro.
  const wasCreating = useRef(false)
  useEffect(() => {
    if (wasCreating.current && !creating && !error) resetAndClose()
    wasCreating.current = creating
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, error])

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) resetAndClose()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" /> Adicionar Chamado
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">Novo chamado</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="criar-chamado-nome" className="text-xs">Título</Label>
            <Input
              id="criar-chamado-nome"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Impressora sem tinta"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Solicitante</Label>
            <Select value={solicitante} onValueChange={setSolicitante}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Selecione…" /></SelectTrigger>
              <SelectContent>
                {solicitantes.map((nome) => (
                  <SelectItem key={nome} value={nome}>{nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">Tipo</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger className="w-full"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {TIPOS.map((t) => (
                    <SelectItem key={t.orderindex} value={String(t.orderindex)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label className="text-xs">Setor</Label>
              <Select value={setor} onValueChange={setSetor}>
                <SelectTrigger className="w-full"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {SETORES.map((s) => (
                    <SelectItem key={s.orderindex} value={String(s.orderindex)}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={resetAndClose}>Cancelar</Button>
            <Button size="sm" onClick={handleSubmit} disabled={creating || !name.trim() || !solicitante}>
              {creating ? "Criando…" : "Criar"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
