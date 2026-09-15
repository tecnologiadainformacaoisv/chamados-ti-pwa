import { useCallback, useState } from "react"

// Controle de sidebar estilo Supabase (2026-09-15, pedido do usuário) — 3 modos
// persistidos, em vez do simples aberto/fechado que já existia (defaultOpen={false}
// em AdminApp.tsx, decisão de 2026-08-13):
//   - "expanded": sempre aberta.
//   - "collapsed": sempre fechada (modo ícone) — comportamento padrão de hoje, mantido
//     como default pra não mudar a experiência de quem já usa o painel sem aviso.
//   - "hover": fica fechada, mas abre temporariamente ao passar o mouse por cima (ver
//     onMouseEnter/onMouseLeave em AdminApp.tsx) — sem ocupar espaço permanente, mas
//     sem precisar clicar toda vez só pra ler o rótulo de um item.
export type SidebarMode = "expanded" | "collapsed" | "hover"

const STORAGE_KEY = "admin_sidebar_mode"

function isValidMode(v: unknown): v is SidebarMode {
  return v === "expanded" || v === "collapsed" || v === "hover"
}

function loadMode(): SidebarMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isValidMode(stored) ? stored : "collapsed"
  } catch {
    return "collapsed"
  }
}

export function useSidebarMode() {
  const [mode, setModeState] = useState<SidebarMode>(loadMode)

  const setMode = useCallback((next: SidebarMode) => {
    setModeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // localStorage indisponível (modo privado, quota) — o modo só não persiste
      // entre sessões, não é um erro que precise aparecer pro usuário.
    }
  }, [])

  return [mode, setMode] as const
}
