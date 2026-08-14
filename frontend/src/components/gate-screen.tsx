import { useState, type FormEvent } from "react"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import iconIsv from "@/assets/icon-isv.svg"

// Porta a tela de gate de admin.html — "Verificando sessão salva…" evita o flash do
// formulário completo quando já existe um segredo salvo (mesma ideia do script inline
// que a versão vanilla usa, só que aqui é natural: React só renderiza o form quando
// o estado realmente vira "gate").
export function GateScreen() {
  const { state, error, login } = useAdminAuth()
  const [value, setValue] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!value.trim()) return
    setSubmitting(true)
    setLocalError(null)
    try {
      await login(value.trim())
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Não foi possível entrar. Verifique sua conexão.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center p-4">
      <div className="bg-brand-gradient fixed inset-0 z-0" />
      <div className="shadow-brand-card relative z-10 w-full max-w-sm rounded-[20px] bg-card p-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          {/* ícone quadrado (não o logotipo largo) — mesmo glyph do app icon/vanilla
              setup-screen; logo-isv.svg é um lockup horizontal (~3.3:1) e fica
              espremido/ilegível dentro de uma caixa quadrada (achado 2026-08-14) */}
          <img src={iconIsv} alt="" className="h-14 w-14 rounded-xl" />
          <h1 className="text-lg font-semibold text-foreground">Painel de Admin</h1>
          <p className="text-sm text-muted-foreground">Chamados de TI – ISV</p>
        </div>

        {state === "checking" ? (
          <p className="text-center text-sm text-muted-foreground">Verificando sessão salva…</p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="gate-secret">Segredo de admin *</Label>
              <Input
                id="gate-secret"
                type="password"
                autoComplete="off"
                placeholder="X-Admin-Secret"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Não é sua senha de login do app — é o segredo separado configurado no Worker (
                <span className="font-mono">ADMIN_SECRET</span>), que a TI já tem.
              </p>
            </div>

            {(error || localError) && (
              <Alert variant="destructive">
                <AlertDescription>{localError || error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={submitting}>
              {submitting ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
