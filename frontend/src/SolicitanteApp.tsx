import { useEffect, useState } from "react"
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query"
import { LogOut } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { SessionAuthProvider, useSessionAuth } from "@/hooks/use-session-auth"
import { SolicitanteSetup } from "@/components/solicitante-setup"
import { NovoChamadoForm } from "@/components/novo-chamado-form"
import { TicketCard } from "@/components/ticket-card"
import { WaModal } from "@/components/wa-modal"
import { fetchMyTasks, isAuthExpired } from "@/lib/app-api"
import type { Task } from "@/lib/api"
import logoIsv from "@/assets/logo-isv.svg"

// Instância própria — SolicitanteApp e AdminApp nunca coexistem na mesma árvore hoje
// (ver App.tsx), cada um com seu próprio client, igual dois apps de fato separados.
const queryClient = new QueryClient()

// Porta initApp()/renderAll()/switchTab() de app.js — 3 abas (Novo Chamado, Meus
// Chamados, Histórico), mesmo "smart polling" de 60s. Fora de escopo desta fase (ver
// relatório da F4): upload de anexo, push notifications, PWA/Service Worker.
function SolicitanteShell() {
  const { sessionToken, userName, logout, handleSessionExpired } = useSessionAuth()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState("novo-chamado")
  const [waTask, setWaTask] = useState<{ task: Task; slaLabel: string } | null>(null)

  const tasksQuery = useQuery({
    queryKey: ["my-tasks"],
    queryFn: () => fetchMyTasks(sessionToken),
    refetchInterval: 60_000,
  })

  useEffect(() => {
    if (isAuthExpired(tasksQuery.error)) handleSessionExpired()
  }, [tasksQuery.error, handleSessionExpired])

  const tasks = tasksQuery.data ?? []
  const ativos = tasks.filter((t) => t.status?.status !== "encerrado").sort((a, b) => Number(b.date_created) - Number(a.date_created))
  const encerrados = tasks.filter((t) => t.status?.status === "encerrado").sort((a, b) => Number(b.date_created) - Number(a.date_created))

  return (
    <div className="min-h-svh bg-muted/30">
      <header className="flex h-16 items-center justify-between border-b border-border bg-primary px-4 text-primary-foreground">
        <div className="flex items-center gap-3">
          <img src={logoIsv} alt="" className="h-8 w-8 invert" />
          <div className="leading-tight">
            <p className="text-sm font-semibold">Chamados de TI</p>
            <p className="text-xs text-primary-foreground/70">{userName}</p>
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          title="Sair"
          className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground"
          onClick={() => confirm("Desconectar?") && logout()}
        >
          <LogOut />
        </Button>
      </header>

      <main className="mx-auto max-w-2xl p-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="novo-chamado" className="flex-1">Novo Chamado</TabsTrigger>
            <TabsTrigger value="meus-chamados" className="flex-1">
              Meus Chamados{ativos.length > 0 && ` (${ativos.length})`}
            </TabsTrigger>
            <TabsTrigger value="todos-chamados" className="flex-1">
              Histórico{encerrados.length > 0 && ` (${encerrados.length})`}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="novo-chamado" className="mt-4">
            <NovoChamadoForm
              onCreated={(task, slaLabel) => {
                queryClient.invalidateQueries({ queryKey: ["my-tasks"] })
                setTab("meus-chamados")
                setWaTask({ task, slaLabel })
              }}
            />
          </TabsContent>

          <TabsContent value="meus-chamados" className="mt-4 flex flex-col gap-3">
            {tasksQuery.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>}
            {!tasksQuery.isLoading && ativos.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">Nenhum chamado em aberto.</p>
            )}
            {ativos.map((t) => <TicketCard key={t.id} task={t} />)}
          </TabsContent>

          <TabsContent value="todos-chamados" className="mt-4 flex flex-col gap-3">
            {tasksQuery.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>}
            {!tasksQuery.isLoading && encerrados.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">Nenhum chamado encerrado ainda.</p>
            )}
            {encerrados.map((t) => <TicketCard key={t.id} task={t} />)}
          </TabsContent>
        </Tabs>
      </main>

      <WaModal task={waTask?.task ?? null} slaLabel={waTask?.slaLabel ?? ""} onClose={() => setWaTask(null)} />
    </div>
  )
}

function SolicitanteBoot() {
  const { state } = useSessionAuth()
  if (state === "app") return <SolicitanteShell />
  return <SolicitanteSetup />
}

export function SolicitanteApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionAuthProvider>
        <SolicitanteBoot />
      </SessionAuthProvider>
    </QueryClientProvider>
  )
}
