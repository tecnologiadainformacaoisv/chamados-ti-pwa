// Agente de leitura de toners — roda DENTRO da rede da empresa.
//
// O painel (Cloudflare) não enxerga os IPs internos; este programa pergunta ao painel quais impressoras
// têm IP cadastrado, consulta cada uma por SNMP e devolve o nível de cada cor.
//
// Variáveis de ambiente:
//   WORKER_URL       endereço do Worker (ex.: https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev)
//   AGENTE_SECRET    o mesmo valor do segredo TONER_AGENT_SECRET configurado no Worker
//   INTERVALO_MIN    de quanto em quanto tempo consultar (padrão 30)
//   SNMP_COMMUNITY   comunidade SNMP das impressoras (padrão "public")
//
// Opções: --uma-vez (consulta e sai) · --simular (não usa SNMP: inventa níveis, para testar o caminho
// até o painel) · --seco (não envia nada, só mostra) · --diagnostico <ip> (mostra o que a impressora
// responde, para ajustar a leitura se algum modelo vier errado).

import snmp from 'net-snmp'
import { OID_SUPRIMENTOS, interpretarSuprimentos, separarOid } from './snmp-toner.mjs'

const args = process.argv.slice(2)
const tem = (f) => args.includes(f)
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '')
const SEGREDO = process.env.AGENTE_SECRET || ''
const INTERVALO_MS = Math.max(1, Number(process.env.INTERVALO_MIN) || 30) * 60_000
const COMUNIDADE = process.env.SNMP_COMMUNITY || 'public'
const CONCORRENCIA = 5

const log = (...m) => console.log(new Date().toLocaleString('pt-BR'), ...m)

function lerSnmp(ip) {
  return new Promise((resolve, reject) => {
    const sessao = snmp.createSession(ip, COMUNIDADE, { version: snmp.Version2c, timeout: 4000, retries: 1 })
    const linhas = []
    const brutas = []
    sessao.subtree(
      OID_SUPRIMENTOS,
      20,
      (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue
          const alvo = separarOid(vb.oid)
          if (!alvo) continue
          const valor = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8').replace(/\0/g, '').trim() : vb.value
          linhas.push({ ...alvo, valor })
          brutas.push(`${vb.oid} = ${JSON.stringify(valor)}`)
        }
      },
      (erro) => {
        sessao.close()
        if (erro) reject(erro)
        else resolve({ linhas, brutas })
      },
    )
  })
}

async function api(caminho, opcoes = {}) {
  const res = await fetch(`${WORKER_URL}${caminho}`, { ...opcoes, headers: { 'X-Agente-Secret': SEGREDO, 'Content-Type': 'application/json' } })
  const corpo = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`painel respondeu ${res.status}: ${corpo.error || 'sem detalhe'}`)
  return corpo
}

async function ciclo() {
  const { impressoras } = await api('/agente/impressoras')
  log(`${impressoras.length} impressora(s) com IP cadastrado`)
  const leituras = []
  const fila = [...impressoras]
  const trabalhadores = Array.from({ length: Math.min(CONCORRENCIA, fila.length) }, async () => {
    while (fila.length) {
      const imp = fila.shift()
      const nome = `${imp.tombamento || imp.id.slice(0, 8)} (${imp.ip})`
      try {
        let suprimentos
        if (tem('--simular')) {
          suprimentos = (imp.cores.length ? imp.cores : ['preto']).map((cor) => ({ cor, nivel: Math.floor(Math.random() * 101) }))
        } else {
          const { linhas } = await lerSnmp(imp.ip)
          suprimentos = interpretarSuprimentos(linhas).map(({ cor, nivel }) => ({ cor, nivel }))
          if (!suprimentos.length) throw new Error('a impressora respondeu, mas sem nível de toner reconhecível (rode --diagnostico)')
        }
        // Só manda as cores que têm toner cadastrado no painel (as outras seriam ignoradas).
        const uteis = imp.cores.length ? suprimentos.filter((s) => imp.cores.includes(s.cor)) : []
        log(`${nome}: ${suprimentos.map((s) => `${s.cor} ${s.nivel}%`).join(', ')}${uteis.length < suprimentos.length ? ' (algumas cores sem toner cadastrado)' : ''}`)
        if (uteis.length) leituras.push({ equipamento_id: imp.id, suprimentos: uteis })
      } catch (e) {
        log(`${nome}: falhou — ${e.message}`)
      }
    }
  })
  await Promise.all(trabalhadores)
  if (!leituras.length) return log('nada para enviar')
  if (tem('--seco')) return log(`(--seco) enviaria ${leituras.length} leitura(s)`)
  const r = await api('/agente/leituras', { method: 'POST', body: JSON.stringify({ leituras }) })
  log(`enviado: ${r.atualizados} toner(s) atualizados${r.ignorados?.length ? `, ${r.ignorados.length} ignorado(s): ${JSON.stringify(r.ignorados)}` : ''}`)
}

async function diagnostico(ip) {
  const { linhas, brutas } = await lerSnmp(ip)
  console.log(brutas.join('\n') || '(sem resposta da tabela de suprimentos)')
  console.log('\nInterpretado:', JSON.stringify(interpretarSuprimentos(linhas), null, 2))
}

async function principal() {
  const i = args.indexOf('--diagnostico')
  if (i >= 0) return diagnostico(args[i + 1])
  if (!WORKER_URL || !SEGREDO) {
    console.error('Defina WORKER_URL e AGENTE_SECRET (veja o README).')
    process.exit(1)
  }
  for (;;) {
    try {
      await ciclo()
    } catch (e) {
      log(`erro no ciclo: ${e.message}`)
      if (tem('--uma-vez')) process.exitCode = 1
    }
    if (tem('--uma-vez')) return
    await new Promise((r) => setTimeout(r, INTERVALO_MS))
  }
}

principal().catch((e) => {
  console.error(e)
  process.exit(1)
})
