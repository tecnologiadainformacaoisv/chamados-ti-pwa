import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TIPO_FIELD_ID, SETOR_FIELD_ID, TIPOS, SETORES, optionName } from "@/lib/constants"
import { getCF, isSessionError, postTaskUpdate, type Task } from "@/lib/api"
import { useAdminAuth } from "@/hooks/use-admin-auth"

// A "caixa" que aparece quando um chamado novo chega (2026-08-13) — diferente do modal
// "Gerenciar" (task-modal.tsx, que edita status/solução/operador com calma): aqui é só
// leitura + UMA ação rápida ("Aceitar chamado" = pôr em Em Atendimento na hora), pro
// caso de uso real de "chegou um chamado, quero aceitar sem abrir mais nada". Mostra 1
// de cada vez, mesmo se `fila` tiver mais — os outros esperam a vez (indicador "+N").
export function NovoChamadoAlert({ fila, onFechar }: { fila: Task[]; onFechar: (taskId: string) => void }) {
  const { secret, logout } = useAdminAuth()
  const queryClient = useQueryClient()
  const task = fila[0] ?? null

  const aceitarMutation = useMutation({
    mutationFn: (taskId: string) => postTaskUpdate(secret, taskId, { status: "em atendimento" }),
    onSuccess: (_, taskId) => {
      queryClient.invalidateQueries({ queryKey: ["admin-tasks"] })
      queryClient.invalidateQueries({ queryKey: ["admin-open-count"] })
      onFechar(taskId)
    },
    onError: (err) => {
      if (isSessionError(err)) logout()
    },
  })

  if (!task) return null

  const tipo = optionName(TIPOS, getCF(task, TIPO_FIELD_ID) as number | null)
  const setor = optionName(SETORES, getCF(task, SETOR_FIELD_ID) as number | null)

  return (
    <Dialog open={!!task} onOpenChange={(open) => !open && onFechar(task.id)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            🔔 Chamado novo
            {fila.length > 1 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                +{fila.length - 1} na fila
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-lg font-semibold text-foreground">{task.name || "(sem título)"}</p>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border border-border px-2 py-0.5">{task.solicitante || "—"}</span>
            <span className="rounded-full border border-border px-2 py-0.5">{tipo}</span>
            <span className="rounded-full border border-border px-2 py-0.5">{setor}</span>
          </div>
          <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 p-2.5 text-sm whitespace-pre-line text-foreground">
            {task.description || task.text_content || "(sem descrição)"}
          </div>

          {aceitarMutation.isError && !isSessionError(aceitarMutation.error) && (
            <Alert variant="destructive">
              <AlertDescription>
                {aceitarMutation.error instanceof Error ? aceitarMutation.error.message : "Não foi possível aceitar."}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onFechar(task.id)} disabled={aceitarMutation.isPending}>
            Ver depois
          </Button>
          <Button size="lg" onClick={() => aceitarMutation.mutate(task.id)} disabled={aceitarMutation.isPending}>
            {aceitarMutation.isPending ? "Aceitando…" : "Aceitar chamado"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
