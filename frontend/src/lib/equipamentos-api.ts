// Inventário de equipamentos (2026-11-23, ideia do estudo do OS800).
// Cliente das rotas /admin/equipamentos e /api/equipamentos do push-worker.js.

import { adminRequest, AdminApiError } from "@/lib/api"
import { apiRequest } from "@/lib/app-api"
import { ADMIN_BASE } from "@/lib/constants"

export type EquipTipo = "impressora" | "computador" | "monitor" | "notebook" | "rede" | "outro"
export type EquipStatus = "ativo" | "manutencao" | "reserva" | "baixado"
export type EquipOrigem = "patrimonio" | "locado"

export type Equipamento = {
  id: string
  tombamento: string | null
  tipo: EquipTipo
  marca: string | null
  modelo: string | null
  numero_serie: string | null
  origem: EquipOrigem
  fornecedor: string | null
  setor: number | null
  local: string | null
  /** IPv4 na rede interna; usado pelo agente que lê o nível de toner das impressoras. */
  ip: string | null
  status: EquipStatus
  observacao: string | null
  chamadosTotal: number
  chamadosAbertos: number
  /** Chamados abertos nos últimos 30 dias (reincidência). */
  chamados30d?: number
}

/** O que o solicitante vê no select do "Novo chamado" (sem nº de série nem observação). */
export type EquipamentoResumo = Pick<Equipamento, "id" | "tombamento" | "tipo" | "marca" | "modelo" | "setor" | "local">

export type EquipamentoForm = Partial<
  Pick<Equipamento, "tombamento" | "tipo" | "marca" | "modelo" | "numero_serie" | "origem" | "fornecedor" | "setor" | "local" | "ip" | "status" | "observacao">
> & { ativo?: boolean }

export const EQUIP_TIPO_LABEL: Record<EquipTipo, string> = {
  impressora: "Impressora",
  computador: "Computador",
  monitor: "Monitor",
  notebook: "Notebook",
  rede: "Rede",
  outro: "Outro",
}

export const EQUIP_STATUS_LABEL: Record<EquipStatus, string> = {
  ativo: "Ativo",
  manutencao: "Em manutenção",
  reserva: "Reserva",
  baixado: "Baixado",
}

export const EQUIP_ORIGEM_LABEL: Record<EquipOrigem, string> = {
  patrimonio: "Patrimônio",
  locado: "Locado",
}

/** "F 0123 · Impressora Brother HL-1" — como o equipamento aparece em listas e selects. */
export function rotuloEquipamento(e: EquipamentoResumo): string {
  const modelo = [e.marca, e.modelo].filter(Boolean).join(" ")
  return [e.tombamento, [EQUIP_TIPO_LABEL[e.tipo], modelo].filter(Boolean).join(" ")].filter(Boolean).join(" · ")
}

export const fetchEquipamentos = (secret: string) => adminRequest<{ equipamentos: Equipamento[] }>(secret, "/equipamentos")

/** POST autenticado por ADMIN_SECRET (toda mutação do Worker é POST). */
export async function adminPost<T = { ok?: boolean; id?: string }>(secret: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ADMIN_BASE}${path}`, {
    method: "POST",
    headers: { "X-Admin-Secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.status === 403) throw new AdminApiError("Segredo de admin inválido ou expirado. Entre de novo.", 403)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new AdminApiError((data as { error?: string }).error || `Erro HTTP ${res.status}`, res.status)
  return data as T
}

export const salvarEquipamento = (secret: string, dados: EquipamentoForm, id?: string) =>
  adminPost<{ id?: string; ok?: boolean }>(secret, `/equipamentos${id ? `/${id}` : ""}`, dados)

/** Lista enxuta para o solicitante escolher o equipamento ao abrir um chamado. */
export async function fetchEquipamentosSolicitante(sessionToken: string): Promise<EquipamentoResumo[]> {
  const data = await apiRequest<{ equipamentos: EquipamentoResumo[] }>(sessionToken, "GET", "/equipamentos")
  return data.equipamentos
}
