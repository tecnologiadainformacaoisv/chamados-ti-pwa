import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MessageCircle, Paperclip, Star } from "lucide-react"
import { getCF, fmtDate, type Attachment, type Task } from "@/lib/api"
import { ateQuando, isOverdue, overdueFor, timeAgo, waLinkForTask } from "@/lib/ticket-helpers"
import { OPERADORES, PRIORITY_MAP, SETORES, SETOR_FIELD_ID, SOLUCAO_FIELD_ID, TIPOS, TIPO_FIELD_ID, optionName, type StatusKey } from "@/lib/constants"
import { COR_PRIO, INK, LINE, MUTED, NORMAL } from "@/lib/mvp-visual"
import { useSessionAuth } from "@/hooks/use-session-auth"
import { useAgora } from "@/hooks/use-agora"
import { fetchTaskDetail, submitNota } from "@/lib/app-api"
import { AnexoModal } from "@/components/anexo-modal"

const OK = "#1E7F52"
const AMBAR = "#9A5A00"

// Nota de satisfação (2026-09-21, pedido do usuário: "julgo essencial") — 5 estrelas,
// só aparece em chamado encerrado (única fase em que faz sentido avaliar). Reenviar
// sobrescreve a nota anterior (mesmo comportamento do servidor, ver handleSetNota em
// push-worker.js) — sem tela de "obrigado, não dá mais pra mudar", deixa a pessoa
// corrigir se clicou errado.
function NotaChamado({ task }: { task: Task }) {
  const { sessionToken } = useSessionAuth()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (nota: number) => submitNota(sessionToken, task.id, nota),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-tasks"] }),
  })
  // Valor do servidor (task.nota, atualizado pela invalidação) é a fonte de verdade;
  // a nota clicada só vale de forma otimista enquanto o envio está pendente.
  const notaAtual = (mutation.isPending ? mutation.variables : task.nota) ?? 0

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span style={{ color: MUTED }}>{notaAtual ? "Sua avaliação:" : "Como foi o atendimento?"}</span>
      <div className="flex" role="group" aria-label="Avaliação do atendimento">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(n)}
            aria-label={`Avaliar com ${n} estrela${n > 1 ? "s" : ""}`}
            aria-pressed={n === notaAtual}
            title={`${n} estrela${n > 1 ? "s" : ""}`}
            className="cursor-pointer rounded p-2.5 transition-transform duration-100 hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:scale-95 disabled:opacity-50"
          >
            <Star className="h-6 w-6" fill={n <= notaAtual ? "#f59e0b" : "none"} stroke={n <= notaAtual ? "#f59e0b" : "currentColor"} />
          </button>
        ))}
      </div>
      {/* contêiner sempre montado, só o texto troca — região viva inserida depois nem
          sempre é anunciada por leitor de tela */}
      <span role="status" style={{ color: MUTED }}>
        {mutation.isSuccess && !mutation.isPending ? "Obrigado pela avaliação!" : ""}
      </span>
      {mutation.isError && (
        <span role="alert" className="text-destructive">
          Não foi possível salvar sua avaliação. Tente de novo.
        </span>
      )}
    </div>
  )
}

// Linha do tempo de 3 passos (Aberto → Em atendimento → Atendido): a pessoa vê de relance em que pé
// está o chamado, sem precisar ler. "Pendente" fica no passo 2, marcado como espera.
function Andamento({ status, cor: corSituacao }: { status: StatusKey; cor: string }) {
  const passo = status === "encerrado" ? 2 : status === "aberto" ? 0 : 1
  const espera = status === "pendente"
  const nomes = ["Aberto", "Em atendimento", "Atendido"]
  return (
    <ol className="m-0 mt-3 flex list-none items-start p-0" aria-label="Andamento do chamado">
      {nomes.map((nome, i) => {
        const feito = i < passo || (status === "encerrado" && i === 2)
        const atual = i === passo && status !== "encerrado"
        const cor = feito || atual ? corSituacao : LINE
        return (
          <li key={nome} className="relative flex min-w-0 flex-1 flex-col items-center text-center" aria-current={atual ? "step" : undefined}>
            {i > 0 && <span aria-hidden="true" className="absolute top-[7px] right-1/2 h-0.5 w-full" style={{ background: i <= passo ? corSituacao : LINE }} />}
            <span
              aria-hidden="true"
              className="relative z-[1] h-4 w-4 rounded-full border-2 bg-white"
              style={{ borderColor: cor, background: feito ? cor : "#fff", boxShadow: atual ? `0 0 0 4px ${cor}33` : undefined }}
            />
            <span className="mt-1 text-[0.78rem] leading-tight" style={{ color: feito || atual ? INK : MUTED, fontWeight: atual ? 700 : 400 }}>
              {atual && espera ? "Em espera" : nome}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function faltam(ms: number): string {
  const min = Math.ceil(ms / 60_000)
  if (min < 1) return "menos de 1 min"
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}min` : `${h}h`
}

// Barra do prazo: quanto do tempo já passou (verde → âmbar → vermelho) e "faltam X". Fica viva: atualiza sozinha
// e pulsa quando falta pouco ou já passou. É a resposta visual pra "será que já vão me atender?".
function BarraPrazo({ task, statusKey }: { task: Task; statusKey: StatusKey }) {
  const agora = useAgora(15_000)
  if (statusKey === "encerrado" || statusKey === "pendente") return null
  const fim = Number(task.due_date)
  const ini = Number((statusKey === "em atendimento" && task.start_date) || task.date_created)
  if (!Number.isFinite(fim) || !Number.isFinite(ini) || fim <= ini) return null
  const pct = Math.max(0, Math.min(100, ((agora - ini) / (fim - ini)) * 100))
  const restante = fim - agora
  const atrasado = restante <= 0
  const urgente = !atrasado && restante <= 15 * 60_000
  const cor = atrasado ? "#C62828" : pct >= 70 ? "#D9650B" : "#16A34A"
  return (
    <div className="mt-3" role="group" aria-label="Tempo até o prazo">
      <div className="mb-1 flex items-baseline justify-between text-[0.85rem]">
        <span style={{ color: MUTED }}>{statusKey === "aberto" ? "Tempo até a TI aceitar" : "Tempo até a conclusão"}</span>
        <span className={`font-bold ${atrasado || urgente ? "alerta-pulso rounded px-1.5" : ""}`} style={{ color: cor }}>
          {atrasado ? "Prazo vencido" : `Faltam ${faltam(restante)}`}
        </span>
      </div>
      <div
        className="relative h-2.5 overflow-hidden rounded-full bg-black/10"
        aria-hidden="true"
      >
        <div className={`relative h-full overflow-hidden rounded-full transition-[width] duration-700 ease-out ${atrasado ? "" : "barra-brilho"}`} style={{ width: `${pct}%`, background: cor }} />
      </div>
    </div>
  )
}

// Cartão de acompanhamento (redesign 2026-11-10, mesma linguagem da fila do admin): faixa colorida da
// prioridade, frase de situação em português claro, andamento em 3 passos e prazo "até 15:20".
export function TicketCard({ task }: { task: Task }) {
  const { sessionToken } = useSessionAuth()
  const [anexoAberto, setAnexoAberto] = useState<Attachment | null>(null)
  // Quando a situação muda na hora (a TI aceitou, encerrou…), o cartão dá um "pulinho" pra chamar o olho.
  const situacaoAnterior = useRef(task.status?.status)
  const [mudou, setMudou] = useState(false)
  useEffect(() => {
    if (situacaoAnterior.current !== task.status?.status) {
      situacaoAnterior.current = task.status?.status
      setMudou(true)
      const id = setTimeout(() => setMudou(false), 1300)
      return () => clearTimeout(id)
    }
  }, [task.status?.status])

  // Porta loadAttachments()/attachmentsCache de app.js — a listagem de /my-tasks não
  // devolve anexo, só o GET de uma task individual. Keyed por date_updated: o próprio
  // TanStack Query já vira o cache "por versão da task" que antes era um Map manual.
  const anexosQuery = useQuery({
    queryKey: ["task-attachments", task.id, task.date_updated],
    queryFn: () => fetchTaskDetail(sessionToken, task.id).then((t) => t.attachments ?? []),
    staleTime: Infinity,
  })
  const anexos = anexosQuery.data ?? []

  const statusKey = (task.status?.status as StatusKey) ?? "aberto"
  const prioId = String(task.priority?.priority ?? "").toLowerCase()
  // task.priority.priority vem do Worker como nome em inglês (urgent/high/normal) — achado de UX
  // 2026-10-16: comparar com o label em português nunca casava. PRIORITY_MAP é indexado por esse nome.
  const prioEntry = PRIORITY_MAP[prioId]
  const overdue = isOverdue(task)
  const oText = overdueFor(task)

  const tipoIdx = Number(getCF(task, TIPO_FIELD_ID))
  const setorIdx = Number(getCF(task, SETOR_FIELD_ID))
  const tipoName = TIPOS.find((t) => t.orderindex === tipoIdx)?.name ?? optionName(TIPOS, tipoIdx)
  const setorName = optionName(SETORES, setorIdx)
  const solucao = statusKey === "encerrado" ? (getCF(task, SOLUCAO_FIELD_ID) as string | null) : null

  const desc = (task.text_content || task.description || "").trim()
  const atendente = (task.assignees ?? []).map((a) => a.username || OPERADORES[String(a.id)] || `#${a.id}`).join(", ")
  const due = Number(task.due_date)
  const temPrazo = Number.isFinite(due) && due > 0

  const situacao =
    statusKey === "aberto"
      ? { texto: atendente ? `Aguardando ${atendente} aceitar` : "Aguardando a TI aceitar", cor: NORMAL, fundo: "#E7F1FB" }
      : statusKey === "em atendimento"
        ? { texto: atendente ? `${atendente} está atendendo` : "Em atendimento", cor: "#5B4FD6", fundo: "#EBE8FD" }
        : statusKey === "pendente"
          ? { texto: "Em espera", cor: AMBAR, fundo: "#FFF1DC" }
          : { texto: "Atendido", cor: OK, fundo: "#E6F5EC" }

  const linhaPrazo =
    statusKey === "aberto" && temPrazo && !overdue
      ? `A TI deve aceitar ${ateQuando(due)}`
      : statusKey === "em atendimento" && temPrazo && !overdue
        ? `Conclusão prevista ${ateQuando(due)}`
        : statusKey === "pendente"
          ? "O prazo fica pausado enquanto o chamado está em espera"
          : statusKey === "encerrado" && task.date_closed
            ? `Atendido em ${fmtDate(task.date_closed)}`
            : null

  return (
    <div
      data-task-id={task.id}
      className={`relative flex overflow-hidden rounded-lg border shadow-[0_2px_6px_rgba(10,61,98,0.10)] transition-shadow duration-150 hover:shadow-[0_5px_16px_rgba(10,61,98,0.18)] ${mudou ? "mudou-situacao" : ""}`}
      style={{ borderColor: overdue ? "#e7a7a7" : `${situacao.cor}44`, background: situacao.fundo, color: INK }}
    >
      <span className="w-[7px] shrink-0" style={{ background: statusKey === "encerrado" ? LINE : COR_PRIO[prioId] ?? NORMAL }} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-4">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.9rem] font-bold text-white" style={{ background: situacao.cor }}>
            <span className="h-2 w-2 rounded-full bg-white/90" aria-hidden="true" />
            {situacao.texto}
          </span>
          <span className="text-[0.8rem]" style={{ color: MUTED }}>Atualizado {timeAgo(task.date_updated ?? task.date_created)}</span>
        </div>

        {overdue && (
          <div className="alerta-pulso mb-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-sm font-medium text-destructive">⚠ {oText}</div>
        )}

        {/* break-words — achado 2026-08-17: título/descrição são texto livre do próprio solicitante,
            sem isso uma string comprida sem espaço estourava a largura do card. */}
        <p className="m-0 text-[1.05rem] leading-snug font-bold break-words">{task.name || "(sem título)"}</p>
        {desc && <p className="mt-1 mb-0 text-[0.92rem] break-words" style={{ color: MUTED }}>{desc}</p>}

        <Andamento status={statusKey} cor={situacao.cor} />
        <BarraPrazo task={task} statusKey={statusKey} />
        {linhaPrazo && <p className="m-0 mt-2.5 text-center text-[0.9rem] font-medium" style={{ color: statusKey === "pendente" ? AMBAR : INK }}>{linhaPrazo}</p>}

        <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-0.5 border-t pt-2.5 text-[0.84rem]" style={{ borderColor: `${situacao.cor}33`, color: MUTED }}>
          <span>{tipoName}</span>
          <span>{setorName}</span>
          {prioEntry && <span style={{ color: prioEntry.color, fontWeight: 700 }}>{prioEntry.label}</span>}
          {atendente && <span>Atendente: {atendente}</span>}
          <span>Aberto em {fmtDate(task.date_created)}</span>
        </div>

        {anexos.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {anexos.map((a, i) => (
              <button
                key={`${a.url}-${i}`}
                type="button"
                onClick={() => setAnexoAberto(a)}
                title={a.title || a.name || "arquivo"}
                className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[#E8F0F6]"
                style={{ borderColor: LINE }}
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="min-w-0 truncate">{a.title || a.name || "arquivo"}</span>
              </button>
            ))}
          </div>
        )}

        {solucao && (
          <div className="mt-3 rounded-md border border-[#1E7F52]/30 bg-[#1E7F52]/10 p-2.5 text-sm">
            <p className="m-0 mb-0.5 text-xs font-bold" style={{ color: OK }}>Solução aplicada</p>
            {/* break-words — solução também é texto livre (escrito pela TI, sem limite de tamanho). */}
            <p className="m-0 break-words">{solucao}</p>
          </div>
        )}

        {statusKey === "encerrado" && <NotaChamado task={task} />}

        <a
          href={waLinkForTask(task)}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-[#16A34A] px-4 text-[1rem] font-bold text-white shadow-sm transition-colors hover:bg-[#15803D] active:translate-y-px focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#15803D]"
        >
          <MessageCircle className="h-5 w-5" /> Falar no WhatsApp
        </a>

        <AnexoModal anexo={anexoAberto} sessionToken={sessionToken} onClose={() => setAnexoAberto(null)} />
      </div>
    </div>
  )
}
