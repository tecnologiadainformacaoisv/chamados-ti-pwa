import { OPERADOR_WHATSAPP, STATUS_MAP, WA_NUMBER_PADRAO, type StatusKey } from "@/lib/constants"
import type { Task } from "@/lib/api"

// Porta isOverdue()/overdueFor()/timeAgo()/timeUntil()/slaProgressInfo()/waLink() de app.js.

export function isOverdue(task: Task): boolean {
  const status = task.status?.status
  if (status === "encerrado" || status === "pendente") return false
  if (!task.due_date) return false
  return Date.now() > Number(task.due_date)
}

export function overdueFor(task: Task): string {
  if (task.status?.status === "pendente" || !task.due_date) return ""
  const diff = Date.now() - Number(task.due_date)
  if (diff <= 0) return ""
  const h = Math.floor(diff / 3600000)
  if (h < 24) return `${h}h em atraso`
  return `${Math.floor(h / 24)}d em atraso`
}

export function timeAgo(ts: string | number | null | undefined): string {
  if (!ts) return "—"
  const d = Date.now() - Number(ts)
  const m = Math.floor(d / 60000)
  if (m < 1) return "agora"
  if (m < 60) return `${m}m atrás`
  const h = Math.floor(d / 3600000)
  if (h < 24) return `${h}h atrás`
  return `${Math.floor(h / 24)}d atrás`
}

export function timeUntil(ts: string | number | null | undefined): string | null {
  if (!ts) return null
  const diff = Number(ts) - Date.now()
  if (diff <= 0) return null
  const totalMin = Math.floor(diff / 60000)
  if (totalMin < 1) return "em breve"
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 1) return `em ${m}min`
  if (h < 24) return m > 0 ? `em ${h}h ${m}min` : `em ${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `em ${d}d ${rh}h` : `em ${d}d`
}

export function slaProgressInfo(task: Task): { pct: number; color: string } | null {
  const status = task.status?.status || "aberto"
  if (status === "encerrado" || status === "pendente") return null
  const start = Number(task.date_created)
  const end = Number(task.due_date)
  if (!start || !end || end <= start) return null
  const pct = ((Date.now() - start) / (end - start)) * 100
  let color = "#22c55e"
  if (pct >= 100) color = "#ef4444"
  else if (pct >= 70) color = "#f59e0b"
  return { pct: Math.max(0, Math.min(pct, 100)), color }
}

export function waNumberForTask(task: Task): string {
  const assigneeId = task.assignees?.[0]?.id != null ? String(task.assignees[0].id) : null
  return (assigneeId && OPERADOR_WHATSAPP[assigneeId]) || WA_NUMBER_PADRAO
}

export function waLinkForTask(task: Task): string {
  const status = STATUS_MAP[(task.status?.status as StatusKey) ?? "aberto"]?.label ?? "Aberto"
  const msg = `Olá! Gostaria de informações sobre meu chamado de TI:\n*${task.name}*\nStatus: ${status}`
  return `https://wa.me/${waNumberForTask(task)}?text=${encodeURIComponent(msg)}`
}
