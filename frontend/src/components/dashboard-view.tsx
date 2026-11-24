import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { fetchMetrics, fetchSolicitanteNomes, fmtMs, isSessionError, type FiltrosMetricas, type OperadorTempo } from "@/lib/api"
import { LISTA_POLL_MS, OPERADORES, PRIORITY_MAP, SETORES, STATUS_MAP, STATUS_ORDER, TIPOS, type Opcao } from "@/lib/constants"

// Prioridade como lista de opções (chaves 1/2/3 do servidor) e operadores como lista, para reaproveitar BarList.
const PRIORIDADES: Opcao[] = [
  { orderindex: 1, name: "Urgente", color: PRIORITY_MAP.urgent.color },
  { orderindex: 2, name: "Alta", color: PRIORITY_MAP.high.color },
  { orderindex: 3, name: "Normal", color: PRIORITY_MAP.normal.color },
]
const CORES_OPERADOR = ["#3e63dd", "#30a46c", "#ab4aba", "#f76808", "#0091ff"]
// Operadores conhecidos + qualquer atendente que apareça nas métricas (ex.: o id antigo da ClickUp em
// chamados importados), senão a barra dele sumia e a soma não fechava com o total.
function listaOperadores(porOperador?: Record<string, number>): Opcao[] {
  const ids = new Set<number>(Object.keys(OPERADORES).map(Number))
  for (const k of Object.keys(porOperador ?? {})) ids.add(Number(k))
  return [...ids].map((id, i) => ({ orderindex: id, name: OPERADORES[String(id)] ?? `Operador #${id}`, color: CORES_OPERADOR[i % CORES_OPERADOR.length] }))
}
const TODOS = "todos"

// yyyy-mm-dd (formato nativo de <input type="date">) -> epoch ms no início/fim do dia,
// no fuso local de quem está usando o painel (não UTC) — é o que a pessoa espera ao
// digitar uma data. Fase A do roadmap pós-MVP-visual (2026-08-14).
function inicioDoDia(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}
function fimDoDia(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}
// Data em que o sistema passou a ser usado de verdade (atalho "Só a operação").
const INICIO_OPERACAO_ISO = "2026-10-16"

// yyyy-mm-dd no fuso LOCAL (toISOString usa UTC: depois das 21h em Fortaleza devolvia o dia seguinte).
function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function isoHoje(offsetDias = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - offsetDias)
  return isoLocal(d)
}

// Porta loadMetrics()/renderMetrics()/renderBarList()/renderSlaChart()/renderOperadores()
// de admin.js — mesmos cards, mesmo donut de SLA em SVG puro (sem lib de gráfico, mesma
// filosofia zero-dependência), mesmos dados de GET /admin/metrics.
export function DashboardView() {
  const { secret, logout } = useAdminAuth()

  // Filtro de período (de/até, livre) + atalhos — reflete direto em `desde`/`ate` do
  // GET /admin/metrics (`d1GetMetrics` já suporta, ver push-worker.js). Vazio = sem
  // filtro (agregado geral, comportamento de sempre).
  const [de, setDe] = useState("")
  const [ate, setAte] = useState("")
  const desdeMs = de ? inicioDoDia(de) : undefined
  const ateMs = ate ? fimDoDia(ate) : undefined
  // Filtros por operador, setor, tipo, prioridade, situação e solicitante (2026-11-24).
  const [filtros, setFiltros] = useState<FiltrosMetricas>({})
  const filtrosAtivos = Object.keys(filtros).length > 0

  const metricsQuery = useQuery({
    queryKey: ["admin-metrics", desdeMs, ateMs, filtros],
    queryFn: () => fetchMetrics(secret, { desde: desdeMs, ate: ateMs, ...filtros }),
    refetchInterval: LISTA_POLL_MS,
    // enquanto um filtro novo carrega, continua mostrando os números anteriores (sem piscar o painel)
    placeholderData: (anterior) => anterior,
  })
  const solicitantesQuery = useQuery({ queryKey: ["solicitantes"], queryFn: fetchSolicitanteNomes, staleTime: 5 * 60_000 })
  const alternar = <K extends keyof FiltrosMetricas>(chave: K, valor: FiltrosMetricas[K]) =>
    setFiltros((f) => {
      const novo = { ...f }
      if (novo[chave] === valor) delete novo[chave]
      else novo[chave] = valor
      return novo
    })

  useEffect(() => {
    if (isSessionError(metricsQuery.error)) logout()
  }, [metricsQuery.error, logout])

  const periodoBar = (
    <div className="flex flex-col gap-3">
      <PeriodoFilterBar de={de} ate={ate} onDe={setDe} onAte={setAte} />
      <FiltrosDash filtros={filtros} onChange={setFiltros} solicitantes={solicitantesQuery.data ?? []} operadores={listaOperadores(metricsQuery.data?.porOperador)} />
    </div>
  )

  if (metricsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        {periodoBar}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-3 w-20" /></CardHeader>
              <CardContent><Skeleton className="h-7 w-14" /></CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (metricsQuery.isError && !isSessionError(metricsQuery.error)) {
    return (
      <div className="flex flex-col gap-6">
        {periodoBar}
        <Alert variant="destructive">
          <AlertDescription>
            {metricsQuery.error instanceof Error ? metricsQuery.error.message : "Não foi possível carregar as métricas."}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const data = metricsQuery.data
  if (!data) return null
  // Enquanto um filtro novo carrega, os números anteriores continuam na tela: avisa que estão sendo trocados.
  const atualizando = metricsQuery.isPlaceholderData

  // Sem nenhum chamado no período (caso real nos primeiros dias, já que as métricas só contam
  // desde o início da operação): em vez de 8 cartões "0" e 4 blocos "nenhum chamado", uma
  // mensagem só, que explica (achado de UX 2026-10-16).
  if (data.total === 0) {
    return (
      <div className="flex flex-col gap-6">
        {periodoBar}
        <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
          {filtrosAtivos ? (
            <>
              <p className="font-medium text-foreground">Nenhum chamado com esses filtros.</p>
              <p className="mt-1 text-sm text-muted-foreground">Tente tirar algum filtro ou ampliar o período.</p>
              <Button className="mt-4" variant="outline" onClick={() => setFiltros({})}>Limpar filtros</Button>
            </>
          ) : (
            <>
              <p className="font-medium text-foreground">Ainda sem chamados neste período.</p>
              <p className="mt-1 text-sm text-muted-foreground">Os números aparecem conforme os chamados forem abertos e encerrados.</p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col gap-6 transition-opacity ${atualizando ? "opacity-60" : ""}`} aria-busy={atualizando}>
      {periodoBar}
      <p className="-mt-3 text-xs text-muted-foreground" aria-live="polite">
        {!de && !ate && !filtrosAtivos
          ? `Contando todos os ${data.total} chamados desde o início. Use as datas, os atalhos ou os filtros para recortar.`
          : `Mostrando ${data.total} chamado${data.total === 1 ? "" : "s"} com o recorte aplicado.`}
      </p>
      {data.truncated && (
        <Alert>
          <AlertDescription>
            Há mais chamados do que a tela consegue mostrar, então estes números podem estar incompletos.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricCard value={data.total} label="Total de chamados" />
        {STATUS_ORDER.map((s) => (
          <MetricCard key={s} value={data.porStatus[s] ?? 0} label={STATUS_MAP[s].label} />
        ))}
        <MetricCard value={fmtPercent(data.sla.dentroDoSlaPercent)} label="Dentro do SLA" tone="success" />
        <MetricCard value={fmtPercent(data.sla.atrasadoPercent)} label="Atrasado" tone="danger" />
        <MetricCard
          value={data.satisfacao.mediaNota != null ? `${data.satisfacao.mediaNota.toFixed(1)} ★` : "—"}
          label={`Satisfação média (${data.satisfacao.totalAvaliacoes} avaliaç${data.satisfacao.totalAvaliacoes === 1 ? "ão" : "ões"})`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">SLA</CardTitle></CardHeader>
          <CardContent>
            <SlaDonut dentroPercent={data.sla.dentroDoSlaPercent} atrasadoPercent={data.sla.atrasadoPercent} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Tempo médio de atendimento por operador</CardTitle></CardHeader>
          <CardContent>
            <OperadoresList tempoMedio={data.tempoMedioPorOperador} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Volume por tipo</CardTitle></CardHeader>
          <CardContent>
            <BarList counts={data.porTipo} list={TIPOS} selected={filtros.tipo} onPick={(v) => alternar("tipo", v)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Volume por setor</CardTitle></CardHeader>
          <CardContent>
            <BarList counts={data.porSetor} list={SETORES} selected={filtros.setor} onPick={(v) => alternar("setor", v)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Volume por prioridade</CardTitle></CardHeader>
          <CardContent>
            <BarList counts={data.porPrioridade} list={PRIORIDADES} selected={filtros.prioridade} onPick={(v) => alternar("prioridade", v)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Volume por atendente</CardTitle>
            <p className="text-xs text-muted-foreground">Chamado com dois atendentes conta para os dois.</p>
          </CardHeader>
          <CardContent>
            <BarList counts={data.porOperador} list={listaOperadores(data.porOperador)} selected={filtros.operador} onPick={(v) => alternar("operador", v)} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// Filtros do Dashboard (2026-11-24): operador, setor, tipo, prioridade, situação e solicitante. Combinam
// entre si e com o período; os ativos aparecem como etiquetas que se removem com um clique.
function FiltrosDash({
  filtros,
  onChange,
  solicitantes,
  operadores,
}: {
  filtros: FiltrosMetricas
  onChange: (f: FiltrosMetricas) => void
  solicitantes: string[]
  operadores: Opcao[]
}) {
  // A lista só traz solicitantes ativos; se o filtro vier de uma conta desativada, mantém o valor visível.
  const nomesSolicitantes = filtros.solicitante && !solicitantes.includes(filtros.solicitante) ? [filtros.solicitante, ...solicitantes] : solicitantes
  const nomeDe = (lista: Opcao[], v: number | undefined) => lista.find((o) => o.orderindex === v)?.name ?? String(v)
  const etiquetas: { chave: keyof FiltrosMetricas; texto: string }[] = []
  if (filtros.operador != null) etiquetas.push({ chave: "operador", texto: `Atendente: ${nomeDe(operadores, filtros.operador)}` })
  if (filtros.setor != null) etiquetas.push({ chave: "setor", texto: `Setor: ${nomeDe(SETORES, filtros.setor)}` })
  if (filtros.tipo != null) etiquetas.push({ chave: "tipo", texto: `Tipo: ${nomeDe(TIPOS, filtros.tipo)}` })
  if (filtros.prioridade != null) etiquetas.push({ chave: "prioridade", texto: `Prioridade: ${nomeDe(PRIORIDADES, filtros.prioridade)}` })
  if (filtros.status) etiquetas.push({ chave: "status", texto: `Situação: ${STATUS_MAP[filtros.status as keyof typeof STATUS_MAP]?.label ?? filtros.status}` })
  if (filtros.solicitante) etiquetas.push({ chave: "solicitante", texto: `Solicitante: ${filtros.solicitante}` })

  const mudar = (chave: keyof FiltrosMetricas, valor: string, numerico: boolean) => {
    const novo: Record<string, string | number> = { ...filtros }
    if (valor === TODOS) delete novo[chave]
    else novo[chave] = numerico ? Number(valor) : valor
    onChange(novo as FiltrosMetricas)
  }
  const opcoes = (lista: Opcao[]) => lista.map((o) => [String(o.orderindex), o.name] as const)

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Escolha rotulo="Atendente" valor={filtros.operador} opcoes={opcoes(operadores)} onChange={(v) => mudar("operador", v, true)} />
        <Escolha rotulo="Setor" valor={filtros.setor} opcoes={opcoes(SETORES)} onChange={(v) => mudar("setor", v, true)} />
        <Escolha rotulo="Tipo" valor={filtros.tipo} opcoes={opcoes(TIPOS)} onChange={(v) => mudar("tipo", v, true)} />
        <Escolha rotulo="Prioridade" valor={filtros.prioridade} opcoes={opcoes(PRIORIDADES)} onChange={(v) => mudar("prioridade", v, true)} />
        <Escolha
          rotulo="Situação"
          valor={filtros.status}
          opcoes={STATUS_ORDER.map((s) => [s, STATUS_MAP[s].label] as const)}
          onChange={(v) => mudar("status", v, false)}
        />
        <Escolha
          rotulo="Solicitante"
          valor={filtros.solicitante}
          opcoes={nomesSolicitantes.map((n) => [n, n] as const)}
          onChange={(v) => mudar("solicitante", v, false)}
        />
      </div>
      {etiquetas.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtros ativos">
          {etiquetas.map((e) => (
            <button
              key={e.chave}
              type="button"
              onClick={() => mudar(e.chave, TODOS, false)}
              aria-label={`Remover filtro ${e.texto}`}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {e.texto} <span aria-hidden>✕</span>
            </button>
          ))}
          <Button size="xs" variant="ghost" onClick={() => onChange({})}>Limpar filtros</Button>
        </div>
      )}
    </div>
  )
}

function Escolha({
  rotulo,
  valor,
  opcoes,
  onChange,
}: {
  rotulo: string
  valor: string | number | undefined
  opcoes: (readonly [string, string])[]
  onChange: (v: string) => void
}) {
  return (
    <Select value={valor == null ? TODOS : String(valor)} onValueChange={onChange}>
      <SelectTrigger className="w-full min-w-0" aria-label={rotulo}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TODOS}>{rotulo}: todos</SelectItem>
        {opcoes.map(([v, l]) => (
          <SelectItem key={v} value={v}>{l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Filtro de período — de/até livre (input de data nativo) + atalhos que só preenchem
// os campos (não é um mecanismo separado). Vazio nos dois = "Tudo" (agregado geral).
function PeriodoFilterBar({
  de,
  ate,
  onDe,
  onAte,
}: {
  de: string
  ate: string
  onDe: (v: string) => void
  onAte: (v: string) => void
}) {
  function aplicarAtalho(offsetDias: number | null) {
    if (offsetDias === null) {
      onDe("")
      onAte("")
      return
    }
    onDe(isoHoje(offsetDias))
    onAte(isoHoje(0))
  }

  const semFiltro = !de && !ate
  const soOperacao = de === INICIO_OPERACAO_ISO && !ate

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex flex-col gap-1">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">De</Label>
        <Input type="date" value={de} max={ate || undefined} onChange={(e) => onDe(e.target.value)} className="w-36" />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Até</Label>
        <Input type="date" value={ate} min={de || undefined} onChange={(e) => onAte(e.target.value)} className="w-36" />
      </div>
      <div className="flex flex-wrap items-center gap-1 pb-0.5">
        <Button size="sm" variant="ghost" onClick={() => aplicarAtalho(0)}>Hoje</Button>
        <Button size="sm" variant="ghost" onClick={() => aplicarAtalho(6)}>7 dias</Button>
        <Button size="sm" variant="ghost" onClick={() => aplicarAtalho(29)}>30 dias</Button>
        <Button size="sm" variant="ghost" onClick={() => { const h = new Date(); onDe(isoLocal(new Date(h.getFullYear(), h.getMonth(), 1))); onAte(isoLocal(h)) }}>Este mês</Button>
        <Button size="sm" variant="ghost" onClick={() => { const h = new Date(); onDe(isoLocal(new Date(h.getFullYear(), h.getMonth() - 1, 1))); onAte(isoLocal(new Date(h.getFullYear(), h.getMonth(), 0))) }}>Mês passado</Button>
        <Button size="sm" variant={semFiltro ? "secondary" : "ghost"} onClick={() => aplicarAtalho(null)} title="Todos os chamados, desde o primeiro">Desde o início</Button>
        <Button
          size="sm"
          variant={soOperacao ? "secondary" : "ghost"}
          onClick={() => { onDe(INICIO_OPERACAO_ISO); onAte("") }}
          title="Só os chamados abertos a partir de 16/10/2026, quando o sistema passou a ser usado de verdade (os anteriores vêm da fase de testes e da ClickUp)"
        >
          Só a operação (16/10)
        </Button>
      </div>
      {!semFiltro && (
        <span className="pb-1.5 text-xs text-muted-foreground">
          Período: {de ? new Date(`${de}T00:00:00`).toLocaleDateString("pt-BR") : "início"} até {ate ? new Date(`${ate}T00:00:00`).toLocaleDateString("pt-BR") : "hoje"}
        </span>
      )}
    </div>
  )
}

function fmtPercent(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${n}%`
}

function MetricCard({ value, label, tone }: { value: number | string; label: string; tone?: "success" | "danger" }) {
  const toneClass = tone === "success" ? "text-[#22c55e]" : tone === "danger" ? "text-destructive" : "text-foreground"
  return (
    <Card>
      <CardHeader className="pb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      </CardHeader>
      <CardContent>
        <span className={`text-2xl font-semibold ${toneClass}`}>{value}</span>
      </CardContent>
    </Card>
  )
}

function BarList({
  counts,
  list,
  selected,
  onPick,
}: {
  counts: Record<string, number>
  list: Opcao[]
  /** orderindex do filtro ativo nesta lista (destaca a linha). */
  selected?: number
  /** Clicar numa linha liga/desliga o filtro correspondente. */
  onPick?: (orderindex: number) => void
}) {
  const entries = list
    .map((item) => ({ orderindex: item.orderindex, name: item.name, color: item.color, count: counts?.[item.orderindex] || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Sem chamados nessa categoria ainda.</p>
  }
  const max = Math.max(...entries.map((e) => e.count))
  return (
    <div className="flex flex-col gap-2.5">
      {entries.map((e) => {
        const linha = (
          <>
            <span className="truncate text-left text-muted-foreground">{e.name}</span>
            <span className="h-2 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full" style={{ width: `${Math.round((e.count / max) * 100)}%`, background: e.color }} />
            </span>
            <span className="font-medium">{e.count}</span>
          </>
        )
        const ativo = selected === e.orderindex
        return onPick ? (
          <button
            key={e.name}
            type="button"
            aria-pressed={ativo}
            aria-label={`${ativo ? "Tirar o filtro" : "Filtrar só por"} "${e.name}" (${e.count} chamado${e.count === 1 ? "" : "s"})`}
            title={ativo ? `Tirar o filtro "${e.name}"` : `Filtrar só por "${e.name}"`}
            onClick={() => onPick(e.orderindex)}
            className={`grid w-full cursor-pointer grid-cols-[100px_1fr_auto] items-center gap-3 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${ativo ? "bg-muted ring-1 ring-primary" : ""}`}
          >
            {linha}
          </button>
        ) : (
          <div key={e.name} className="grid grid-cols-[100px_1fr_auto] items-center gap-3 text-sm">{linha}</div>
        )
      })}
    </div>
  )
}

function OperadoresList({ tempoMedio }: { tempoMedio: Record<string, OperadorTempo> }) {
  const entries = Object.entries(tempoMedio || {})
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum chamado encerrado com tempo de atendimento registrado ainda.</p>
  }
  entries.sort((a, b) => (a[1].nome || "").localeCompare(b[1].nome || "", "pt-BR"))
  return (
    <div className="flex flex-col gap-2">
      {entries.map(([id, dado]) => {
        const nome = dado.nome || OPERADORES[id] || `Operador #${id}`
        const plural = dado.totalChamados === 1 ? "" : "s"
        return (
          <div key={id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">{nome}</p>
              <p className="text-xs text-muted-foreground">
                {dado.totalChamados} chamado{plural} encerrado{plural}
              </p>
            </div>
            <span className="text-sm font-semibold text-primary">{fmtMs(dado.mediaMs) || "—"}</span>
          </div>
        )
      })}
    </div>
  )
}

// Donut de SLA em SVG puro (stroke-dasharray por segmento) — mesma técnica de
// renderSlaChart() em admin.js, sem lib de gráfico nenhuma.
function SlaDonut({ dentroPercent, atrasadoPercent }: { dentroPercent: number | null; atrasadoPercent: number | null }) {
  if (dentroPercent === null || dentroPercent === undefined) {
    return <p className="text-sm text-muted-foreground">Nenhum chamado com prazo definido ainda.</p>
  }
  const r = 50
  const cx = 60
  const cy = 60
  const circumference = 2 * Math.PI * r
  const dentroLen = circumference * (dentroPercent / 100)
  const atrasadoLen = circumference * ((atrasadoPercent ?? 0) / 100)

  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 120 120" width={120} height={120} role="img" aria-label={`Dentro do SLA: ${dentroPercent}%, Atrasado: ${atrasadoPercent}%`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={14} />
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke="#22c55e" strokeWidth={14}
          strokeDasharray={`${dentroLen} ${circumference - dentroLen}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke="#ef4444" strokeWidth={14}
          strokeDasharray={`${atrasadoLen} ${circumference - atrasadoLen}`}
          strokeDashoffset={-dentroLen}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={20} fontWeight={700} fill="var(--foreground)">
          {dentroPercent}%
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize={9} fill="var(--muted-foreground)">
          dentro do SLA
        </text>
      </svg>
      <div className="flex flex-col gap-1.5 text-sm">
        <LegendItem color="#22c55e" label="Dentro do SLA" value={`${dentroPercent}%`} />
        <LegendItem color="#ef4444" label="Atrasado" value={`${atrasadoPercent ?? 0}%`} />
      </div>
    </div>
  )
}

function LegendItem({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  )
}
