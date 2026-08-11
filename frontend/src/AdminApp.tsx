import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { AppSidebar, type Secao } from "@/components/app-sidebar"
import { AppHeader } from "@/components/app-header"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AdminAuthProvider, useAdminAuth } from "@/hooks/use-admin-auth"
import { GateScreen } from "@/components/gate-screen"
import { GestaoView } from "@/components/gestao-view"
import { DashboardView } from "@/components/dashboard-view"
import { isSessionError } from "@/lib/api"

// Nunca insiste tentando de novo (com backoff) quando o segredo foi revogado — isso só
// atrasaria voltar pro gate. Continua tentando normalmente pra qualquer outro erro
// (rede, 5xx), até 3 vezes, mesmo comportamento padrão do TanStack Query.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => (isSessionError(error) ? false : failureCount < 3),
    },
  },
})

const SECAO_META: Record<Secao, { titulo: string; subtitulo: string }> = {
  gestao: {
    titulo: "Gestão",
    subtitulo: "Aceite, mudança de status, atribuição de operador e solução dos chamados.",
  },
  dashboard: {
    titulo: "Dashboard",
    subtitulo: "Indicadores e relatórios — volume por tipo/setor, SLA e tempo médio de atendimento.",
  },
}

function AdminShell() {
  const [secaoAtiva, setSecaoAtiva] = useState<Secao>("gestao")
  const meta = SECAO_META[secaoAtiva]

  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider>
        <AppSidebar secaoAtiva={secaoAtiva} onSecaoChange={setSecaoAtiva} />
        <SidebarInset>
          <AppHeader />
          <main className="flex-1 space-y-6 bg-muted/30 p-6">
            <div>
              <h1 className="text-xl font-semibold text-foreground">{meta.titulo}</h1>
              <p className="text-sm text-muted-foreground">{meta.subtitulo}</p>
            </div>

            {secaoAtiva === "gestao" ? <GestaoView /> : <DashboardView />}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function AuthGate() {
  const { state } = useAdminAuth()
  if (state === "authed") return <AdminShell />
  return <GateScreen />
}

export function AdminApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminAuthProvider>
        <AuthGate />
      </AdminAuthProvider>
    </QueryClientProvider>
  )
}
