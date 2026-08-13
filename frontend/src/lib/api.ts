import { ADMIN_BASE } from "@/lib/constants"

// Mesmo shape que /admin/tasks devolve hoje — passa a task da ClickUp praticamente
// direto (ver handleAdminListTasks em push-worker.js). Só os campos que o painel usa.
export type CustomField = { id: string; value: unknown }
export type Assignee = { id: number; username?: string | null }
export type Attachment = { url: string; title?: string | null; name?: string | null; extension?: string | null }
export type Task = {
  id: string
  name: string
  description?: string | null
  text_content?: string | null
  status: { status: string }
  priority?: { priority: string } | null
  assignees?: Assignee[]
  // Nome já resolvido (não orderindex) — só presente quando a task vem do D1 (achado de
  // produção 2026-08-12: GET /admin/tasks nunca devolvia isso via custom_fields, e
  // `Number(getCF(task, SOLICITANTE_FIELD_ID))` virava 0, mostrando o solicitante errado
  // no Kanban/Tabela do admin). Ler este campo direto, não mais via getCF/idxToName.
  solicitante?: string | null
  due_date?: string | number | null
  date_created?: string | number | null
  date_updated?: string | number | null
  date_closed?: string | number | null
  start_date?: string | number | null
  custom_fields?: CustomField[]
  // Só presente no GET de uma task individual (GET /tasks/:id) — a listagem não devolve.
  attachments?: Attachment[]
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

// Lista de solicitantes pro dropdown de filtro — mesmo endpoint público que o app dos
// solicitantes usa pro login (X-App-Secret, não o ADMIN_SECRET). Fase M1 (2026-08-13,
// migração de saída da ClickUp): passou a ler da tabela `solicitantes` do D1 (gerida
// pela TI numa tela própria no admin) em vez do campo customizado da ClickUp — não
// existe mais orderindex nenhum, `task.solicitante` (ver Task acima) já vem com o nome
// resolvido direto do servidor.
const APP_SHARED_SECRET = "isv-chamados-2k26-9fQ3vM7xZp"

export async function fetchSolicitanteNomes(): Promise<string[]> {
  const res = await fetch(`${ADMIN_BASE.replace("/admin", "/api")}/solicitantes`, {
    headers: { "X-App-Secret": APP_SHARED_SECRET },
  })
  if (!res.ok) throw new AdminApiError(`Erro HTTP ${res.status} ao buscar solicitantes`, res.status)
  const data = await res.json()
  return data.names ?? []
}

// Gestão de solicitantes (Fase M1, 2026-08-13) — tela nova "Usuários" no admin, pra TI
// adicionar/desativar quem pode logar no app, sem precisar mais editar isso na ClickUp.
export type AdminSolicitante = { name: string; ativo: number; created_at: number }

export async function fetchAdminSolicitantes(secret: string): Promise<{ solicitantes: AdminSolicitante[] }> {
  return adminRequest(secret, "/solicitantes")
}

async function adminMutate(secret: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${ADMIN_BASE}${path}`, {
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
}

export async function createSolicitante(secret: string, name: string): Promise<void> {
  await adminMutate(secret, "/solicitantes", { name })
}

export async function setSolicitanteAtivo(secret: string, name: string, ativo: boolean): Promise<void> {
  await adminMutate(secret, `/solicitantes/${encodeURIComponent(name)}/ativo`, { ativo })
}

// Alerta de chamado novo pro admin (2026-08-13) — sem login por pessoa no admin (só
// ADMIN_SECRET compartilhado), a inscrição de push é por NAVEGADOR/DISPOSITIVO: `id` é
// gerado no cliente (ver use-admin-push-notifications.tsx), não no servidor. Reenviar
// com o mesmo `id` sobrescreve (idempotente) — não precisa se preocupar em duplicar.
export async function subscribeAdminPush(secret: string, id: string, subscription: PushSubscriptionJSON): Promise<void> {
  await adminMutate(secret, "/subscribe", { id, subscription })
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
