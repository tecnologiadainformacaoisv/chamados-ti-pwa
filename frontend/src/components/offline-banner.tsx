import { useOnlineStatus } from "@/hooks/use-online-status"

// Porta #offline-banner/.offline-banner de index.html+css/style.css — banner
// sticky no topo, acima até do header (mesmo z-index relativo do vanilla:
// offline-banner=400, app-header=100). Só existe no app do solicitante — o
// admin nunca teve isso (css/admin.css não define nada equivalente), TI
// trabalha de rede estável no escritório, não era o alvo do vanilla.
export function OfflineBanner() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <div className="sticky top-0 z-[400] bg-destructive px-3 py-2 text-center text-sm font-semibold text-destructive-foreground">
      Sem conexão com a internet
    </div>
  )
}
