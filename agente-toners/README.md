# Agente de leitura de toners

O painel de Chamados de TI roda na nuvem e **não enxerga os IPs internos** da empresa. Este programa roda
**dentro da rede**: pergunta ao painel quais impressoras têm IP cadastrado, consulta cada uma por SNMP e envia
o nível de cada cor. Os níveis aparecem na tela **Toners** do admin ("Nível 18% · lido há 2 h").

Enquanto uma leitura é recente (menos de 48 h), o nível manda na situação do toner (10% ou menos é crítico,
25% ou menos é atenção). Sem leitura, vale o ciclo das recargas registradas, como antes.

## O que precisa ser feito uma vez

1. **No Worker**, criar o segredo `TONER_AGENT_SECRET` (um texto longo e aleatório, só para este agente):
   `npx wrangler secret put TONER_AGENT_SECRET` na pasta do projeto, ou pelo painel da Cloudflare.
   Sem ele, as rotas do agente respondem 403 (propositalmente: falha fechado).
2. **No painel**, em Inventário, preencher o **IP** de cada impressora, e em Toners cadastrar o toner de cada cor.
   O agente só envia as cores que têm toner cadastrado.
3. **Nas impressoras**, conferir que o SNMP está ligado (a maioria vem com a comunidade `public` de leitura).
4. **Num computador sempre ligado na rede das impressoras**, com Node 20 ou mais novo:
   ```powershell
   cd agente-toners
   npm install
   $env:WORKER_URL = "https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev"
   $env:AGENTE_SECRET = "o mesmo valor de TONER_AGENT_SECRET"
   node agente.mjs --uma-vez      # primeira rodada, para conferir
   node agente.mjs                # fica rodando (consulta a cada 30 minutos)
   ```

## Opções

| Opção | O que faz |
|---|---|
| `--uma-vez` | consulta uma vez e sai (bom para o Agendador de Tarefas do Windows) |
| `--simular` | não usa SNMP: inventa níveis, só para testar o caminho até o painel |
| `--seco` | consulta, mostra, mas não envia nada |
| `--diagnostico 192.168.0.10` | mostra o que a impressora responde, para ajustar a leitura se algum modelo vier errado |

Variáveis opcionais: `INTERVALO_MIN` (padrão 30) e `SNMP_COMMUNITY` (padrão `public`).

## Se uma impressora não aparecer

Rode `node agente.mjs --diagnostico <ip>` e veja o bloco "Interpretado". Se vier vazio, a impressora não
respondeu à tabela padrão de suprimentos (Printer-MIB) ou o SNMP está desligado/com outra comunidade.
Cada modelo pode descrever o toner de um jeito; a interpretação está em `snmp-toner.mjs` e tem testes (`npm test`).

## Segurança

- O segredo do agente só serve para duas rotas (`/agente/impressoras` e `/agente/leituras`). Não dá acesso ao painel.
- O agente só **faz consultas de saída** (para o painel e para as impressoras); não abre nenhuma porta.
- Não coloque o segredo em arquivo do repositório (ele é público). Use variável de ambiente.
