import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { fetchMetrics, fmtMs, isSessionError, type OperadorTempo } from "@/lib/api"
import { OPERADORES, SETORES, STATUS_MAP, STATUS_ORDER, TIPOS, type Opcao } from "@/lib/constants"

// Porta loadMetrics()/renderMetrics()/renderBarList()/renderSlaChart()/renderOperadores()
// de admin.js — mesmos cards, mesmo donut de SLA em SVG puro (sem lib de gráfico, mesma
// filosofia zero-dependência), mesmos dados de GET /admin/metrics.
export function DashboardView() {
  const { secret, logout } = useAdminAuth()

  const metricsQuery = useQuery({
    queryKey: ["admin-metrics"],
    queryFn: () => fetchMetrics(secret),
    refetchInterval: 60_000,
  })

  useEffect(() => {
    if (isSessionError(metricsQuery.error)) logout()
  }, [metricsQuery.error, logout])

  if (metricsQuery.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2"><Skeleton className="h-3 w-20" /></CardHeader>
            <CardContent><Skeleton className="h-7 w-14" /></CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (metricsQuery.isError && !isSessionError(metricsQuery.error)) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {metricsQuery.error instanceof Error ? metricsQuery.error.message : "Não foi possível carregar as métricas."}
        </AlertDescription>
      </Alert>
    )
  }

  const data = metricsQuery.data
  if (!data) return null

  return (
    <div className="flex flex-col gap-6">
      {data.truncated && (
        <Alert>
          <AlertDescription>
            Alguns chamados podem não estar entrando nesses números — a busca na ClickUp bateu no teto de páginas.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard value={data.total} label="Total de chamados" />
        {STATUS_ORDER.map((s) => (
          <MetricCard key={s} value={data.porStatus[s] ?? 0} label={STATUS_MAP[s].label} />
        ))}
        <MetricCard value={fmtPercent(data.sla.dentroDoSlaPercent)} label="Dentro do SLA" tone="success" />
        <MetricCard value={fmtPercent(data.sla.atrasadoPercent)} label="Atrasado" tone="danger" />
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
            <BarList counts={data.porTipo} list={TIPOS} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Volume por setor</CardTitle></CardHeader>
          <CardContent>
            <BarList counts={data.porSetor} list={SETORES} />
          </CardContent>
        </Card>
      </div>
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

function BarList({ counts, list }: { counts: Record<string, number>; list: Opcao[] }) {
  const entries = list
    .map((item) => ({ name: item.name, color: item.color, count: counts?.[item.orderindex] || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Sem chamados nessa categoria ainda.</p>
  }
  const max = Math.max(...entries.map((e) => e.count))
  return (
    <div className="flex flex-col gap-2.5">
      {entries.map((e) => (
        <div key={e.name} className="grid grid-cols-[100px_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground">{e.name}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full" style={{ width: `${Math.round((e.count / max) * 100)}%`, background: e.color }} />
          </span>
          <span className="font-medium">{e.count}</span>
        </div>
      ))}
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
