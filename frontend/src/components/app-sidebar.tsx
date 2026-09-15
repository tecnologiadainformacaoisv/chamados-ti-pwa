import { ClipboardList, LayoutDashboard, Users } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { SidebarControl } from "@/components/sidebar-control"
import type { SidebarMode } from "@/hooks/use-sidebar-mode"
import logoIsv from "@/assets/logo-isv.svg"
import iconIsv from "@/assets/icon-isv.svg"
// Versão declarada em package.json (ver CLAUDE.md, "Padrões de desenvolvimento") —
// Vite resolve import de JSON nativamente, sem precisar duplicar o número aqui.
// Named import (não `import pkg from "..."`) de propósito — achado do revisor
// (2026-09-15): o default import bundlava o package.json INTEIRO no admin.js de
// produção (scripts/dependencies/devDependencies, tudo), não só o version. Named
// import permite o Rollup fazer tree-shaking do resto.
import { version } from "../../package.json"

export type Secao = "gestao" | "dashboard" | "usuarios"

const NAV_ITEMS: { id: Secao; label: string; icon: typeof ClipboardList }[] = [
  { id: "gestao", label: "Gestão", icon: ClipboardList },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  // Fase M1 (2026-08-13, migração de saída da ClickUp) — antes disso, a lista de
  // solicitantes só existia como custom field dentro da ClickUp; agora a TI gerencia
  // aqui direto.
  { id: "usuarios", label: "Usuários", icon: Users },
]

// Espelha a mesma sidebar (navy, Gestão/Dashboard) que já existe em admin.html —
// Fase F1 do roadmap de modernização: só o shell visual, sem dados/rotas ainda.
export function AppSidebar({
  secaoAtiva,
  onSecaoChange,
  sidebarMode,
  onSidebarModeChange,
  onMouseEnter,
  onMouseLeave,
}: {
  secaoAtiva: Secao
  onSecaoChange: (s: Secao) => void
  sidebarMode: SidebarMode
  onSidebarModeChange: (m: SidebarMode) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar-gradient border-sidebar-border text-sidebar-foreground"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 2026-08-13: sidebar abre colapsada por padrão (defaultOpen={false} em
          AdminApp.tsx). 2026-08-14: logo-isv.svg é um lockup largo (~3.3:1) —
          não dá pra esmagar num quadrado sem virar ilegível (mesmo achado do
          header/login), então aqui ela só aparece expandida (h-8 w-auto,
          brightness-0 invert pra virar silhueta branca de verdade — só
          invert() sozinho inverte as CORES, não basta). Quando colapsa, troca
          pro ícone quadrado (iconIsv, mesmo glyph do app/PWA) — o encaixe é
          exato, sem sobra: modo ícone tem --sidebar-width-icon: 3rem (48px,
          definido em ui/sidebar.tsx), e p-2 (8px de cada lado) + h-8 w-8
          (32px) fecham a conta em 48px. Se qualquer uma das três pontas mudar
          (largura do ícone no componente base, este padding, ou o tamanho do
          ícone aqui), ele estoura o container — reconferir com o app rodando
          de verdade. */}
      <SidebarHeader className="p-4 group-data-[collapsible=icon]:p-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <img
            src={logoIsv}
            alt=""
            className="h-8 w-auto shrink-0 brightness-0 invert group-data-[collapsible=icon]:hidden"
          />
          <img
            src={iconIsv}
            alt=""
            className="hidden h-8 w-8 shrink-0 rounded-md group-data-[collapsible=icon]:block"
          />
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-wide">Instituto</span>
            <span className="text-sm font-semibold tracking-wide">São Vicente</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={secaoAtiva === item.id}
                    onClick={() => onSecaoChange(item.id)}
                    tooltip={item.label}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      {/* Controle de sidebar estilo Supabase (2026-09-15, pedido do usuário) — o ícone
          de controle fica sempre visível, mesmo colapsada (é o único jeito de voltar
          pro modo expandido sem depender do trigger do header) — só a versão que
          continua escondendo no modo ícone (não cabe, mesma regra de sempre). */}
      <SidebarFooter className="flex-row items-center justify-between gap-1 group-data-[collapsible=icon]:justify-center">
        <span className="px-2 text-xs text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden">v{version}</span>
        <SidebarControl mode={sidebarMode} onChange={onSidebarModeChange} />
      </SidebarFooter>
    </Sidebar>
  )
}
