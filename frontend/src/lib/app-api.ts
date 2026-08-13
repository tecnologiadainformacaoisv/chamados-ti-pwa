import { API_BASE, AUTH_BASE, APP_SHARED_SECRET } from "@/lib/constants"
import type { Task } from "@/lib/api"

export class AuthError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

// Porta authRequest()/login()/register()/logoutFromServer() de app.js. Primeiro acesso =
// cadastro: se /auth/login devolve 404 (sem senha cadastrada pra esse nome), tenta
// /auth/register com a mesma senha — sem tela de cadastro separada.
async function authRequest(path: string, body: unknown): Promise<{ token: string; name: string }> {
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    headers: { "X-App-Secret": APP_SHARED_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}) as { error?: string })
  if (!res.ok) throw new AuthError(data.error || `Erro HTTP ${res.status}`, res.status)
  return data as { token: string; name: string }
}

export async function loginOrRegister(name: string, password: string): Promise<{ token: string; name: string }> {
  try {
    return await authRequest("/login", { name, password })
  } catch (err) {
    if (err instanceof AuthError && err.status === 404) {
      return await authRequest("/register", { name, password })
    }
    throw err
  }
}

export async function logoutFromServer(sessionToken: string): Promise<void> {
  if (!sessionToken) return
  try {
    await fetch(`${AUTH_BASE}/logout`, { method: "POST", headers: { "X-Session-Token": sessionToken } })
  } catch {
    // se não conseguir avisar o servidor, tudo bem — a sessão vai expirar sozinha
  }
}

// Porta apiRequest() de app.js — 401 aqui significa sessão morta, quem chama decide
// (ver use-session-auth.tsx: desloga e volta pro login, igual ao reload da versão vanilla).
export async function apiRequest<T>(sessionToken: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "X-App-Secret": APP_SHARED_SECRET,
      "X-Session-Token": sessionToken,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    throw new AuthError("Sessão expirada, faça login novamente.", 401)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string; err?: string })
    throw new AuthError(data.err || data.error || `Erro HTTP ${res.status}`, res.status)
  }
  return res.json()
}

export function isAuthExpired(err: unknown): boolean {
  return err instanceof AuthError && err.status === 401
}

export async function fetchMyTasks(sessionToken: string): Promise<Task[]> {
  const data = await apiRequest<{ tasks: Task[] }>(sessionToken, "GET", "/my-tasks")
  return data.tasks ?? []
}

export type CreateTaskPayload = {
  name: string
  description?: string
  status: "aberto"
  priority: number
  due_date: number
  due_date_time: true
  assignees: number[]
  custom_fields: { id: string; value: number }[]
}

export async function createTask(sessionToken: string, payload: CreateTaskPayload): Promise<Task> {
  return apiRequest<Task>(sessionToken, "POST", "/tasks", payload)
}

// Porta uploadAttachment() de app.js — multipart, sem Content-Type manual (o browser
// define o boundary sozinho). Chamado depois de createTask, nunca antes (precisa do task.id).
export async function uploadAttachment(sessionToken: string, taskId: string, file: File): Promise<void> {
  const formData = new FormData()
  formData.append("attachment", file, file.name)
  const res = await fetch(`${API_BASE}/tasks/${taskId}/attachment`, {
    method: "POST",
    headers: { "X-App-Secret": APP_SHARED_SECRET, "X-Session-Token": sessionToken },
    body: formData,
  })
  if (res.status === 401) throw new AuthError("Sessão expirada, faça login novamente.", 401)
  if (!res.ok) throw new AuthError(`Erro HTTP ${res.status}`, res.status)
}

// GET /tasks/:id — só essa rota devolve `attachments` (a listagem de /my-tasks não).
export async function fetchTaskDetail(sessionToken: string, taskId: string): Promise<Task> {
  return apiRequest<Task>(sessionToken, "GET", `/tasks/${taskId}`)
}

// Lista de solicitantes — mesmo endpoint público (X-App-Secret) que o painel de admin
// usa pro filtro, aqui usado pro select de nome na tela de login/cadastro. Fase M1
// (2026-08-13, migração de saída da ClickUp): passou a ler de uma tabela própria no D1
// (`solicitantes`, gerida pela TI numa tela nova no admin) em vez do campo customizado
// da ClickUp — já vem ordenado do servidor, sem precisar reconstruir orderindex/nome.
export async function fetchSolicitanteNomes(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/solicitantes`, { headers: { "X-App-Secret": APP_SHARED_SECRET } })
  if (!res.ok) throw new Error(`Erro HTTP ${res.status} ao buscar solicitantes`)
  const data = await res.json()
  return data.names ?? []
}
