import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { MessageCircle, Paperclip } from "lucide-react"
import { getCF, fmtDate, type Attachment, type Task } from "@/lib/api"
import { isOverdue, overdueFor, slaProgressInfo, timeAgo, timeUntil, waLinkForTask } from "@/lib/ticket-helpers"
import { OPERADORES, PRIORITY, SETORES, SETOR_FIELD_ID, SOLUCAO_FIELD_ID, STATUS_MAP, TIPOS, TIPO_FIELD_ID, optionName, type StatusKey } from "@/lib/constants"
import { useSessionAuth } from "@/hooks/use-session-auth"
import { fetchTaskDetail } from "@/lib/app-api"
import { AnexoModal } from "@/components/anexo-modal"

// Porta renderDetailCard() de app.js — mesmo cartão: barra de progresso do SLA, banner de
// atraso, cor de fundo por status, solução em destaque quando encerrado.
export function TicketCard({ task }: { task: Task }) {
  const { sessionToken } = useSessionAuth()
  const [anexoAberto, setAnexoAberto] = useState<Attachment | null>(null)

  // Porta loadAttachments()/attachmentsCache de app.js — a listagem de /my-tasks não
  // devolve anexo, só o GET de uma task individual. Keyed por date_updated: o próprio
  // TanStack Query já vira o cache "por versão da task" que antes era um Map manual.
  const anexosQuery = useQuery({
    queryKey: ["task-attachments", task.id, task.date_updated],
    queryFn: () => fetchTaskDetail(sessionToken, task.id).then((t) => t.attachments ?? []),
    staleTime: Infinity,
  })
  const anexos = anexosQuery.data ?? []

  const statusKey = (task.status?.status as StatusKey) ?? "aberto"
  const info = STATUS_MAP[statusKey] ?? STATUS_MAP.aberto
  const prioId = task.priority?.priority
  // task.priority aqui vem da ClickUp como nome (urgent/high/normal) em vez do número —
  // mapeia pro mesmo PRIORITY por label, já que app-api usa PRIORITY indexado por id numérico.
  const prioEntry = Object.values(PRIORITY).find((p) => p.label.toLowerCase() === String(prioId).toLowerCase())
  const overdue = isOverdue(task)
  const oText = overdueFor(task)
  const sla = slaProgressInfo(task)

  const tipoIdx = Number(getCF(task, TIPO_FIELD_ID))
  const setorIdx = Number(getCF(task, SETOR_FIELD_ID))
  const tipoName = TIPOS.find((t) => t.orderindex === tipoIdx)?.name ?? optionName(TIPOS, tipoIdx)
  const setorName = optionName(SETORES, setorIdx)
  const solucao = statusKey === "encerrado" ? (getCF(task, SOLUCAO_FIELD_ID) as string | null) : null

  const desc = (task.text_content || task.description || "").trim()
  const dueFuture = statusKey === "encerrado" || statusKey === "pendente" ? null : timeUntil(task.due_date)
  const assignees = (task.assignees ?? []).map((a) => a.username || OPERADORES[String(a.id)] || `#${a.id}`).join(", ")

  return (
    <div
      data-task-id={task.id}
      className={`relative overflow-hidden rounded-lg border p-4 shadow-sm ${overdue ? "border-destructive/50" : "border-border"}`}
      style={{ background: statusBg(statusKey) }}
    >
      {sla && (
        <div className="absolute inset-x-0 top-0 h-1 bg-black/10">
          <div className="h-full transition-all" style={{ width: `${sla.pct}%`, background: sla.color }} />
        </div>
      )}

      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>Atualizado {timeAgo(task.date_created)}</span>
        <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: info.dot }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: info.dot }} />
          {info.label}
        </span>
      </div>

      {overdue && (
        <div className="mb-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive">
          ⚠ {oText}
        </div>
      )}

      {/* break-words — achado 2026-08-17: título/descrição são texto livre do próprio
          solicitante (descrição sem limite de tamanho nenhum), sem isso uma string
          comprida sem espaço estourava a largura do card inteiro (visto em produção
          num caso parecido, ver novo-chamado-alert.tsx). Card mais visto por usuários
          reais no app — prioridade alta pra esse fix. */}
      <p className="mb-1 font-semibold break-words text-foreground">{task.name || "(sem título)"}</p>
      {desc && <p className="mb-2 text-sm break-words text-muted-foreground">{desc}</p>}

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>{tipoName}</span>
        <span>{setorName}</span>
        {prioEntry && <span style={{ color: prioEntry.color }}>{prioEntry.label}</span>}
        {assignees && <span>Atendente: {assignees}</span>}
        <span>Aberto em {fmtDate(task.date_created)}</span>
        {dueFuture && <span>Prazo {dueFuture}</span>}
      </div>

      {anexos.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {anexos.map((a, i) => (
            <button
              key={`${a.url}-${i}`}
              type="button"
              onClick={() => setAnexoAberto(a)}
              title={a.title || a.name || "arquivo"}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
            >
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{a.title || a.name || "arquivo"}</span>
            </button>
          ))}
        </div>
      )}

      {solucao && (
        <div className="mt-3 rounded-md border border-[#22c55e]/30 bg-[#22c55e]/10 p-2.5 text-sm">
          <p className="mb-0.5 text-xs font-semibold text-[#166534]">Solução aplicada</p>
          {/* break-words — solução também é texto livre (escrito pela TI, sem limite
              de tamanho), mesmo risco de overflow. */}
          <p className="break-words text-foreground">{solucao}</p>
        </div>
      )}

      <a
        href={waLinkForTask(task)}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#22c55e] hover:underline"
      >
        <MessageCircle className="h-4 w-4" /> Falar no WhatsApp
      </a>

      <AnexoModal anexo={anexoAberto} sessionToken={sessionToken} onClose={() => setAnexoAberto(null)} />
    </div>
  )
}

function statusBg(status: StatusKey): string {
  const map: Record<StatusKey, string> = {
    aberto: "#e3f2fd",
    "em atendimento": "#e3e0fb",
    pendente: "#fce4ec",
    encerrado: "#e8f5e9",
  }
  return map[status] ?? "#fff"
}
