import { RefreshCw, LogOut } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import logoIsv from "@/assets/logo-isv.svg"

// Espelha o .app-header de admin.html — mesma marca (logo ISV, "Painel de
// Admin" / "Chamados de TI") e as mesmas duas ações (atualizar, sair).
export function AppHeader() {
  const { logout } = useAdminAuth()
  const queryClient = useQueryClient()

  return (
    <header className="bg-brand-gradient flex h-16 shrink-0 items-center justify-between px-4 text-primary-foreground shadow-[0_2px_12px_rgba(0,0,0,0.2)]">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground" />
        <img src={logoIsv} alt="Instituto São Vicente" className="h-8 w-8 invert" />
      </div>
      <div className="flex flex-col items-center leading-tight">
        <span className="text-sm font-semibold">Painel de Admin</span>
        <span className="text-xs text-primary-foreground/70">Chamados de TI</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          title="Atualizar"
          className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground"
          onClick={() => queryClient.invalidateQueries()}
        >
          <RefreshCw />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Sair"
          className="text-primary-foreground hover:bg-white/10 hover:text-primary-foreground"
          onClick={() => {
            if (confirm("Sair do painel?")) logout()
          }}
        >
          <LogOut />
        </Button>
      </div>
    </header>
  )
}
