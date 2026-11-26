import { createContext, useCallback, useContext, useState, type ReactNode } from "react"
import { loginOrRegister, logoutFromServer, registerExterno } from "@/lib/app-api"

const TOKEN_KEY = "session_token"
const NAME_KEY = "user_name"

type BootState = "setup" | "app"

type SessionAuthValue = {
  state: BootState
  sessionToken: string
  userName: string
  login: (email: string, password: string, confirmacao?: string, nome?: string) => Promise<void>
  // Autocadastro externo (2026-09-17) — quem não está na lista pré-aprovada pela TI
  // digita o próprio nome/e-mail em vez de escolher/entrar com um já cadastrado.
  loginExterno: (name: string, email: string, password: string, telefone?: string) => Promise<void>
  logout: () => void
  // Chamado quando qualquer requisição à API devolve 401 — mesmo efeito do
  // location.reload() da versão vanilla (limpa a sessão morta, volta pro login).
  handleSessionExpired: () => void
}

const SessionAuthContext = createContext<SessionAuthValue | null>(null)

// Porta boot()/onSetupSubmit() de app.js. Com sessão salva o app abre direto: não há consulta no
// boot. Quem foi desativado, renomeado ou excluído tem a sessão revogada no servidor, e a primeira
// chamada real de API devolve 401 (handleSessionExpired).
export function SessionAuthProvider({ children }: { children: ReactNode }) {
  const [salva] = useState(() => {
    const token = localStorage.getItem(TOKEN_KEY)
    const name = localStorage.getItem(NAME_KEY)
    return token && name ? { token, name } : null
  })
  const [state, setState] = useState<BootState>(salva ? "app" : "setup")
  const [sessionToken, setSessionToken] = useState(salva?.token ?? "")
  const [userName, setUserName] = useState(salva?.name ?? "")

  const login = useCallback(async (email: string, password: string, confirmacao?: string, nome?: string) => {
    const result = await loginOrRegister(email, password, confirmacao, nome)
    localStorage.setItem(TOKEN_KEY, result.token)
    localStorage.setItem(NAME_KEY, result.name)
    setSessionToken(result.token)
    setUserName(result.name)
    setState("app")
  }, [])

  const loginExterno = useCallback(async (name: string, email: string, password: string, telefone?: string) => {
    const result = await registerExterno(name, email, password, telefone)
    localStorage.setItem(TOKEN_KEY, result.token)
    localStorage.setItem(NAME_KEY, result.name)
    setSessionToken(result.token)
    setUserName(result.name)
    setState("app")
  }, [])

  const logout = useCallback(() => {
    logoutFromServer(sessionToken)
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(NAME_KEY)
    setSessionToken("")
    setUserName("")
    setState("setup")
  }, [sessionToken])

  return (
    <SessionAuthContext.Provider
      value={{ state, sessionToken, userName, login, loginExterno, logout, handleSessionExpired: logout }}
    >
      {children}
    </SessionAuthContext.Provider>
  )
}

export function useSessionAuth() {
  const ctx = useContext(SessionAuthContext)
  if (!ctx) throw new Error("useSessionAuth precisa estar dentro de <SessionAuthProvider>")
  return ctx
}
