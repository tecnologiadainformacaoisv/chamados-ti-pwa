import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, LayoutGrid, List, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { FiltersBar } from "@/components/filters-bar"
import { KanbanBoard } from "@/components/kanban-board"
import { TasksTable } from "@/components/tasks-table"
import { TaskModal } from "@/components/task-modal"
import { EncerrarComSolucaoDialog } from "@/components/encerrar-com-solucao-dialog"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { useIsMobile } from "@/hooks/use-mobile"
import { getCF, compararUrgencia, fetchSolicitanteNomes, fetchTasks, isSessionError, postTaskUpdate, postBulkUpdate, createAdminTask, type CreateTaskPayload, type Filtros, type Task, type UpdatePayload } from "@/lib/api"
import { SOLUCAO_FIELD_ID } from "@/lib/constants"
import { downloadTasksCsv } from "@/lib/export-csv"

type ViewMode = "quadro" | "tabela"

export function GestaoView() {
  const { secret, logout } = useAdminAuth()
  const queryClient = useQueryClient()

  const [filtros, setFiltros] = useState<Filtros>({})
  const [busca, setBusca] = useState("")
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("admin_view_mode_react") as ViewMode) || "quadro")
  // No celular a Tabela (13 colunas, controles de 24px) não é usável — revisão de UX
  // 2026-10-16. Lá só existe o Quadro, sem mexer na preferência salva pro desktop.
  const isMobile = useIsMobile()
  const modoVisao: ViewMode = isMobile ? "quadro" : viewMode
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [bulkMessage, setBulkMessage] = useState<string | null>(null)

  // Solução obrigatória pra encerrar (2026-08-24, pedido do usuário) — dispara ao
  // arrastar um card pro Quadro ou trocar status pra Encerrado direto na Tabela (os
  // dois jeitos de mudar status sem passar pelo modal "Gerenciar", que já valida isso
  // na própria tela — ver task-modal.tsx). `solucaoAtual` pré-preenche o popup se o
  // chamado já tinha uma solução escrita antes (ex.: via o modal, sem ter encerrado).
  const [encerrarPendente, setEncerrarPendente] = useState<{ taskId: string; nomeTask: string; solucaoAtual: string } | null>(null)
  const [encerrarError, setEncerrarError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  function changeViewMode(mode: ViewMode) {
    setViewMode(mode)
    localStorage.setItem("admin_view_mode_react", mode)
  }

  const solicitantesQuery = useQuery({
    queryKey: ["solicitantes"],
    queryFn: fetchSolicitanteNomes,
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
  // A ordem por urgência depende da hora (um chamado passa a "vence logo"/"atrasado" com o
  // tempo, sem o servidor mudar nada): reavalia a cada minuto, senão ele só subiria na coluna
  // quando outro dado mudasse (achado do revisor, 2026-10-16).
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  const lastVisible = useMemo(() => {
    const term = busca.trim().toLowerCase()
    // A busca olha o título E o nome de quem abriu (achado de UX 2026-10-16: "achar o chamado
    // da Fulana" só funcionava pelo filtro de Solicitante, a busca ignorava o nome).
    const filtrados = term
      ? tasks.filter((t) => (t.name || "").toLowerCase().includes(term) || (t.solicitante || "").toLowerCase().includes(term))
      : tasks
    return [...filtrados].sort(compararUrgencia)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` só força a reordenação por tempo
  }, [tasks, busca, tick])

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

  // Mutação de "edição rápida" — reaproveitada tanto pelo arrastar-e-soltar do Quadro
  // (corpo {status}) quanto pela edição inline de Status/Operador na Tabela (Fase A do
  // roadmap pós-MVP-visual, 2026-08-14). Mesma rota do modal "Gerenciar"
  // (POST /admin/tasks/:id), só chamada de mais lugares — sem duplicar onSuccess/
  // onError/invalidação de cache pra cada caso.
  const quickUpdateMutation = useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: UpdatePayload }) => postTaskUpdate(secret, taskId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-tasks"] }),
    onError: (err) => {
      if (isSessionError(err)) logout()
    },
  })

  // Intercepta qualquer tentativa de status->"encerrado" vinda do Quadro (drag) ou da
  // Tabela (select inline) — abre o popup pedindo a solução em vez de mandar a
  // mutação direto. Qualquer outro status segue o caminho de sempre, sem popup.
  function pedirStatus(taskId: string, body: UpdatePayload) {
    if (body.status === "encerrado") {
      const task = tasks.find((t) => t.id === taskId)
      const solucaoAtual = (task && (getCF(task, SOLUCAO_FIELD_ID) as string | null)) || ""
      setEncerrarError(null)
      setEncerrarPendente({ taskId, nomeTask: task?.name || "(sem título)", solucaoAtual })
      return
    }
    quickUpdateMutation.mutate({ taskId, body })
  }

  // Ação em lote (Fase B, mesmo dia) — mesmo conceito do Artifact do MVP visual,
  // via POST /admin/tasks/bulk (nova rota). Sem transação entre chamados — o servidor
  // já reporta sucesso/falha por id, mostrado aqui como uma mensagem curta.
  const bulkMutation = useMutation({
    mutationFn: ({ ids, body }: { ids: string[]; body: UpdatePayload }) => postBulkUpdate(secret, ids, body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["admin-tasks"] })
      setBulkMessage(
        data.falha > 0
          ? `${data.sucesso} de ${data.total} chamados atualizados — ${data.falha} falharam.`
          : `${data.sucesso} chamado${data.sucesso > 1 ? "s" : ""} atualizado${data.sucesso > 1 ? "s" : ""}.`
      )
    },
    onError: (err) => {
      if (isSessionError(err)) { logout(); return }
      setBulkMessage(err instanceof Error ? err.message : "Não foi possível aplicar a ação em lote.")
    },
  })

  // "Adicionar Chamado" inline (2026-09-15) — ver criar-chamado-inline.tsx/
  // handleAdminCreateTask. Erro fica junto do próprio popover (não um Alert solto na
  // página) — o mesmo padrão do resto do formulário de criação.
  const createMutation = useMutation({
    mutationFn: (payload: CreateTaskPayload) => createAdminTask(secret, payload),
    onSuccess: () => {
      setCreateError(null)
      queryClient.invalidateQueries({ queryKey: ["admin-tasks"] })
    },
    onError: (err) => {
      if (isSessionError(err)) { logout(); return }
      setCreateError(err instanceof Error ? err.message : "Não foi possível criar o chamado.")
    },
  })

  return (
    <div className="flex flex-col gap-4">
      {/* Bloco fixo (2026-09-15, pedido do usuário: "a parte de cima fixa e
          congelada... quando eu scrollar, descer só os chamados") — filtros +
          contador + toggle Quadro/Tabela grudam logo abaixo do header (também
          sticky, ver app-header.tsx) enquanto só a lista de chamados rola por
          baixo. `bg-background` sólido (não `bg-muted/30`, que é o fundo real da
          página, mas TRANSPARENTE — achado testando o scroll de verdade: com
          opacidade, o conteúdo rolando por baixo vazava através da barra fixa).
          SEM `-mx-6`/margem negativa (2026-09-15, 2ª rodada) — achado real: isso
          alargava o `<main>` (e a PÁGINA INTEIRA) 24px além da viewport de cada
          lado, criando um scroll horizontal fantasma que não tinha nada a ver com
          a largura da tabela em si (o que pareceu ser "a tabela ainda não cabe"
          era na real esse truque de margem). */}
      <div className="flex flex-col gap-4 bg-background pt-2 pb-3 md:sticky md:top-16 md:z-10">
        <FiltersBar
          filtros={filtros}
          onChange={setFiltros}
          solicitantes={solicitantesQuery.data ?? []}
          busca={busca}
          onBuscaChange={setBusca}
          mostrarStatus={modoVisao === "tabela"}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="whitespace-nowrap text-sm font-medium text-foreground">
            Chamados {busca ? `(${lastVisible.length} de ${tasks.length})` : `(${tasks.length})`}
          </p>
          <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadTasksCsv(lastVisible)}
            disabled={lastVisible.length === 0}
            title="Baixa em CSV os chamados que estão na tela (com os filtros e a busca aplicados)"
            aria-label="Exportar CSV"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Exportar CSV</span>
            <span className="sm:hidden">CSV</span>
          </Button>
          <div className="hidden gap-1 rounded-md border border-border p-1 md:flex">
            <Button size="sm" variant={viewMode === "quadro" ? "default" : "ghost"} onClick={() => changeViewMode("quadro")}>
              <LayoutGrid className="h-4 w-4" /> Quadro
            </Button>
            <Button size="sm" variant={viewMode === "tabela" ? "default" : "ghost"} onClick={() => changeViewMode("tabela")}>
              <List className="h-4 w-4" /> Tabela
            </Button>
          </div>
          </div>
        </div>
      </div>

      {tasksQuery.data?.truncated && (
        <Alert>
          <AlertDescription>
            Há mais chamados do que a tela consegue mostrar. Use os filtros para ver o restante.
          </AlertDescription>
        </Alert>
      )}

      {/* Se a atualização automática falhar com a lista já carregada, a TI não pode continuar
          olhando dados velhos sem saber (achado do revisor, 2026-10-16). */}
      {tasksQuery.isError && !!tasksQuery.data && !isSessionError(tasksQuery.error) && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Sem conexão com o servidor. Os chamados abaixo podem estar desatualizados — tentando de novo automaticamente.
        </p>
      )}

      {tasksQuery.isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Carregando chamados…</p>
      ) : tasksQuery.isError && !tasksQuery.data ? (
        // Sem dado nenhum e com erro: NÃO mostrar as 4 colunas "Nenhum chamado." (parecia que não
        // havia chamados, quando na verdade não carregou — achado de UX 2026-10-16).
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-10 text-center" role="alert">
          <p className="font-medium text-destructive">Não foi possível carregar os chamados.</p>
          <p className="text-sm text-muted-foreground">Verifique a internet e tente de novo. Os chamados continuam salvos.</p>
          <Button variant="outline" onClick={() => tasksQuery.refetch()} disabled={tasksQuery.isFetching}>
            <RefreshCw className="h-4 w-4" /> {tasksQuery.isFetching ? "Tentando…" : "Tentar de novo"}
          </Button>
        </div>
      ) : busca.trim() && lastVisible.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <p className="font-medium text-foreground">Nenhum chamado com “{busca.trim()}”.</p>
          <p className="text-sm text-muted-foreground">A busca olha o título e o nome de quem abriu o chamado.</p>
          <Button variant="outline" onClick={() => setBusca("")}>Limpar busca</Button>
        </div>
      ) : modoVisao === "quadro" && tasks.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
          {Object.values(filtros).some(Boolean) ? (
            <>
              <p className="font-medium text-foreground">Nenhum chamado com esses filtros.</p>
              <Button variant="outline" onClick={() => setFiltros({})}>Limpar filtros</Button>
            </>
          ) : (
            <>
              <p className="font-medium text-foreground">Ainda não há chamados.</p>
              <p className="text-sm text-muted-foreground">Quando alguém abrir um chamado, ele aparece aqui.</p>
            </>
          )}
        </div>
      ) : modoVisao === "quadro" ? (
        <KanbanBoard
          semLimiteEncerrados={!!busca.trim()}
          tasks={lastVisible}
          onOpenTask={setSelectedTask}
          onDropStatus={(taskId, status) => pedirStatus(taskId, { status })}
        />
      ) : (
        <>
          {bulkMessage && (
            <Alert>
              <AlertDescription className="flex items-center justify-between gap-2">
                {bulkMessage}
                <Button variant="ghost" size="sm" onClick={() => setBulkMessage(null)}>Fechar</Button>
              </AlertDescription>
            </Alert>
          )}
          <TasksTable
            tasks={lastVisible}
            onOpenTask={setSelectedTask}
            onQuickUpdate={pedirStatus}
            onBulkUpdate={(taskIds, body) => { setBulkMessage(null); bulkMutation.mutate({ ids: taskIds, body }) }}
            solicitantes={solicitantesQuery.data ?? []}
            onCreateTask={(payload) => createMutation.mutate(payload)}
            creatingTask={createMutation.isPending}
            createTaskError={createError}
          />
        </>
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

      <EncerrarComSolucaoDialog
        aberto={!!encerrarPendente}
        nomeTask={encerrarPendente?.nomeTask ?? ""}
        solucaoInicial={encerrarPendente?.solucaoAtual ?? ""}
        saving={quickUpdateMutation.isPending}
        error={encerrarError}
        onCancel={() => {
          setEncerrarPendente(null)
          setEncerrarError(null)
        }}
        onConfirm={(solucao) => {
          if (!encerrarPendente) return
          quickUpdateMutation.mutate(
            { taskId: encerrarPendente.taskId, body: { status: "encerrado", solucao } },
            {
              onSuccess: () => {
                setEncerrarPendente(null)
                setEncerrarError(null)
              },
              onError: (err) => {
                if (isSessionError(err)) return // onError do useMutation já desloga
                setEncerrarError(err instanceof Error ? err.message : "Não foi possível encerrar o chamado.")
              },
            }
          )
        }}
      />
    </div>
  )
}
