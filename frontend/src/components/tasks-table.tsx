import { Fragment, useState } from "react"
import { ChevronDown, Check, Circle } from "lucide-react"
import { Button } from "@/components/ui/button"
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

const GROUP_TABLE_LIMIT = 200 // mesmo teto por grupo que admin.js já usa
const STORAGE_KEY = "admin_group_collapsed_react"

function loadCollapsed(): Record<string, boolean> {
  try {
    return { aberto: false, "em atendimento": false, pendente: false, encerrado: false, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }
  } catch {
    return { aberto: false, "em atendimento": false, pendente: false, encerrado: false }
  }
}

// Porta renderTableGrouped/taskRowHtml de admin.js — tabela agrupada por status,
// com expandir/recolher (lembrado entre sessões), mesmo padrão visual da ClickUp.
export function TasksTable({
  tasks,
  onOpenTask,
}: {
  tasks: Task[]
  onOpenTask: (task: Task) => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)

  const byStatus: Record<string, Task[]> = { aberto: [], "em atendimento": [], pendente: [], encerrado: [] }
  for (const t of tasks) {
    const key = (t.status?.status || "").toLowerCase()
    if (byStatus[key]) byStatus[key].push(t)
  }

  function toggle(statusKey: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [statusKey]: !prev[statusKey] }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Chamado</th>
            <th className="px-3 py-2 font-medium">Prioridade</th>
            <th className="px-3 py-2 font-medium">Tipo</th>
            <th className="px-3 py-2 font-medium">Setor</th>
            <th className="px-3 py-2 font-medium">Solicitante</th>
            <th className="px-3 py-2 font-medium">Operador</th>
            <th className="px-3 py-2 font-medium">Prazo</th>
            <th className="px-3 py-2 font-medium">Criado em</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {STATUS_ORDER.map((statusKey) => {
            const list = byStatus[statusKey]
            const isCollapsed = collapsed[statusKey]
            const info = STATUS_MAP[statusKey]
            return (
              <Fragment key={statusKey}>
                <tr className="border-b border-border bg-muted/40">
                  <td colSpan={9} className="p-0">
                    <button
                      type="button"
                      onClick={() => toggle(statusKey)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
                    >
                      <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                      {statusKey === "aberto" ? (
                        <Circle className="h-3.5 w-3.5 shrink-0" style={{ color: info.dot }} strokeWidth={2} />
                      ) : (
                        <span
                          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
                          style={{ background: info.dot }}
                        >
                          <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
                        </span>
                      )}
                      <span className="text-sm font-semibold">{info.label}</span>
                      <span className="text-xs text-muted-foreground">{list.length}</span>
                    </button>
                  </td>
                </tr>
                {!isCollapsed &&
                  (list.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-4 text-center text-xs text-muted-foreground">
                        Nenhum chamado.
                      </td>
                    </tr>
                  ) : (
                    <>
                      {list.slice(0, GROUP_TABLE_LIMIT).map((task) => (
                        <TaskRow key={task.id} task={task} onOpen={() => onOpenTask(task)} />
                      ))}
                      {list.length > GROUP_TABLE_LIMIT && (
                        <tr>
                          <td colSpan={9} className="px-3 py-3 text-center text-xs text-muted-foreground">
                            +{list.length - GROUP_TABLE_LIMIT} chamado(s) — refine os filtros/busca pra ver todos
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const setorNome = optionName(SETORES, Number(getCF(task, SETOR_FIELD_ID)))
  const tipoIdx = Number(getCF(task, TIPO_FIELD_ID))
  const tipo = TIPOS.find((t) => t.orderindex === tipoIdx)
  const solNome = task.solicitante || "—"
  const operadores = (task.assignees ?? []).map((a) => a.username || OPERADORES[String(a.id)] || `#${a.id}`).join(", ") || "—"
  const prioridade = task.priority?.priority ? PRIORITY_MAP[task.priority.priority] : null
  const atrasado = isAtrasado(task)

  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/30">
      <td className="max-w-64 truncate px-3 py-2 font-medium" title={task.name}>
        {task.name || "(sem título)"}
      </td>
      <td className="px-3 py-2">
        {prioridade ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: prioridade.color }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: prioridade.color }} />
            {prioridade.label}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {tipo ? (
          <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${tipo.color}22`, color: tipo.color }}>
            {tipo.name}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2">{setorNome}</td>
      <td className="px-3 py-2">{solNome}</td>
      <td className="px-3 py-2">{operadores}</td>
      <td className={`px-3 py-2 ${atrasado ? "font-medium text-destructive" : ""}`}>
        {task.due_date ? fmtDate(task.due_date) : "—"}
        {atrasado ? " ⚠" : ""}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{task.date_created ? fmtDate(task.date_created) : "—"}</td>
      <td className="px-3 py-2">
        <Button size="sm" variant="outline" onClick={onOpen}>
          Gerenciar
        </Button>
      </td>
    </tr>
  )
}
