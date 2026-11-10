import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react"
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
// Achado 2026-08-17: "Detalhes adicionais" nunca teve limite nenhum (diferente de
// "Descrição do problema", já capado em 300) — texto sem limite é o pior caso pro
// bug de overflow visto em produção (uma linha comprida sem espaço estourando a
// largura de cards/modais). Mesmo limite generoso o bastante pra não incomodar uso
// normal, só fecha o caso extremo.
const DETALHES_MAX = 1000

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

  // O aviso de "Falta preencher…" some assim que a pessoa corrige algum campo — antes
  // ficava na tela mesmo com o formulário já completo (achado de UX 2026-10-16). Só
  // limpa ESSE aviso: a rejeição de anexo > 10MB e o erro do servidor continuam visíveis.
  useEffect(() => {
    setError((atual) => (atual?.startsWith("Falta preencher") ? null : atual))
  }, [setor, tipo, operador, descricao])
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
    // Diz QUAL campo falta (achado de UX 2026-10-16): "preencha todos os obrigatórios"
    // deixava a pessoa procurando o que faltava.
    const faltando = [
      !setor && "Setor",
      !tipo && "Tipo de solicitação",
      !operador && "Quem vai atender",
      !descricao.trim() && "Descrição do problema",
    ].filter(Boolean)
    if (faltando.length > 0) {
      setError(`Falta preencher: ${faltando.join(", ")}.`)
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
    <div className="overflow-hidden rounded-md border border-[#D5DCE1] bg-card shadow-[0_1px_2px_rgba(10,61,98,0.06)]">
      {/* Cabeçalho do cartão (redesign 2026-11-10): o gradiente grande saiu; o título e a promessa
          do prazo ficam em texto simples, no mesmo tom do resto do app. A faixa azul de 7px à
          esquerda é a mesma linguagem dos cartões de chamado. */}
      <div className="bg-brand-gradient flex items-center gap-3 px-5 py-4 text-white">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/15 text-xl" aria-hidden="true">🛠️</span>
        <div>
          <h2 className="m-0 text-[1.2rem] font-bold">Novo Chamado</h2>
          <p className="m-0 text-[0.92rem] text-white/80">Conte o que está acontecendo. Você acompanha tudo na aba Meus Chamados.</p>
        </div>
      </div>
      <form onSubmit={handleSubmit} onPaste={handlePaste} className="flex flex-col gap-5 p-5 pb-0">
      {/* Solicitante + Setor pareados na mesma linha (pedido do usuário, 2026-08-15:
          "coloque o Setor do lado de solicitante") — simétrico, mesma largura de
          coluna pros dois. Tipo de solicitação desceu pra sua própria linha, largura
          cheia, alinhada com Descrição/Detalhes/Anexo/botão abaixo — mesmo respiro
          que o resto do formulário, em vez de dividir espaço com Setor. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label>Solicitante</Label>
          <p className="text-sm text-muted-foreground">{userName}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label>Setor *</Label>
          <Select value={setor} onValueChange={setSetor}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Selecione..." /></SelectTrigger>
            <SelectContent>
              {SETORES.map((s) => (
                <SelectItem key={s.orderindex} value={String(s.orderindex)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* min-w-0 + w-full no trigger — achado 2026-08-15: SelectTrigger do shadcn é
          `w-fit` por padrão, e um item de grid/flex sem min-w-0 nunca encolhe abaixo
          do conteúdo intrínseco ("grid blowout") — a opção mais longa de TIPOS_FULL
          estourava o container e cortava o texto sem reticências. */}
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label>Tipo de solicitação *</Label>
        <Select value={tipo} onValueChange={setTipo}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Selecione..." /></SelectTrigger>
          <SelectContent>
            {TIPOS.map((t) => (
              <SelectItem key={t.orderindex} value={String(t.orderindex)}>{TIPOS_FULL[t.orderindex]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Dica na hora da escolha: a pessoa sabe QUANDO a TI deve responder antes de enviar. */}
        <p className="m-0 min-h-5 text-[0.9rem] font-medium text-[#1F6FB2]" aria-live="polite">
          {tipo ? `A TI deve aceitar em até ${(PRIORITY[CATEGORIA_PRIORIDADE[Number(tipo)] ?? 3] ?? PRIORITY[3]).slaLabel}.` : ""}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Quem vai atender? *</Label>
        <RadioGroup value={operador} onValueChange={setOperador} className="grid grid-cols-2 gap-3">
          {Object.entries(OPERADORES).map(([id, nome]) => (
            <label
              key={id}
              htmlFor={`op-${id}`}
              className="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-md border-2 border-[#D5DCE1] bg-white px-3 py-2 text-[0.95rem] font-medium transition-colors hover:bg-[#E8F0F6] has-[[data-state=checked]]:border-[#1F6FB2] has-[[data-state=checked]]:bg-[#DCEBFA] has-[[data-state=checked]]:font-bold has-[[data-state=checked]]:text-[#0A3D62]"
            >
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
        <Textarea
          rows={3}
          maxLength={DETALHES_MAX}
          placeholder="Mais informações, se precisar..."
          value={detalhes}
          onChange={(e) => setDetalhes(e.target.value)}
        />
        <p className="text-right text-xs text-muted-foreground">{detalhes.length}/{DETALHES_MAX}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Anexo (opcional)</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Paperclip className="h-4 w-4" /> Escolher arquivo
          </Button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
          <span className="text-xs text-muted-foreground">
            {/* Ctrl+V só existe com teclado: no celular a dica confundia */}
            <span className="hidden md:inline">ou cole um print (Ctrl+V) — </span>
            até {MAX_ANEXO_MB}MB por arquivo
          </span>
        </div>
        {anexos.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {anexos.map((f, i) => (
              <span key={`${f.name}-${i}`} title={f.name} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs">
                <span className="shrink-0">📎</span>
                <span className="min-w-0 truncate">{f.name}</span>
                <button type="button" onClick={() => removerAnexo(i)} aria-label="Remover anexo" className="shrink-0 text-muted-foreground hover:text-foreground">
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

      {/* w-full (não self-start) — .btn-full no vanilla era largura cheia/centralizado;
          "self-start" colava o botão na esquerda, achado 2026-08-14. */}
      {/* Barra do botão presa no rodapé da tela (celular): o formulário é comprido e o botão fica
          sempre à mão, sem precisar rolar até o fim. */}
      <div className="sticky bottom-0 -mx-5 border-t border-[#D5DCE1] bg-card px-5 py-3">
        <Button type="submit" disabled={submitting} size="lg" className="w-full justify-center">
          {submitting ? "Enviando…" : "Abrir Chamado"}
        </Button>
      </div>
      </form>
    </div>
  )
}
