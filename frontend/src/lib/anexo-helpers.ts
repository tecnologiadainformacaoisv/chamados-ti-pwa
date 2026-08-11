import { IMAGE_EXTENSIONS, MAX_ANEXO_BYTES } from "@/lib/constants"

// Porta filtrarAnexosValidos() de app.js.
export function filtrarAnexosValidos(files: File[]): { validos: File[]; rejeitados: File[] } {
  const validos: File[] = []
  const rejeitados: File[] = []
  for (const f of files) (f.size > MAX_ANEXO_BYTES ? rejeitados : validos).push(f)
  return { validos, rejeitados }
}

// Porta o trecho de setupAnexo() que lê imagens coladas (Ctrl+V) do clipboard e as
// transforma em File — usado no onPaste do textarea/form.
export function imagensDoClipboard(items: DataTransferItemList | undefined | null): File[] {
  if (!items) return []
  const imagens: File[] = []
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile()
      if (file) {
        const ext = item.type.split("/")[1] || "png"
        imagens.push(new File([file], `print-${Date.now()}.${ext}`, { type: item.type }))
      }
    }
  }
  return imagens
}

// Porta a checagem isImage de openAnexoModal() em app.js.
export function isImagemAnexo(url: string, ext?: string | null): boolean {
  if (ext && IMAGE_EXTENSIONS.includes(ext.toLowerCase())) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url)
}
