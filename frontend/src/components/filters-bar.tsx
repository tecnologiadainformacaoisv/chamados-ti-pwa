import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { TIPOS, SETORES, OPERADORES, STATUS_MAP, STATUS_ORDER } from "@/lib/constants"
import type { Filtros } from "@/lib/api"

const TODOS = "__todos__"

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

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4 shadow-sm">
      {mostrarStatus && (
        <Field label="Status">
          <Select value={filtros.status ?? TODOS} onValueChange={(v) => set("status", v)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS}>Todos</SelectItem>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s}>{STATUS_MAP[s].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Setor">
        <Select value={filtros.setor ?? TODOS} onValueChange={(v) => set("setor", v)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={TODOS}>Todos</SelectItem>
            {SETORES.map((s) => (
              <SelectItem key={s.orderindex} value={String(s.orderindex)}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Tipo">
        <Select value={filtros.tipo ?? TODOS} onValueChange={(v) => set("tipo", v)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={TODOS}>Todos</SelectItem>
            {TIPOS.map((t) => (
              <SelectItem key={t.orderindex} value={String(t.orderindex)}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Operador">
        <Select value={filtros.operador ?? TODOS} onValueChange={(v) => set("operador", v)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={TODOS}>Todos</SelectItem>
            {Object.entries(OPERADORES).map(([id, nome]) => (
              <SelectItem key={id} value={id}>{nome}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Solicitante">
        <Select value={filtros.solicitante ?? TODOS} onValueChange={(v) => set("solicitante", v)}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={TODOS}>Todos</SelectItem>
            {solicitantes.map((nome) => (
              <SelectItem key={nome} value={nome}>{nome}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Buscar por título" className="min-w-48 flex-1">
        <Input placeholder="Ex.: notebook, impressora…" value={busca} onChange={(e) => onBuscaChange(e.target.value)} />
      </Field>

      <Button variant="outline" onClick={limpar}>Limpar filtros</Button>
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
