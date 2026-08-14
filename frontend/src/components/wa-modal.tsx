import { Check } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { waNumberForTask } from "@/lib/ticket-helpers"
import type { Task } from "@/lib/api"

// Porta openWaModal()/closeWaModal() de app.js — aparece assim que o chamado é aberto,
// convidando a avisar o operador certo direto pelo WhatsApp. `anexoWarning` (F4.5): esse
// modal fica montado independente da aba ativa, por isso é o lugar certo pra avisar se o
// anexo falhou ao enviar — diferente do formulário, que já saiu de tela nesse momento.
//
// Redesenhado 2026-08-14 (2ª rodada da regressão visual da F5) — o Dialog genérico do
// shadcn tinha perdido o ícone verde de sucesso, a pill colorida do SLA, o texto
// centralizado e os botões empilhados largura-cheia que o `.wa-modal-card` do vanilla
// (css/style.css) sempre teve.
export function WaModal({ task, slaLabel, anexoWarning, onClose }: { task: Task | null; slaLabel: string; anexoWarning?: string; onClose: () => void }) {
  if (!task) return null
  const msg = `Olá! Acabei de abrir um chamado de TI:\n*${task.name}*\nGostaria de acompanhar meu atendimento.`
  const link = `https://wa.me/${waNumberForTask(task)}?text=${encodeURIComponent(msg)}`

  return (
    <Dialog open={!!task} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="sr-only">
          <DialogTitle>Chamado aberto!</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-1 pt-2 text-center">
          <div className="mb-2 flex h-[60px] w-[60px] items-center justify-center rounded-full bg-[#22c55e]">
            <Check className="h-8 w-8 text-white" strokeWidth={3} />
          </div>
          <h2 className="text-lg font-bold text-foreground">Chamado aberto!</h2>
          <span className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-sm font-bold text-primary">
            Prazo de atendimento: {slaLabel}
          </span>
        </div>

        {anexoWarning && (
          <Alert variant="destructive">
            <AlertDescription>{anexoWarning}</AlertDescription>
          </Alert>
        )}

        <p className="text-center text-sm leading-relaxed text-muted-foreground">
          Quer avisar o atendente agora pelo WhatsApp? Ele já vai saber exatamente qual é o seu chamado.
        </p>

        <div className="flex flex-col gap-2.5">
          <Button asChild size="lg" className="w-full justify-center">
            <a href={link} target="_blank" rel="noreferrer">Abrir WhatsApp</a>
          </Button>
          <Button variant="outline" size="lg" className="w-full justify-center" onClick={onClose}>Fechar</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
