import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LayoutGrid, List } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { FiltersBar } from "@/components/filters-bar"
import { KanbanBoard } from "@/components/kanban-board"
import { TasksTable } from "@/components/tasks-table"
import { TaskModal } from "@/components/task-modal"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { fetchSolicitanteMaps, fetchTasks, isSessionError, postTaskUpdate, type Filtros, type Task, type UpdatePayload } from "@/lib/api"

type ViewMode = "quadro" | "tabela"

export function GestaoView() {
  const { secret, logout } = useAdminAuth()
  const queryClient = useQueryClient()

  const [filtros, setFiltros] = useState<Filtros>({})
  const [busca, setBusca] = useState("")
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("admin_view_mode_react") as ViewMode) || "quadro")
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  function changeViewMode(mode: ViewMode) {
    setViewMode(mode)
    localStorage.setItem("admin_view_mode_react", mode)
  }

  const solicitantesQuery = useQuery({
    queryKey: ["solicitantes"],
    queryFn: fetchSolicitanteMaps,
    staleTime: 5 * 60_000,
  })

  const tasksQuery = useQuery({
    queryKey: ["admin-tasks", filtros],
    queryFn: () => fetchTasks(secret, filtros),
    // Mesmo "smart polling" do app principal/painel vanilla: atualiza sozinho, sem
    // precisar de F5 manual (mesma correção do incidente de 2026-08-10).
    refetchInterval: 60_000,
  })

  // GET /admin/tasks também pode voltar 403 (segredo revogado/expirado enquanto já
  // estava logado) — mesmo tratamento de loadTasks() em admin.js: volta pro gate.
  useEffect(() => {
    if (isSessionError(tasksQuery.error)) logout()
  }, [tasksQuery.error, logout])

  const tasks = tasksQuery.data?.tasks ?? []
  const lastVisible = useMemo(() => {
    const term = busca.trim().toLowerCase()
    return term ? tasks.filter((t) => (t.name || "").toLowerCase().includes(term)) : tasks
  }, [tasks, busca])

  const updateMutation = useMutation({
    mutationFn: (body: UpdatePayload) => {
      if (!selectedTask) throw new Error("nenhum chamado selecionado")
      return postTaskUpdate(secret, selectedTask.id, body)
    },
    onSuccess: () => {
      setSelectedTask(null)
      setSaveError(null)
      queryClient.invalidateQueries({ queryKey: ["admin-tasks"] })
    },
    onError: (err) => {
      if (isSessionError(err)) {
        setSelectedTask(null)
        logout()
        return
      }
      setSaveError(err instanceof Error ? err.message : "Não foi possível salvar.")
    },
  })

  // Arrastar-e-soltar no Quadro muda só o status — mesma rota de mutação do modal,
  // corpo diferente (só status, sem tocar solução/operador).
  const dropMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: string }) => postTaskUpdate(secret, taskId, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-tasks"] }),
    onError: (err) => {
      if (isSessionError(err)) logout()
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <FiltersBar
        filtros={filtros}
        onChange={setFiltros}
        solicitantes={solicitantesQuery.data?.names ?? []}
        busca={busca}
        onBuscaChange={setBusca}
        mostrarStatus={viewMode === "tabela"}
      />

      {tasksQuery.data?.truncated && (
        <Alert>
          <AlertDescription>
            Alguns chamados podem não estar aparecendo — a busca na ClickUp bateu no teto de páginas. Refine os
            filtros pra ver o conjunto completo.
          </AlertDescription>
        </Alert>
      )}

      {tasksQuery.isError && (
        <Alert variant="destructive">
          <AlertDescription>{tasksQuery.error instanceof Error ? tasksQuery.error.message : "Erro ao carregar chamados."}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">
          Chamados {busca ? `(${lastVisible.length} de ${tasks.length})` : `(${tasks.length})`}
        </p>
        <div className="flex gap-1 rounded-md border border-border p-1">
          <Button size="sm" variant={viewMode === "quadro" ? "default" : "ghost"} onClick={() => changeViewMode("quadro")}>
            <LayoutGrid className="h-4 w-4" /> Quadro
          </Button>
          <Button size="sm" variant={viewMode === "tabela" ? "default" : "ghost"} onClick={() => changeViewMode("tabela")}>
            <List className="h-4 w-4" /> Tabela
          </Button>
        </div>
      </div>

      {tasksQuery.isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Carregando chamados…</p>
      ) : viewMode === "quadro" ? (
        <KanbanBoard
          tasks={lastVisible}
          onOpenTask={setSelectedTask}
          onDropStatus={(taskId, status) => dropMutation.mutate({ taskId, status })}
        />
      ) : (
        <TasksTable tasks={lastVisible} onOpenTask={setSelectedTask} />
      )}

      <TaskModal
        task={selectedTask}
        onClose={() => {
          setSelectedTask(null)
          setSaveError(null)
        }}
        onSave={(body) => updateMutation.mutate(body)}
        saving={updateMutation.isPending}
        error={saveError}
      />
    </div>
  )
}
