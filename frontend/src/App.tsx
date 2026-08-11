import { useEffect, useState } from "react"
import { AdminApp } from "@/AdminApp"
import { SolicitanteApp } from "@/SolicitanteApp"

type AppAlvo = "admin" | "solicitante"

// Switcher só de conveniência pra testar os dois apps lado a lado em dev, ANTES da
// F5 (corte de produção) decidir de verdade como cada um é publicado — hoje
// index.html/admin.html são páginas separadas de verdade; em produção real cada
// build React também vai virar sua própria página/entrada, não este hash.
// Escolha lida/gravada em `#admin`/`#solicitante` na URL, com fallback em localStorage
// pra lembrar a última escolha entre reloads.
function alvoFromHash(): AppAlvo | null {
  const h = window.location.hash.replace("#", "")
  return h === "admin" || h === "solicitante" ? h : null
}

function App() {
  const [alvo, setAlvo] = useState<AppAlvo>(
    () => alvoFromHash() ?? (localStorage.getItem("dev_app_alvo") as AppAlvo | null) ?? "admin",
  )

  useEffect(() => {
    const onHash = () => {
      const h = alvoFromHash()
      if (h) setAlvo(h)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  useEffect(() => {
    localStorage.setItem("dev_app_alvo", alvo)
    if (window.location.hash.replace("#", "") !== alvo) window.location.hash = alvo
  }, [alvo])

  return (
    <>
      {import.meta.env.DEV && (
        <div className="fixed bottom-2 right-2 z-[999] flex gap-1 rounded-md border border-border bg-background p-1 text-xs shadow-md">
          <button
            className={`rounded px-2 py-1 ${alvo === "admin" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => setAlvo("admin")}
          >
            Admin
          </button>
          <button
            className={`rounded px-2 py-1 ${alvo === "solicitante" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            onClick={() => setAlvo("solicitante")}
          >
            Solicitante
          </button>
        </div>
      )}
      {alvo === "admin" ? <AdminApp /> : <SolicitanteApp />}
    </>
  )
}

export default App
