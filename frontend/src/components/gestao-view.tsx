import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, LayoutGrid, List, ListOrdered, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { FiltersBar } from "@/components/filters-bar"
import { KanbanBoard } from "@/components/kanban-board"
import { TasksTable } from "@/components/tasks-table"
import { TaskModal } from "@/components/task-modal"
import { EncerrarComSolucaoDialog } from "@/components/encerrar-com-solucao-dialog"
import { CommandPalette, type Comando } from "@/components/command-palette"
import { DesfazerAviso } from "@/components/desfazer-aviso"
import { LinhaDoDia } from "@/components/linha-do-dia"
import { FilaAtendimento } from "@/components/fila-atendimento"
import { useDesfazer } from "@/hooks/use-desfazer"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { useIsMobile } from "@/hooks/use-mobile"
import { getCF, compararUrgencia, isAtrasado, venceLogo, fetchSolicitanteNomes, fetchTasks, isSessionError, postTaskUpdate, postBulkUpdate, createAdminTask, type CreateTaskPayload, type Filtros, type Task, type UpdatePayload } from "@/lib/api"
import { OPERADORES, SOLUCAO_FIELD_ID, STATUS_ORDER } from "@/lib/constants"
import { downloadTasksCsv } from "@/lib/export-csv"

type ViewMode = "fila" | "quadro" | "tabela"

export function GestaoView() {
  const { secret, logout } = useAdminAuth()
  const queryClient = useQueryClient()

  const [filtros, setFiltros] = useState<Filtros>({})
  const [busca, setBusca] = useState("")
  const [viewMode, setViewMode] = // chave nova (v3): a Fila virou a visão padrão (2026-10-19) e quem já tinha "quadro" salvo ia continuar nele
  useState<ViewMode>(() => (localStorage.getItem("admin_view_mode_v3") as ViewMode) || "fila")
  // No celular a Tabela (13 colunas, controles de 24px) não é usável — revisão de UX
  // 2026-10-16. Lá ela vira a Fila, sem mexer na preferência salva pro desktop.
  const isMobile = useIsMobile()
  const modoVisao: ViewMode = isMobile && viewMode === "tabela" ? "fila" : viewMode
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
  // Fase 3 do redesign de UX (2026-10-19): foco do teclado, filtro rápido, paleta e "Desfazer" seguro
  const [focoId, setFocoId] = useState<string | null>(null)
  const [rapido, setRapido] = useState<"todos" | "atrasados" | "hora">("todos")
  const [paletaAberta, setPaletaAberta] = useState(false)
  const [acaoErro, setAcaoErro] = useState<string | null>(null)
  const desfazer = useDesfazer()

  function changeViewMode(mode: ViewMode) {
    setViewMode(mode)
    localStorage.setItem("admin_view_mode_v3", mode)
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

  const tasksServidor = tasksQuery.data?.tasks ?? []
  // Sobreposição LOCAL das ações "Aceitar" ainda dentro da janela do Desfazer. Não escreve no cache:
  // assim uma atualização automática (a cada 60 s) não desfaz o efeito na tela, e desfazer só remove a
  // sobreposição — sem restaurar um snapshot velho por cima de dados novos (achados do revisor, 19/10).
  const [otimistas, setOtimistas] = useState<Record<string, { status: string; due_date: number }>>({})
  const tasks = useMemo(
    () =>
      Object.keys(otimistas).length === 0
        ? tasksServidor
        : tasksServidor.map((t) => (otimistas[t.id] ? { ...t, status: { ...t.status, status: otimistas[t.id].status }, due_date: otimistas[t.id].due_date } : t)),
    [tasksServidor, otimistas]
  )
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
    // Filtros rápidos ("o que preciso atender agora"): só chamados em andamento, que são os que têm
    // prazo correndo — pendente tem o SLA pausado e encerrado já acabou.
    const rapidos = rapido === "todos"
      ? filtrados
      : filtrados.filter((t) => {
          const st = (t.status?.status || "").toLowerCase()
          if (st !== "aberto" && st !== "em atendimento") return false
          return rapido === "atrasados" ? isAtrasado(t) : isAtrasado(t) || venceLogo(t, 60)
        })
    return [...rapidos].sort(compararUrgencia)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` só força a reordenação por tempo
  }, [tasks, busca, rapido, tick])

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
    desfazer.enviar() // ação pendente do Desfazer sai antes, pra não competir com esta
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

  // Aceitar com "Desfazer" (Fase 3): aparece na tela na hora (sobreposição local), mas só é ENVIADO depois
  // de 7 s (ver hooks/use-desfazer.tsx pro porquê). O commit não depende do componente continuar montado.
  const JANELA_FINALIZACAO_MIN: Record<string, number> = { urgent: 15, high: 30, normal: 60 } // mesmo padrão do servidor
  function aceitarComDesfazer(task: Task) {
    const id = task.id
    const nome = task.name || "(sem título)"
    const prazoNovo = Date.now() + (JANELA_FINALIZACAO_MIN[String(task.priority?.priority ?? "").toLowerCase()] ?? 60) * 60_000
    const limpar = () =>
      setOtimistas((o) => {
        const novo = { ...o }
        delete novo[id]
        return novo
      })
    desfazer.agendar(`Chamado aceito: ${nome}`, {
      // status E prazo: sem isso o chamado recém-aceito aparecia "atrasado" em Em atendimento
      apply: () => setOtimistas((o) => ({ ...o, [id]: { status: "em atendimento", due_date: prazoNovo } })),
      commit: () => {
        setAcaoErro(null)
        // pré-condição: se o servidor já mostra outro status (outra pessoa/ação mexeu), não envia
        const noServidor = queryClient
          .getQueriesData<{ tasks: Task[] }>({ queryKey: ["admin-tasks"] })
          .flatMap(([, d]) => d?.tasks ?? [])
          .find((t) => t.id === id)
        if (noServidor && (noServidor.status?.status || "").toLowerCase() !== "aberto") {
          limpar()
          setAcaoErro(`"${nome}" já mudou de status enquanto você aceitava. Nada foi enviado.`)
          return
        }
        postTaskUpdate(secret, id, { status: "em atendimento" })
          .catch((err) => {
            if (isSessionError(err)) { logout(); return }
            setAcaoErro(`Não foi possível aceitar "${nome}". Ele voltou para Aberto. Tente de novo.`)
          })
          .finally(async () => {
            // só tira a sobreposição DEPOIS de recarregar, pra não piscar de volta pra "Aberto"
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["admin-tasks"] }),
              queryClient.invalidateQueries({ queryKey: ["admin-open-count"] }),
            ])
            limpar()
          })
      },
      rollback: limpar,
    })
  }

  // Ordem do teclado: segue o que se vê na tela (colunas do Quadro / grupos da Tabela, da esquerda
  // pra direita), sem os encerrados, que não pedem ação.
  const ordemNav = useMemo(
    () => STATUS_ORDER.filter((st) => st !== "encerrado").flatMap((st) => lastVisible.filter((t) => (t.status?.status || "").toLowerCase() === st)),
    [lastVisible]
  )
  function mover(delta: number) {
    if (!ordemNav.length) return
    const i = ordemNav.findIndex((t) => t.id === focoId)
    const n = i < 0 ? (delta > 0 ? 0 : ordemNav.length - 1) : Math.min(ordemNav.length - 1, Math.max(0, i + delta))
    const id = ordemNav[n].id
    setFocoId(id)
    requestAnimationFrame(() => document.querySelector(`[data-task-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }))
  }

  // Foco do teclado só vale pra chamado que está na lista visível (filtro/busca podem esconder).
  useEffect(() => {
    if (focoId && !ordemNav.some((t) => t.id === focoId)) setFocoId(null)
  }, [ordemNav, focoId])

  // Atalhos (J/K/Enter/E/U, "/" e Ctrl+K). O handler fica numa ref (atualizada a cada render, dentro de um
  // efeito) pra enxergar sempre o estado mais novo sem reinscrever o listener. Ignora campo em foco, diálogo
  // aberto e QUALQUER controle Radix (Select/menu): lá as teclas são typeahead/escolha de opção, não nossas.
  const teclaRef = useRef<(e: KeyboardEvent) => void>(() => {})
  function aoTeclar(e: KeyboardEvent) {
    const alvo = e.target as HTMLElement | null
    const emCampo = alvo?.tagName === "INPUT" || alvo?.tagName === "TEXTAREA" || alvo?.tagName === "SELECT" || !!alvo?.isContentEditable
    const haDialogo = !!document.querySelector('[role="dialog"]')
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      if (!haDialogo) setPaletaAberta(true)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey || emCampo || haDialogo) return
    const emRadix =
      !!alvo?.closest('[role="combobox"],[role="listbox"],[role="option"],[role="menu"],[role="menuitem"],[role="checkbox"],[data-radix-popper-content-wrapper]') ||
      alvo?.getAttribute("aria-expanded") === "true"
    if (emRadix) return
    const tecla = e.key.toLowerCase()
    if (tecla === "/") { e.preventDefault(); document.getElementById("busca-chamados")?.focus(); return }
    if (tecla === "j" || tecla === "k") { e.preventDefault(); mover(tecla === "j" ? 1 : -1); return }
    if (e.repeat) return // segurar Enter/E/U não repete a ação
    if (tecla === "escape") { setFocoId(null); return }
    if (tecla === "u" && desfazer.aviso) { e.preventDefault(); desfazer.desfazer(); return }
    const foco = ordemNav.find((t) => t.id === focoId)
    if (!foco) return
    const st = (foco.status?.status || "").toLowerCase()
    if (tecla === "enter" && !alvo?.closest("button,a")) {
      e.preventDefault()
      if (st === "aberto") aceitarComDesfazer(foco)
      else setSelectedTask(foco)
    } else if (tecla === "e" && st !== "encerrado") {
      e.preventDefault()
      pedirStatus(foco.id, { status: "encerrado" })
    }
  }
  useEffect(() => {
    teclaRef.current = aoTeclar
  })
  useEffect(() => {
    const h = (e: KeyboardEvent) => teclaRef.current(e)
    document.addEventListener("keydown", h)
    return () => document.removeEventListener("keydown", h)
  }, [])

  const comandos = useMemo<Comando[]>(() => {
    const cs: Comando[] = []
    const foco = ordemNav.find((t) => t.id === focoId)
    const st = (foco?.status?.status || "").toLowerCase()
    if (foco && st === "aberto") cs.push({ id: "aceitar", rotulo: `Aceitar: ${foco.name}`, dica: "Enter", executar: () => aceitarComDesfazer(foco) })
    if (foco && st !== "encerrado") cs.push({ id: "encerrar", rotulo: `Encerrar: ${foco.name}`, dica: "E", executar: () => pedirStatus(foco.id, { status: "encerrado" }) })
    cs.push(
      { id: "f-atrasados", rotulo: "Mostrar só os atrasados", dica: "filtro", executar: () => setRapido("atrasados") },
      { id: "f-hora", rotulo: "Mostrar atrasados e o que vence em 1 hora", dica: "filtro", executar: () => setRapido("hora") },
      ...Object.entries(OPERADORES).map(([opId, nome]) => ({
        id: "f-op-" + opId,
        rotulo: `Mostrar só os chamados de ${nome}`,
        dica: "filtro",
        executar: () => setFiltros((f) => ({ ...f, operador: opId })),
      })),
      { id: "f-limpar", rotulo: "Mostrar tudo (limpar filtros e busca)", dica: "filtro", executar: () => { setRapido("todos"); setFiltros({}); setBusca("") } },
      { id: "csv", rotulo: "Exportar a lista na tela em CSV", dica: "arquivo", executar: () => downloadTasksCsv(lastVisible) }
    )
    for (const t of ordemNav.slice(0, 60)) {
      cs.push({ id: "t-" + t.id, rotulo: `Abrir: ${t.name}${t.solicitante ? " (" + t.solicitante + ")" : ""}`, dica: "chamado", executar: () => { setFocoId(t.id); setSelectedTask(t) } })
    }
    return cs
    // eslint-disable-next-line react-hooks/exhaustive-deps -- aceitarComDesfazer/pedirStatus mudam a cada render, mas só leem estado já listado
  }, [focoId, ordemNav, lastVisible])

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
      {/* Gestão à vista (pedido do usuário, 2026-10-19): a linha do dia é a PRIMEIRA coisa da tela, acima
          dos filtros, e mostra todos os chamados em andamento (não muda com filtro/busca). */}
      {!tasksQuery.isLoading && !!tasksQuery.data && (
        <LinhaDoDia tasks={tasks} focoId={focoId} onOpenTask={(t) => { setFocoId(t.id); setSelectedTask(t) }} />
      )}

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
          <div className="flex flex-wrap items-center gap-3">
            <p className="whitespace-nowrap text-sm font-medium text-foreground">
              Chamados {busca || rapido !== "todos" ? `(${lastVisible.length} de ${tasks.length})` : `(${tasks.length})`}
            </p>
            <div className="flex items-center gap-1.5" role="group" aria-label="Filtros rápidos">
              {([["todos", "Todos"], ["atrasados", "Atrasados"], ["hora", "Atrasados e até 1 h"]] as const).map(([k, rotulo]) => (
                <Button key={k} size="sm" variant={rapido === k ? "default" : "outline"} aria-pressed={rapido === k} onClick={() => setRapido(k)}>
                  {rotulo}
                </Button>
              ))}
            </div>
          </div>
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
            <Button size="sm" variant={viewMode === "fila" ? "default" : "ghost"} onClick={() => changeViewMode("fila")}>
              <ListOrdered className="h-4 w-4" /> Fila
            </Button>
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
      ) : (modoVisao === "quadro" || modoVisao === "fila") && tasks.length === 0 ? (
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
      ) : modoVisao === "fila" ? (
        <FilaAtendimento
          tasks={lastVisible}
          focoId={focoId}
          onFoco={setFocoId}
          onGerenciar={setSelectedTask}
          onAceitar={aceitarComDesfazer}
          onEncerrar={(t) => pedirStatus(t.id, { status: "encerrado" })}
          onRetomar={(t) => pedirStatus(t.id, { status: "em atendimento" })}
        />
      ) : modoVisao === "quadro" ? (
        <KanbanBoard
          semLimiteEncerrados={!!busca.trim()}
          focoId={focoId}
          onAceitar={aceitarComDesfazer}
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
            focoId={focoId}
            tasks={lastVisible}
            onOpenTask={setSelectedTask}
            onQuickUpdate={pedirStatus}
            onBulkUpdate={(taskIds, body) => { desfazer.enviar(); setBulkMessage(null); bulkMutation.mutate({ ids: taskIds, body }) }}
            solicitantes={solicitantesQuery.data ?? []}
            onCreateTask={(payload) => createMutation.mutate(payload)}
            creatingTask={createMutation.isPending}
            createTaskError={createError}
          />
        </>
      )}

      {acaoErro && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {acaoErro}
            <Button variant="ghost" size="sm" onClick={() => setAcaoErro(null)}>Fechar</Button>
          </AlertDescription>
        </Alert>
      )}

      <DesfazerAviso aviso={desfazer.aviso} onDesfazer={desfazer.desfazer} />
      <CommandPalette aberto={paletaAberta} onFechar={() => setPaletaAberta(false)} comandos={comandos} />

      <TaskModal
        task={selectedTask}
        onClose={() => {
          setSelectedTask(null)
          setSaveError(null)
        }}
        onSave={(body) => { desfazer.enviar(); updateMutation.mutate(body) }}
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
