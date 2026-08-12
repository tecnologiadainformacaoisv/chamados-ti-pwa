import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import {
  SETORES,
  SETOR_FIELD_ID,
  STATUS_MAP,
  STATUS_ORDER,
  TIPOS,
  TIPO_FIELD_ID,
  OPERADORES,
  PRIORITY_MAP,
  optionName,
} from "@/lib/constants"
import { getCF, isAtrasado, fmtDate, type Task } from "@/lib/api"

const KANBAN_CARD_LIMIT = 100 // mesmo teto por coluna que admin.js já usa

// Porta renderKanban/kanbanCardHtml + arrastar-e-soltar de admin.js. Clique abre o
// modal "Gerenciar" (via onOpenTask); arrastar entre colunas muda só o status (via
// onDropStatus) — um drag de verdade não dispara 'click', então os dois convivem.
export function KanbanBoard({
  tasks,
  onOpenTask,
  onDropStatus,
}: {
  tasks: Task[]
  onOpenTask: (task: Task) => void
  onDropStatus: (taskId: string, status: string) => void
}) {
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const byStatus: Record<string, Task[]> = { aberto: [], "em atendimento": [], pendente: [], encerrado: [] }
  for (const t of tasks) {
    const key = (t.status?.status || "").toLowerCase()
    if (byStatus[key]) byStatus[key].push(t)
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {STATUS_ORDER.map((statusKey) => {
        const list = byStatus[statusKey]
        const shown = list.slice(0, KANBAN_CARD_LIMIT)
        return (
          <div key={statusKey} className="flex flex-col rounded-lg border border-border bg-muted/40">
            <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_MAP[statusKey].dot }} />
                <span className="text-sm font-semibold">{STATUS_MAP[statusKey].label}</span>
              </div>
              <Badge variant="secondary">{list.length}</Badge>
            </div>
            <div
              data-status={statusKey}
              className={`flex min-h-40 flex-1 flex-col gap-2 p-2 transition-colors ${dragOverCol === statusKey ? "bg-accent/20" : ""}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverCol(statusKey)
              }}
              onDragLeave={() => setDragOverCol((c) => (c === statusKey ? null : c))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverCol(null)
                const taskId = e.dataTransfer.getData("text/plain")
                if (taskId) onDropStatus(taskId, statusKey)
              }}
            >
              {shown.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">Nenhum chamado.</p>}
              {shown.map((task) => (
                <KanbanCard
                  key={task.id}
                  task={task}
                  isDragging={draggingId === task.id}
                  onDragStart={(e) => {
                    setDraggingId(task.id)
                    e.dataTransfer.effectAllowed = "move"
                    e.dataTransfer.setData("text/plain", task.id)
                  }}
                  onDragEnd={() => setDraggingId(null)}
                  onClick={() => onOpenTask(task)}
                />
              ))}
              {list.length > KANBAN_CARD_LIMIT && (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  +{list.length - KANBAN_CARD_LIMIT} chamado(s) — refine os filtros/busca pra ver todos
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function KanbanCard({
  task,
  isDragging,
  onDragStart,
  onDragEnd,
  onClick,
}: {
  task: Task
  isDragging: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onClick: () => void
}) {
  const setorNome = optionName(SETORES, Number(getCF(task, SETOR_FIELD_ID)))
  const tipoIdx = Number(getCF(task, TIPO_FIELD_ID))
  const tipo = TIPOS.find((t) => t.orderindex === tipoIdx)
  const solNome = task.solicitante || "—"
  const operadores = (task.assignees ?? []).map((a) => a.username || OPERADORES[String(a.id)] || `#${a.id}`).join(", ") || "—"
  const prioridade = task.priority?.priority ? PRIORITY_MAP[task.priority.priority] : null
  const atrasado = isAtrasado(task)

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`cursor-grab rounded-md border bg-card p-3 shadow-sm transition-opacity hover:border-primary/40 active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      } ${atrasado ? "border-destructive/50" : "border-border"}`}
    >
      <p className="mb-2 line-clamp-2 text-sm font-medium text-foreground" title={task.name}>
        {task.name || "(sem título)"}
      </p>
      <div className="mb-2 flex flex-wrap gap-1">
        {tipo && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: `${tipo.color}22`, color: tipo.color }}
          >
            {tipo.name}
          </span>
        )}
        {prioridade && (
          <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: prioridade.color }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: prioridade.color }} />
            {prioridade.label}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <span>{setorNome}</span>
        <span>{solNome}</span>
        <span>{operadores}</span>
        <span className={atrasado ? "font-medium text-destructive" : ""}>
          {task.due_date ? fmtDate(task.due_date) : "—"}
          {atrasado ? " ⚠" : ""}
        </span>
      </div>
    </div>
  )
}
