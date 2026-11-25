// Relatório mensal da TI (2026-11-26): mês civil, só números, em uma folha que o navegador salva como PDF.
// Usa as mesmas rotas do Dashboard (/admin/metrics e /admin/avaliacoes-mensais); sem nome de solicitante
// nem comentário.

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { fetchMetrics, fmtMs, isSessionError, type Metrics } from "@/lib/api"
import { PERGUNTAS, fetchResumoAvaliacao, rotuloCompetencia, type ResumoAvaliacao } from "@/lib/avaliacao-api"
import { OPERADORES, SETORES, STATUS_MAP, STATUS_ORDER, TIPOS } from "@/lib/constants"

const PRIORIDADES = [
  { orderindex: 1, name: "Urgente" },
  { orderindex: 2, name: "Alta" },
  { orderindex: 3, name: "Normal" },
]
// America/Fortaleza é UTC-3 fixo: o mês começa e termina nesse fuso, não no do computador.
const FUSO_MS = 3 * 3600000

function competenciaDe(deslocamento: number, agora = Date.now()): string {
  const local = new Date(agora - FUSO_MS)
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - deslocamento, 1)).toISOString().slice(0, 7)
}
function anterior(competencia: string): string {
  const [a, m] = competencia.split("-").map(Number)
  return new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 7)
}
function limites(competencia: string): { desde: number; ate: number } {
  const [a, m] = competencia.split("-").map(Number)
  return { desde: Date.UTC(a, m - 1, 1) + FUSO_MS, ate: Date.UTC(a, m, 1) + FUSO_MS - 1 }
}

export function RelatorioMensal() {
  // Por padrão o último mês fechado; a lista vai até 12 meses atrás.
  const [competencia, setCompetencia] = useState(() => competenciaDe(1))
  const [aberto, setAberto] = useState(false)
  const botaoRef = useRef<HTMLButtonElement>(null)
  const meses = Array.from({ length: 13 }, (_, i) => competenciaDe(i))

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Relatório mensal</span>
      <Select value={competencia} onValueChange={setCompetencia}>
        <SelectTrigger className="w-48" aria-label="Mês do relatório">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {meses.map((m, i) => (
            <SelectItem key={m} value={m}>
              {rotuloCompetencia(m)}
              {i === 0 ? " (em andamento)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button ref={botaoRef} size="sm" onClick={() => setAberto(true)}>Abrir relatório</Button>
      <span className="text-xs text-muted-foreground">Não usa os filtros acima.</span>
      {aberto && (
        <Folha
          competencia={competencia}
          onFechar={() => {
            setAberto(false)
            // o botão só volta a aceitar foco depois que o painel deixa de estar inerte
            setTimeout(() => botaoRef.current?.focus(), 0)
          }}
        />
      )}
    </div>
  )
}

function Folha({ competencia, onFechar }: { competencia: string; onFechar: () => void }) {
  const { secret, logout } = useAdminAuth()
  const mesAnterior = anterior(competencia)
  const atual = useQuery({ queryKey: ["relatorio-metricas", competencia], queryFn: () => fetchMetrics(secret, limites(competencia)), gcTime: 0 })
  const antes = useQuery({ queryKey: ["relatorio-metricas", mesAnterior], queryFn: () => fetchMetrics(secret, limites(mesAnterior)), gcTime: 0 })
  const avaliacao = useQuery({ queryKey: ["relatorio-avaliacao", competencia], queryFn: () => fetchResumoAvaliacao(secret, competencia), gcTime: 0 })
  const fecharRef = useRef<HTMLButtonElement>(null)

  const erroSessao = [atual.error, antes.error, avaliacao.error].some((e) => isSessionError(e))
  useEffect(() => {
    if (erroSessao) logout()
  }, [erroSessao, logout])

  const fecharFn = useRef(onFechar)
  fecharFn.current = onFechar
  useEffect(() => {
    // O painel por trás fica inerte (foco preso na folha) e o título vira o nome sugerido do PDF.
    const raiz = document.getElementById("root")
    raiz?.setAttribute("inert", "")
    const tituloAntes = document.title
    document.title = `Relatorio-TI-${competencia}`
    fecharRef.current?.focus()
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && fecharFn.current()
    window.addEventListener("keydown", tecla)
    return () => {
      raiz?.removeAttribute("inert")
      document.title = tituloAntes
      window.removeEventListener("keydown", tecla)
    }
  }, [competencia])

  // Só deixa imprimir com os números na tela (avaliação que falhou sai marcada como indisponível).
  const pronto = !!atual.data && !!antes.data && !avaliacao.isLoading
  const falhou = atual.isError || antes.isError

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`Relatório de ${rotuloCompetencia(competencia)}`} className="relatorio-folha fixed inset-0 z-50 overflow-y-auto bg-white text-black">
      <div className="mx-auto max-w-3xl px-5 py-6">
        <div className="relatorio-acoes mb-6 flex justify-end gap-2">
          <Button ref={fecharRef} variant="outline" className="bg-white text-black" onClick={onFechar}>Fechar</Button>
          <Button disabled={!pronto} onClick={() => window.print()}>Salvar em PDF</Button>
        </div>
        <h2 className="text-xl font-bold">Relatório da TI: {rotuloCompetencia(competencia)}</h2>
        <p className="text-sm text-neutral-600">
          Instituto São Vicente
          {atual.dataUpdatedAt ? ` · números de ${new Date(atual.dataUpdatedAt).toLocaleString("pt-BR", { timeZone: "America/Fortaleza", dateStyle: "short", timeStyle: "short" })}` : ""}
          {competencia === competenciaDe(0) ? " · mês em andamento (parcial)" : ""}
        </p>
        {falhou ? (
          <p className="mt-6" role="alert">Não foi possível carregar os números. Feche e abra o relatório de novo.</p>
        ) : !pronto || !atual.data || !antes.data ? (
          <p className="mt-6" role="status">Carregando os números…</p>
        ) : (
          <Conteudo m={atual.data} a={antes.data} rotuloAnterior={rotuloCompetencia(mesAnterior)} avaliacao={avaliacao.data} />
        )}
      </div>
    </div>,
    document.body,
  )
}

const pct = (v: number | null) => (v == null ? "—" : `${v.toLocaleString("pt-BR")}%`)
const nota = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }))

function Conteudo({ m, a, rotuloAnterior, avaliacao }: { m: Metrics; a: Metrics; rotuloAnterior: string; avaliacao: ResumoAvaliacao | undefined }) {
  const contagem = (lista: { orderindex: number; name: string }[], atual: Record<string, number>, antes: Record<string, number>) => {
    const linhas = lista
      .map((i) => [i.name, atual[i.orderindex] ?? 0, antes[i.orderindex] ?? 0] as [string, number, number])
      .filter((l) => l[1] || l[2])
      .sort((x, y) => y[1] - x[1])
    // Chamado antigo sem tipo ou setor: aparece, para a soma fechar com o total.
    const semAtual = m.total - linhas.reduce((n, l) => n + l[1], 0)
    const semAntes = a.total - linhas.reduce((n, l) => n + l[2], 0)
    if (semAtual > 0 || semAntes > 0) linhas.push(["Não informado", Math.max(semAtual, 0), Math.max(semAntes, 0)])
    return linhas as Linha[]
  }
  const ids = [...new Set([...Object.keys(m.porOperador ?? {}), ...Object.keys(a.porOperador ?? {})])]
  const nomeOperador = (id: string) => OPERADORES[id] ?? `Operador #${id}`
  const tempo = (x: Metrics, id: string) => {
    const d = x.tempoMedioPorOperador[id]
    return d ? `${fmtMs(d.mediaMs) || "—"} (${d.totalChamados})` : "—"
  }
  const colunas = ["Mês", "Mês anterior"]

  return (
    <>
      <p className="mt-3 text-xs text-neutral-600">
        Conta os chamados abertos no mês. Situação e prazo são os do momento em que o relatório foi gerado.
        Mês anterior: {rotuloAnterior}.
      </p>
      <p className="mt-1 text-xs text-neutral-600">
        Prazo: vale o prazo atual de cada chamado (de aceitação ou de conclusão). Chamado em espera tem o prazo parado
        e é medido no momento em que entrou em espera.
        Tempo de atendimento: soma do tempo em atendimento, sem contar a espera, com a quantidade de chamados entre
        parênteses. Chamado com dois atendentes conta para os dois. Em chamados antigos, sem histórico completo, o tempo
        pode incluir a espera, e os que estão em espera sem esse registro ficam fora da conta de prazo.
      </p>
      <Tabela
        titulo="Resumo"
        colunas={colunas}
        linhas={[
          ["Chamados abertos no mês", m.total, a.total],
          ...STATUS_ORDER.map((s) => [`Situação: ${STATUS_MAP[s].label}`, m.porStatus[s] ?? 0, a.porStatus[s] ?? 0] as Linha),
          ["Dentro do prazo", pct(m.sla.dentroDoSlaPercent), pct(a.sla.dentroDoSlaPercent)],
          ["Fora do prazo", pct(m.sla.atrasadoPercent), pct(a.sla.atrasadoPercent)],
          ["Nota média dos chamados (1 a 5)", nota(m.satisfacao.mediaNota), nota(a.satisfacao.mediaNota)],
          ["Chamados avaliados", m.satisfacao.totalAvaliacoes, a.satisfacao.totalAvaliacoes],
        ]}
      />
      <Tabela titulo="Por tipo" colunas={colunas} linhas={contagem(TIPOS, m.porTipo, a.porTipo)} />
      <Tabela titulo="Por setor" colunas={colunas} linhas={contagem(SETORES, m.porSetor, a.porSetor)} />
      <Tabela titulo="Por prioridade" colunas={colunas} linhas={contagem(PRIORIDADES, m.porPrioridade, a.porPrioridade)} />
      <Tabela titulo="Chamados por atendente" colunas={colunas} linhas={ids.map((id) => [nomeOperador(id), m.porOperador[id] ?? 0, a.porOperador[id] ?? 0])} />
      <Tabela
        titulo="Tempo médio em atendimento"
        colunas={colunas}
        linhas={[...new Set([...Object.keys(m.tempoMedioPorOperador), ...Object.keys(a.tempoMedioPorOperador)])].map((id) => [nomeOperador(id), tempo(m, id), tempo(a, id)])}
      />
      {!avaliacao ? (
        <p className="mt-5 text-sm">Avaliação mensal da TI: não foi possível carregar.</p>
      ) : avaliacao.respondentes === 0 ? (
        <p className="mt-5 text-sm">Avaliação mensal da TI: ninguém respondeu neste mês.</p>
      ) : (
        <Tabela
          titulo="Avaliação mensal da TI"
          colunas={["Mês"]}
          linhas={[
            ["Pessoas que responderam", avaliacao.elegiveis != null ? `${avaliacao.respondentes} (hoje há ${avaliacao.elegiveis} ativos)` : avaliacao.respondentes],
            ["NPS (-100 a 100)", avaliacao.nps?.valor ?? "—"],
            ["Média geral (1 a 5)", nota(avaliacao.mediaGeral)],
            ...PERGUNTAS.map((p) => [p.rotulo, nota(avaliacao.medias[p.chave])] as Linha),
          ]}
        />
      )}
    </>
  )
}

type Linha = (string | number)[]

function Tabela({ titulo, colunas, linhas }: { titulo: string; colunas: string[]; linhas: Linha[] }) {
  return (
    <section className="relatorio-bloco mt-5">
      <table className="w-full border-collapse text-sm">
        <caption className="border-b-2 border-black pb-1 text-left text-sm font-bold">{titulo}</caption>
        {linhas.length > 0 && (
          <thead>
            <tr className="text-xs text-neutral-600">
              <th scope="col" className="py-1 text-left font-normal"><span className="sr-only">Item</span></th>
              {colunas.map((c) => (
                <th key={c} scope="col" className="w-28 py-1 text-right font-normal">{c}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {linhas.length === 0 && (
            <tr><td className="py-1 text-neutral-600">Sem registros.</td></tr>
          )}
          {linhas.map(([rotulo, ...valores]) => (
            <tr key={rotulo} className="border-b border-neutral-200">
              <th scope="row" className="py-1 text-left font-normal">{rotulo}</th>
              {valores.map((v, i) => (
                <td key={i} className="py-1 text-right tabular-nums">{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
