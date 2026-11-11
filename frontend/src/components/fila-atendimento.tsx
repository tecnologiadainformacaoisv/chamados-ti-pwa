import { useState } from "react"
import { SETORES, SETOR_FIELD_ID, TIPOS, TIPO_FIELD_ID, SOLUCAO_FIELD_ID, OPERADORES, PRIORITY_MAP, optionName } from "@/lib/constants"
import { getCF, isAtrasado, venceLogo, fmtDate, fmtMs, type Task } from "@/lib/api"
import { ateQuando, numeroChamado } from "@/lib/ticket-helpers"
import { useAgora } from "@/hooks/use-agora"
import { COR_PRIO, FONTE, INK, LINE, MUTED, NAVY, NORMAL, URGENT } from "@/lib/mvp-visual"

// Fila de atendimento (pedido do usuário, 2026-10-19: "gostaria deste tipo de lista", do protótipo):
// uma linha por chamado, faixa colorida da prioridade, título, quem/setor/tipo, atendente, prazo em
// linguagem de gente e UM botão com a próxima ação (Aceitar / Encerrar / Retomar). Clicar na linha abre o
// resumo; "Gerenciar" abre o modal completo. A ordem vem pronta de `compararUrgencia` (gestao-view).
const LIMITE_LINHAS = 200 // teto de linhas na tela (a busca/filtros ajudam a achar o resto)
// botão da fila: mão ao passar o mouse, cor que muda, leve "afundar" ao apertar e anel de foco do teclado
const BTN =
  "min-h-9 cursor-pointer rounded-[5px] border px-3.5 py-1.5 font-bold transition-colors duration-100 active:translate-y-px active:brightness-95 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0A3D62]"
const HORA = { timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" } as const

function atendenteDe(t: Task): string {
  const a = t.assignees?.[0]
  if (!a) return "Sem atendente"
  return OPERADORES[String(a.id)] || a.username || `#${a.id}`
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
  useAgora(30_000) // refaz os textos de prazo ("atrasado 5min", "vence em 2 min") sem esperar o próximo poll

  const visiveis = tasks.filter((t) => mostrarEncerrados || (t.status?.status || "").toLowerCase() !== "encerrado")
  const lista = visiveis.slice(0, LIMITE_LINHAS)
  const cortadas = visiveis.length - lista.length

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
                className="grid cursor-pointer grid-cols-[7px_minmax(0,1fr)] hover:bg-[#F6FAFD] items-center gap-x-3 gap-y-1 border-b py-2.5 pr-3 last:border-b-0 md:grid-cols-[7px_minmax(0,1fr)_auto]"
                style={{
                  borderColor: LINE,
                  background: foco ? "#F6FAFD" : "#fff",
                  outline: foco ? `3px solid ${NAVY}` : undefined,
                  outlineOffset: foco ? -3 : undefined,
                }}
              >
                <span className="self-stretch" style={{ background: cor }} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="m-0 truncate font-bold" title={t.name}>
                    {numeroChamado(t) && <span className="mr-2 font-bold tabular-nums" style={{ color: MUTED }}>{numeroChamado(t)}</span>}
                    {/* botão de verdade: abre o resumo pelo teclado/leitor de tela (a linha toda continua clicável com o mouse) */}
                    <button type="button" aria-expanded={expandido} className="max-w-full cursor-pointer truncate text-left font-bold focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0A3D62]">
                      {t.name || "(sem título)"}
                    </button>
                  </p>
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
                      className={`${BTN} ${acao.cheio ? "bg-[#0A3D62] text-white hover:bg-[#0F5282]" : "bg-white text-[#0A3D62] hover:bg-[#E8F0F6]"}`}
                      style={{ borderColor: NAVY }}
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
                      {Number.isFinite(Number(t.date_created)) && Number(t.date_created) > 0
                        ? `Aberto às ${new Date(Number(t.date_created)).toLocaleTimeString("pt-BR", HORA)} em ${new Date(Number(t.date_created)).toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" })} para ${atendenteDe(t)}`
                        : `Atendente: ${atendenteDe(t)}`}
                    </p>
                    <div>
                      <button
                        type="button"
                        onClick={() => onGerenciar(t)}
                        className={`${BTN} bg-white text-[#0A3D62] hover:bg-[#E8F0F6]`}
                        style={{ borderColor: NAVY }}
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
      {cortadas > 0 && (
        <p className="mt-2 text-[0.88rem]" style={{ color: MUTED }} role="status">
          Mostrando {lista.length} de {visiveis.length} chamados. Use a busca ou os filtros para achar os demais.
        </p>
      )}
    </section>
  )
}
