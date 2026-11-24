// "O que atacar agora" — bloco para o topo do Dashboard/Gestão (estudo do OS800).
//
// O OS800 mostra "Ações pendentes" com contagens clicáveis (em atraso sem técnico,
// aguardando atribuição há +24h, solicitações pendentes). Aqui a mesma ideia com os
// dados que JÁ temos (lista de chamados do painel), sem rota nova no Worker.
// Correção em relação a ele: chamado "pendente" não conta como atrasado (o SLA está
// pausado), e cada linha só aparece se a contagem for maior que zero.

import { AlertTriangle, Clock, UserX, PauseCircle } from "lucide-react"
import type { Task } from "@/lib/api"
import { isAtrasado, venceLogo } from "@/lib/api"
import { cn } from "@/lib/utils"

const HORA = 60 * 60 * 1000

export type FiltroRapido = "atrasados" | "vence-logo" | "sem-atendente" | "pendentes-antigos"

type Linha = {
  chave: FiltroRapido
  texto: (n: number) => string
  tom: "vermelho" | "ambar" | "neutro"
  Icone: typeof AlertTriangle
  conta: (t: Task, agora: number) => boolean
}

const st = (t: Task) => (t.status?.status || "").toLowerCase()
const emAndamento = (t: Task) => st(t) === "aberto" || st(t) === "em atendimento"

const LINHAS: Linha[] = [
  {
    chave: "atrasados",
    texto: (n) => (n === 1 ? "1 chamado passou do prazo" : `${n} chamados passaram do prazo`),
    tom: "vermelho",
    Icone: AlertTriangle,
    conta: (t) => emAndamento(t) && isAtrasado(t),
  },
  {
    chave: "vence-logo",
    texto: (n) => (n === 1 ? "1 vence nos próximos minutos" : `${n} vencem nos próximos minutos`),
    tom: "ambar",
    Icone: Clock,
    conta: (t) => emAndamento(t) && !isAtrasado(t) && venceLogo(t),
  },
  {
    chave: "sem-atendente",
    texto: (n) => (n === 1 ? "1 aberto sem atendente" : `${n} abertos sem atendente`),
    tom: "ambar",
    Icone: UserX,
    conta: (t) => st(t) === "aberto" && !(t.assignees?.length),
  },
  {
    chave: "pendentes-antigos",
    texto: (n) => (n === 1 ? "1 em espera há mais de 3 dias" : `${n} em espera há mais de 3 dias`),
    tom: "neutro",
    Icone: PauseCircle,
    // Aproximação: `date_updated` muda com qualquer edição (nota, operador), então um chamado
    // parado que ganhou uma nota recentemente sai da contagem. O dado exato (data da transição
    // para pendente) só existe em chamado_eventos.
    conta: (t, agora) =>
      st(t) === "pendente" && agora - Number(t.date_updated ?? t.date_created ?? agora) > 72 * HORA,
  },
]

/** Mesma regra do contador, para a lista filtrar exatamente o que o número prometeu. */
export function casaFiltro(chave: FiltroRapido, t: Task, agora: number = Date.now()): boolean {
  return LINHAS.find((l) => l.chave === chave)?.conta(t, agora) ?? false
}

export const ROTULO_FILTRO: Record<FiltroRapido, string> = {
  atrasados: "Passaram do prazo",
  "vence-logo": "Vencem em breve",
  "sem-atendente": "Abertos sem atendente",
  "pendentes-antigos": "Em espera há +3 dias",
}

const TOM: Record<Linha["tom"], string> = {
  vermelho: "border-red-200 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  ambar: "border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  neutro: "border-border bg-muted/50 text-foreground hover:bg-muted",
}

export function AcoesPendentes({
  tasks,
  agora = Date.now(),
  ativo,
  onFiltrar,
}: {
  tasks: Task[]
  agora?: number
  /** Filtro rápido aplicado agora na lista (destaca a linha correspondente). */
  ativo?: string
  /** Clicar numa linha aplica o filtro correspondente na lista (a tela decide como). */
  onFiltrar?: (filtro: FiltroRapido) => void
}) {
  const itens = LINHAS.map((l) => ({ ...l, n: tasks.filter((t) => l.conta(t, agora)).length })).filter((l) => l.n > 0)
  // Chamados distintos: um aberto, atrasado e sem atendente entra em duas linhas, mas é um só.
  const total = tasks.filter((t) => LINHAS.some((l) => l.conta(t, agora))).length

  if (!itens.length) {
    return (
      <section aria-label="Ações pendentes" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
        Nada atrasado nem largado agora.
      </section>
    )
  }

  return (
    <section aria-label="Ações pendentes" className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">O que atacar agora</h2>
        <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
          {total}
          <span className="sr-only"> {total === 1 ? "chamado precisa" : "chamados precisam"} de atenção</span>
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {itens.map(({ chave, texto, tom, Icone, n }) => (
          <li key={chave}>
            <button
              type="button"
              onClick={() => onFiltrar?.(chave)}
              disabled={!onFiltrar}
              aria-pressed={onFiltrar ? ativo === chave : undefined}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default",
                TOM[tom],
                ativo === chave && "ring-2 ring-primary",
              )}
            >
              <Icone className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{texto(n)}</span>
              {onFiltrar && <span aria-hidden>→</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
