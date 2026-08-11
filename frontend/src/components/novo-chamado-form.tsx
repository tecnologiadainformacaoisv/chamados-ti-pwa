import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useSessionAuth } from "@/hooks/use-session-auth"
import { createTask } from "@/lib/app-api"
import { CATEGORIA_PRIORIDADE, OPERADORES, PRIORITY, SETORES, SETOR_FIELD_ID, TIPOS, TIPOS_FULL, TIPO_FIELD_ID } from "@/lib/constants"
import type { Task } from "@/lib/api"

const DESCRICAO_MAX = 300

// Porta populateForm()/onFormSubmit() de app.js — SOLICITANTE nunca vai no corpo: o
// Worker sempre resolve pela sessão (handleCreateTask em push-worker.js), o mesmo aqui.
// Anexo (upload de arquivo/print) fica de fora desta fase — ver relatório da F4.
export function NovoChamadoForm({ onCreated }: { onCreated: (task: Task, slaLabel: string) => void }) {
  const { sessionToken, userName } = useSessionAuth()
  const [setor, setSetor] = useState("")
  const [tipo, setTipo] = useState("")
  const [operador, setOperador] = useState("")
  const [descricao, setDescricao] = useState("")
  const [detalhes, setDetalhes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!setor || !tipo || !operador || !descricao.trim()) {
      setError("Preencha todos os campos obrigatórios (*)")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const tipoIdx = Number(tipo)
      const prio = CATEGORIA_PRIORIDADE[tipoIdx] ?? 3
      const pInfo = PRIORITY[prio] ?? PRIORITY[3]
      const dueDate = Date.now() + pInfo.slaMs

      const task = await createTask(sessionToken, {
        name: descricao.trim(),
        description: detalhes.trim() || undefined,
        status: "aberto",
        priority: prio,
        due_date: dueDate,
        due_date_time: true,
        assignees: [Number(operador)],
        custom_fields: [
          { id: SETOR_FIELD_ID, value: Number(setor) },
          { id: TIPO_FIELD_ID, value: tipoIdx },
        ],
      })

      setSetor("")
      setTipo("")
      setOperador("")
      setDescricao("")
      setDetalhes("")
      onCreated(task, pInfo.slaLabel)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível abrir o chamado.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-1.5">
        <Label>Solicitante</Label>
        <p className="text-sm text-muted-foreground">{userName}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>Setor *</Label>
          <Select value={setor} onValueChange={setSetor}>
            <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
            <SelectContent>
              {SETORES.map((s) => (
                <SelectItem key={s.orderindex} value={String(s.orderindex)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Tipo de solicitação *</Label>
          <Select value={tipo} onValueChange={setTipo}>
            <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
            <SelectContent>
              {TIPOS.map((t) => (
                <SelectItem key={t.orderindex} value={String(t.orderindex)}>{TIPOS_FULL[t.orderindex]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Quem vai atender? *</Label>
        <RadioGroup value={operador} onValueChange={setOperador} className="flex gap-4">
          {Object.entries(OPERADORES).map(([id, nome]) => (
            <label key={id} htmlFor={`op-${id}`} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
              <RadioGroupItem value={id} id={`op-${id}`} />
              {nome}
            </label>
          ))}
        </RadioGroup>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Descrição do problema *</Label>
        <Textarea
          rows={3}
          maxLength={DESCRICAO_MAX}
          placeholder="Descreva o problema de forma breve e clara..."
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
        />
        <p className="text-right text-xs text-muted-foreground">{descricao.length}/{DESCRICAO_MAX}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Detalhes adicionais (opcional)</Label>
        <Textarea rows={3} placeholder="Mais informações, se precisar..." value={detalhes} onChange={(e) => setDetalhes(e.target.value)} />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? "Enviando…" : "Abrir Chamado"}
      </Button>
    </form>
  )
}
