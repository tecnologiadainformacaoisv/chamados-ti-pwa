import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { fetchSolicitanteNomes, loginOrRegister, logoutFromServer } from "@/lib/app-api"

const TOKEN_KEY = "session_token"
const NAME_KEY = "user_name"

type BootState = "loading" | "boot-error" | "setup" | "app"

type SessionAuthValue = {
  state: BootState
  sessionToken: string
  userName: string
  nomes: string[]
  bootError: string | null
  retryBoot: () => void
  login: (name: string, password: string) => Promise<void>
  logout: () => void
  // Chamado quando qualquer requisição à API devolve 401 — mesmo efeito do
  // location.reload() da versão vanilla (limpa a sessão morta, volta pro login).
  handleSessionExpired: () => void
}

const SessionAuthContext = createContext<SessionAuthValue | null>(null)

// Porta boot()/onSetupSubmit() de app.js. Diferença deliberada de use-admin-auth.tsx: aqui
// NÃO existe ping de validação no boot — a versão vanilla também não faz isso, confia na
// sessão salva até a primeira chamada real de API (que aí sim trata 401).
export function SessionAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootState>("loading")
  const [sessionToken, setSessionToken] = useState("")
  const [userName, setUserName] = useState("")
  const [nomes, setNomes] = useState<string[]>([])
  const [bootError, setBootError] = useState<string | null>(null)
  const bootedOnce = useRef(false)

  const boot = useCallback(async () => {
    setState("loading")
    setBootError(null)
    try {
      const lista = await fetchSolicitanteNomes()
      setNomes(lista)
      const storedToken = localStorage.getItem(TOKEN_KEY)
      const storedName = localStorage.getItem(NAME_KEY)
      if (storedToken && storedName && lista.includes(storedName)) {
        setSessionToken(storedToken)
        setUserName(storedName)
        setState("app")
      } else {
        setState("setup")
      }
    } catch (err) {
      setBootError(err instanceof Error ? err.message : "Não foi possível carregar a lista de solicitantes.")
      setState("boot-error")
    }
  }, [])

  useEffect(() => {
    if (bootedOnce.current) return
    bootedOnce.current = true
    boot()
  }, [boot])

  const login = useCallback(async (name: string, password: string) => {
    const result = await loginOrRegister(name, password)
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
      value={{ state, sessionToken, userName, nomes, bootError, retryBoot: boot, login, logout, handleSessionExpired: logout }}
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
