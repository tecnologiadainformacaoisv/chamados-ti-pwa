import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { isImagemAnexo } from "@/lib/anexo-helpers"
import { fetchAnexoBlob } from "@/lib/app-api"
import type { Attachment } from "@/lib/api"

// Porta openAnexoModal()/closeAnexoModal() de app.js — imagem em preview direto, outros
// tipos de arquivo caem no fallback "abrir em nova aba" (não dá pra prever renderização
// de PDF/DOCX etc. sem lib nova).
//
// Fase M2 (2026-08-13, migração de saída da ClickUp): `anexo.url` deixou de ser um link
// público/direto da ClickUp e virou uma rota autenticada por sessão (GET /api/anexos/:id)
// — `<img src>`/`<a href>` não carregam header customizado, então busca o arquivo aqui
// (fetch com sessão) e converte pra object URL antes de renderizar. Efeito colateral bom:
// antes, qualquer um com o link da ClickUp abria o anexo sem sessão nenhuma; agora exige
// login de dono do chamado, igual o resto do app já exige.
export function AnexoModal({
  anexo,
  sessionToken,
  onClose,
}: {
  anexo: Attachment | null
  sessionToken: string
  onClose: () => void
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!anexo) {
      setBlobUrl(null)
      setError(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setBlobUrl(null)
    setError(null)
    fetchAnexoBlob(sessionToken, anexo.url)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setBlobUrl(objectUrl)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Não foi possível carregar o anexo.")
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [anexo, sessionToken])

  if (!anexo) return null
  const isImage = isImagemAnexo(anexo.url, anexo.extension)
  const titulo = anexo.title || anexo.name || "Anexo"

  return (
    <Dialog open={!!anexo} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : !blobUrl ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Carregando…</p>
        ) : isImage ? (
          <img src={blobUrl} alt={titulo} className="max-h-[70vh] w-full rounded-md object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">Pré-visualização não disponível para este tipo de arquivo.</p>
            <Button asChild>
              <a href={blobUrl} download={titulo} target="_blank" rel="noopener noreferrer">Abrir arquivo</a>
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
