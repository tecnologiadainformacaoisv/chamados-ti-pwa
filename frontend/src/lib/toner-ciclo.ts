// Regra de situação do toner (estudo do OS800, 2026-11-17).
//
// O OS800 mostra Críticos ("recarga imediata"), Atenção ("recarga em breve") e OK
// ("dentro do ciclo"), mais a "média de ciclo entre recargas". A regra abaixo é nossa:
//   * ciclo = média dos intervalos entre recargas seguidas; com menos de 2 recargas,
//     usa o ciclo padrão cadastrado no toner; sem nenhum dos dois, "sem dados".
//   * uso = dias desde a última recarga / ciclo
//   * uso >= 100% → crítico; >= 80% → atenção; senão ok.
//
// Leitura pelo IP (2026-11-23): quando o agente da rede interna leu o nível da impressora há
// pouco, o NÍVEL manda (<= 10% crítico, <= 25% atenção) e o ciclo vira só informação. Uma leitura
// vale por 48 h e não vale se for anterior à última recarga (toner novo, leitura velha).
// Função pura, sem dependência do React, pra testar fácil.

export type SituacaoToner = "critico" | "atencao" | "ok" | "sem_dados"

export const LIMITE_ATENCAO = 0.8
export const LIMITE_CRITICO = 1
export const NIVEL_CRITICO = 10
export const NIVEL_ATENCAO = 25
export const LEITURA_VALIDADE_MS = 48 * 60 * 60 * 1000

export type Leitura = { nivel: number | null | undefined; lidoEm: number | null | undefined }

const DIA_MS = 24 * 60 * 60 * 1000

/** Média em dias entre recargas seguidas. `null` se houver menos de 2 recargas. */
export function cicloMedioDias(recargasMs: number[]): number | null {
  const ordenadas = recargasMs.filter(Number.isFinite).sort((a, b) => a - b)
  if (ordenadas.length < 2) return null
  let soma = 0
  for (let i = 1; i < ordenadas.length; i++) soma += ordenadas[i] - ordenadas[i - 1]
  return soma / (ordenadas.length - 1) / DIA_MS
}

export type CalculoToner = {
  situacao: SituacaoToner
  cicloDias: number | null
  diasDesdeRecarga: number | null
  /** 0..n (1 = ciclo inteiro consumido). `null` sem dados. */
  uso: number | null
  /** Dias até o fim previsto do ciclo (negativo = já passou). */
  diasRestantes: number | null
  /** Nível lido da impressora (0-100), só quando a leitura ainda vale; senão null. */
  nivel: number | null
  /** Hora da última leitura, mesmo quando já não vale (para avisar "desatualizada"). */
  lidoEm: number | null
  /** true = a situação veio do nível lido; false = veio do ciclo de recargas. */
  porLeitura: boolean
}

export function calcularToner(
  recargasMs: number[],
  cicloPadraoDias: number | null | undefined,
  agoraMs: number = Date.now(),
  leitura?: Leitura | null,
): CalculoToner {
  const validas = recargasMs.filter(Number.isFinite)
  const ultima = validas.length ? Math.max(...validas) : null
  const ciclo = cicloMedioDias(validas) ?? (cicloPadraoDias && cicloPadraoDias > 0 ? cicloPadraoDias : null)

  const lidoEm = leitura?.lidoEm != null && Number.isFinite(leitura.lidoEm) ? leitura.lidoEm : null
  const nivelLido = leitura?.nivel != null && Number.isFinite(leitura.nivel) ? leitura.nivel : null
  const leituraVale =
    nivelLido != null && lidoEm != null && agoraMs - lidoEm <= LEITURA_VALIDADE_MS && (ultima == null || lidoEm >= ultima)

  const dias = ultima == null ? null : Math.max(0, (agoraMs - ultima) / DIA_MS)
  const uso = dias == null || ciclo == null ? null : dias / ciclo
  const diasRestantes = dias == null || ciclo == null ? null : ciclo - dias
  const base = { cicloDias: ciclo, diasDesdeRecarga: dias, uso, diasRestantes, lidoEm }

  if (leituraVale) {
    const situacao: SituacaoToner = nivelLido! <= NIVEL_CRITICO ? "critico" : nivelLido! <= NIVEL_ATENCAO ? "atencao" : "ok"
    return { ...base, situacao, nivel: nivelLido, porLeitura: true }
  }
  if (uso == null) return { ...base, situacao: "sem_dados", nivel: null, porLeitura: false }
  const situacao: SituacaoToner = uso >= LIMITE_CRITICO ? "critico" : uso >= LIMITE_ATENCAO ? "atencao" : "ok"
  return { ...base, situacao, nivel: null, porLeitura: false }
}

/** Média geral de ciclo (cartão "Média ciclo"), ignorando toners sem dados. */
export function mediaGeralCiclo(calculos: CalculoToner[]): number | null {
  const ciclos = calculos.map((c) => c.cicloDias).filter((c): c is number => c != null)
  if (!ciclos.length) return null
  return ciclos.reduce((a, b) => a + b, 0) / ciclos.length
}
