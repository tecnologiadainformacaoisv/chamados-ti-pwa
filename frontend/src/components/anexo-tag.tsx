import { Paperclip } from "lucide-react"
import type { Task } from "@/lib/api"

// Tag "tem anexo" (2026-11-24, pedido do usuário): clipe + quantidade ao lado do título,
// só aparece quando o chamado tem pelo menos um arquivo. Lê `anexos_count` que o servidor
// já manda em GET /admin/tasks.
export function AnexoTag({ task }: { task: Task }) {
  const n = task.anexos_count ?? 0
  if (n <= 0) return null
  const texto = n === 1 ? "1 anexo" : `${n} anexos`
  return (
    <span
      title={texto}
      aria-label={texto}
      className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 rounded-full bg-sky-100 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-sky-800"
    >
      <Paperclip className="h-3 w-3" aria-hidden="true" />
      {n}
    </span>
  )
}
