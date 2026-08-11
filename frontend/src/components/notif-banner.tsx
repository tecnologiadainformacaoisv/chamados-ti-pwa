import { useState } from "react"
import { Bell, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePushNotifications } from "@/hooks/use-push-notifications"

// Porta o banner de notif-banner/#notif-enable/#notif-dismiss de app.js — mesma regra:
// só aparece se a permissão ainda está em "default" e não foi dispensado nas últimas 24h.
export function NotifBanner({ sessionToken }: { sessionToken: string }) {
  const { state, ativar, dispensar } = usePushNotifications(sessionToken)
  const [feedback, setFeedback] = useState<string | null>(null)

  // `ativar()` já muda o estado do hook pra "hidden" antes do requestPermission()
  // resolver (pra não deixar o banner de "Ativar" aberto enquanto espera a resposta do
  // navegador) — por isso o feedback de "negada" precisa de estado próprio aqui, e não
  // pode depender só de `state === "show-banner"` continuar verdadeiro.
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
        <Bell className="h-4 w-4 shrink-0" /> Ative as notificações pra saber em tempo real quando seu chamado for atualizado.
      </span>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={dispensar}>Agora não</Button>
        <Button size="sm" onClick={handleAtivar}>Ativar</Button>
      </div>
    </div>
  )
}
