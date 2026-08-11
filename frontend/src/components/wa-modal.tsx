import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { waNumberForTask } from "@/lib/ticket-helpers"
import type { Task } from "@/lib/api"

// Porta openWaModal()/closeWaModal() de app.js — aparece assim que o chamado é aberto,
// convidando a avisar o operador certo direto pelo WhatsApp. `anexoWarning` (F4.5): esse
// modal fica montado independente da aba ativa, por isso é o lugar certo pra avisar se o
// anexo falhou ao enviar — diferente do formulário, que já saiu de tela nesse momento.
export function WaModal({ task, slaLabel, anexoWarning, onClose }: { task: Task | null; slaLabel: string; anexoWarning?: string; onClose: () => void }) {
  if (!task) return null
  const msg = `Olá! Acabei de abrir um chamado de TI:\n*${task.name}*\nGostaria de acompanhar meu atendimento.`
  const link = `https://wa.me/${waNumberForTask(task)}?text=${encodeURIComponent(msg)}`

  return (
    <Dialog open={!!task} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Chamado aberto!</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Prazo de atendimento: {slaLabel}</p>
        {anexoWarning && (
          <Alert variant="destructive">
            <AlertDescription>{anexoWarning}</AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-foreground">
          Quer avisar o atendente agora pelo WhatsApp? Ele já vai saber exatamente qual é o seu chamado.
        </p>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button asChild>
            <a href={link} target="_blank" rel="noreferrer">Abrir WhatsApp</a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
