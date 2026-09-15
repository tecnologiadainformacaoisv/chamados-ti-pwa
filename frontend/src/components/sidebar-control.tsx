import { useState } from "react"
import { Check, PanelLeft } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { SidebarMode } from "@/hooks/use-sidebar-mode"

// Controle de sidebar estilo Supabase (2026-09-15, pedido do usuário — print de
// referência do próprio Supabase, mesma mecânica: um botão de ícone abre um popover
// com 3 opções de comportamento). Cores/tokens são os nossos (navy/sidebar), não uma
// cópia literal do visual escuro do Supabase — a MECÂNICA é o que foi pedido.
const OPCOES: { value: SidebarMode; label: string }[] = [
  { value: "expanded", label: "Expandida" },
  { value: "collapsed", label: "Colapsada" },
  { value: "hover", label: "Expandir ao passar o mouse" },
]

export function SidebarControl({ mode, onChange }: { mode: SidebarMode; onChange: (m: SidebarMode) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          title="Controle da sidebar"
          aria-label="Controle da sidebar"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-64 p-2">
        <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">Controle da sidebar</p>
        <div className="flex flex-col gap-0.5">
          {OPCOES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value)
                setOpen(false)
              }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {mode === opt.value && <Check className="h-3.5 w-3.5 text-primary" />}
              </span>
              {opt.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
