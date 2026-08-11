import { useState } from "react"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { AppSidebar, type Secao } from "@/components/app-sidebar"
import { AppHeader } from "@/components/app-header"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"

// Mesmo texto de SECTION_META em admin.js — Fase F1 do roadmap de
// modernização: só o shell visual (sidebar + header + área de conteúdo),
// espelhando admin.html. Nenhum dado real ainda (isso é F2 em diante).
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

function App() {
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

            {/* Placeholder — layout provado, sem dado real (Fase F2 em diante conecta no Worker) */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {["Aberto", "Em atendimento", "Pendente", "Encerrado"].map((status) => (
                <Card key={status}>
                  <CardHeader className="pb-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {status}
                    </span>
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-7 w-14" />
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
                <p className="text-sm">
                  Shell visual da Fase F1 — Quadro/Tabela de verdade chegam nas próximas fases.
                </p>
              </CardContent>
            </Card>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
