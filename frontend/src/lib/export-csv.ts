import { getCF, type Task } from "@/lib/api"
import { OPERADORES, PRIORITY_MAP, SETORES, SETOR_FIELD_ID, SOLUCAO_FIELD_ID, STATUS_MAP, TIPOS, TIPO_FIELD_ID, optionName, type StatusKey } from "@/lib/constants"

// Exportação CSV da Gestão (2026-10-16) — exporta exatamente o conjunto que está na tela
// (filtros + busca já aplicados), 100% no cliente, sem endpoint novo. Mesmas proteções
// da versão antiga do painel (admin.js):
//  - BOM UTF-8, pro Excel abrir os acentos certo;
//  - separador ";" (o Excel em pt-BR espera ponto-e-vírgula, vírgula abre tudo numa coluna);
//  - "formula injection": título/descrição/solução são texto livre de qualquer solicitante,
//    então uma célula começando com = + - @ (ou tab/CR) ganha um ' na frente — sem isso,
//    um título como =HYPERLINK(...) viraria fórmula executável ao abrir no Excel.
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value)
  if (FORMULA_START.test(s)) s = "'" + s
  return `"${s.replace(/"/g, '""')}"`
}

function fullDate(value: string | number | null | undefined): string {
  if (!value) return ""
  const d = new Date(Number(value))
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
}

const HEADER = ["Título", "Status", "Prioridade", "Tipo", "Setor", "Solicitante", "Operador", "Criado em", "Data inicial", "Prazo", "Encerrado em", "Nota", "Solução"]

export function tasksToCsv(tasks: Task[]): string {
  const rows = tasks.map((t) => {
    const status = STATUS_MAP[(t.status?.status as StatusKey) ?? "aberto"]?.label ?? t.status?.status ?? ""
    const prio = PRIORITY_MAP[String(t.priority?.priority ?? "").toLowerCase()]?.label ?? t.priority?.priority ?? ""
    const operadores = (t.assignees ?? []).map((a) => OPERADORES[String(a.id)] ?? `#${a.id}`).join(", ")
    return [
      t.name,
      status,
      prio,
      optionName(TIPOS, getCF(t, TIPO_FIELD_ID) as number | null),
      optionName(SETORES, getCF(t, SETOR_FIELD_ID) as number | null),
      t.solicitante ?? "",
      operadores,
      fullDate(t.date_created),
      fullDate(t.start_date),
      fullDate(t.due_date),
      fullDate(t.date_closed),
      t.nota ?? "",
      getCF(t, SOLUCAO_FIELD_ID) ?? "",
    ].map(csvCell).join(";")
  })
  return "\uFEFF" + [HEADER.map(csvCell).join(";"), ...rows].join("\r\n")
}

export function downloadTasksCsv(tasks: Task[]) {
  const blob = new Blob([tasksToCsv(tasks)], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `chamados-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
