import { ADMIN_BASE, SOLICITANTE_FIELD_ID } from "@/lib/constants"

// Mesmo shape que /admin/tasks devolve hoje — passa a task da ClickUp praticamente
// direto (ver handleAdminListTasks em push-worker.js). Só os campos que o painel usa.
export type CustomField = { id: string; value: unknown }
export type Assignee = { id: number; username?: string | null }
export type Task = {
  id: string
  name: string
  description?: string | null
  text_content?: string | null
  status: { status: string }
  priority?: { priority: string } | null
  assignees?: Assignee[]
  due_date?: string | number | null
  date_created?: string | number | null
  date_closed?: string | number | null
  start_date?: string | number | null
  custom_fields?: CustomField[]
}

export type Filtros = {
  status?: string
  setor?: string
  tipo?: string
  operador?: string
  solicitante?: string
}

export class AdminApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

// Erro "de sessão" (403) — quem chama decide o que fazer (ex.: limpar o segredo salvo
// e voltar pro gate). Mesmo padrão de adminRequest()/postTaskUpdate() em admin.js.
export function isSessionError(err: unknown): err is AdminApiError {
  return err instanceof AdminApiError && err.status === 403
}

export async function adminRequest<T>(secret: string, path: string): Promise<T> {
  const res = await fetch(`${ADMIN_BASE}${path}`, { headers: { "X-Admin-Secret": secret } })
  if (res.status === 403) {
    throw new AdminApiError("Segredo de admin inválido ou expirado. Entre de novo.", 403)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string })
    throw new AdminApiError(data.error || `Erro HTTP ${res.status}`, res.status)
  }
  return res.json()
}

export async function validateSecret(secret: string): Promise<void> {
  await adminRequest(secret, "/users")
}

export async function fetchTasks(secret: string, filtros: Filtros): Promise<{ tasks: Task[]; total: number; truncated: boolean }> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filtros)) {
    if (v) params.set(k, v)
  }
  const qs = params.toString()
  return adminRequest(secret, `/tasks${qs ? `?${qs}` : ""}`)
}

export type UpdatePayload = { status?: string; solucao?: string; assigneeId?: number | null }

export async function postTaskUpdate(secret: string, taskId: string, body: UpdatePayload): Promise<Task> {
  const res = await fetch(`${ADMIN_BASE}/tasks/${taskId}`, {
    method: "POST",
    headers: { "X-Admin-Secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.status === 403) {
    throw new AdminApiError("Segredo de admin inválido ou expirado. Entre de novo.", 403)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string })
    throw new AdminApiError(data.error || `Erro HTTP ${res.status}`, res.status)
  }
  return res.json()
}

// Valor "puro" de um custom field — mesma lógica de getCF() em admin.js.
export function getCF(task: Task, fieldId: string): number | string | null {
  const f = task.custom_fields?.find((cf) => cf.id === fieldId)
  if (!f || f.value === undefined || f.value === null) return null
  if (typeof f.value === "object" && f.value !== null && "orderindex" in (f.value as object)) {
    return (f.value as { orderindex: number }).orderindex
  }
  return f.value as number | string
}

// Lista de solicitantes (nome -> orderindex e vice-versa), buscada em runtime do campo
// customizado da ClickUp — mesmo endpoint que o app principal já usa (GET /api/field),
// autenticado com o APP_SHARED_SECRET público (não o ADMIN_SECRET).
const APP_SHARED_SECRET = "isv-chamados-2k26-9fQ3vM7xZp"

export async function fetchSolicitanteMaps(): Promise<{ idxToName: Record<number, string>; names: string[] }> {
  const res = await fetch(`${ADMIN_BASE.replace("/admin", "/api")}/field`, {
    headers: { "X-App-Secret": APP_SHARED_SECRET },
  })
  if (!res.ok) throw new AdminApiError(`Erro HTTP ${res.status} ao buscar solicitantes`, res.status)
  const data = await res.json()
  const field = data.fields?.find((f: { id: string }) => f.id === SOLICITANTE_FIELD_ID)
  const options: { name: string; orderindex: number }[] = field?.type_config?.options ?? []
  const idxToName: Record<number, string> = {}
  for (const o of options) idxToName[o.orderindex] = o.name
  const names = options.map((o) => o.name).sort((a, b) => a.localeCompare(b, "pt-BR"))
  return { idxToName, names }
}

export function isAtrasado(task: Task): boolean {
  if (!task.due_date) return false
  const status = (task.status?.status || "").toLowerCase()
  const dueDate = Number(task.due_date)
  const referencia = status === "encerrado" && task.date_closed ? Number(task.date_closed) : Date.now()
  return referencia > dueDate
}

export function fmtDate(value: string | number | null | undefined): string {
  if (!value) return "—"
  const d = new Date(Number(value))
  return (
    d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) +
    " " +
    d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
  )
}

// Mesma formatação de fmtMs() em admin.js — min/h/dia, o mais grosso que couber.
export function fmtMs(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  if (h < 24) return rm > 0 ? `${h}h ${rm}min` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`
}

// Mesmo shape que /admin/metrics já devolve — ver handleAdminMetrics em push-worker.js.
export type OperadorTempo = { nome: string | null; mediaMs: number; totalChamados: number }
export type Metrics = {
  total: number
  truncated: boolean
  porStatus: Record<string, number>
  porTipo: Record<string, number>
  porSetor: Record<string, number>
  sla: { dentroDoSla: number; atrasado: number; dentroDoSlaPercent: number | null; atrasadoPercent: number | null }
  tempoMedioPorOperador: Record<string, OperadorTempo>
}

export async function fetchMetrics(secret: string): Promise<Metrics> {
  return adminRequest(secret, "/metrics")
}
