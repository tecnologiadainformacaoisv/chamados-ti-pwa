import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { isImagemAnexo } from "@/lib/anexo-helpers"
import type { Attachment } from "@/lib/api"

// Porta openAnexoModal()/closeAnexoModal() de app.js — imagem em preview direto, outros
// tipos de arquivo caem no fallback "abrir em nova aba" (não dá pra prever renderização
// de PDF/DOCX etc. sem lib nova).
export function AnexoModal({ anexo, onClose }: { anexo: Attachment | null; onClose: () => void }) {
  if (!anexo) return null
  const isImage = isImagemAnexo(anexo.url, anexo.extension)
  const titulo = anexo.title || anexo.name || "Anexo"

  return (
    <Dialog open={!!anexo} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
        </DialogHeader>
        {isImage ? (
          <img src={anexo.url} alt={titulo} className="max-h-[70vh] w-full rounded-md object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">Pré-visualização não disponível para este tipo de arquivo.</p>
            <Button asChild>
              <a href={anexo.url} target="_blank" rel="noopener noreferrer">Abrir arquivo</a>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
