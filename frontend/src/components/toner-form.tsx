// Cadastro/edição de toner. Dialog único para criar e editar.

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { isSessionError } from "@/lib/api"
import { SETORES } from "@/lib/constants"
import { EQUIP_TIPO_LABEL, fetchEquipamentos, type Equipamento } from "@/lib/equipamentos-api"
import { salvarToner, TONER_COR_LABEL, type Toner, type TonerCor } from "@/lib/toners-api"

// "Financeiro · Lexmark MX622adhe · 10.10.2.110": o lugar primeiro, que é o que a pessoa reconhece.
const rotuloImpressora = (e: Equipamento) =>
  [e.local || (e.setor != null ? SETORES.find((s) => s.orderindex === e.setor)?.name : null), [e.marca, e.modelo].filter(Boolean).join(" ") || EQUIP_TIPO_LABEL[e.tipo], e.ip ?? e.tombamento]
    .filter(Boolean)
    .join(" · ")

const inteiroOuNulo = (v: string): number | null => {
  const t = v.trim()
  return t ? Number(t) : null
}

export function TonerForm({ toner, onClose }: { toner: Toner | null; onClose: () => void }) {
  const { secret, logout } = useAdminAuth()
  const qc = useQueryClient()
  const [equipamentoId, setEquipamentoId] = useState(toner?.equipamento_id ?? "")
  const [codigo, setCodigo] = useState(toner?.codigo ?? "")
  const [cor, setCor] = useState<TonerCor>(toner?.cor ?? "preto")
  const [capacidade, setCapacidade] = useState(toner?.capacidade_paginas != null ? String(toner.capacidade_paginas) : "")
  const [ciclo, setCiclo] = useState(toner?.ciclo_dias_padrao != null ? String(toner.ciclo_dias_padrao) : "")
  const [observacao, setObservacao] = useState(toner?.observacao ?? "")
  const [erro, setErro] = useState<string | null>(null)

  // Só impressoras do Inventário podem ter toner.
  const equipamentosQuery = useQuery({ queryKey: ["equipamentos"], queryFn: () => fetchEquipamentos(secret) })
  const impressoras = (equipamentosQuery.data?.equipamentos ?? []).filter((e) => e.tipo === "impressora")

  const salvar = useMutation({
    mutationFn: (extra?: { ativo: boolean }) =>
      salvarToner(
        secret,
        {
          equipamento_id: equipamentoId || undefined,
          codigo: codigo.trim(),
          cor,
          capacidade_paginas: inteiroOuNulo(capacidade),
          ciclo_dias_padrao: inteiroOuNulo(ciclo),
          observacao: observacao.trim() || null,
          ...extra,
        },
        toner?.id,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["toners"] })
      onClose()
    },
    onError: (e) => {
      if (isSessionError(e)) return logout()
      setErro(e instanceof Error ? e.message : "Não foi possível salvar.")
    },
  })

  const remover = () => {
    if (!toner || !window.confirm("Remover este toner da lista? O histórico de recargas some junto da tela.")) return
    setErro(null)
    salvar.mutate({ ativo: false })
  }

  const semImpressora = !equipamentosQuery.isLoading && impressoras.length === 0 && !toner

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{toner ? "Editar toner" : "Novo toner"}</DialogTitle>
        </DialogHeader>
        {semImpressora ? (
          <Alert>
            <AlertDescription>Cadastre antes a impressora no Inventário. O toner fica ligado a ela.</AlertDescription>
          </Alert>
        ) : (
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault()
              setErro(null)
              if (!equipamentoId) return setErro("Escolha a impressora.")
              if (!codigo.trim()) return setErro("Informe o código do toner.")
              salvar.mutate(undefined)
            }}
          >
            <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="toner-impressora">Impressora</Label>
              <Select value={equipamentoId} onValueChange={setEquipamentoId}>
                <SelectTrigger id="toner-impressora" className="w-full min-w-0">
                  <SelectValue placeholder="Escolha a impressora" />
                </SelectTrigger>
                <SelectContent>
                  {impressoras.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{rotuloImpressora(e)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="toner-codigo">Código do toner</Label>
              <Input id="toner-codigo" value={codigo} maxLength={40} placeholder="TN-1060" onChange={(e) => setCodigo(e.target.value)} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="toner-cor">Cor</Label>
              <Select value={cor} onValueChange={(v) => setCor(v as TonerCor)}>
                <SelectTrigger id="toner-cor" className="w-full min-w-0"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TONER_COR_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="toner-capacidade">Capacidade (páginas)</Label>
              <Input id="toner-capacidade" inputMode="numeric" value={capacidade} placeholder="2600" onChange={(e) => setCapacidade(e.target.value.replace(/\D/g, ""))} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="toner-ciclo">Ciclo esperado (dias)</Label>
              <Input id="toner-ciclo" inputMode="numeric" value={ciclo} placeholder="45" onChange={(e) => setCiclo(e.target.value.replace(/\D/g, ""))} />
              <p className="text-xs text-muted-foreground">Vale até haver 2 recargas; depois o sistema usa a média real.</p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="toner-obs">Observação</Label>
              <Textarea id="toner-obs" rows={2} maxLength={300} value={observacao} onChange={(e) => setObservacao(e.target.value)} />
            </div>

            {erro && (
              <Alert variant="destructive" className="sm:col-span-2" role="alert">
                <AlertDescription>{erro}</AlertDescription>
              </Alert>
            )}

            <DialogFooter className="sm:col-span-2">
              {toner && (
                <Button type="button" variant="destructive" className="sm:mr-auto" disabled={salvar.isPending} onClick={remover}>
                  Remover da lista
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={salvar.isPending}>{salvar.isPending ? "Salvando…" : "Salvar"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
