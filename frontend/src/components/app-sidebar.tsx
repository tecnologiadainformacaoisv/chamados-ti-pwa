import { ClipboardList, LayoutDashboard } from "lucide-react"
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

export type Secao = "gestao" | "dashboard"

const NAV_ITEMS: { id: Secao; label: string; icon: typeof ClipboardList }[] = [
  { id: "gestao", label: "Gestão", icon: ClipboardList },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
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
      className="border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2 overflow-hidden">
          <img src={logoIsv} alt="" className="h-8 w-8 shrink-0 invert" />
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
