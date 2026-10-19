import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { OPERADORES } from "@/lib/constants"
import { fmtDate, isAtrasado, type Task } from "@/lib/api"
import { COR_PRIO, FONTE, INK, LINE, MUTED, NORMAL, URGENT } from "@/lib/mvp-visual"

// Linha do dia (Fase 2 do redesign de UX, 2026-10-19; protótipo aprovado pelo usuário).
// Cada chamado em andamento vira uma barra do início (ou da abertura) até o prazo, numa faixa por
// atendente, com o "agora" em vermelho: dá pra ver de relance onde aperta e quanto cada um tem pela frente.
// Só usa dados que já existem (start_date/date_created, due_date, assignees): nada novo no servidor.
// O visual copia o protótipo (_ux-design/prototipos/chamados-mvp/index.html): mesmas cores, tamanhos e fonte.
const H0 = 8 // expediente: 08h às 18h (hora local do navegador)
const H1 = 18
const SPAN_MS = (H1 - H0) * 3_600_000
const MIN_W = 3.2 // largura mínima da barra, em % (igual ao protótipo)

function useAgora(ms = 30_000) {
  const [agora, setAgora] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return agora
}

type Barra = { task: Task; left: number; width: number; row: number; cutDir: boolean; semPrazo: boolean; antesDeHoje: boolean; atrasado: boolean }

export function LinhaDoDia({
  tasks,
  onOpenTask,
  focoId,
}: {
  tasks: Task[]
  onOpenTask: (task: Task) => void
  focoId: string | null
}) {
  const agora = useAgora()
  const [aberta, setAberta] = useState(() => {
    try {
      const v = localStorage.getItem("admin_linha_dia")
      if (v) return v === "1"
    } catch { /* sem localStorage: usa o padrão */ }
    return window.innerWidth >= 768 // no celular começa recolhida (a régua rola na horizontal)
  })
  function alternar() {
    setAberta((a) => {
      const n = !a
      try { localStorage.setItem("admin_linha_dia", n ? "1" : "0") } catch { /* idem */ }
      return n
    })
  }

  const hoje = new Date(agora)
  hoje.setHours(H0, 0, 0, 0)
  const d0 = hoje.getTime()
  const d1 = d0 + SPAN_MS
  const pct = (ms: number) => ((ms - d0) / SPAN_MS) * 100

  const ativos = tasks.filter((t) => {
    const s = (t.status?.status || "").toLowerCase()
    return s === "aberto" || s === "em atendimento"
  })
  const prazoOk = (t: Task) => !!t.due_date && Number.isFinite(Number(t.due_date))
  const inicioDe = (t: Task) => {
    const n = Number(t.start_date || t.date_created)
    return Number.isFinite(n) ? n : prazoOk(t) ? Number(t.due_date) : agora
  }
  const atrasados = ativos.filter((t) => isAtrasado(t)).length

  const lanes: { id: string; nome: string }[] = Object.entries(OPERADORES).map(([id, nome]) => ({ id, nome }))
  if (ativos.some((t) => !OPERADORES[String(t.assignees?.[0]?.id ?? "")])) lanes.push({ id: "", nome: "Sem atendente" })

  function barrasDaFaixa(id: string): { barras: Barra[]; linhas: number } {
    const itens = ativos
      .filter((t) => {
        const a = String(t.assignees?.[0]?.id ?? "")
        return id === "" ? !OPERADORES[a] : a === id
      })
      .sort((a, b) => inicioDe(a) - inicioDe(b))
    const fimDasLinhas: number[] = []
    const barras: Barra[] = []
    for (const t of itens) {
      const ini = inicioDe(t)
      const sp = !prazoOk(t)
      const fim = sp ? Math.max(d1, ini) : Number(t.due_date) // sem prazo: vai até o fim da régua
      const antesDeHoje = fim < d0 // venceu antes do expediente de hoje: marcador na borda esquerda
      let left = antesDeHoje ? 0 : pct(Math.max(ini, d0))
      let width = antesDeHoje ? MIN_W : pct(Math.min(fim, d1)) - left
      width = Math.max(width, MIN_W)
      left = ini >= d1 ? 100 - width : Math.min(left, 100 - width) // começa depois do expediente: fica na borda direita
      let row = fimDasLinhas.findIndex((fim2) => fim2 <= left)
      if (row < 0) {
        row = fimDasLinhas.length
        fimDasLinhas.push(0)
      }
      fimDasLinhas[row] = left + width + 0.8
      barras.push({ task: t, left, width, row, cutDir: fim > d1, semPrazo: sp, antesDeHoje, atrasado: isAtrasado(t) })
    }
    return { barras, linhas: Math.max(1, fimDasLinhas.length) }
  }

  const dentroDoExpediente = agora >= d0 && agora <= d1
  const p = (agora - d0) / SPAN_MS
  const horas = Array.from({ length: H1 - H0 + 1 }, (_, i) => H0 + i)

  return (
    <section className="rounded-md border bg-white p-4" style={{ fontFamily: FONTE, color: INK, borderColor: LINE }} aria-label="Linha do dia">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3.5 gap-y-1.5">
        <button
          type="button"
          onClick={alternar}
          aria-expanded={aberta}
          className="flex items-baseline gap-2 text-left"
          title={aberta ? "Recolher a linha do dia" : "Mostrar a linha do dia"}
        >
          {aberta ? <ChevronDown className="h-4 w-4 self-center" aria-hidden /> : <ChevronRight className="h-4 w-4 self-center" aria-hidden />}
          <h2 className="m-0 text-[1.2rem] font-bold">Linha do dia</h2>
          <span className="text-[0.85rem]" style={{ color: MUTED }}>
            {ativos.length} em andamento{atrasados > 0 ? `, ${atrasados} atrasado${atrasados > 1 ? "s" : ""}` : ""}
          </span>
        </button>
        {aberta && (
          <div className="flex flex-wrap gap-4 text-[0.85rem]" style={{ color: MUTED }} aria-label="Legenda">
            <span><i className="mr-1.5 inline-block h-[11px] w-6 rounded-[3px] border-2 align-[-1px]" style={{ borderColor: NORMAL, background: "#e3eef8" }} />aguardando a TI</span>
            <span><i className="mr-1.5 inline-block h-[11px] w-6 rounded-[3px] border-2 align-[-1px]" style={{ borderColor: NORMAL, background: NORMAL }} />em atendimento</span>
            <span><i className="mr-1.5 inline-block h-[11px] w-6 rounded-[3px] border-2 align-[-1px]" style={{ borderColor: URGENT, background: "repeating-linear-gradient(135deg,#fff 0 4px,#f2b8b8 4px 8px)" }} />passou do prazo</span>
          </div>
        )}
      </div>

      {aberta && (
        <>
          {ativos.length === 0 ? (
            <p className="mt-3.5 py-6 text-center text-[0.88rem]" style={{ color: MUTED }}>Nenhum chamado em andamento.</p>
          ) : (
            <div className="relative mt-3.5 overflow-x-auto">
              <div className="relative min-w-[780px]">
                <div className="grid grid-cols-[96px_1fr]">
                  <div className="sticky left-0 z-[3] bg-white" />
                  <div className="relative h-[22px] text-[0.78rem]" style={{ color: MUTED }} aria-hidden="true">
                    {horas.map((h, i) => (
                      <span key={h} className="absolute top-0" style={{ left: `${(i / (H1 - H0)) * 100}%`, transform: i === 0 ? "none" : i === horas.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>
                        {String(h).padStart(2, "0")}h
                      </span>
                    ))}
                  </div>
                </div>

                {lanes.map((lane) => {
                  const { barras, linhas } = barrasDaFaixa(lane.id)
                  return (
                    <div key={lane.id || "sem"} className="grid grid-cols-[96px_1fr] border-t" style={{ borderColor: LINE }}>
                      <div className="sticky left-0 z-[3] bg-white pt-2.5 pr-2 text-[0.95rem] font-bold">
                        {lane.nome}
                        <small className="block text-[0.8rem] font-normal" style={{ color: MUTED }}>{barras.length} em aberto</small>
                      </div>
                      <div
                        className="relative"
                        style={{
                          height: linhas * 32 + 16,
                          backgroundImage: `linear-gradient(to right,${LINE} 1px,transparent 1px)`,
                          backgroundSize: `${100 / (H1 - H0)}% 100%`,
                        }}
                      >
                        {barras.length === 0 && <span className="absolute top-3 left-2.5 text-[0.88rem]" style={{ color: MUTED }}>Nada na fila agora.</span>}
                        {barras.map((b) => {
                          const cor = COR_PRIO[String(b.task.priority?.priority ?? "").toLowerCase()] ?? NORMAL
                          const emAtendimento = (b.task.status?.status || "").toLowerCase() === "em atendimento"
                          const estado = b.atrasado ? "atrasado" : emAtendimento ? "em atendimento" : "aguardando"
                          const foco = focoId === b.task.id
                          const prazoTxt = b.semPrazo ? "sem prazo definido" : "prazo " + fmtDate(b.task.due_date)
                          return (
                            <button
                              key={b.task.id}
                              type="button"
                              data-barra-id={b.task.id}
                              data-atrasado={b.atrasado ? "sim" : "nao"}
                              onClick={() => onOpenTask(b.task)}
                              title={`${b.task.name || "(sem título)"} — ${estado}, ${prazoTxt}`}
                              aria-label={`${b.task.name || "Chamado sem título"}, ${estado}, ${prazoTxt}. Abrir`}
                              className={`absolute h-[26px] min-w-[56px] overflow-hidden rounded-[4px] border-2 px-[7px] text-left text-[0.78rem] text-ellipsis whitespace-nowrap ${b.semPrazo ? "border-dashed" : ""} ${foco ? "z-[3] outline outline-[3px] outline-offset-1 outline-[#0A3D62]" : "z-[2]"}`}
                              style={{
                                left: `${b.left}%`,
                                width: `${Math.min(b.width, 100 - b.left)}%`,
                                top: 8 + b.row * 32,
                                borderColor: b.atrasado ? URGENT : cor,
                                color: b.atrasado ? "#7a1212" : emAtendimento ? "#fff" : INK,
                                fontWeight: b.atrasado ? 700 : 400,
                                background: b.atrasado
                                  ? "repeating-linear-gradient(135deg,#fff 0 6px,#f6c9c9 6px 12px)"
                                  : emAtendimento
                                    ? cor
                                    : `color-mix(in srgb, ${cor} 14%, #fff)`,
                                clipPath: b.cutDir ? "polygon(0 0,calc(100% - 10px) 0,100% 50%,calc(100% - 10px) 100%,0 100%)" : undefined,
                                paddingRight: b.cutDir ? 16 : undefined,
                                borderRightWidth: b.cutDir ? 0 : undefined,
                              }}
                            >
                              {b.antesDeHoje ? `${fmtDate(b.task.due_date).slice(0, 5)} ` : ""}
                              {b.semPrazo ? "sem prazo · " : ""}
                              {b.task.name || "(sem título)"}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}

                {dentroDoExpediente && (
                  <div
                    data-testid="agora"
                    className="pointer-events-none absolute top-0 bottom-0 z-[1] w-0.5"
                    style={{ left: `calc(96px + (100% - 96px) * ${p})`, background: URGENT }}
                    aria-hidden="true"
                  >
                    <span className="absolute -top-px left-1 rounded-[3px] px-[5px] text-[0.72rem] font-bold text-white" style={{ background: URGENT }}>
                      {new Date(agora).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
          {!dentroDoExpediente && ativos.length > 0 && (
            <p className="mt-2 text-[0.85rem]" style={{ color: MUTED }}>Fora do expediente (08h às 18h): a linha do “agora” fica escondida.</p>
          )}
        </>
      )}
    </section>
  )
}
