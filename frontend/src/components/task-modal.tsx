import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { OPERADORES, SOLUCAO_FIELD_ID, STATUS_MAP, STATUS_ORDER } from "@/lib/constants"
import { getCF, type Task, type UpdatePayload } from "@/lib/api"

const SEM_ATRIBUICAO = "__sem__"

// Porta openTaskModal()/o listener de #btn-modal-salvar de admin.js — mesmas duas
// proteções que o revisor pediu em 2026-08-07:
// 1) status fora dos 4 esperados nunca vira "Aberto" em silêncio — avisa explicitamente.
// 2) assigneeId só entra no body se o admin realmente tocou o campo (operadorTouched) —
//    senão, salvar um chamado com 2+ operadores atribuídos apagaria um deles.
export function TaskModal({
  task,
  onClose,
  onSave,
  saving,
  error,
}: {
  task: Task | null
  onClose: () => void
  onSave: (body: UpdatePayload) => void
  saving: boolean
  error: string | null
}) {
  const [status, setStatus] = useState("aberto")
  const [solucao, setSolucao] = useState("")
  const [operador, setOperador] = useState(SEM_ATRIBUICAO)
  const [operadorTouched, setOperadorTouched] = useState(false)
  const [statusDesconhecido, setStatusDesconhecido] = useState<string | null>(null)

  useEffect(() => {
    if (!task) return
    setOperadorTouched(false)
    const statusKey = (task.status?.status || "").toLowerCase()
    if (Object.prototype.hasOwnProperty.call(STATUS_MAP, statusKey)) {
      setStatus(statusKey)
      setStatusDesconhecido(null)
    } else {
      setStatus("aberto")
      setStatusDesconhecido(task.status?.status || "—")
    }
    const assignees = task.assignees ?? []
    setOperador(assignees[0] ? String(assignees[0].id) : SEM_ATRIBUICAO)
    setSolucao((getCF(task, SOLUCAO_FIELD_ID) as string) || "")
  }, [task])

  if (!task) return null

  const assignees = task.assignees ?? []
  const multiplosOperadores = assignees.length > 1

  function handleSave() {
    const body: UpdatePayload = { status, solucao }
    if (operadorTouched) {
      body.assigneeId = operador === SEM_ATRIBUICAO ? null : Number(operador)
    }
    onSave(body)
  }

  return (
    <Dialog open={!!task} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{task.name || "(sem título)"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Descrição (o que o solicitante escreveu)</Label>
            <div className="max-h-36 overflow-y-auto rounded-md border border-border bg-muted/40 p-2.5 text-sm whitespace-pre-line text-foreground">
              {task.description || task.text_content || "(sem descrição)"}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_MAP[s].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {statusDesconhecido && (
              <p className="text-xs text-amber-600">
                ⚠ Status real ("{statusDesconhecido}") não é reconhecido pelo painel — "Aberto" foi pré-selecionado só
                como padrão. Confira antes de salvar.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Operador</Label>
            <Select
              value={operador}
              onValueChange={(v) => {
                setOperador(v)
                setOperadorTouched(true)
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SEM_ATRIBUICAO}>Sem atribuição</SelectItem>
                {Object.entries(OPERADORES).map(([id, nome]) => (
                  <SelectItem key={id} value={id}>{nome}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {multiplosOperadores && (
              <p className="text-xs text-amber-600">
                ⚠ {assignees.length} operadores atribuídos (
                {assignees.map((a) => a.username || OPERADORES[String(a.id)] || `#${a.id}`).join(", ")}). Deixe como
                está se não quiser mudar quem está atribuído — mudar aqui substitui todos por só 1.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Solução</Label>
            <Textarea rows={4} placeholder="Descreva a solução aplicada..." value={solucao} onChange={(e) => setSolucao(e.target.value)} />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
