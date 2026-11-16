import { useCallback, useEffect, useState } from "react"

// Tema do PAINEL DE ADMIN (2026-11-16, pedido do usuário: "seletor de tema no painel adm").
// Três escolhas: claro, escuro e "sistema" (segue o computador). A preferência fica no
// localStorage (por navegador); o app do solicitante não usa isso e continua sempre claro.
// O script inline de admin.html aplica a classe `dark` antes do React montar, pra não piscar.
export type Tema = "claro" | "escuro" | "sistema"
const CHAVE = "admin_tema"

function lerTema(): Tema {
  try {
    const v = localStorage.getItem(CHAVE)
    if (v === "claro" || v === "escuro" || v === "sistema") return v
  } catch {
    /* localStorage bloqueado: segue o padrão */
  }
  return "claro"
}

function aplicar(tema: Tema) {
  const escuro = tema === "escuro" || (tema === "sistema" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.toggle("dark", escuro)
  document.documentElement.style.colorScheme = escuro ? "dark" : "light"
}

export function useTema() {
  const [tema, setTemaState] = useState<Tema>(lerTema)

  useEffect(() => {
    aplicar(tema)
    if (tema !== "sistema") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => aplicar("sistema")
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [tema])

  const setTema = useCallback((novo: Tema) => {
    try {
      localStorage.setItem(CHAVE, novo)
    } catch {
      /* sem persistência, só vale nesta sessão */
    }
    setTemaState(novo)
  }, [])

  return { tema, setTema }
}
