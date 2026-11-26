// Tela inicial do painel NO CELULAR (pedido do usuário, 2026-11-26): aparece uma vez por entrada no app,
// antes da lista. Cada número abre a lista já filtrada. Os números saem da lista que o painel já carrega.
import type { Task } from "@/lib/api"
import { casaFiltro } from "@/components/acoes-pendentes"
import { cn } from "@/lib/utils"

export type FiltroInicial = "aguardando" | "atrasados" | "atendimento" | "espera"

const status = (t: Task) => (t.status?.status || "").toLowerCase()

const ITENS: { chave: FiltroInicial; rotulo: string; tom: string; conta: (t: Task) => boolean }[] = [
  { chave: "aguardando", rotulo: "aguardando aceite", tom: "border-blue-200 bg-blue-50 text-blue-900", conta: (t) => status(t) === "aberto" },
  {
    chave: "atrasados",
    rotulo: "passaram do prazo",
    tom: "border-red-200 bg-red-50 text-red-800",
    conta: (t) => casaFiltro("atrasados", t),
  },
  { chave: "atendimento", rotulo: "em atendimento", tom: "border-violet-200 bg-violet-50 text-violet-900", conta: (t) => status(t) === "em atendimento" },
  { chave: "espera", rotulo: "em espera", tom: "border-amber-200 bg-amber-50 text-amber-900", conta: (t) => status(t) === "pendente" },
]

export function casaFiltroInicial(chave: FiltroInicial, t: Task): boolean {
  return ITENS.find((i) => i.chave === chave)?.conta(t) ?? false
}

export const ROTULO_INICIAL: Record<FiltroInicial, string> = {
  aguardando: "Aguardando aceite",
  atrasados: "Atrasados",
  atendimento: "Em atendimento",
  espera: "Em espera",
}

function saudacao(): string {
  // Hora de Fortaleza, como o resto do painel.
  const hora = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Fortaleza", hour: "2-digit", hourCycle: "h23" }).format(new Date()))
  return hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite"
}

export function TelaInicial({
  tasks,
  nome,
  carregando,
  desatualizado,
  onEscolher,
  onVerTodos,
}: {
  tasks: Task[]
  nome?: string
  carregando: boolean
  desatualizado?: boolean
  onEscolher: (f: FiltroInicial) => void
  onVerTodos: () => void
}) {
  const itens = ITENS.map((i) => ({ ...i, n: tasks.filter(i.conta).length }))
  const emDia = !carregando && !itens.some((i) => (i.chave === "aguardando" || i.chave === "atrasados") && i.n > 0)
  return (
    <section aria-label="Tela inicial" className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">
          {saudacao()}
          {nome ? `, ${nome}` : ""}
        </h2>
        <p role="status" className="text-sm text-muted-foreground">
          {carregando ? "Carregando chamados…" : desatualizado ? "Sem conexão: os números podem estar desatualizados." : emDia ? "Tudo em dia: nada esperando aceite nem atrasado." : "Há chamado esperando por você."}
        </p>
      </div>
      <ul className="flex flex-col gap-2.5">
        {itens.map(({ chave, rotulo, tom, n }) => (
          <li key={chave}>
            <button
              type="button"
              disabled={carregando || n === 0}
              onClick={() => onEscolher(chave)}
              className={cn(
                "flex min-h-16 w-full cursor-pointer items-center gap-4 rounded-xl border px-4 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default",
                n > 0 ? tom : "border-border bg-muted/40 text-muted-foreground",
              )}
            >
              <span className="min-w-10 text-3xl font-bold tabular-nums">{carregando ? "–" : n}</span>
              <span className="min-w-0 flex-1 text-base font-medium">{rotulo}</span>
              {n > 0 && !carregando && <span aria-hidden>→</span>}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onVerTodos}
        className="min-h-12 w-full cursor-pointer rounded-xl bg-primary font-semibold text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Ver chamados
      </button>
    </section>
  )
}
