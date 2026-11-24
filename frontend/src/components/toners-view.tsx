// Gestão de toners (estudo do OS800, 2026-11-17).
//
// Do OS800: cartões Total / Críticos (recarga imediata) / Atenção (recarga em breve) /
// OK (dentro do ciclo) / Média de ciclo, e a lista com busca.
// Diferenças nossas: os cartões filtram a lista ao clicar; cada linha tem
// "Registrar recarga" (é a recarga que alimenta o ciclo, sem ela o módulo não aprende
// nada); a situação é recalculada no cliente (lib/toner-ciclo.ts) e a lista vem
// ordenada do mais urgente para o menos.

import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Printer, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { SETORES, optionName } from "@/lib/constants"
import { desfazerUltimaRecarga, fetchToners, nomeDoLugar, registrarRecarga, TONER_COR_LABEL, type Toner } from "@/lib/toners-api"
import { TonerForm } from "@/components/toner-form"
import { isSessionError } from "@/lib/api"
import { calcularToner, mediaGeralCiclo, type CalculoToner, type SituacaoToner } from "@/lib/toner-ciclo"
import { cn } from "@/lib/utils"

const ORDEM: Record<SituacaoToner, number> = { critico: 0, atencao: 1, sem_dados: 2, ok: 3 }

const SITUACAO: Record<SituacaoToner, { rotulo: string; dica: string; cor: string }> = {
  critico: { rotulo: "Crítico", dica: "Trocar agora", cor: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" },
  atencao: { rotulo: "Atenção", dica: "Trocar em breve", cor: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" },
  ok: { rotulo: "OK", dica: "Dentro do ciclo", cor: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200" },
  sem_dados: { rotulo: "Sem histórico", dica: "Registre a primeira recarga", cor: "border-border bg-muted text-muted-foreground" },
}

const lugarDe = (t: Toner) => nomeDoLugar(t, (s) => optionName(SETORES, s))

function haQuanto(ms: number, agora = Date.now()): string {
  const min = Math.max(0, Math.round((agora - ms) / 60_000))
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  return `há ${d} dia${d === 1 ? "" : "s"}`
}

const fmtDias = (d: number | null) => (d == null ? "—" : `${Math.round(d)} dia${Math.round(d) === 1 ? "" : "s"}`)

export function TonersView() {
  const { secret, logout } = useAdminAuth()
  const qc = useQueryClient()
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["toners"],
    queryFn: () => fetchToners(secret),
  })
  const [filtro, setFiltro] = useState<SituacaoToner | null>(null)
  // null = fechado; "novo" = cadastro; objeto = edição
  const [editando, setEditando] = useState<Toner | "novo" | null>(null)
  const [erroAcao, setErroAcao] = useState<string | null>(null)
  // Mesmo "Quem escreve?" lembrado do modal Gerenciar (localStorage admin_nota_autor).
  const autor = (() => { try { return localStorage.getItem("admin_nota_autor") } catch { return null } })()

  const aoFalhar = (e: unknown) => {
    if (isSessionError(e)) return logout()
    setErroAcao(e instanceof Error ? e.message : "A ação não foi concluída.")
  }
  const recarga = useMutation({
    mutationFn: (id: string) => registrarRecarga(secret, id, autor),
    onMutate: () => setErroAcao(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["toners"] }),
    onError: aoFalhar,
  })
  const desfazer = useMutation({
    mutationFn: (id: string) => desfazerUltimaRecarga(secret, id),
    onMutate: () => setErroAcao(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["toners"] }),
    onError: aoFalhar,
  })
  const pedirRecarga = (t: Toner) => {
    if (window.confirm(`Registrar que o toner da impressora "${lugarDe(t)}" foi trocado agora?`)) recarga.mutate(t.id)
  }
  const pedirDesfazer = (t: Toner) => {
    if (window.confirm(`Desfazer a última recarga registrada da impressora "${lugarDe(t)}"?`)) desfazer.mutate(t.id)
  }

  const linhas = useMemo(() => {
    const agora = Date.now()
    return (data?.toners ?? [])
      .map((t) => ({ t, c: calcularToner(t.recargas, t.ciclo_dias_padrao, agora, { nivel: t.nivel_percentual, lidoEm: t.nivel_lido_em }) }))
      .sort((a, b) => ORDEM[a.c.situacao] - ORDEM[b.c.situacao] || (a.c.diasRestantes ?? 1e9) - (b.c.diasRestantes ?? 1e9))
  }, [data])

  const conta = (s: SituacaoToner) => linhas.filter((l) => l.c.situacao === s).length
  const media = mediaGeralCiclo(linhas.map((l) => l.c))
  const visiveis = filtro ? linhas.filter((l) => l.c.situacao === filtro) : linhas

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Toners</h1>
          <p className="text-sm text-muted-foreground">Quando trocar, antes de virar chamado</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("size-4", isFetching && "animate-spin")} aria-hidden /> Atualizar
          </Button>
          <Button onClick={() => setEditando("novo")}>Novo toner</Button>
        </div>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Não foi possível carregar os toners. Tente atualizar.</AlertDescription>
        </Alert>
      ) : isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {(["critico", "atencao", "ok"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={filtro === s}
                onClick={() => setFiltro(filtro === s ? null : s)}
                className={cn(
                  "cursor-pointer rounded-xl border p-3 text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  SITUACAO[s].cor,
                  filtro === s && "ring-2 ring-primary",
                )}
              >
                <p className="text-xs font-medium">{SITUACAO[s].rotulo}</p>
                <p className="text-2xl font-bold">{conta(s)}</p>
                <p className="text-xs opacity-80">{SITUACAO[s].dica}</p>
              </button>
            ))}
            <div className="rounded-xl border bg-card p-3">
              <p className="text-xs font-medium text-muted-foreground">Total</p>
              <p className="text-2xl font-bold">{linhas.length}</p>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <p className="text-xs font-medium text-muted-foreground">Ciclo médio</p>
              <p className="text-2xl font-bold">{media == null ? "—" : fmtDias(media)}</p>
              <p className="text-xs text-muted-foreground">entre recargas</p>
            </div>
          </div>

          {erroAcao && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{erroAcao}</AlertDescription>
            </Alert>
          )}

          {!linhas.length ? (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nenhum toner cadastrado. Cadastre a impressora no Inventário, depois clique em "Novo toner" para ligar o toner a ela.
            </p>
          ) : (
            <ul className="divide-y rounded-xl border bg-card">
              {visiveis.map(({ t, c }) => (
                <LinhaToner
                  key={t.id}
                  t={t}
                  c={c}
                  registrando={recarga.isPending && recarga.variables === t.id}
                  onRecarga={() => pedirRecarga(t)}
                  onDesfazer={() => pedirDesfazer(t)}
                  onEditar={() => setEditando(t)}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {editando && <TonerForm toner={editando === "novo" ? null : editando} onClose={() => setEditando(null)} />}
    </div>
  )
}

function LinhaToner({ t, c, registrando, onRecarga, onDesfazer, onEditar }: { t: Toner; c: CalculoToner; registrando: boolean; onRecarga: () => void; onDesfazer: () => void; onEditar: () => void }) {
  const s = SITUACAO[c.situacao]
  // Com leitura válida a barra mostra o que SOBROU no toner; sem ela, quanto do ciclo já foi consumido.
  const pct = c.porLeitura && c.nivel != null ? c.nivel : c.uso == null ? null : Math.min(100, Math.round(c.uso * 100))
  const cor = c.situacao === "critico" ? "bg-red-600" : c.situacao === "atencao" ? "bg-amber-500" : "bg-emerald-600"
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <Printer className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold">{lugarDe(t)}</p>
        <p className="truncate text-sm text-muted-foreground">
          {[
            [t.marca, t.modelo].filter(Boolean).join(" "),
            // o setor entra quando o título já é o local e eles dizem coisas diferentes
            t.local && t.setor != null && optionName(SETORES, t.setor) !== t.local ? optionName(SETORES, t.setor) : null,
            t.ip,
            t.tombamento,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          Cartucho {TONER_COR_LABEL[t.cor].toLowerCase()} · cód. {t.codigo}
        </p>
        {pct != null && (
          <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className={cn("h-full", cor)} style={{ width: `${pct}%` }} />
          </div>
        )}
        {c.porLeitura && c.nivel != null ? (
          <p className="mt-1 text-xs text-muted-foreground">Nível {c.nivel}% · lido {haQuanto(c.lidoEm!)}</p>
        ) : c.lidoEm != null ? (
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Última leitura {haQuanto(c.lidoEm)}: desatualizada, valendo o ciclo das recargas</p>
        ) : null}
      </div>
      <div className="text-right text-sm">
        <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", s.cor)}>{s.rotulo}</span>
        <p className="mt-1 text-xs text-muted-foreground">
          {c.porLeitura
            ? s.dica
            : c.diasRestantes == null
              ? s.dica
              : c.diasRestantes < 0
                ? `passou ${fmtDias(-c.diasRestantes)} do ciclo`
                : `faltam ~${fmtDias(c.diasRestantes)}`}
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="outline" onClick={onRecarga} disabled={registrando}>
          {registrando ? "Registrando…" : "Registrar recarga"}
        </Button>
        {t.recargas.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onDesfazer}>Desfazer última</Button>
        )}
        <Button size="sm" variant="ghost" onClick={onEditar}>Editar</Button>
      </div>
    </li>
  )
}
