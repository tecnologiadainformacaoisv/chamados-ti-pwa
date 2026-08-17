import { Search, X } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TIPOS, SETORES, OPERADORES, STATUS_MAP, STATUS_ORDER } from "@/lib/constants"
import type { Filtros } from "@/lib/api"

const TODOS = "__todos__"

// Redesign (Fase A do roadmap pós-MVP-visual, 2026-08-14) — mais compacto/denso, com
// badge "N filtros" contando quantos dos 5 estão ativos, no espírito do mockup
// aprovado (ver Artifact publicado na sessão). Mesma lógica de sempre por baixo —
// set()/limpar() intocados, só o layout mudou.
export function FiltersBar({
  filtros,
  onChange,
  solicitantes,
  busca,
  onBuscaChange,
  mostrarStatus,
}: {
  filtros: Filtros
  onChange: (f: Filtros) => void
  solicitantes: string[]
  busca: string
  onBuscaChange: (v: string) => void
  mostrarStatus: boolean
}) {
  function set(field: keyof Filtros, value: string) {
    onChange({ ...filtros, [field]: value === TODOS ? undefined : value })
  }

  function limpar() {
    onChange({})
    onBuscaChange("")
  }

  const filtrosAtivos = Object.values(filtros).filter(Boolean).length

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2.5 shadow-sm">
      {mostrarStatus && (
        <CompactSelect value={filtros.status ?? TODOS} onChange={(v) => set("status", v)} placeholder="Status: Todos">
          {STATUS_ORDER.map((s) => (
            <SelectItem key={s} value={s}>{STATUS_MAP[s].label}</SelectItem>
          ))}
        </CompactSelect>
      )}

      <CompactSelect value={filtros.setor ?? TODOS} onChange={(v) => set("setor", v)} placeholder="Setor: Todos">
        {SETORES.map((s) => (
          <SelectItem key={s.orderindex} value={String(s.orderindex)}>{s.name}</SelectItem>
        ))}
      </CompactSelect>

      <CompactSelect value={filtros.tipo ?? TODOS} onChange={(v) => set("tipo", v)} placeholder="Tipo: Todos">
        {TIPOS.map((t) => (
          <SelectItem key={t.orderindex} value={String(t.orderindex)}>{t.name}</SelectItem>
        ))}
      </CompactSelect>

      <CompactSelect value={filtros.operador ?? TODOS} onChange={(v) => set("operador", v)} placeholder="Operador: Todos">
        {Object.entries(OPERADORES).map(([id, nome]) => (
          <SelectItem key={id} value={id}>{nome}</SelectItem>
        ))}
      </CompactSelect>

      <CompactSelect value={filtros.solicitante ?? TODOS} onChange={(v) => set("solicitante", v)} placeholder="Solicitante: Todos">
        {solicitantes.map((nome) => (
          <SelectItem key={nome} value={nome}>{nome}</SelectItem>
        ))}
      </CompactSelect>

      {filtrosAtivos > 0 && (
        <Badge variant="secondary" className="font-semibold">
          {filtrosAtivos} {filtrosAtivos === 1 ? "filtro" : "filtros"}
        </Badge>
      )}

      <div className="flex min-w-48 flex-1 items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="Buscar por título..."
          value={busca}
          onChange={(e) => onBuscaChange(e.target.value)}
        />
      </div>

      {(filtrosAtivos > 0 || busca) && (
        <Button variant="ghost" size="sm" onClick={limpar} className="gap-1 text-muted-foreground">
          <X className="h-3.5 w-3.5" /> Limpar
        </Button>
      )}
    </div>
  )
}

function CompactSelect({
  value,
  onChange,
  placeholder,
  children,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  children: React.ReactNode
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      {/* max-w-48 — achado do revisor (2026-08-17): SelectTrigger é w-fit por padrão;
          nome de solicitante (cadastro livre em usuarios-view.tsx, sem limite) podia
          alargar o chip indefinidamente na barra de filtros. line-clamp-1 já herdado
          do SelectTrigger cuida da reticência dentro dessa largura. */}
      <SelectTrigger size="sm" className="h-8 max-w-48 bg-transparent text-xs font-medium">
        <SelectValue placeholder={placeholder}>{value === TODOS ? placeholder : undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TODOS}>Todos</SelectItem>
        {children}
      </SelectContent>
    </Select>
  )
}
