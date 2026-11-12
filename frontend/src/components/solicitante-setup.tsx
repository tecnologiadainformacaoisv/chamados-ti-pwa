import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useSessionAuth } from "@/hooks/use-session-auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { PrimeiroAcessoError } from "@/lib/app-api"
import { WA_NUMBER_PADRAO } from "@/lib/constants"
import iconIsv from "@/assets/icon-isv.svg"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MSG_EMAIL = "Digite seu e-mail completo, por exemplo nome@institutosaovicente.com.br."
const MSG_SENHA = "A senha precisa ter pelo menos 8 caracteres."

type CartaoEx = { n: string; sit: "aberto" | "atend" | "espera" | "ok"; t: string; sub: string }
const SIT = {
  aberto: { rot: "Aberto", chip: "bg-[#E3ECFA] text-[#1A3A6B]", passos: 1, barra: "bg-[#2A5298]" },
  atend: { rot: "Em atendimento", chip: "bg-[#EEE8FB] text-[#5B3FB0]", passos: 2, barra: "bg-[#5B3FB0]" },
  espera: { rot: "Em espera", chip: "bg-[#FEF3C7] text-[#92400E]", passos: 2, barra: "bg-[#D97706]" },
  ok: { rot: "Atendido", chip: "bg-[#DCFCE7] text-[#166534]", passos: 3, barra: "bg-[#16A34A]" },
} as const
const CARDS_A: CartaoEx[] = [
  { n: "0142", sit: "atend", t: "Impressora do financeiro não imprime", sub: "Everson está atendendo" },
  { n: "0143", sit: "aberto", t: "Computador da recepção não liga", sub: "Aguardando a TI aceitar" },
  { n: "0138", sit: "ok", t: "Acesso ao e-mail liberado", sub: "Atendido por Henrique" },
  { n: "0144", sit: "espera", t: "Troca de toner da sala 3", sub: "Em espera, prazo pausado" },
]
const CARDS_B: CartaoEx[] = [
  { n: "0145", sit: "atend", t: "Wi-Fi caindo na sala de reuniões", sub: "Henrique está atendendo" },
  { n: "0139", sit: "ok", t: "Senha do sistema redefinida", sub: "Atendido por Everson" },
  { n: "0146", sit: "aberto", t: "Instalar o Excel no notebook novo", sub: "Aguardando a TI aceitar" },
  { n: "0140", sit: "ok", t: "Ramal sem som corrigido", sub: "Atendido por Henrique" },
]

function CartaoExemplo({ c }: { c: CartaoEx }) {
  const s = SIT[c.sit]
  return (
    <div className="mb-4 rounded-2xl bg-white p-4 text-[#12223F] shadow-[0_18px_40px_rgba(0,0,0,.28)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-[#1A3A6B]">#{c.n}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.chip}`}>{s.rot}</span>
      </div>
      <p className="mt-1.5 text-sm font-semibold leading-snug">{c.t}</p>
      <p className="mt-0.5 text-xs text-slate-600">{c.sub}</p>
      <div className="mt-3 flex gap-1">
        {[1, 2, 3].map((i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= s.passos ? s.barra : "bg-slate-200"}`} />
        ))}
      </div>
    </div>
  )
}

// Moldura da tela de entrada (redesenho 2026-11-11): no computador, duas colunas — à esquerda a
// marca e um exemplo de chamado (o que a pessoa vai ter depois de entrar), à direita o formulário
// alinhado à esquerda, sem cartão flutuante. No celular a coluna da marca vira uma faixa curta no topo.
function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh grid-rows-[auto_1fr] bg-[#F4F7FB] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:grid-rows-1">
      <aside className="bg-sidebar-gradient relative flex flex-col gap-10 overflow-hidden px-6 py-5 text-white lg:justify-between lg:px-14 lg:py-12">
        <div className="flex items-center gap-3">
          <img src={iconIsv} alt="" className="h-11 w-11 rounded-xl" />
          <div className="leading-tight">
            <p className="text-base font-bold">Chamados de TI</p>
            <p className="text-sm text-white/70">Instituto São Vicente</p>
          </div>
        </div>

        <div className="hidden lg:block">
          <p className="max-w-md text-[2.4rem] font-bold leading-[1.1] tracking-tight">
            Peça ajuda da TI e acompanhe cada passo.
          </p>
          <p className="mt-4 max-w-sm text-base leading-relaxed text-white/75">
            Todo chamado tem número, prazo e aviso no seu celular quando o status muda.
          </p>

        </div>

        {/* Palco dinâmico (o -mx-14 compensa o lg:px-14 do aside): duas colunas de chamados de exemplo, uma sobe e outra desce, em loop.
            Só transform (leve), pausa com prefers-reduced-motion e some no celular. */}
        <div
          aria-hidden="true"
          className="relative -mx-14 hidden min-h-0 flex-1 overflow-hidden lg:block [mask-image:linear-gradient(to_bottom,transparent,#000_16%,#000_84%,transparent)]"
        >
          <div className="login-glow pointer-events-none absolute -right-10 top-1/4 h-72 w-72 rounded-full bg-[#5B8DEF]/40 blur-3xl" />
          <div className="absolute inset-0 grid -rotate-6 scale-110 grid-cols-2 gap-4">
            <div className="login-sobe">
              {[...CARDS_A, ...CARDS_A].map((c, i) => <CartaoExemplo key={i} c={c} />)}
            </div>
            <div className="login-desce">
              {[...CARDS_B, ...CARDS_B].map((c, i) => <CartaoExemplo key={i} c={c} />)}
            </div>
          </div>
        </div>

        <p className="hidden text-sm text-white/70 lg:block">Suporte técnico do ISV</p>
      </aside>

      <main className="flex items-start justify-center px-6 py-8 lg:items-center lg:px-12 lg:py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  )
}

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
        className="h-11 pr-11"
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
  // Primeiro acesso (2026-11-11): o servidor ainda não tem senha pra esse e-mail, então a tela
  // pede pra repetir a senha antes de cadastrar (um erro de digitação aqui seria definitivo).
  const [primeiroAcesso, setPrimeiroAcesso] = useState(false)
  const [confirmacao, setConfirmacao] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Foco vai pro campo com problema quando a validação falha (leitor de tela e teclado).
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmacaoRef = useRef<HTMLInputElement>(null)

  if (bootError) {
    return (
      <LoginShell>
        <p role="alert" className="mb-1 text-base font-semibold text-destructive">Não foi possível conectar ao sistema.</p>
        <p className="mb-5 text-sm text-muted-foreground">
          Verifique sua internet e tente de novo. Se continuar, fale com a TI.
        </p>
        <Button onClick={retryBoot} className="h-11 w-full">Tentar de novo</Button>
      </LoginShell>
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
    if (primeiroAcesso) {
      if (password.length < 8) {
        setError(MSG_SENHA)
        passwordRef.current?.focus()
        return
      }
      if (confirmacao !== password) {
        setError("As duas senhas não são iguais. Digite de novo.")
        confirmacaoRef.current?.focus()
        return
      }
    }
    setSubmitting(true)
    setError(null)
    try {
      await login(email.trim(), password, primeiroAcesso ? confirmacao : undefined)
    } catch (err) {
      if (err instanceof PrimeiroAcessoError) {
        // Ainda sem senha: abre o campo "Repita a senha" e espera a pessoa confirmar.
        setPrimeiroAcesso(true)
        setConfirmacao("")
        setError(null)
        setTimeout(() => confirmacaoRef.current?.focus(), 0)
      } else {
        setError(err instanceof Error ? err.message : "Não foi possível entrar. Verifique sua conexão.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const linkEsqueci = `https://wa.me/${WA_NUMBER_PADRAO}?text=${encodeURIComponent("Olá! Esqueci minha senha do sistema de chamados de TI. Pode resetar pra mim?")}`

  return (
    <LoginShell>
      {modoExterno ? (
        <SetupExterno
          onVoltar={() => {
            setError(null)
            setModoExterno(false)
          }}
        />
      ) : (
        <>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Entrar</h1>
          <p className="mb-6 mt-1 text-sm text-muted-foreground">Use o e-mail institucional e a sua senha.</p>

          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-email">E-mail institucional</Label>
              <Input
                id="setup-email"
                ref={emailRef}
                type="email"
                autoComplete="username"
                placeholder="voce@institutosaovicente.com.br"
                className="h-11"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  // Trocou o e-mail: a etapa de "primeiro acesso" valia pro e-mail anterior.
                  if (primeiroAcesso) { setPrimeiroAcesso(false); setConfirmacao("") }
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-password">{primeiroAcesso ? "Crie sua senha" : "Senha"}</Label>
              <PasswordInput
                id="setup-password"
                inputRef={passwordRef}
                describedBy="setup-password-hint"
                autoComplete="current-password"
                placeholder="Sua senha de acesso"
                value={password}
                onChange={setPassword}
              />
              {!primeiroAcesso && (
                <p id="setup-password-hint" className="text-xs leading-relaxed text-muted-foreground">
                  <strong className="font-semibold text-foreground">Primeiro acesso?</strong> Digite a senha que você
                  quer usar (mínimo 8 caracteres). Vamos pedir para repeti-la.
                </p>
              )}
            </div>

            {primeiroAcesso && (
              <div className="flex flex-col gap-1.5 rounded-xl border border-primary/20 bg-primary/5 p-3.5" role="group" aria-label="Confirmação da senha">
                <p id="setup-password-hint" className="m-0 mb-1.5 text-sm font-medium leading-snug text-foreground" role="status">
                  Este é o seu primeiro acesso. Crie sua senha e repita no campo abaixo. Se o e-mail estiver errado,
                  corrija-o acima.
                </p>
                <Label htmlFor="setup-password-confirm">Repita a senha</Label>
                <PasswordInput
                  id="setup-password-confirm"
                  inputRef={confirmacaoRef}
                  autoComplete="new-password"
                  placeholder="Digite a mesma senha de novo"
                  value={confirmacao}
                  onChange={setConfirmacao}
                />
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={submitting} className="h-11 w-full text-base">
              {submitting ? "Entrando…" : primeiroAcesso ? "Criar senha e entrar" : "Entrar"}
            </Button>

            {/* Sem recuperação automática por e-mail: quem esqueceu a senha pede o reset à TI
                (tela Usuários do painel), então o caminho precisa estar à vista. */}
            <p className="m-0 text-center text-sm text-muted-foreground">
              Esqueceu a senha?{" "}
              <a href={linkEsqueci} target="_blank" rel="noreferrer" className="font-semibold text-primary underline underline-offset-2">
                Peça à TI pelo WhatsApp
              </a>
            </p>
          </form>

          <div className="mt-8 border-t border-border pt-5">
            <p className="mb-2 text-sm text-muted-foreground">Visitante, parceiro ou fornecedor?</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setModoExterno(true)}
              className="h-auto w-full whitespace-normal bg-white py-2.5 text-center leading-snug"
            >
              Não tenho e-mail institucional (visitante, parceiro ou fornecedor)
            </Button>
          </div>
        </>
      )}
    </LoginShell>
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Cadastro de visitante</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cadastro pra quem não tem e-mail institucional — a TI vai ver seu nome, e-mail e
          telefone junto de cada chamado que você abrir.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-ext-name">Nome completo</Label>
        <Input
          id="setup-ext-name"
          autoComplete="name"
          placeholder="Seu nome e sobrenome"
          className="h-11"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-ext-email">Seu e-mail</Label>
        <Input
          id="setup-ext-email"
          type="email"
          autoComplete="username"
          placeholder="voce@email.com"
          className="h-11"
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
          className="h-11"
          value={telefone}
          onChange={(e) => setTelefone(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="setup-ext-password">Senha</Label>
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

      <Button type="submit" disabled={submitting} className="h-11 w-full text-base">
        {submitting ? "Cadastrando…" : "Cadastrar e entrar"}
      </Button>

      <Button type="button" variant="outline" onClick={onVoltar} className="h-auto w-full whitespace-normal bg-white py-2.5 text-center leading-snug">
        Tenho e-mail institucional — voltar pra entrada normal
      </Button>
    </form>
  )
}
