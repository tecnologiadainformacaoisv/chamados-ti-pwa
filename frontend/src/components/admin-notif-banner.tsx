import { useState } from "react"
import { Bell, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAdminPushNotifications } from "@/hooks/use-admin-push-notifications"

// Mesmo componente/mesma regra de notif-banner.tsx (lado solicitante) — só troca o
// texto e a fonte da inscrição (por dispositivo, não por sessão de login).
export function AdminNotifBanner({ secret }: { secret: string }) {
  const { state, ativar, dispensar } = useAdminPushNotifications(secret)
  const [feedback, setFeedback] = useState<string | null>(null)

  if (state !== "show-banner" && !feedback) return null

  async function handleAtivar() {
    const perm = await ativar()
    if (perm === "denied") {
      setFeedback("Permissão negada. Ative nas configurações do navegador se mudar de ideia.")
    }
  }

  if (feedback) {
    return (
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-muted-foreground">
        <span>{feedback}</span>
        <Button size="icon-sm" variant="ghost" onClick={() => setFeedback(null)} aria-label="Fechar">
          <X className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-accent/10 px-4 py-2.5 text-sm">
      <span className="flex items-center gap-2 text-foreground">
        <Bell className="h-4 w-4 shrink-0" /> Ative as notificações pra saber na hora quando um chamado novo chegar, mesmo com o painel fechado.
      </span>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={dispensar}>Agora não</Button>
        <Button size="sm" onClick={handleAtivar}>Ativar</Button>
      </div>
    </div>
  )
}
