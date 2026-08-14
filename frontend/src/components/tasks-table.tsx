import { Fragment, useState } from "react"
import { ChevronDown, Check, Circle, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  SETORES,
  SETOR_FIELD_ID,
  STATUS_MAP,
  STATUS_ORDER,
  TIPOS,
  TIPO_FIELD_ID,
  OPERADORES,
  PRIORITY_MAP,
} from "@/lib/constants"
import { getCF, isAtrasado, fmtDate, type Task, type UpdatePayload } from "@/lib/api"

const SEM_ATRIBUICAO = "__sem__"

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
//
// `onQuickUpdate` (Fase A do roadmap pós-MVP-visual, 2026-08-14) — edição inline de
// Status/Operador direto na linha, sem abrir o modal "Gerenciar" (mesma mecânica que
// o Quadro já tem via drag-and-drop pro status). Reaproveita a MESMA rota/mutation
// de sempre (`POST /admin/tasks/:id`) — só um jeito novo, mais rápido, de chamá-la.
//
// `onBulkUpdate` (Fase B, mesmo dia) — ação em lote, mesmo conceito já demonstrado no
// Artifact do MVP visual: seleciona várias linhas (checkbox), aplica status/operador
// a todas de uma vez via POST /admin/tasks/bulk (nova rota, não existia até agora).
export function TasksTable({
  tasks,
  onOpenTask,
  onQuickUpdate,
  onBulkUpdate,
}: {
  tasks: Task[]
  onOpenTask: (task: Task) => void
  onQuickUpdate: (taskId: string, body: UpdatePayload) => void
  onBulkUpdate: (taskIds: string[], body: UpdatePayload) => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed)
  const [selected, setSelected] = useState<Set<string>>(new Set())

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

  function toggleSelected(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id); else next.delete(id)
      return next
    })
  }

  function toggleGroup(ids: string[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) { if (checked) next.add(id); else next.delete(id) }
      return next
    })
  }

  const selectedIds = Array.from(selected)

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 font-medium">Chamado</th>
              <th className="px-3 py-2 font-medium">Prioridade</th>
              <th className="px-3 py-2 font-medium">Tipo</th>
              <th className="px-3 py-2 font-medium">Setor</th>
              <th className="px-3 py-2 font-medium">Solicitante</th>
              <th className="px-3 py-2 font-medium">Operador</th>
              <th className="px-3 py-2 font-medium">Status</th>
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
              const visibleIds = list.slice(0, GROUP_TABLE_LIMIT).map((t) => t.id)
              const todosSelecionados = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
              return (
                <Fragment key={statusKey}>
                  <tr className="border-b border-border bg-muted/40">
                    <td className="px-3 py-2">
                      {visibleIds.length > 0 && (
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={todosSelecionados}
                          onChange={(e) => toggleGroup(visibleIds, e.target.checked)}
                          title="Selecionar todos deste grupo"
                        />
                      )}
                    </td>
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
                        <td colSpan={11} className="px-3 py-4 text-center text-xs text-muted-foreground">
                          Nenhum chamado.
                        </td>
                      </tr>
                    ) : (
                      <>
                        {list.slice(0, GROUP_TABLE_LIMIT).map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            selected={selected.has(task.id)}
                            onToggleSelected={(checked) => toggleSelected(task.id, checked)}
                            onOpen={() => onOpenTask(task)}
                            onQuickUpdate={(body) => onQuickUpdate(task.id, body)}
                          />
                        ))}
                        {list.length > GROUP_TABLE_LIMIT && (
                          <tr>
                            <td colSpan={11} className="px-3 py-3 text-center text-xs text-muted-foreground">
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

      {selectedIds.length > 0 && (
        <div className="sticky bottom-4 z-10 flex w-fit items-center gap-3 self-center rounded-full border border-border bg-foreground px-4 py-2 text-primary-foreground shadow-lg">
          <span className="text-xs font-semibold whitespace-nowrap">
            {selectedIds.length} selecionado{selectedIds.length > 1 ? "s" : ""}
          </span>
          <Select value="" onValueChange={(v) => { onBulkUpdate(selectedIds, { status: v }); setSelected(new Set()) }}>
            <SelectTrigger size="sm" className="h-7 border-none bg-white/10 text-xs text-primary-foreground hover:bg-white/20">
              <SelectValue placeholder="Mudar status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s}>{STATUS_MAP[s].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value="" onValueChange={(v) => { onBulkUpdate(selectedIds, { assigneeId: v === SEM_ATRIBUICAO ? null : Number(v) }); setSelected(new Set()) }}>
            <SelectTrigger size="sm" className="h-7 border-none bg-white/10 text-xs text-primary-foreground hover:bg-white/20">
              <SelectValue placeholder="Reatribuir" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SEM_ATRIBUICAO}>Sem atribuição</SelectItem>
              {Object.entries(OPERADORES).map(([id, nome]) => (
                <SelectItem key={id} value={id}>{nome}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" className="h-7 text-primary-foreground hover:bg-white/20 hover:text-primary-foreground" onClick={() => setSelected(new Set())}>
            Cancelar
          </Button>
        </div>
      )}
    </div>
  )
}

function TaskRow({
  task,
  selected,
  onToggleSelected,
  onOpen,
  onQuickUpdate,
}: {
  task: Task
  selected: boolean
  onToggleSelected: (checked: boolean) => void
  onOpen: () => void
  onQuickUpdate: (body: UpdatePayload) => void
}) {
  const setorIdx = Number(getCF(task, SETOR_FIELD_ID))
  const setor = SETORES.find((s) => s.orderindex === setorIdx)
  const tipoIdx = Number(getCF(task, TIPO_FIELD_ID))
  const tipo = TIPOS.find((t) => t.orderindex === tipoIdx)
  const solNome = task.solicitante || "—"
  const assignees = task.assignees ?? []
  const operadorAtual = assignees[0] ? String(assignees[0].id) : SEM_ATRIBUICAO
  const multiplosOperadores = assignees.length > 1
  const prioridade = task.priority?.priority ? PRIORITY_MAP[task.priority.priority] : null
  const atrasado = isAtrasado(task)
  const statusAtual = (task.status?.status || "").toLowerCase()

  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/30">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-primary"
          checked={selected}
          onChange={(e) => onToggleSelected(e.target.checked)}
        />
      </td>
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
      <td className="px-3 py-2">
        {setor ? (
          <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${setor.color}22`, color: setor.color }}>
            {setor.name}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2">{solNome}</td>
      <td className="px-3 py-2">
        {/* Edição inline (Fase A, 2026-08-14) — pré-seleciona só o 1º operador, mesma
            simplificação que o modal "Gerenciar" já faz; escolher aqui substitui quem
            estava atribuído por completo (mesmo comportamento de sempre da rota),
            avisado pelo ícone quando há mais de 1. */}
        <div className="flex items-center gap-1.5">
          <Select value={operadorAtual} onValueChange={(v) => onQuickUpdate({ assigneeId: v === SEM_ATRIBUICAO ? null : Number(v) })}>
            <SelectTrigger size="sm" className="h-7 border-none bg-transparent px-1.5 shadow-none hover:bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SEM_ATRIBUICAO}>Sem atribuição</SelectItem>
              {Object.entries(OPERADORES).map(([id, nome]) => (
                <SelectItem key={id} value={id}>{nome}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {multiplosOperadores && (
            <span
              className="shrink-0"
              title={`${assignees.length} operadores atribuídos (${assignees.map((a) => a.username || OPERADORES[String(a.id)] || `#${a.id}`).join(", ")}). Mudar aqui substitui todos por só 1.`}
            >
              <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <Select value={statusAtual} onValueChange={(v) => onQuickUpdate({ status: v })}>
          <SelectTrigger size="sm" className="h-7 border-none bg-transparent px-1.5 shadow-none hover:bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_ORDER.map((s) => (
              <SelectItem key={s} value={s}>{STATUS_MAP[s].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
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
