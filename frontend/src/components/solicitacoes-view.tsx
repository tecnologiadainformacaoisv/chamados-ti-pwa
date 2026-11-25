// Lista de solicitações com o andamento em 5 etapas (2026-11-25, ideia do estudo do OS800). A mesma lista serve
// ao solicitante ("modo solicitante", só leitura) e à TI ("modo admin", com os botões da próxima etapa).
//   * os botões oferecem só as transições que o servidor aceita (SOLIC_PROXIMOS);
//   * rejeitar pede o motivo (quem pediu lê); aprovar e "a caminho" aceitam um recado opcional (ex.: previsão);
//   * o andamento tem texto para leitor de tela, não só as bolinhas.

import { useState } from "react"
import { Check, Clock, MessageSquare, Package, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SETORES, optionName } from "@/lib/constants"
import {
  SOLIC_CATEGORIAS,
  SOLIC_CATEGORIA_LABEL,
  SOLIC_CATEGORIA_SINGULAR,
  SOLIC_ETAPAS,
  SOLIC_PROXIMOS,
  SOLIC_STATUS_LABEL,
  solicEmAndamento,
  type SolicCategoria,
  type SolicStatus,
  type Solicitacao,
} from "@/lib/solicitacoes-api"
import { cn } from "@/lib/utils"

const ACAO: Partial<Record<SolicStatus, string>> = {
  em_analise: "Começar análise",
  aprovado: "Aprovar",
  em_transito: "Marcar a caminho",
  entregue: "Marcar entregue",
  pendente: "Voltar para pendente",
}

// Etapas em que a TI pode deixar um recado opcional para quem pediu (ex.: "chega na sexta").
const PEDE_RECADO: SolicStatus[] = ["aprovado", "em_transito"]

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })

type Props = {
  solicitacoes: Solicitacao[]
  modo: "admin" | "solicitante"
  /** Só no modo admin. `motivo` é o motivo da rejeição (obrigatório) ou o recado opcional. */
  onMudarStatus?: (s: Solicitacao, para: SolicStatus, motivo?: string) => void
  /** Só no modo solicitante: botão "Nova solicitação". */
  onNova?: () => void
  ocupadoId?: string | null
}

export function SolicitacoesView({ solicitacoes, modo, onMudarStatus, onNova, ocupadoId }: Props) {
  const [categoria, setCategoria] = useState<SolicCategoria | "todas">("todas")
  const [estado, setEstado] = useState<SolicStatus | "todos">("todos")

  const daCategoria = categoria === "todas" ? solicitacoes : solicitacoes.filter((s) => s.categoria === categoria)
  const lista = estado === "todos" ? daCategoria : daCategoria.filter((s) => s.status === estado)
  const emAndamento = (c: SolicCategoria | "todas") =>
    solicitacoes.filter((s) => (c === "todas" || s.categoria === c) && solicEmAndamento(s)).length

  return (
    <div className="flex flex-col gap-4">
      {modo === "solicitante" && onNova && (
        <Button className="self-start" onClick={onNova}>
          <Package className="size-4" aria-hidden /> Nova solicitação
        </Button>
      )}

      <Tabs value={categoria} onValueChange={(v) => { setCategoria(v as SolicCategoria | "todas"); setEstado("todos") }}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="todas">
            Todas{emAndamento("todas") > 0 && <span className="count-pill ml-1.5">{emAndamento("todas")}</span>}
          </TabsTrigger>
          {SOLIC_CATEGORIAS.map((c) => (
            <TabsTrigger key={c} value={c}>
              {SOLIC_CATEGORIA_LABEL[c]}
              {emAndamento(c) > 0 && <span className="count-pill ml-1.5">{emAndamento(c)}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por situação">
        {(["todos", ...SOLIC_ETAPAS, "rejeitado"] as const).map((e) => {
          const n = e === "todos" ? daCategoria.length : daCategoria.filter((s) => s.status === e).length
          return (
            <Button key={e} size="sm" variant={estado === e ? "default" : "outline"} aria-pressed={estado === e} onClick={() => setEstado(e)}>
              {e === "todos" ? "Todas" : SOLIC_STATUS_LABEL[e]}
              {n > 0 && <span className="ml-1 opacity-80">{n}</span>}
            </Button>
          )
        })}
      </div>

      {lista.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-white p-8 text-center text-sm text-muted-foreground">
          {solicitacoes.length === 0
            ? modo === "solicitante"
              ? "Você ainda não fez nenhuma solicitação. Precisa de um equipamento, material, peça ou autorização? Peça por aqui."
              : "Nenhuma solicitação ainda."
            : "Nenhuma solicitação nessa situação."}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {lista.map((s) => (
            <li key={s.id} className="min-w-0">
              <CardSolicitacao s={s} modo={modo} onMudarStatus={onMudarStatus} ocupado={ocupadoId === s.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CardSolicitacao({ s, modo, onMudarStatus, ocupado }: { s: Solicitacao; modo: Props["modo"]; onMudarStatus?: Props["onMudarStatus"]; ocupado: boolean }) {
  const rejeitado = s.status === "rejeitado"
  const etapaAtual = SOLIC_ETAPAS.indexOf(s.status)

  // `null` no prompt = a pessoa cancelou (não faz nada); texto vazio = segue sem recado.
  const avancar = (para: SolicStatus) => {
    if (para === "rejeitado") {
      const motivo = window.prompt("Por que esta solicitação foi rejeitada? Quem pediu vai ler este texto.")?.trim()
      if (motivo) onMudarStatus?.(s, para, motivo)
      return
    }
    if (PEDE_RECADO.includes(para)) {
      const recado = window.prompt("Recado para quem pediu (opcional, ex.: previsão de entrega). Deixe em branco para seguir sem recado.")
      if (recado === null) return
      onMudarStatus?.(s, para, recado.trim() || undefined)
      return
    }
    onMudarStatus?.(s, para)
  }

  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border bg-card p-4" data-solicitacao-id={s.id}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="mb-0.5 text-xs font-medium text-muted-foreground">
            {s.numero != null && <span className="mr-1 font-mono">#{String(s.numero).padStart(4, "0")}</span>}
            {SOLIC_CATEGORIA_SINGULAR[s.categoria]}
          </p>
          <h3 className="font-semibold break-words">{s.item}</h3>
          <p className="text-sm text-muted-foreground">
            {s.quantidade} unidade{s.quantidade > 1 ? "s" : ""}
            {modo === "admin" && ` · ${s.solicitante}`}
            {s.setor != null && ` · ${optionName(SETORES, s.setor)}`}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
            rejeitado ? "border-red-200 bg-red-50 text-red-800"
              : s.status === "entregue" ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-900",
          )}
        >
          {SOLIC_STATUS_LABEL[s.status]}
        </span>
      </header>

      <p className="text-sm break-words">
        <span className="text-muted-foreground">Para quê: </span>
        {s.justificativa}
      </p>

      {rejeitado ? (
        <p className="flex gap-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">
          <X className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="break-words">{s.motivo_rejeicao || "Rejeitada sem motivo informado."}</span>
        </p>
      ) : (
        <ol className="grid grid-cols-5 gap-1" aria-label={`Andamento: etapa ${etapaAtual + 1} de ${SOLIC_ETAPAS.length}, ${SOLIC_STATUS_LABEL[s.status]}`}>
          {SOLIC_ETAPAS.map((e, i) => {
            const feita = i < etapaAtual || s.status === "entregue"
            const atual = i === etapaAtual && s.status !== "entregue"
            return (
              <li key={e} className="flex flex-col items-center gap-1 text-center" aria-current={atual ? "step" : undefined}>
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs font-semibold",
                    feita && "border-primary bg-primary text-primary-foreground",
                    atual && "border-primary bg-primary/10 text-primary ring-2 ring-primary/30",
                    !feita && !atual && "border-border text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {feita ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className={cn("text-[11px] leading-tight", atual ? "font-semibold" : "text-muted-foreground")}>{SOLIC_STATUS_LABEL[e]}</span>
              </li>
            )
          })}
        </ol>
      )}

      {s.nota_ti && !rejeitado && (
        <p className="flex gap-2 rounded-lg bg-primary/5 p-2 text-sm">
          <MessageSquare className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span className="break-words"><span className="font-medium">Recado da TI:</span> {s.nota_ti}</span>
        </p>
      )}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-2">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="size-3.5" aria-hidden /> Pedido em {fmt(s.created_at)}
        </span>
        {modo === "admin" && onMudarStatus && (
          <div className="flex flex-wrap gap-1.5">
            {SOLIC_PROXIMOS[s.status].map((para) =>
              para === "rejeitado" ? (
                <Button key={para} size="xs" variant="destructive" disabled={ocupado} onClick={() => avancar(para)}>Rejeitar</Button>
              ) : (
                <Button key={para} size="xs" variant={para === "pendente" ? "ghost" : "default"} disabled={ocupado} onClick={() => avancar(para)}>
                  {ACAO[para]}
                </Button>
              ),
            )}
          </div>
        )}
      </footer>
    </article>
  )
}
