// Avaliação mensal da TI (2026-11-25, ideia do estudo do OS800): cada solicitante avalia a TI uma vez por mês.
// Cliente das rotas /api/avaliacao-mensal (sessão do solicitante) e /admin/avaliacoes-mensais (resumo da TI).

import { adminRequest } from "@/lib/api"
import { apiRequest } from "@/lib/app-api"

export type AvaliacaoRespostas = {
  tempo_resposta: number
  primeiro_atendimento: number
  conhecimento: number
  cordialidade: number
  equipamentos: number
  comunicacao: number
  recomendacao: number
}

export type ChaveNota = Exclude<keyof AvaliacaoRespostas, "recomendacao">

/** As 6 notas de 1 a 5: a pergunta feita ao solicitante e o rótulo curto usado no resumo da TI. */
export const PERGUNTAS: { chave: ChaveNota; pergunta: string; rotulo: string }[] = [
  { chave: "tempo_resposta", pergunta: "A TI respondeu rápido aos seus chamados?", rotulo: "Rapidez" },
  { chave: "primeiro_atendimento", pergunta: "Os problemas foram resolvidos logo no primeiro atendimento?", rotulo: "Resolvido de primeira" },
  { chave: "conhecimento", pergunta: "A equipe mostrou que sabia resolver?", rotulo: "Conhecimento" },
  { chave: "cordialidade", pergunta: "Você foi bem tratado(a)?", rotulo: "Cordialidade" },
  { chave: "equipamentos", pergunta: "Seu computador, impressora e internet funcionaram bem no mês?", rotulo: "Equipamentos" },
  { chave: "comunicacao", pergunta: "Você ficou sabendo do andamento sem precisar perguntar?", rotulo: "Comunicação" },
]

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]

/** "2026-11" -> "novembro". */
export function nomeDoMes(competencia: string): string {
  return MESES[Number(competencia.split("-")[1]) - 1] ?? competencia
}

/** "2026-11" -> "novembro de 2026". */
export function rotuloCompetencia(competencia: string): string {
  const [ano] = competencia.split("-")
  return `${nomeDoMes(competencia)} de ${ano}`
}

export type AvaliacaoDoMes = {
  competencia: string
  respondida: boolean
  /** false = conta de fora da instituição (não avalia e não vê a faixa). */
  elegivel: boolean
  respostas: AvaliacaoRespostas | null
  comentario: string | null
}

export const fetchAvaliacaoMensal = (sessionToken: string) =>
  apiRequest<AvaliacaoDoMes>(sessionToken, "GET", "/avaliacao-mensal")

// `competencia` é o mês que o formulário mostrou: se o mês virou enquanto a pessoa respondia, o servidor recusa (409)
// em vez de gravar no mês seguinte com o título do anterior.
export const enviarAvaliacaoMensal = (sessionToken: string, respostas: AvaliacaoRespostas, comentario: string | undefined, competencia: string) =>
  apiRequest<{ ok: true; competencia: string }>(sessionToken, "POST", "/avaliacao-mensal", { respostas, comentario, competencia })

export type ResumoAvaliacao = {
  competencia: string
  meses: { competencia: string; respondentes: number }[]
  respondentes: number
  /** Solicitantes internos ativos (base da participação); null se não deu para contar. */
  elegiveis: number | null
  participacaoPercent: number | null
  medias: Record<ChaveNota, number | null>
  mediaGeral: number | null
  nps: { valor: number; promotores: number; neutros: number; detratores: number } | null
  /** Sem nome de quem escreveu; vazio quando há menos de 3 respondentes (anonimato). */
  comentarios: string[]
  /** true = há comentários, mas estão escondidos por haver poucos respondentes. */
  comentariosOcultos?: boolean
}

export const fetchResumoAvaliacao = (secret: string, competencia?: string) =>
  adminRequest<ResumoAvaliacao>(secret, `/avaliacoes-mensais${competencia ? `?competencia=${competencia}` : ""}`)
