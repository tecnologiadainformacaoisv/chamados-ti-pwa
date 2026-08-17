import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { OPERADORES, SOLUCAO_FIELD_ID, STATUS_MAP, STATUS_ORDER } from "@/lib/constants"
import { getCF, fetchEventos, postEvento, isSessionError, fmtDate, type ChamadoEvento, type Task, type UpdatePayload } from "@/lib/api"
import { useAdminAuth } from "@/hooks/use-admin-auth"

const SEM_ATRIBUICAO = "__sem__"

// Formata o "de -> para" de um evento automático (status/operador) pra texto legível
// — de_valor/para_valor vêm como string crua do banco (chave de status, ou id de
// operador como string, ou null = "Sem atribuição").
function formatEventoAutomatico(evento: ChamadoEvento): string {
  function nomeValor(v: string | null): string {
    if (evento.tipo === "status") return v ? (STATUS_MAP as Record<string, { label: string }>)[v]?.label ?? v : "—"
    return v ? OPERADORES[v] ?? `#${v}` : "Sem atribuição"
  }
  const campo = evento.tipo === "status" ? "Status" : "Operador"
  return `${campo} mudou de "${nomeValor(evento.de_valor)}" para "${nomeValor(evento.para_valor)}"`
}

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
  const { secret, logout } = useAdminAuth()
  const queryClient = useQueryClient()

  const [status, setStatus] = useState("aberto")
  const [solucao, setSolucao] = useState("")
  const [operador, setOperador] = useState(SEM_ATRIBUICAO)
  const [operadorTouched, setOperadorTouched] = useState(false)
  const [statusDesconhecido, setStatusDesconhecido] = useState<string | null>(null)

  // Histórico + comentários (Fase B do roadmap pós-MVP-visual, 2026-08-14) — mesmo
  // conceito já validado no Artifact do MVP visual (drawer de detalhe), evoluindo o
  // modal "Gerenciar" existente em vez de introduzir um componente de drawer
  // paralelo (mesmo Dialog, mais conteúdo — não fragmenta a interação já conhecida).
  const eventosQuery = useQuery({
    queryKey: ["chamado-eventos", task?.id],
    queryFn: () => fetchEventos(secret, task!.id),
    enabled: !!task,
  })
  const [notaAutor, setNotaAutor] = useState(SEM_ATRIBUICAO)
  const [notaTexto, setNotaTexto] = useState("")
  const [notaError, setNotaError] = useState<string | null>(null)
  const notaMutation = useMutation({
    mutationFn: () => {
      const nomeAutor = OPERADORES[notaAutor] ?? notaAutor
      return postEvento(secret, task!.id, nomeAutor, notaTexto.trim())
    },
    onSuccess: () => {
      setNotaTexto("")
      setNotaError(null)
      queryClient.invalidateQueries({ queryKey: ["chamado-eventos", task?.id] })
    },
    // Achado do revisor (2026-08-14): erro que não fosse sessão expirada era engolido
    // em silêncio — o botão só voltava a ficar clicável, sem indicar que a nota não
    // foi salva. Mesmo padrão de `error`/Alert que o resto do modal já usa.
    onError: (err) => {
      if (isSessionError(err)) { logout(); return }
      setNotaError(err instanceof Error ? err.message : "Não foi possível adicionar a nota.")
    },
  })

  useEffect(() => {
    if (!task) return
    setOperadorTouched(false)
    setNotaAutor(SEM_ATRIBUICAO)
    setNotaTexto("")
    setNotaError(null)
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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{task.name || "(sem título)"}</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 flex-1 overflow-y-auto pr-1">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label>Descrição (o que o solicitante escreveu)</Label>
            {/* min-w-0 + break-words — achado 2026-08-17: descrição é texto livre e
                SEM limite de tamanho no formulário ("Detalhes adicionais" não tem
                maxLength); sem isso, uma linha comprida sem espaço estourava a
                largura do modal inteiro (mesmo bug visto em produção no alerta de
                chamado novo). */}
            <div className="max-h-36 min-w-0 overflow-y-auto rounded-md border border-border bg-muted/40 p-2.5 text-sm break-words whitespace-pre-line text-foreground">
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

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <Label>Histórico e comentários</Label>
            {eventosQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Carregando…</p>
            ) : eventosQuery.isError ? (
              <p className="text-xs text-destructive">Não foi possível carregar o histórico.</p>
            ) : eventosQuery.data?.eventos.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum evento ainda.</p>
            ) : (
              <ul className="flex max-h-48 min-w-0 flex-col gap-2.5 overflow-y-auto">
                {eventosQuery.data?.eventos.map((ev) => (
                  <li key={ev.id} className="min-w-0 text-sm">
                    {ev.tipo === "nota" ? (
                      <div className="min-w-0 rounded-md border border-border bg-muted/40 p-2.5">
                        <div className="mb-0.5 flex min-w-0 items-baseline justify-between gap-2">
                          <span className="truncate font-medium">{ev.autor}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(ev.created_at)}</span>
                        </div>
                        {/* break-words — nota interna é texto livre digitado pela TI,
                            sem limite de tamanho, mesmo risco de overflow. */}
                        <p className="break-words whitespace-pre-line text-foreground">{ev.texto}</p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {formatEventoAutomatico(ev)} <span className="text-muted-foreground/70">— {fmtDate(ev.created_at)}</span>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
              <div className="flex gap-2">
                <Select value={notaAutor} onValueChange={setNotaAutor}>
                  <SelectTrigger className="w-36"><SelectValue placeholder="Quem escreve?" /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(OPERADORES).map(([id, nome]) => (
                      <SelectItem key={id} value={id}>{nome}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  rows={2}
                  placeholder="Escrever nota interna (visível só pra TI)..."
                  value={notaTexto}
                  onChange={(e) => setNotaTexto(e.target.value)}
                  className="flex-1"
                />
              </div>
              {notaError && (
                <Alert variant="destructive">
                  <AlertDescription>{notaError}</AlertDescription>
                </Alert>
              )}
              <Button
                size="sm"
                variant="outline"
                className="self-end"
                disabled={notaAutor === SEM_ATRIBUICAO || !notaTexto.trim() || notaMutation.isPending}
                onClick={() => notaMutation.mutate()}
              >
                {notaMutation.isPending ? "Adicionando…" : "Adicionar nota"}
              </Button>
            </div>
          </div>
        </div>
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
