import { ClipboardList, LayoutDashboard, Users } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import logoIsv from "@/assets/logo-isv.svg"
import iconIsv from "@/assets/icon-isv.svg"

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
}: {
  secaoAtiva: Secao
  onSecaoChange: (s: Secao) => void
}) {
  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar-gradient border-sidebar-border text-sidebar-foreground"
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
    </Sidebar>
  )
}
