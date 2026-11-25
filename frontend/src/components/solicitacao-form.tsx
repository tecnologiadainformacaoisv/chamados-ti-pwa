// Formulário "Nova solicitação" do app do solicitante (2026-11-25, ideia do estudo do OS800).

import { useState, type FormEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useSessionAuth } from "@/hooks/use-session-auth"
import { isAuthExpired } from "@/lib/app-api"
import { SETORES } from "@/lib/constants"
import {
  SOLIC_CATEGORIAS,
  SOLIC_CATEGORIA_EXEMPLO,
  SOLIC_CATEGORIA_SINGULAR,
  criarSolicitacao,
  type SolicCategoria,
} from "@/lib/solicitacoes-api"

const SEM_SETOR = "nenhum"
export const CHAVE_MINHAS_SOLICITACOES = ["minhas-solicitacoes"] as const

export function SolicitacaoForm({ aberto, onFechar, onCriada }: { aberto: boolean; onFechar: () => void; onCriada: (numero: number) => void }) {
  const { sessionToken, handleSessionExpired } = useSessionAuth()
  const qc = useQueryClient()
  const [categoria, setCategoria] = useState<SolicCategoria | "">("")
  const [item, setItem] = useState("")
  const [quantidade, setQuantidade] = useState("1")
  const [setor, setSetor] = useState(SEM_SETOR)
  const [justificativa, setJustificativa] = useState("")
  const [erro, setErro] = useState<string | null>(null)

  const criar = useMutation({
    mutationFn: () =>
      criarSolicitacao(sessionToken, {
        categoria: categoria as SolicCategoria,
        item: item.trim(),
        quantidade: Number(quantidade),
        justificativa: justificativa.trim(),
        ...(setor !== SEM_SETOR ? { setor: Number(setor) } : {}),
      }),
    onSuccess: ({ numero }) => {
      qc.invalidateQueries({ queryKey: CHAVE_MINHAS_SOLICITACOES })
      setCategoria(""); setItem(""); setQuantidade("1"); setSetor(SEM_SETOR); setJustificativa(""); setErro(null)
      onCriada(numero)
    },
    onError: (e) => {
      if (isAuthExpired(e)) return handleSessionExpired()
      setErro(e instanceof Error ? e.message : "Não foi possível enviar agora. Tente de novo.")
    },
  })

  function enviar(ev: FormEvent) {
    ev.preventDefault()
    setErro(null)
    const faltando = [!categoria && "o que você precisa", !item.trim() && "o item", !justificativa.trim() && "para quê"].filter(Boolean)
    if (faltando.length) return setErro(`Falta preencher: ${faltando.join(", ")}.`)
    const q = Number(quantidade)
    if (!Number.isInteger(q) || q < 1 || q > 999) return setErro("A quantidade precisa ser um número de 1 a 999.")
    criar.mutate()
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova solicitação</DialogTitle>
          <DialogDescription>Peça um equipamento, material, peça ou uma autorização. Você acompanha o andamento na aba Pedidos.</DialogDescription>
        </DialogHeader>
        <form onSubmit={enviar} noValidate className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="solic-categoria">O que você precisa? *</Label>
            <Select value={categoria} onValueChange={(v) => setCategoria(v as SolicCategoria)}>
              <SelectTrigger id="solic-categoria" className="w-full min-w-0"><SelectValue placeholder="Escolha" /></SelectTrigger>
              <SelectContent>
                {SOLIC_CATEGORIAS.map((c) => <SelectItem key={c} value={c}>{SOLIC_CATEGORIA_SINGULAR[c]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="solic-item">Item *</Label>
              <Input id="solic-item" value={item} maxLength={120} onChange={(e) => setItem(e.target.value)} placeholder={categoria ? SOLIC_CATEGORIA_EXEMPLO[categoria] : "O que você precisa"} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="solic-qtd">Qtde</Label>
              <Input id="solic-qtd" inputMode="numeric" value={quantidade} onChange={(e) => setQuantidade(e.target.value.replace(/\D/g, "").slice(0, 3))} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="solic-setor">Setor (opcional)</Label>
            <Select value={setor} onValueChange={setSetor}>
              <SelectTrigger id="solic-setor" className="w-full min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SEM_SETOR}>Não informar</SelectItem>
                {SETORES.map((s) => <SelectItem key={s.orderindex} value={String(s.orderindex)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="solic-just">Para quê? *</Label>
            <Textarea id="solic-just" rows={3} maxLength={1000} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} placeholder="Explique rapidamente por que você precisa." />
            <p className="text-right text-xs text-muted-foreground">{justificativa.length}/1000</p>
          </div>
          {erro && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{erro}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onFechar}>Cancelar</Button>
            <Button type="submit" disabled={criar.isPending}>{criar.isPending ? "Enviando…" : "Enviar pedido"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
