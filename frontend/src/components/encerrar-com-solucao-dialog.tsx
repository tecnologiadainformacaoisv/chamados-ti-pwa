import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"

// Regra de negócio (2026-08-24, pedido do usuário: "a solução precisa ser descrita
// toda vez que o chamado for encerrado") — dispara ao arrastar um card pro Quadro
// ou trocar o status pra Encerrado direto na Tabela (kanban-board.tsx/tasks-table.tsx,
// via gestao-view.tsx), os dois únicos jeitos de mudar status sem passar pelo modal
// "Gerenciar" (que já tem o campo Solução na própria tela — ver a mesma validação
// aplicada lá em task-modal.tsx, com o mesmo texto de erro do servidor).
export function EncerrarComSolucaoDialog({
  aberto,
  nomeTask,
  solucaoInicial,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  aberto: boolean
  nomeTask: string
  solucaoInicial: string
  saving: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (solucao: string) => void
}) {
  const [solucao, setSolucao] = useState(solucaoInicial)

  // Recarrega o rascunho toda vez que o popup abre pra um chamado (pode já ter uma
  // solução escrita antes, se alguém passou pelo modal "Gerenciar" e voltou sem
  // encerrar) — nunca reseta enquanto está aberto (evitaria perder o que a pessoa
  // já digitou se o componente re-renderizar por outro motivo).
  useEffect(() => {
    if (aberto) setSolucao(solucaoInicial)
    // Depende só de `aberto` de propósito — reagir a `solucaoInicial` sozinho
    // reescreveria o que a pessoa já digitou se o valor de origem mudasse enquanto
    // o popup segue aberto (ex.: refetch em segundo plano).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto])

  return (
    <Dialog open={aberto} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Encerrar chamado</DialogTitle>
        </DialogHeader>
        <p className="min-w-0 text-sm break-words text-muted-foreground">
          Antes de encerrar <strong className="text-foreground">{nomeTask}</strong>, descreva a solução aplicada.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label>Solução *</Label>
          <Textarea
            rows={4}
            autoFocus
            placeholder="Descreva a solução aplicada..."
            value={solucao}
            onChange={(e) => setSolucao(e.target.value)}
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => onConfirm(solucao)} disabled={saving || !solucao.trim()}>
            {saving ? "Encerrando…" : "Encerrar chamado"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
