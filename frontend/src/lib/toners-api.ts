// Toners (2026-11-23): acompanhamento dos suprimentos do parque de impressão.
// Cliente das rotas /admin/toners do push-worker.js.

import { adminRequest } from "@/lib/api"
import { adminPost } from "@/lib/equipamentos-api"

export type TonerCor = "preto" | "ciano" | "magenta" | "amarelo"

export type Toner = {
  id: string
  equipamento_id: string
  codigo: string
  cor: TonerCor
  capacidade_paginas: number | null
  ciclo_dias_padrao: number | null
  observacao: string | null
  /** Nível lido da impressora pelo agente (0-100); null = nunca lido. */
  nivel_percentual: number | null
  /** Hora (epoch ms, do servidor) da última leitura. */
  nivel_lido_em: number | null
  // da impressora (junção com o inventário)
  tombamento: string | null
  marca: string | null
  modelo: string | null
  setor: number | null
  local: string | null
  ip: string | null
  /** Datas das recargas em epoch ms, da mais antiga para a mais recente. */
  recargas: number[]
}

export type TonerForm = {
  equipamento_id?: string
  codigo?: string
  cor?: TonerCor
  capacidade_paginas?: number | null
  ciclo_dias_padrao?: number | null
  observacao?: string | null
  ativo?: boolean
}

export const TONER_COR_LABEL: Record<TonerCor, string> = {
  preto: "Preto",
  ciano: "Ciano",
  magenta: "Magenta",
  amarelo: "Amarelo",
}

/**
 * Como a impressora é chamada na tela: o lugar onde ela está ("Financeiro", "Sala 3"), que é o que a
 * pessoa reconhece. O código do cartucho e o modelo ficam em linhas menores.
 */
export function nomeDoLugar(t: Pick<Toner, "local" | "setor" | "tombamento">, nomeSetor: (setor: number) => string): string {
  if (t.local) return t.local
  if (t.setor != null) return nomeSetor(t.setor)
  return t.tombamento || "Impressora sem local"
}

export const fetchToners = (secret: string) => adminRequest<{ toners: Toner[] }>(secret, "/toners")

export const salvarToner = (secret: string, dados: TonerForm, id?: string) =>
  adminPost<{ id?: string; ok?: boolean }>(secret, `/toners${id ? `/${id}` : ""}`, dados)

export const registrarRecarga = (secret: string, tonerId: string, autor?: string | null) =>
  adminPost(secret, `/toners/${tonerId}/recarga`, autor ? { autor } : {})

export const desfazerUltimaRecarga = (secret: string, tonerId: string) =>
  adminPost(secret, `/toners/${tonerId}/recarga/desfazer`, {})
