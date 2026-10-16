import { useRef, useState, type FormEvent, type RefObject } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useSessionAuth } from "@/hooks/use-session-auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import iconIsv from "@/assets/icon-isv.svg"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MSG_EMAIL = "Digite seu e-mail completo, por exemplo nome@institutosaovicente.com.br."
const MSG_SENHA = "A senha precisa ter pelo menos 8 caracteres."

// Campo de senha com botão "mostrar" (2026-10-16, revisão de UX pra implantação): no
// primeiro acesso a senha digitada vira a senha definitiva, e um erro de digitação às
// cegas vira fila de reset na TI. Ver a senha antes de entrar evita isso.
function PasswordInput({ id, autoComplete, placeholder, value, onChange, inputRef, describedBy }: {
  id: string; autoComplete: string; placeholder: string; value: string; onChange: (v: string) => void
  inputRef?: RefObject<HTMLInputElement | null>; describedBy?: string
}) {
  const [visivel, setVisivel] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        ref={inputRef}
        aria-describedby={describedBy}
        type={visivel ? "text" : "password"}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="pr-11"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setVisivel((v) => !v)}
        aria-label={visivel ? "Esconder senha" : "Mostrar senha"}
        aria-pressed={visivel}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        {visivel ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

// Porta showSetup()/onSetupSubmit() de app.js — login e cadastro são a mesma tela e o
// mesmo formulário: se /auth/login devolve 404 (sem senha pra esse e-mail), a senha
// digitada agora vira a senha de acesso (ver loginOrRegister em app-api.ts).
//
// Login por e-mail (2026-09-16, pedido da diretoria) — antes disso era um <Select>
// escolhendo o próprio nome numa lista de todo mundo (`nomes`, ainda usado aqui só
// pra validar se a sessão salva continua correspondendo a alguém ativo, ver
// use-session-auth.tsx). Trocar pra e-mail fecha o risco de escolher o nome de
// OUTRA pessoa sem querer — cada um só sabe o próprio e-mail.
export function SolicitanteSetup() {
  const { bootError, retryBoot, login } = useSessionAuth()
  const [modoExterno, setModoExterno] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Foco vai pro campo com problema quando a validação falha (leitor de tela e teclado).
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  if (bootError) {
    return (
      <div className="relative flex min-h-svh items-center justify-center p-4">
        <div className="bg-brand-gradient fixed inset-0 z-0" />
        <div className="shadow-brand-card relative z-10 w-full max-w-sm rounded-[20px] bg-card p-8 text-center">
          <p className="mb-1 text-sm font-medium text-destructive">Não foi possível conectar ao sistema.</p>
          <p className="mb-4 text-sm text-muted-foreground">
            Verifique sua internet e tente de novo. Se continuar, fale com a TI.
          </p>
          <Button onClick={retryBoot}>Tentar de novo</Button>
        </div>
      </div>
    )
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!EMAIL_RE.test(email.trim())) {
      setError(MSG_EMAIL)
      emailRef.current?.focus()
      return
    }
    // No login só exige senha preenchida (o mínimo de 8 caracteres vale pra CRIAR a senha;
    // se existir uma senha antiga mais curta, quem já tem conta não pode ficar trancado
    // aqui). No primeiro acesso, o servidor devolve a mensagem do mínimo de 8 caracteres.
    if (!password) {
      setError("Digite sua senha.")
      passwordRef.current?.focus()
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await login(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível entrar. Verifique sua conexão.")
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
          <h1 className="text-lg font-semibold text-foreground">Chamados de TI</h1>
          <p className="text-sm text-muted-foreground">ISV – Suporte Técnico</p>
        </div>

        {modoExterno ? (
          <SetupExterno
            onVoltar={() => {
              setError(null)
              setModoExterno(false)
            }}
          />
        ) : (
          <>
            <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="setup-email">Seu e-mail institucional *</Label>
                <Input
                  id="setup-email"
                  ref={emailRef}
                  type="email"
                  autoComplete="username"
                  placeholder="voce@institutosaovicente.com.br"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="setup-password">Senha *</Label>
                <PasswordInput
                  id="setup-password"
                  inputRef={passwordRef}
                  describedBy="setup-password-hint"
                  autoComplete="current-password"
                  placeholder="Sua senha de acesso"
                  value={password}
                  onChange={setPassword}
                />
                <p id="setup-password-hint" className="rounded-md bg-muted px-2.5 py-2 text-xs text-foreground">
                  <strong>Primeiro acesso?</strong> A senha que você digitar agora será a sua senha. Use o olho para
                  conferir antes de entrar (mínimo 8 caracteres).
                </p>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button type="submit" disabled={submitting}>
                {submitting ? "Entrando…" : "Entrar"}
              </Button>
            </form>

            {/* variant="secondary", não "outline" — --background e --card são o MESMO
                branco puro neste tema (ver index.css), então "outline" (bg-background)
                não tinha NENHUM preenchimento visível por cima do card, só uma borda
                fraca — o que fazia o botão sumir mesmo depois do fix de quebra de linha.
                "secondary" usa --secondary (cinza-azulado real, distinto do card) —
                preenchimento visível de verdade, não só borda. h-auto/whitespace-normal
                — o texto é longo demais pra caber numa linha só (Button base é
                whitespace-nowrap, pensado pra rótulo curto). */}
            <Button
              type="button"
              variant="secondary"
              onClick={() => setModoExterno(true)}
              className="mt-4 h-auto w-full whitespace-normal py-2.5 text-center leading-snug"
            >
              Não tenho e-mail institucional (visitante, parceiro ou fornecedor)
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

// Autocadastro externo (2026-09-17, pedido do usuário: "os chamados tbm estao
// sendo usados de forma externa, e agora recebemos um chamado com a identificacao
// outros e nem sabemos de onde veio... preciso que haja uma forma de identificar
// estes usuarios que nao sao os pre selecionados"). Antes disso, quem não tinha
// e-mail institucional não conseguia logar de jeito NENHUM — na prática isso
// empurrava todo mundo externo pra uma conta compartilhada única, misturando
// chamados de pessoas diferentes sob a mesma identidade. Formulário separado (não
// um campo a mais no de cima) porque pede dado que o login normal não pede (nome
// completo digitado na hora, telefone) e não tem a restrição de domínio.
function SetupExterno({ onVoltar }: { onVoltar: () => void }) {
  const { loginExterno } = useSessionAuth()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [telefone, setTelefone] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || name.trim().split(/\s+/).length < 2) {
      setError("Digite seu nome completo (nome e sobrenome)")
      return
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError("Digite um e-mail completo, por exemplo nome@email.com.")
      return
    }
    if (password.length < 8) {
      setError(MSG_SENHA)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await loginExterno(name.trim(), email.trim(), password, telefone.trim() || undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível cadastrar. Verifique sua conexão.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Cadastro pra quem não tem e-mail institucional — a TI vai ver seu nome, e-mail e
        telefone junto de cada chamado que você abrir.
      </p>

      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-ext-name">Nome completo *</Label>
        <Input
          id="setup-ext-name"
          autoComplete="name"
          placeholder="Seu nome e sobrenome"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-ext-email">Seu e-mail *</Label>
        <Input
          id="setup-ext-email"
          type="email"
          autoComplete="username"
          placeholder="voce@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-ext-telefone">Telefone (opcional)</Label>
        <Input
          id="setup-ext-telefone"
          type="tel"
          autoComplete="tel"
          placeholder="(85) 90000-0000"
          value={telefone}
          onChange={(e) => setTelefone(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-ext-password">Senha *</Label>
        <PasswordInput
          id="setup-ext-password"
          autoComplete="new-password"
          placeholder="Crie uma senha de acesso"
          value={password}
          onChange={setPassword}
        />
        <p className="text-xs text-muted-foreground">Mínimo de 8 caracteres. Use o olho para conferir.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={submitting}>
        {submitting ? "Cadastrando…" : "Cadastrar e entrar"}
      </Button>

      <Button type="button" variant="secondary" onClick={onVoltar} className="h-auto w-full whitespace-normal py-2.5 text-center leading-snug">
        Tenho e-mail institucional — voltar pra entrada normal
      </Button>
    </form>
  )
}
