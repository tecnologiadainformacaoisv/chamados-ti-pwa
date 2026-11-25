// Solicitações (2026-11-25, ideia do estudo do OS800): pedido de equipamento, material, peça ou autorização,
// com andamento em 5 etapas. Cliente das rotas /api/solicitacoes (sessão do solicitante) e
// /admin/solicitacoes (TI).

import { adminRequest } from "@/lib/api"
import { apiRequest } from "@/lib/app-api"
import { adminPost } from "@/lib/equipamentos-api"

export type SolicCategoria = "equipamento" | "material" | "peca" | "autorizacao"
export type SolicStatus = "pendente" | "em_analise" | "aprovado" | "em_transito" | "entregue" | "rejeitado"

export type Solicitacao = {
  id: string
  numero: number | null
  categoria: SolicCategoria
  item: string
  quantidade: number
  justificativa: string
  solicitante: string
  setor: number | null
  status: SolicStatus
  /** Último recado da TI (quem pediu lê). */
  nota_ti: string | null
  /** Só preenchido enquanto status = rejeitado. */
  motivo_rejeicao: string | null
  created_at: number
  updated_at: number
}

export const SOLIC_CATEGORIAS: SolicCategoria[] = ["equipamento", "material", "peca", "autorizacao"]

export const SOLIC_CATEGORIA_LABEL: Record<SolicCategoria, string> = {
  equipamento: "Equipamentos",
  material: "Materiais",
  peca: "Peças",
  autorizacao: "Autorizações",
}

export const SOLIC_CATEGORIA_SINGULAR: Record<SolicCategoria, string> = {
  equipamento: "Equipamento",
  material: "Material",
  peca: "Peça",
  autorizacao: "Autorização",
}

export const SOLIC_CATEGORIA_EXEMPLO: Record<SolicCategoria, string> = {
  equipamento: "Ex.: mouse sem fio, monitor, notebook",
  material: "Ex.: cabo HDMI, pilhas, papel",
  peca: "Ex.: fonte do computador, memória",
  autorizacao: "Ex.: acesso à pasta do Financeiro",
}

export const SOLIC_STATUS_LABEL: Record<SolicStatus, string> = {
  pendente: "Pendente",
  em_analise: "Em análise",
  aprovado: "Aprovado",
  em_transito: "A caminho",
  entregue: "Entregue",
  rejeitado: "Rejeitado",
}

/** As 5 etapas na ordem em que aparecem no andamento. "rejeitado" fica fora (é um desvio). */
export const SOLIC_ETAPAS: SolicStatus[] = ["pendente", "em_analise", "aprovado", "em_transito", "entregue"]

/** Mesmo mapa do Worker (SOLIC_TRANSICOES): a tela só oferece o que o servidor aceita. */
export const SOLIC_PROXIMOS: Record<SolicStatus, SolicStatus[]> = {
  pendente: ["em_analise", "rejeitado"],
  em_analise: ["aprovado", "rejeitado", "pendente"],
  aprovado: ["em_transito", "entregue", "rejeitado"],
  em_transito: ["entregue"],
  entregue: [],
  rejeitado: ["pendente"],
}

/** Ainda não terminou (nem entregue, nem rejeitado). */
export const solicEmAndamento = (s: Pick<Solicitacao, "status">) => s.status !== "entregue" && s.status !== "rejeitado"

// ------------------------------------------------------------------ solicitante

export const fetchMinhasSolicitacoes = (sessionToken: string) =>
  apiRequest<{ solicitacoes: Solicitacao[] }>(sessionToken, "GET", "/solicitacoes").then((r) => r.solicitacoes)

export type NovaSolicitacao = { categoria: SolicCategoria; item: string; quantidade: number; justificativa: string; setor?: number }

export const criarSolicitacao = (sessionToken: string, dados: NovaSolicitacao) =>
  apiRequest<{ id: string; numero: number }>(sessionToken, "POST", "/solicitacoes", dados)

// ------------------------------------------------------------------ TI

export const fetchSolicitacoesAdmin = (secret: string) =>
  adminRequest<{ solicitacoes: Solicitacao[]; pendentes: number }>(secret, "/solicitacoes")

export const mudarStatusSolicitacao = (secret: string, id: string, status: SolicStatus, motivo?: string) =>
  adminPost<{ ok: true }>(secret, `/solicitacoes/${id}/status`, motivo ? { status, motivo } : { status })
