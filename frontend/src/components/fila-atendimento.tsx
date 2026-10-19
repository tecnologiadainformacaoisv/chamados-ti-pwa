import { useState } from "react"
import { SETORES, SETOR_FIELD_ID, TIPOS, TIPO_FIELD_ID, SOLUCAO_FIELD_ID, OPERADORES, PRIORITY_MAP, optionName } from "@/lib/constants"
import { getCF, isAtrasado, venceLogo, fmtDate, fmtMs, type Task } from "@/lib/api"
import { COR_PRIO, FONTE, INK, LINE, MUTED, NAVY, NORMAL, URGENT } from "@/lib/mvp-visual"

// Fila de atendimento (pedido do usuário, 2026-10-19: "gostaria deste tipo de lista", do protótipo):
// uma linha por chamado, faixa colorida da prioridade, título, quem/setor/tipo, atendente, prazo em
// linguagem de gente e UM botão com a próxima ação (Aceitar / Encerrar / Retomar). Clicar na linha abre o
// resumo; "Gerenciar" abre o modal completo. A ordem vem pronta de `compararUrgencia` (gestao-view).
const ENCERRADOS_VISIVEIS = 50
const HORA = { hour: "2-digit", minute: "2-digit" } as const

function atendenteDe(t: Task): string {
  const a = t.assignees?.[0]
  if (!a) return "Sem atendente"
  return OPERADORES[String(a.id)] || a.username || `#${a.id}`
}

// "até 11:22", "até amanhã 08:50" ou "até 22/10 08:50": o prazo como a pessoa fala, não como o banco guarda.
function ateQuando(due: number): string {
  const d = new Date(due)
  const hoje = new Date()
  const amanha = new Date(hoje)
  amanha.setDate(hoje.getDate() + 1)
  const hora = d.toLocaleTimeString("pt-BR", HORA)
  if (d.toDateString() === hoje.toDateString()) return `até ${hora}`
  if (d.toDateString() === amanha.toDateString()) return `até amanhã ${hora}`
  return `até ${fmtDate(due)}`
}

function quando(t: Task): { texto: string; cor: string; peso: number } {
  const st = (t.status?.status || "").toLowerCase()
  if (st === "encerrado") return { texto: `encerrado ${fmtDate(t.date_closed)}`, cor: MUTED, peso: 500 }
  if (st === "pendente") return { texto: "em espera, prazo pausado", cor: MUTED, peso: 500 }
  if (!t.due_date || !Number.isFinite(Number(t.due_date))) return { texto: "sem prazo definido", cor: MUTED, peso: 500 }
  const due = Number(t.due_date)
  if (isAtrasado(t)) return { texto: `atrasado ${fmtMs(Date.now() - due) ?? "agora"}`, cor: URGENT, peso: 700 }
  if (venceLogo(t, 15)) return { texto: `vence em ${Math.max(1, Math.round((due - Date.now()) / 60_000))} min`, cor: "#9A5A00", peso: 700 }
  return { texto: ateQuando(due), cor: INK, peso: 700 }
}

export function FilaAtendimento({
  tasks,
  focoId,
  onFoco,
  onGerenciar,
  onAceitar,
  onEncerrar,
  onRetomar,
}: {
  tasks: Task[]
  focoId: string | null
  onFoco: (id: string) => void
  onGerenciar: (task: Task) => void
  onAceitar: (task: Task) => void
  onEncerrar: (task: Task) => void
  onRetomar: (task: Task) => void
}) {
  const [mostrarEncerrados, setMostrarEncerrados] = useState(false)
  const [aberto, setAberto] = useState<string | null>(null)

  const visiveis = tasks.filter((t) => mostrarEncerrados || (t.status?.status || "").toLowerCase() !== "encerrado")
  const lista = visiveis.slice(0, ENCERRADOS_VISIVEIS * 4)

  return (
    <section style={{ fontFamily: FONTE, color: INK }} aria-label="Fila de atendimento">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[1.2rem] font-bold">Fila de atendimento</h2>
        <label className="flex items-center gap-1.5 text-[0.92rem]" style={{ color: MUTED }}>
          <input type="checkbox" checked={mostrarEncerrados} onChange={(e) => setMostrarEncerrados(e.target.checked)} style={{ accentColor: NAVY }} />
          mostrar encerrados
        </label>
      </div>

      {lista.length === 0 ? (
        <div className="rounded-md border bg-white px-4 py-8 text-center" style={{ borderColor: LINE, color: MUTED }}>
          <b className="mb-1 block text-[1.05rem]" style={{ color: INK }}>Fila vazia.</b>
          Quando alguém abrir um chamado, ele aparece aqui.
        </div>
      ) : (
        <ol className="m-0 list-none overflow-hidden rounded-md border bg-white p-0" style={{ borderColor: LINE }}>
          {lista.map((t) => {
            const st = (t.status?.status || "").toLowerCase()
            const prio = String(t.priority?.priority ?? "").toLowerCase()
            const cor = st === "encerrado" ? LINE : COR_PRIO[prio] ?? NORMAL
            const w = quando(t)
            const setor = optionName(SETORES, Number(getCF(t, SETOR_FIELD_ID)))
            const tipo = TIPOS.find((x) => x.orderindex === Number(getCF(t, TIPO_FIELD_ID)))?.name ?? ""
            const prioLabel = PRIORITY_MAP[prio]?.label ?? ""
            const foco = focoId === t.id
            const expandido = aberto === t.id
            const solucao = String(getCF(t, SOLUCAO_FIELD_ID) ?? "").trim()
            const descricao = (t.text_content || t.description || "").toString().trim()
            const acao =
              st === "aberto"
                ? { rotulo: "Aceitar", fn: onAceitar, cheio: true }
                : st === "em atendimento"
                  ? { rotulo: "Encerrar", fn: onEncerrar, cheio: false }
                  : st === "pendente"
                    ? { rotulo: "Retomar", fn: onRetomar, cheio: false }
                    : null
            return (
              <li
                key={t.id}
                data-task-id={t.id}
                aria-current={foco ? "true" : undefined}
                onClick={() => {
                  onFoco(t.id)
                  setAberto((a) => (a === t.id ? null : t.id))
                }}
                className="grid cursor-pointer grid-cols-[7px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b py-2.5 pr-3 last:border-b-0 md:grid-cols-[7px_minmax(0,1fr)_auto]"
                style={{
                  borderColor: LINE,
                  background: foco ? "#F6FAFD" : "#fff",
                  outline: foco ? `3px solid ${NAVY}` : undefined,
                  outlineOffset: foco ? -3 : undefined,
                }}
              >
                <span className="self-stretch" style={{ background: cor }} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="m-0 truncate font-bold" title={t.name}>{t.name || "(sem título)"}</p>
                  <p className="m-0 flex flex-wrap gap-x-3.5 text-[0.86rem]" style={{ color: MUTED }}>
                    <span>{t.solicitante || "—"}</span>
                    {setor && <span>{setor}</span>}
                    {tipo && <span>{tipo}</span>}
                    {prioLabel && <span>{prioLabel}</span>}
                  </p>
                </div>
                <div className="col-start-2 flex flex-wrap items-center justify-end gap-3 md:col-start-3">
                  <span className="rounded-full border px-2.5 py-0.5 text-[0.88rem] font-bold" style={{ borderColor: LINE, background: "#F4F7F9" }} title="Atendente">
                    {atendenteDe(t)}
                  </span>
                  <span className="text-[0.9rem] whitespace-nowrap" style={{ color: w.cor, fontWeight: w.peso }}>{w.texto}</span>
                  {acao ? (
                    <button
                      type="button"
                      aria-label={`${acao.rotulo}: ${t.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        acao.fn(t)
                      }}
                      className="min-h-9 rounded-[5px] border px-3.5 py-1.5 font-bold"
                      style={{ borderColor: NAVY, background: acao.cheio ? NAVY : "#fff", color: acao.cheio ? "#fff" : NAVY }}
                    >
                      {acao.rotulo}
                    </button>
                  ) : (
                    <span className="inline-block w-[1px]" />
                  )}
                </div>
                {expandido && (
                  <div className="col-span-2 grid cursor-default gap-2.5 pt-1 pb-3 pl-0 md:col-span-3" style={{ paddingLeft: 19 }} onClick={(e) => e.stopPropagation()}>
                    <p className="m-0 max-w-[70ch] break-words">{descricao || "(sem descrição)"}</p>
                    {solucao && (
                      <p className="m-0 max-w-[70ch] break-words">
                        <b>Solução:</b> {solucao}
                      </p>
                    )}
                    <p className="m-0 text-[0.88rem]" style={{ color: MUTED }}>
                      Aberto às {new Date(Number(t.date_created)).toLocaleTimeString("pt-BR", HORA)} em {new Date(Number(t.date_created)).toLocaleDateString("pt-BR")} para {atendenteDe(t)}
                    </p>
                    <div>
                      <button
                        type="button"
                        onClick={() => onGerenciar(t)}
                        className="min-h-9 rounded-[5px] border px-3.5 py-1.5 font-bold"
                        style={{ borderColor: NAVY, background: "#fff", color: NAVY }}
                      >
                        Gerenciar
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
