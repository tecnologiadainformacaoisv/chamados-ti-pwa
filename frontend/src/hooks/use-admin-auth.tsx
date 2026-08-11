import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { validateSecret } from "@/lib/api"

const STORAGE_KEY = "admin_secret"

type AuthState = "checking" | "gate" | "authed"

type AdminAuthContextValue = {
  state: AuthState
  secret: string
  error: string | null
  login: (secret: string) => Promise<void>
  logout: () => void
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null)

// Porta boot()/checkStoredSecret()/showGate() de admin.js — mesmo cuidado: só trata
// como "segredo inválido de verdade" um 403 explícito. Qualquer outra falha (rede,
// deploy em andamento) é transitória e NÃO limpa o segredo salvo nem força re-digitar
// (bug real corrigido em 2026-08-10 na versão vanilla — ver CLAUDE.md).
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("checking")
  const [secret, setSecret] = useState("")
  const [error, setError] = useState<string | null>(null)
  const checkedOnce = useRef(false)

  const checkStored = useCallback(async (value: string, isRetry = false): Promise<void> => {
    try {
      await validateSecret(value)
      setSecret(value)
      setState("authed")
    } catch (err) {
      const status = (err as { status?: number })?.status
      if (status === 403) {
        localStorage.removeItem(STORAGE_KEY)
        setError("Segredo de admin inválido ou expirado. Entre de novo.")
        setState("gate")
        return
      }
      if (!isRetry) {
        await new Promise((r) => setTimeout(r, 1500))
        return checkStored(value, true)
      }
      setError(
        "Não foi possível confirmar sua sessão agora (falha de rede ou o servidor está temporariamente indisponível). Seu segredo salvo continua válido — recarregue a página pra tentar de novo, ou entre normalmente abaixo."
      )
      setState("gate")
    }
  }, [])

  useEffect(() => {
    if (checkedOnce.current) return
    checkedOnce.current = true
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      setState("gate")
      return
    }
    checkStored(stored)
  }, [checkStored])

  const login = useCallback(async (value: string) => {
    setError(null)
    await validateSecret(value) // deixa o erro propagar pro form tratar
    localStorage.setItem(STORAGE_KEY, value)
    setSecret(value)
    setState("authed")
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY)
    setSecret("")
    setState("gate")
  }, [])

  return (
    <AdminAuthContext.Provider value={{ state, secret, error, login, logout }}>
      {children}
    </AdminAuthContext.Provider>
  )
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext)
  if (!ctx) throw new Error("useAdminAuth precisa estar dentro de <AdminAuthProvider>")
  return ctx
}
