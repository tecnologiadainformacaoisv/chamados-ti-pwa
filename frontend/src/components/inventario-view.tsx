// Inventário de equipamentos (estudo do OS800, 2026-11-17).
//
// Do OS800: cards com tombamento, status, tipo, marca/modelo, local, origem
// (patrimônio/locado), nº de série; filtros por tipo/status/origem; paginação.
// Melhorias nossas: contagem de chamados por equipamento (abertos/total), busca que
// ignora acento, filtro "só com chamado aberto", e lista vazia que diz o que fazer.
// Sem foto por enquanto (exigiria upload em R2 por equipamento; dá para somar depois).

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Monitor, Printer, Laptop, Network, Package, Search, Wrench } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { EquipamentoForm } from "@/components/equipamento-form"
import { SETORES, optionName } from "@/lib/constants"
import {
  fetchEquipamentos,
  EQUIP_STATUS_LABEL,
  EQUIP_TIPO_LABEL,
  type EquipStatus,
  type EquipTipo,
  type Equipamento,
} from "@/lib/equipamentos-api"
import { cn } from "@/lib/utils"

const POR_PAGINA = 24
const TODOS = "todos"

const ICONE: Record<EquipTipo, typeof Printer> = {
  impressora: Printer,
  computador: Monitor,
  monitor: Monitor,
  notebook: Laptop,
  rede: Network,
  outro: Package,
}

const STATUS_COR: Record<EquipStatus, string> = {
  ativo: "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900",
  manutencao: "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900",
  reserva: "bg-sky-50 text-sky-900 border-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:border-sky-900",
  baixado: "bg-muted text-muted-foreground border-border",
}

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

export function InventarioView() {
  const { secret } = useAdminAuth()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["equipamentos"],
    queryFn: () => fetchEquipamentos(secret),
  })

  const [busca, setBusca] = useState("")
  const [tipo, setTipo] = useState<string>(TODOS)
  const [status, setStatus] = useState<string>(TODOS)
  const [origem, setOrigem] = useState<string>(TODOS)
  const [soComChamado, setSoComChamado] = useState(false)
  const [pagina, setPagina] = useState(1)
  // null = fechado; "novo" = cadastro; objeto = edição
  const [editando, setEditando] = useState<Equipamento | "novo" | null>(null)
  const onNovo = () => setEditando("novo")
  const onAbrir = (e: Equipamento) => setEditando(e)

  const filtrados = useMemo(() => {
    const q = semAcento(busca.trim())
    return (data?.equipamentos ?? []).filter((e) => {
      if (tipo !== TODOS && e.tipo !== tipo) return false
      if (status !== TODOS && e.status !== status) return false
      if (origem !== TODOS && e.origem !== origem) return false
      if (soComChamado && !e.chamadosAbertos) return false
      if (!q) return true
      const alvo = [e.tombamento, e.marca, e.modelo, e.numero_serie, e.local, e.setor != null ? optionName(SETORES, e.setor) : ""]
        .filter(Boolean)
        .join(" ")
      return semAcento(alvo).includes(q)
    })
  }, [data, busca, tipo, status, origem, soComChamado])

  const paginas = Math.max(1, Math.ceil(filtrados.length / POR_PAGINA))
  const paginaAtual = Math.min(pagina, paginas)
  const visiveis = filtrados.slice((paginaAtual - 1) * POR_PAGINA, paginaAtual * POR_PAGINA)
  const mudaFiltro = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v)
    setPagina(1)
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Inventário</h1>
          <p className="text-sm text-muted-foreground">Equipamentos da TI e onde cada um está</p>
        </div>
        <Button onClick={onNovo}>Novo equipamento</Button>
      </header>

      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
        <label className="relative">
          <span className="sr-only">Buscar equipamento</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={busca}
            onChange={(e) => mudaFiltro(setBusca)(e.target.value)}
            placeholder="Buscar por tombamento, marca, modelo, série ou local…"
            className="pl-9"
          />
        </label>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Filtro valor={tipo} onChange={mudaFiltro(setTipo)} rotulo="Tipo" opcoes={EQUIP_TIPO_LABEL} />
          <Filtro valor={status} onChange={mudaFiltro(setStatus)} rotulo="Situação" opcoes={EQUIP_STATUS_LABEL} />
          <Filtro valor={origem} onChange={mudaFiltro(setOrigem)} rotulo="Origem" opcoes={{ patrimonio: "Patrimônio", locado: "Locado" }} />
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm">
            <input type="checkbox" checked={soComChamado} onChange={(e) => mudaFiltro(setSoComChamado)(e.target.checked)} />
            Só com chamado aberto
          </label>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            Não foi possível carregar o inventário.
            <Button size="sm" variant="outline" onClick={() => refetch()}>Tentar de novo</Button>
          </AlertDescription>
        </Alert>
      ) : isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
        </div>
      ) : !data?.equipamentos.length ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Nenhum equipamento cadastrado ainda. Comece pelas impressoras: são as que mais geram chamado. Clique em "Novo equipamento".
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {filtrados.length === data.equipamentos.length
              ? `${filtrados.length} equipamentos`
              : `${filtrados.length} de ${data.equipamentos.length} equipamentos`}
          </p>
          {filtrados.length === 0 ? (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nenhum equipamento com esses filtros.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visiveis.map((e) => (
                <li key={e.id}>
                  <CardEquipamento e={e} onAbrir={onAbrir} />
                </li>
              ))}
            </ul>
          )}
          {paginas > 1 && (
            <nav className="flex items-center justify-center gap-2" aria-label="Páginas">
              <Button size="sm" variant="outline" disabled={paginaAtual === 1} onClick={() => setPagina(paginaAtual - 1)}>Anterior</Button>
              <span className="text-sm text-muted-foreground">Página {paginaAtual} de {paginas}</span>
              <Button size="sm" variant="outline" disabled={paginaAtual === paginas} onClick={() => setPagina(paginaAtual + 1)}>Próxima</Button>
            </nav>
          )}
        </>
      )}
      {editando && <EquipamentoForm equipamento={editando === "novo" ? null : editando} onClose={() => setEditando(null)} />}
    </div>
  )
}

function Filtro({
  valor,
  onChange,
  rotulo,
  opcoes,
}: {
  valor: string
  onChange: (v: string) => void
  rotulo: string
  opcoes: Record<string, string>
}) {
  return (
    <Select value={valor} onValueChange={onChange}>
      <SelectTrigger className="w-full min-w-0" aria-label={rotulo}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TODOS}>{rotulo}: todos</SelectItem>
        {Object.entries(opcoes).map(([v, l]) => (
          <SelectItem key={v} value={v}>{l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function CardEquipamento({ e, onAbrir }: { e: Equipamento; onAbrir?: (e: Equipamento) => void }) {
  const Icone = ICONE[e.tipo] ?? Package
  const conteudo = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{e.tombamento ?? "sem etiqueta"}</span>
        <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_COR[e.status])}>
          {EQUIP_STATUS_LABEL[e.status]}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Icone className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">{EQUIP_TIPO_LABEL[e.tipo]}</p>
          <p className="truncate text-sm text-primary">{[e.marca, e.modelo].filter(Boolean).join(" · ") || "Modelo não informado"}</p>
        </div>
      </div>
      <p className="min-w-0 truncate text-sm text-muted-foreground">
        {[e.setor != null ? optionName(SETORES, e.setor) : null, e.local].filter(Boolean).join(" · ") || "Local não informado"}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full border px-2 py-0.5">{e.origem === "locado" ? `Locado${e.fornecedor ? ` · ${e.fornecedor}` : ""}` : "Patrimônio"}</span>
        {e.numero_serie && <span className="truncate text-muted-foreground">Série {e.numero_serie}</span>}
        {e.ip && <span className="font-mono text-muted-foreground">{e.ip}</span>}
      </div>
      <p className={cn("flex items-center gap-1 text-xs", e.chamadosAbertos ? "font-medium text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>
        <Wrench className="size-3.5" aria-hidden />
        {e.chamadosAbertos
          ? `${e.chamadosAbertos} chamado${e.chamadosAbertos > 1 ? "s" : ""} aberto${e.chamadosAbertos > 1 ? "s" : ""} · ${e.chamadosTotal} no total`
          : e.chamadosTotal
            ? `${e.chamadosTotal} chamado${e.chamadosTotal > 1 ? "s" : ""} no histórico`
            : "Nenhum chamado ainda"}
      </p>
    </>
  )
  const classe = "flex h-full w-full min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 text-left"
  return onAbrir ? (
    <button type="button" onClick={() => onAbrir(e)} className={cn(classe, "cursor-pointer transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}>
      {conteudo}
    </button>
  ) : (
    <div className={classe}>{conteudo}</div>
  )
}
