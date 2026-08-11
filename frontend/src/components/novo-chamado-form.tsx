import { useRef, useState, type ClipboardEvent, type FormEvent } from "react"
import { Paperclip, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useSessionAuth } from "@/hooks/use-session-auth"
import { createTask, uploadAttachment } from "@/lib/app-api"
import { filtrarAnexosValidos, imagensDoClipboard } from "@/lib/anexo-helpers"
import { CATEGORIA_PRIORIDADE, MAX_ANEXO_MB, OPERADORES, PRIORITY, SETORES, SETOR_FIELD_ID, TIPOS, TIPOS_FULL, TIPO_FIELD_ID } from "@/lib/constants"
import type { Task } from "@/lib/api"

const DESCRICAO_MAX = 300

// Porta populateForm()/onFormSubmit() de app.js — SOLICITANTE nunca vai no corpo: o
// Worker sempre resolve pela sessão (handleCreateTask em push-worker.js), o mesmo aqui.
// `anexoWarning` (F4.5) avisa quando o chamado abriu mas o anexo falhou — mostrado no
// modal de WhatsApp, que continua visível mesmo depois da troca de aba pra Meus Chamados.
export function NovoChamadoForm({ onCreated }: { onCreated: (task: Task, slaLabel: string, anexoWarning?: string) => void }) {
  const { sessionToken, userName } = useSessionAuth()
  const [setor, setSetor] = useState("")
  const [tipo, setTipo] = useState("")
  const [operador, setOperador] = useState("")
  const [descricao, setDescricao] = useState("")
  const [detalhes, setDetalhes] = useState("")
  const [anexos, setAnexos] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function adicionarAnexos(novos: File[]) {
    const { validos, rejeitados } = filtrarAnexosValidos(novos)
    if (rejeitados.length > 0) {
      setError(`Arquivo(s) acima de ${MAX_ANEXO_MB}MB não foram anexados: ${rejeitados.map((f) => f.name).join(", ")}`)
    }
    if (validos.length > 0) setAnexos((prev) => [...prev, ...validos])
  }

  function handleFileChange() {
    adicionarAnexos(Array.from(fileInputRef.current?.files || []))
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function handlePaste(e: ClipboardEvent<HTMLFormElement>) {
    const imagens = imagensDoClipboard(e.clipboardData?.items)
    if (imagens.length === 0) return
    e.preventDefault()
    adicionarAnexos(imagens)
  }

  function removerAnexo(idx: number) {
    setAnexos((prev) => prev.filter((_, i) => i !== idx))
  }

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

      let anexoWarning: string | undefined
      if (anexos.length > 0) {
        try {
          await Promise.all(anexos.map((file) => uploadAttachment(sessionToken, task.id, file)))
        } catch {
          anexoWarning = "Chamado aberto, mas houve um erro ao enviar o anexo."
        }
      }

      setSetor("")
      setTipo("")
      setOperador("")
      setDescricao("")
      setDetalhes("")
      setAnexos([])
      onCreated(task, pInfo.slaLabel, anexoWarning)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível abrir o chamado.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} onPaste={handlePaste} className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-sm">
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

      <div className="flex flex-col gap-1.5">
        <Label>Anexo (opcional)</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Paperclip className="h-4 w-4" /> Escolher arquivo
          </Button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
          <span className="text-xs text-muted-foreground">ou cole um print (Ctrl+V) — até {MAX_ANEXO_MB}MB por arquivo</span>
        </div>
        {anexos.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {anexos.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs">
                📎 {f.name}
                <button type="button" onClick={() => removerAnexo(i)} aria-label="Remover anexo" className="text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
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
