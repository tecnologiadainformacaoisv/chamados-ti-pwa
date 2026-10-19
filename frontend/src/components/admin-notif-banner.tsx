import { useState } from "react"
import { Bell, BellOff, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAdminPushNotifications } from "@/hooks/use-admin-push-notifications"

// Mesmo componente/mesma regra de notif-banner.tsx (lado solicitante) — só troca o
// texto e a fonte da inscrição (por dispositivo, não por sessão de login).
//
// Reescrito em 2026-09-15 (pedido do usuário: "chamados estão acontecendo e não estou
// sendo notificado") — antes disso, o único estado visível era o banner de "Ativar" (só
// aparece uma vez, some pra sempre depois de clicado) e um badge silencioso: depois de
// ativado, não havia NENHUMA indicação — de erro ou de sucesso — que as notificações
// realmente estavam chegando no servidor. Agora sempre mostra uma linha de status
// compacta (ativo/erro/verificando), com um botão "Testar" que dispara o som local (o
// mesmo tocado quando o painel está aberto) E um push real de ponta a ponta pelo
// servidor (o mesmo caminho que um chamado novo usaria) — sem precisar criar um
// chamado de teste real só pra verificar velocidade/som/entrega.
export function AdminNotifBanner({ secret }: { secret: string }) {
  const { state, erro, ativar, dispensar, testar } = useAdminPushNotifications(secret)
  const [permissaoNegada, setPermissaoNegada] = useState(false)
  const [testando, setTestando] = useState(false)

  if (state === "unsupported" || state === "hidden") return null

  async function handleAtivar() {
    const perm = await ativar()
    if (perm === "denied") setPermissaoNegada(true)
  }

  async function handleTestar() {
    setTestando(true)
    try {
      await testar()
    } catch {
      /* o hook já passa pro estado de erro, que aparece na barra */
    } finally {
      setTestando(false)
    }
  }

  if (permissaoNegada) {
    return (
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-2.5 text-sm text-muted-foreground">
        <span>Permissão negada. Ative nas configurações do navegador (cadeado ao lado da URL → Notificações) se mudar de ideia.</span>
        <Button size="icon-sm" variant="ghost" onClick={() => setPermissaoNegada(false)} aria-label="Fechar">
          <X className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  if (state === "show-banner") {
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

  // Funcionando (ou ainda verificando): nada na tela. A barra de status com "Testar notificação" saiu a
  // pedido do usuário (2026-10-19, tela mais limpa); só o ERRO continua aparecendo, pra não falhar em silêncio.
  if (state !== "error") return null
  const isError = state === "error"
  return (
    <div className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2 text-sm ${isError ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40"}`}>
      <span className="flex items-center gap-2">
        {isError ? (
          <>
            <BellOff className="h-4 w-4 shrink-0 text-destructive" />
            <span className="text-destructive">Notificação não confirmada: {erro}</span>
          </>
        ) : (
          <>
            <Bell className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-muted-foreground">
              {state === "checking" ? "Verificando notificações…" : "Notificações push ativas neste navegador."}
            </span>
          </>
        )}
      </span>
      <Button size="sm" variant={isError ? "default" : "outline"} onClick={handleTestar} disabled={testando}>
        {testando ? "Testando…" : isError ? "Tentar de novo" : "Testar notificação"}
      </Button>
    </div>
  )
}
