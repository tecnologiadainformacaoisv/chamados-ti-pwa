// Resultado da avaliação mensal da TI, no Dashboard (2026-11-25, ideia do estudo do OS800): NPS, média, participação,
// média por pergunta e comentários SEM nome. Independe do filtro de período do Dashboard (é sempre por mês).

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { isSessionError } from "@/lib/api"
import { PERGUNTAS, fetchResumoAvaliacao, rotuloCompetencia } from "@/lib/avaliacao-api"
import { cn } from "@/lib/utils"

/** NPS: 50 ou mais é muito bom, 0 a 49 é razoável, negativo é problema. */
function corNps(v: number): string {
  return v >= 50 ? "text-emerald-600" : v >= 0 ? "text-amber-600" : "text-red-600"
}

export function AvaliacaoMensalCard() {
  const { secret, logout } = useAdminAuth()
  const [competencia, setCompetencia] = useState<string | undefined>(undefined)
  const consulta = useQuery({
    queryKey: ["avaliacao-resumo", competencia],
    queryFn: () => fetchResumoAvaliacao(secret, competencia),
    placeholderData: (anterior) => anterior,
  })
  useEffect(() => {
    if (isSessionError(consulta.error)) logout()
  }, [consulta.error, logout])

  const d = consulta.data
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="text-sm">Avaliação mensal da TI</CardTitle>
          <p className="text-xs text-muted-foreground">O que os solicitantes responderam no mês. Não muda com o filtro de período.</p>
        </div>
        {d && (
          <Select value={d.competencia} onValueChange={setCompetencia}>
            <SelectTrigger className="w-52" aria-label="Mês da avaliação">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {d.meses.map((m) => (
                <SelectItem key={m.competencia} value={m.competencia}>
                  {rotuloCompetencia(m.competencia)} ({m.respondentes})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent>
        {consulta.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : consulta.isError && !d ? (
          <p className="text-sm text-muted-foreground">Não foi possível carregar a avaliação mensal agora.</p>
        ) : !d || d.respondentes === 0 ? (
          <p className="text-sm text-muted-foreground">Ninguém avaliou {d ? rotuloCompetencia(d.competencia) : "este mês"} ainda.</p>
        ) : (
          <div className={cn("flex flex-col gap-5 transition-opacity", consulta.isPlaceholderData && "opacity-60")} aria-busy={consulta.isPlaceholderData}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">NPS</p>
                <p className={cn("text-2xl font-bold", d.nps && corNps(d.nps.valor))}>{d.nps ? d.nps.valor : "—"}</p>
                {d.nps && (
                  <p className="text-xs text-muted-foreground">
                    {d.nps.promotores} promotor{d.nps.promotores === 1 ? "" : "es"} · {d.nps.neutros} neutro{d.nps.neutros === 1 ? "" : "s"} · {d.nps.detratores} detrator{d.nps.detratores === 1 ? "" : "es"}
                  </p>
                )}
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Média geral</p>
                <p className="text-2xl font-bold">{d.mediaGeral != null ? `${d.mediaGeral.toFixed(1)} ★` : "—"}</p>
                <p className="text-xs text-muted-foreground">de 1 a 5</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Responderam</p>
                <p className="text-2xl font-bold">{d.respondentes}</p>
                <p className="text-xs text-muted-foreground">
                  {d.elegiveis != null ? `de ${d.elegiveis}${d.participacaoPercent != null ? ` (${d.participacaoPercent}%)` : ""}` : "pessoas"}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2" role="list" aria-label="Média por pergunta">
              {PERGUNTAS.map((p) => {
                const media = d.medias[p.chave]
                return (
                  <div key={p.chave} role="listitem" className="grid grid-cols-[9.5rem_1fr_2.5rem] items-center gap-3 text-sm">
                    <span className="truncate text-muted-foreground" title={p.rotulo}>{p.rotulo}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${((media ?? 0) / 5) * 100}%` }} />
                    </span>
                    <span className="text-right font-medium">{media != null ? media.toFixed(1) : "—"}</span>
                  </div>
                )
              })}
            </div>

            {d.comentarios.length === 0 && d.comentariosOcultos && (
              <p className="text-xs text-muted-foreground">
                Há comentários, mas só aparecem quando pelo menos 3 pessoas respondem, para ninguém ser identificado.
              </p>
            )}
            {d.comentarios.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">Comentários (sem nome)</p>
                <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {d.comentarios.map((c, i) => (
                    <li key={i} className="rounded-md bg-muted/50 px-3 py-2 text-sm break-words">“{c}”</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
