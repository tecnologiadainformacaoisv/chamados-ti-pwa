// Testes da leitura (sem rede, sem dependência): node teste.mjs
import assert from 'node:assert'
import { corDaDescricao, nivelPercentual, interpretarSuprimentos, separarOid } from './snmp-toner.mjs'

const linha = (chave, classe, tipo, desc, max, level) => [
  { coluna: 4, chave, valor: classe }, { coluna: 5, chave, valor: tipo }, { coluna: 6, chave, valor: desc },
  { coluna: 8, chave, valor: max }, { coluna: 9, chave, valor: level },
]

// cores
assert.equal(corDaDescricao('Black Toner Cartridge TN-1060'), 'preto')
assert.equal(corDaDescricao('Cartucho de toner preto'), 'preto')
assert.equal(corDaDescricao('Cyan Toner'), 'ciano')
assert.equal(corDaDescricao('Magenta toner'), 'magenta')
assert.equal(corDaDescricao('Yellow Ink'), 'amarelo')
assert.equal(corDaDescricao('K'), 'preto')
assert.equal(corDaDescricao('Toner Cartridge'), null)
assert.equal(corDaDescricao('Drum Unit DR-1060 (comprimento)'), null) // "m" solto dentro de frase não é magenta
assert.equal(corDaDescricao(undefined), null)

// nível
assert.equal(nivelPercentual(50, 100), 50)
assert.equal(nivelPercentual(130, 2600), 5)
assert.equal(nivelPercentual(0, 2600), 0)
assert.equal(nivelPercentual(-2, 100), null) // desconhecido
assert.equal(nivelPercentual(-3, 100), null) // "resta algum"
assert.equal(nivelPercentual(10, 0), null)
assert.equal(nivelPercentual(300, 100), 100) // nunca passa de 100

// OID
assert.deepEqual(separarOid('1.3.6.1.2.1.43.11.1.1.9.1.1'), { coluna: 9, chave: '1.1' })
assert.deepEqual(separarOid('1.3.6.1.2.1.43.11.1.1.6.1.4'), { coluna: 6, chave: '1.4' })
assert.equal(separarOid('1.3.6.1.2.1.1.1.0'), null)

// monocromática: um toner sem cor na descrição vale como preto; caixa de resíduo e tambor ficam de fora
let r = interpretarSuprimentos([
  ...linha('1.1', 3, 3, 'Toner Cartridge', 2600, 780),
  ...linha('1.2', 4, 4, 'Waste Toner Box', 100, 20),
  ...linha('1.3', 3, 9, 'Drum Unit', 12000, 9000),
])
assert.deepEqual(r, [{ cor: 'preto', nivel: 30, descricao: 'Toner Cartridge' }])

// colorida: 4 cores, uma desconhecida (-2) fica de fora
r = interpretarSuprimentos([
  ...linha('1.1', 3, 21, 'Black Toner', 100, 80),
  ...linha('1.2', 3, 21, 'Cyan Toner', 100, 10),
  ...linha('1.3', 3, 21, 'Magenta Toner', 100, 0),
  ...linha('1.4', 3, 21, 'Yellow Toner', 100, -2),
])
assert.deepEqual(r.map((x) => [x.cor, x.nivel]).sort(), [['ciano', 10], ['magenta', 0], ['preto', 80]])

// sem a coluna Type: reconhece pela descrição
r = interpretarSuprimentos([
  { coluna: 6, chave: '1.1', valor: 'Black Cartridge' }, { coluna: 8, chave: '1.1', valor: 100 }, { coluna: 9, chave: '1.1', valor: 42 },
  { coluna: 6, chave: '1.2', valor: 'Fuser Kit' }, { coluna: 8, chave: '1.2', valor: 100 }, { coluna: 9, chave: '1.2', valor: 99 },
])
assert.deepEqual(r.map((x) => [x.cor, x.nivel]), [['preto', 42]])

// cor repetida: vale o menor nível
r = interpretarSuprimentos([...linha('1.1', 3, 3, 'Black Toner', 100, 60), ...linha('1.2', 3, 3, 'Black Toner (reserva)', 100, 15)])
assert.deepEqual(r.map((x) => [x.cor, x.nivel]), [['preto', 15]])

// nada reconhecível
assert.deepEqual(interpretarSuprimentos([]), [])

console.log('agente-toners: leitura ok')

// descoberta
import { parseSysDescr, ipsDaRede } from './snmp-toner.mjs'
assert.deepEqual(parseSysDescr('Lexmark MX622adhe version MXTCT.081.226 kernel 5.4'), { marca: 'Lexmark', modelo: 'MX622adhe' })
assert.deepEqual(parseSysDescr('HP LaserJet Pro M404dn'), { marca: 'HP', modelo: 'LaserJet Pro M404dn' })
assert.deepEqual(parseSysDescr(''), { marca: null, modelo: null })
const ips = ipsDaRede('10.10.0.0/22')
assert.equal(ips.length, 1022)
assert.equal(ips[0], '10.10.0.1')
assert.equal(ips.at(-1), '10.10.3.254')
assert.deepEqual(ipsDaRede('10.0.0.0/8'), []) // grande demais
assert.deepEqual(ipsDaRede('lixo'), [])
console.log('agente-toners: descoberta ok')
