// Cadastro/edição de equipamento (Inventário). Dialog único para criar e editar.

import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { SETORES } from "@/lib/constants"
import { isSessionError } from "@/lib/api"
import {
  EQUIP_ORIGEM_LABEL,
  EQUIP_STATUS_LABEL,
  EQUIP_TIPO_LABEL,
  salvarEquipamento,
  type Equipamento,
  type EquipOrigem,
  type EquipStatus,
  type EquipTipo,
} from "@/lib/equipamentos-api"

const SEM_SETOR = "nenhum"

type Estado = {
  tombamento: string
  tipo: EquipTipo
  marca: string
  modelo: string
  numero_serie: string
  origem: EquipOrigem
  fornecedor: string
  setor: string
  local: string
  ip: string
  status: EquipStatus
  observacao: string
}

const vazio: Estado = {
  tombamento: "", tipo: "impressora", marca: "", modelo: "", numero_serie: "", origem: "patrimonio",
  fornecedor: "", setor: SEM_SETOR, local: "", ip: "", status: "ativo", observacao: "",
}

const deEquipamento = (e: Equipamento): Estado => ({
  tombamento: e.tombamento ?? "", tipo: e.tipo, marca: e.marca ?? "", modelo: e.modelo ?? "",
  numero_serie: e.numero_serie ?? "", origem: e.origem, fornecedor: e.fornecedor ?? "",
  setor: e.setor == null ? SEM_SETOR : String(e.setor), local: e.local ?? "", ip: e.ip ?? "", status: e.status, observacao: e.observacao ?? "",
})

// Texto vazio vira null: no servidor, `null` limpa o campo e `undefined` o deixaria como está.
const nuloSeVazio = (v: string) => v.trim() || null

export function EquipamentoForm({ equipamento, onClose }: { equipamento: Equipamento | null; onClose: () => void }) {
  const { secret, logout } = useAdminAuth()
  const qc = useQueryClient()
  const [f, setF] = useState<Estado>(equipamento ? deEquipamento(equipamento) : vazio)
  const [erro, setErro] = useState<string | null>(null)
  const set = <K extends keyof Estado>(k: K, v: Estado[K]) => setF((x) => ({ ...x, [k]: v }))

  const salvar = useMutation({
    mutationFn: (extra?: { ativo: boolean }) =>
      salvarEquipamento(
        secret,
        {
          tombamento: nuloSeVazio(f.tombamento), tipo: f.tipo, marca: nuloSeVazio(f.marca), modelo: nuloSeVazio(f.modelo),
          numero_serie: nuloSeVazio(f.numero_serie), origem: f.origem,
          fornecedor: f.origem === "locado" ? nuloSeVazio(f.fornecedor) : null,
          setor: f.setor === SEM_SETOR ? null : Number(f.setor), local: nuloSeVazio(f.local), ip: nuloSeVazio(f.ip), status: f.status,
          observacao: nuloSeVazio(f.observacao), ...extra,
        },
        equipamento?.id,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["equipamentos"] })
      onClose()
    },
    onError: (e) => {
      if (isSessionError(e)) return logout()
      setErro(e instanceof Error ? e.message : "Não foi possível salvar.")
    },
  })

  const remover = () => {
    if (!equipamento) return
    if (!window.confirm("Remover este equipamento da lista? O histórico dos chamados dele é mantido.")) return
    setErro(null)
    salvar.mutate({ ativo: false })
  }

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{equipamento ? "Editar equipamento" : "Novo equipamento"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            setErro(null)
            salvar.mutate(undefined)
          }}
        >
          <Campo id="eq-tombamento" rotulo="Tombamento (etiqueta)">
            <Input id="eq-tombamento" value={f.tombamento} maxLength={40} onChange={(e) => set("tombamento", e.target.value)} placeholder="F 0123" />
          </Campo>
          <Campo id="eq-tipo" rotulo="Tipo">
            <Escolha id="eq-tipo" valor={f.tipo} onChange={(v) => set("tipo", v as EquipTipo)} opcoes={EQUIP_TIPO_LABEL} />
          </Campo>
          <Campo id="eq-marca" rotulo="Marca">
            <Input id="eq-marca" value={f.marca} maxLength={60} onChange={(e) => set("marca", e.target.value)} />
          </Campo>
          <Campo id="eq-modelo" rotulo="Modelo">
            <Input id="eq-modelo" value={f.modelo} maxLength={80} onChange={(e) => set("modelo", e.target.value)} />
          </Campo>
          <Campo id="eq-serie" rotulo="Número de série">
            <Input id="eq-serie" value={f.numero_serie} maxLength={80} onChange={(e) => set("numero_serie", e.target.value)} />
          </Campo>
          <Campo id="eq-status" rotulo="Situação">
            <Escolha id="eq-status" valor={f.status} onChange={(v) => set("status", v as EquipStatus)} opcoes={EQUIP_STATUS_LABEL} />
          </Campo>
          <Campo id="eq-origem" rotulo="Origem">
            <Escolha id="eq-origem" valor={f.origem} onChange={(v) => set("origem", v as EquipOrigem)} opcoes={EQUIP_ORIGEM_LABEL} />
          </Campo>
          {f.origem === "locado" ? (
            <Campo id="eq-fornecedor" rotulo="Fornecedor">
              <Input id="eq-fornecedor" value={f.fornecedor} maxLength={80} onChange={(e) => set("fornecedor", e.target.value)} />
            </Campo>
          ) : (
            <div className="hidden sm:block" />
          )}
          <Campo id="eq-setor" rotulo="Setor">
            <Escolha
              id="eq-setor"
              valor={f.setor}
              onChange={(v) => set("setor", v)}
              opcoes={{ [SEM_SETOR]: "Não informado", ...Object.fromEntries(SETORES.map((s) => [String(s.orderindex), s.name])) }}
            />
          </Campo>
          <Campo id="eq-local" rotulo="Local">
            <Input id="eq-local" value={f.local} maxLength={120} onChange={(e) => set("local", e.target.value)} placeholder="Sala 3, mesa 2" />
          </Campo>
          {f.tipo === "impressora" && (
            <div className="sm:col-span-2">
              <Campo id="eq-ip" rotulo="IP na rede (para ler o toner automaticamente)">
                <Input id="eq-ip" value={f.ip} maxLength={15} inputMode="decimal" placeholder="192.168.0.10" onChange={(e) => set("ip", e.target.value.replace(/[^\d.]/g, ""))} />
              </Campo>
            </div>
          )}
          <div className="sm:col-span-2">
            <Campo id="eq-obs" rotulo="Observação">
              <Textarea id="eq-obs" value={f.observacao} maxLength={500} rows={2} onChange={(e) => set("observacao", e.target.value)} />
            </Campo>
          </div>

          {erro && (
            <Alert variant="destructive" className="sm:col-span-2" role="alert">
              <AlertDescription>{erro}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="sm:col-span-2">
            {equipamento && (
              <Button type="button" variant="destructive" className="sm:mr-auto" disabled={salvar.isPending} onClick={remover}>
                Remover da lista
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={salvar.isPending}>{salvar.isPending ? "Salvando…" : "Salvar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Campo({ id, rotulo, children }: { id: string; rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{rotulo}</Label>
      {children}
    </div>
  )
}

function Escolha({ id, valor, onChange, opcoes }: { id: string; valor: string; onChange: (v: string) => void; opcoes: Record<string, string> }) {
  return (
    <Select value={valor} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(opcoes).map(([v, l]) => (
          <SelectItem key={v} value={v}>{l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
