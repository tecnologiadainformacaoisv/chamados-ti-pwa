// Interpretação da tabela de suprimentos de impressoras (Printer-MIB, RFC 3805).
// Funções PURAS, sem rede: recebem as linhas já lidas por SNMP e devolvem o nível de cada cor.
//
// prtMarkerSuppliesTable = 1.3.6.1.2.1.43.11.1.1.<coluna>.<hrDeviceIndex>.<prtMarkerSuppliesIndex>
//   4 = Class     (3 = supplyThatIsConsumed; 4 = receptacleThatIsFilled, ex.: caixa de resíduo)
//   5 = Type      (3 toner, 4 wasteToner, 5 ink, 6 inkCartridge, 21 tonerCartridge, ...)
//   6 = Description
//   8 = MaxCapacity
//   9 = Level     (-1 other, -2 unknown, -3 "ainda resta algum", >= 0 na unidade da tabela)

export const OID_SUPRIMENTOS = '1.3.6.1.2.1.43.11.1.1'

const TIPOS_CONSUMIVEL = new Set([3, 5, 6, 21]) // toner, ink, inkCartridge, tonerCartridge
const TIPOS_RESIDUO = new Set([4, 8, 14, 24, 26])

const CORES = [
  ['preto', /\b(black|preto|negro|noir|bk|k)\b/i],
  ['ciano', /\b(cyan|ciano|c)\b/i],
  ['magenta', /\b(magenta|m)\b/i],
  ['amarelo', /\b(yellow|amarelo|y)\b/i],
]

/** "Black Toner Cartridge" -> "preto". null quando a descrição não diz a cor. */
export function corDaDescricao(descricao) {
  const d = String(descricao ?? '')
  // letras soltas (k, c, m, y) só valem quando a descrição inteira é curta, ex.: "K", "C"
  for (const [cor, re] of CORES) {
    const palavras = d.match(re)
    if (palavras && (palavras[0].length > 1 || d.trim().length <= 3)) return cor
  }
  return null
}

/** Nível em % (0-100, inteiro) a partir de Level e MaxCapacity. null = a impressora não informa. */
export function nivelPercentual(level, max) {
  if (!Number.isFinite(level) || level < 0) return null // -1 outro, -2 desconhecido, -3 "resta algum"
  if (!Number.isFinite(max) || max <= 0) return null
  return Math.max(0, Math.min(100, Math.round((level / max) * 100)))
}

/**
 * linhas: [{ coluna: number, chave: string, valor: number | string }] — `chave` é "<dev>.<idx>".
 * Devolve [{ cor, nivel, descricao }] só dos consumíveis de toner/tinta com cor identificada
 * e nível conhecido. Impressora monocromática cuja descrição não cita a cor vale como "preto".
 */
export function interpretarSuprimentos(linhas) {
  const porChave = new Map()
  for (const l of linhas) {
    if (!porChave.has(l.chave)) porChave.set(l.chave, {})
    porChave.get(l.chave)[l.coluna] = l.valor
  }
  const itens = []
  for (const [, c] of porChave) {
    const tipo = Number(c[5])
    const classe = Number(c[4])
    const descricao = c[6] == null ? '' : String(c[6])
    if (TIPOS_RESIDUO.has(tipo)) continue
    if (Number.isFinite(classe) && classe !== 3) continue // só o que é consumido (não o que se enche)
    // Sem a coluna Type, aceita o que a descrição chama de toner/cartucho/tinta.
    const consumivel = TIPOS_CONSUMIVEL.has(tipo) || (!Number.isFinite(tipo) && /toner|cartu|cartridge|ink|tinta/i.test(descricao))
    if (!consumivel) continue
    itens.push({ descricao, nivel: nivelPercentual(Number(c[9]), Number(c[8])), cor: corDaDescricao(descricao) })
  }
  // Monocromática: um único consumível sem cor na descrição é o preto.
  if (itens.length === 1 && itens[0].cor == null) itens[0].cor = 'preto'
  // Uma cor aparece uma vez só (se a impressora repetir, vale o menor nível: o pior caso).
  const porCor = new Map()
  for (const i of itens) {
    if (i.cor == null || i.nivel == null) continue
    const atual = porCor.get(i.cor)
    if (!atual || i.nivel < atual.nivel) porCor.set(i.cor, i)
  }
  return [...porCor.values()].map(({ cor, nivel, descricao }) => ({ cor, nivel, descricao }))
}

/** Separa "<OID base>.<coluna>.<dev>.<idx>" em { coluna, chave }. null se o OID não é da tabela. */
export function separarOid(oid, base = OID_SUPRIMENTOS) {
  if (!oid.startsWith(base + '.')) return null
  const [coluna, ...resto] = oid.slice(base.length + 1).split('.')
  if (!/^\d+$/.test(coluna) || resto.length === 0) return null
  return { coluna: Number(coluna), chave: resto.join('.') }
}

/** "Lexmark MX622adhe version MXTCT.081.226 ..." -> { marca: "Lexmark", modelo: "MX622adhe" }. */
export function parseSysDescr(texto) {
  const t = String(texto ?? '').replace(/\0/g, '').trim()
  const m = /^(\S+)\s+(.+?)(?:\s+(?:version|ver\.?|v\d)\b.*)?$/i.exec(t)
  if (!m) return { marca: null, modelo: null }
  return { marca: m[1].slice(0, 60), modelo: m[2].slice(0, 80) }
}

/** Endereços (IPv4) de uma rede "a.b.c.d/p", sem o de rede e o de broadcast. Limita a /22 (1022 hosts). */
export function ipsDaRede(cidr) {
  const [base, pStr] = String(cidr).split('/')
  const partes = base.split('.').map(Number)
  const p = Number(pStr)
  if (partes.length !== 4 || partes.some((n) => !Number.isInteger(n) || n < 0 || n > 255) || !Number.isInteger(p) || p < 22 || p > 30) return []
  const num = ((partes[0] << 24) | (partes[1] << 16) | (partes[2] << 8) | partes[3]) >>> 0
  const mascara = (0xffffffff << (32 - p)) >>> 0
  const rede = (num & mascara) >>> 0
  const total = 2 ** (32 - p)
  const ips = []
  for (let i = 1; i < total - 1; i++) {
    const n = (rede + i) >>> 0
    ips.push(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`)
  }
  return ips
}
