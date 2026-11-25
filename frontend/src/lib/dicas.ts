// Dicas para o solicitante tentar ANTES de abrir o chamado (2026-11-26). Escritas a partir dos problemas que
// mais se repetiram no histórico de chamados, em linguagem para quem é leigo. São texto fixo de propósito:
// nada do histórico (nomes, dados internos) é mostrado, e o repositório é público.
// Regra para incluir uma dica: a pessoa consegue fazer sozinha, sem risco de piorar o problema.

export type Dica = {
  id: string
  titulo: string
  passos: string[]
  /** Quando chamar a TI sem insistir. */
  aviso?: string
  /** Tipos de solicitação (orderindex) em que a dica é mais provável: só desempata. */
  tipos: number[]
  /** Testadas contra o texto digitado, já em minúsculas e sem acento. */
  quando: RegExp[]
  /** Se bater, a dica não vale (outro aparelho, outro assunto). */
  exceto?: RegExp
}

// Água, queimado, faísca: nenhuma dica de "tente de novo". Só desligar e chamar a TI.
const PERIGO = /\bagua\b|molh|liquido|derram|\b(cafe|suco)\b.*(caiu|notebook|teclado|computador)|(caiu|virou).*\b(cafe|suco)\b|queimad|queimando|fumaca|faisca|\bchoque|derret/
export const DICA_PERIGO: Dica = {
  id: "perigo",
  titulo: "Pare e chame a TI",
  passos: [
    "Não ligue o aparelho nem coloque para carregar.",
    "Se der para fazer sem encostar em nada molhado ou quente, tire da tomada.",
    "Abra o chamado e avise a TI na hora, pessoalmente ou por WhatsApp.",
  ],
  tipos: [],
  quando: [],
}

// Pedido (acesso, instalação, compra) sem sinal de defeito não recebe dica.
const PEDIDO = /\b(instalar|instalacao|criar|criacao|liberar|liberacao|comprar|compra|acesso|solicit\w*|atualizar|cadastr\w*)\b/
const DEFEITO = /\bnao\b|\bsem\b|erro|falh|parou|parad|trav|lent|pres[oa]|obstru|acaband|acabou|frac|listr|caiu|fora|chei|lotad|piscand|manchad|desconect/

// A ordem importa: em empate, vale a primeira (as específicas vêm antes das gerais).
export const DICAS: Dica[] = [
  {
    id: "papel-preso",
    titulo: "Papel preso na impressora",
    passos: [
      "Olhe na tela da impressora onde ela diz que o papel está preso.",
      "Abra só as tampas e bandejas indicadas e puxe o papel devagar, com as duas mãos, para não rasgar.",
      "Confira se a pilha de papel está alinhada, sem folha amassada, e com as travas da bandeja encostadas nela.",
      "Feche tudo e envie a impressão de novo.",
    ],
    aviso: "Não use tesoura ou objeto de metal, e não toque em partes quentes. Se rasgar um pedaço lá dentro ou travar de novo, abra o chamado.",
    tipos: [1],
    quando: [/papel (preso|atolad|enroscad)/, /\batol(ad|am|ou|and)/, /obstru/, /(folhas?|papel).*(presa|preso|prendendo|amassa)/],
  },
  {
    id: "toner",
    titulo: "Toner acabando ou impressão clara",
    passos: [
      "Retire o toner com cuidado (a tela ou a tampa da impressora mostra como).",
      "Balance de um lado para o outro, deitado, umas 5 vezes. Isso espalha o pó que sobrou.",
      "Coloque de volta até encaixar e faça uma impressão de teste.",
    ],
    aviso: "Não sopre nem abra o toner: o pó faz sujeira e faz mal se respirado. É um quebra-galho: abra o chamado para a TI repor.",
    tipos: [1],
    quando: [/\bton+er/, /impress(ao|oes).*(clara|fraca|apagad)/],
    exceto: /epson|tinta/,
  },
  {
    id: "tinta-falhas",
    titulo: "Impressão com listras, manchas ou cor errada",
    passos: [
      "Veja se o nível de tinta está baixo nos reservatórios (na Epson dá para ver pela frente).",
      "Confira se o papel é o certo e está seco, sem estar amassado.",
      "Imprima uma única página de teste para ver se o problema continua.",
    ],
    aviso: "Não coloque tinta por conta própria nem faça várias limpezas seguidas, porque gasta tinta e pode piorar. Abra o chamado.",
    tipos: [1],
    quando: [/listra/, /manchad|borrad/, /falh\w* .*impress|impress\w* .*falh/, /cor(es)? (errad|incorret|diferent)/, /tinta/, /(impress\w*|copias?|folhas?|saindo).*em branco/],
    exceto: /\btela\b|monitor/,
  },
  {
    id: "scanner",
    titulo: "Problema para escanear",
    passos: [
      "Confira se as folhas estão na bandeja de cima viradas para o lado certo (veja o desenho na bandeja) ou bem encostadas no vidro.",
      "Veja se o vidro está limpo, passando um pano seco e macio.",
      "Salve o que está fazendo, reinicie a impressora e o computador e tente de novo.",
      "Procure o arquivo também na pasta de digitalizações: às vezes ele foi salvo em outro lugar.",
    ],
    tipos: [1],
    quando: [/scan+/, /escane/, /digitaliz/],
  },
  {
    id: "nao-imprime",
    titulo: "A impressora não imprime",
    passos: [
      "Veja se a impressora está ligada e se não há aviso na tela dela (papel, toner, tampa aberta).",
      "Confira se o cabo de força e o cabo de rede (ou USB) estão bem encaixados.",
      "Desligue a impressora, espere 30 segundos e ligue de novo.",
      "No computador, confira se você escolheu a impressora certa na hora de imprimir.",
      "Salve o que está fazendo, reinicie o computador e envie só uma vez: mandar várias vezes trava a fila.",
    ],
    tipos: [1],
    quando: [
      /nao (esta |ta |estou |consigo |conseguindo |sai|saiu)*\s*(a )?imprim/,
      /impressora.*(parad|parou|offline|off\b|nao funciona|sem funcionar|travad|piscando|erro)/,
      /erro (de|na|ao) impr/,
      /imprim\w* (lent|sozinha)/,
      /impressora.*nao (esta |ta )?lig/,
    ],
  },
  {
    id: "internet",
    titulo: "Sem internet ou Wi-Fi",
    passos: [
      "Veja se o Wi-Fi do computador está ligado e conectado na rede certa.",
      "Se usa cabo, confira se está bem encaixado dos dois lados.",
      "Desligue e ligue o Wi-Fi. Se não voltar, salve o que está fazendo e reinicie o computador.",
      "Pergunte a um colega do lado se a internet dele funciona e conte isso no chamado.",
    ],
    tipos: [2],
    quando: [/internet/, /wi-?fi/, /(sem|caiu a?) ?(rede|conexao)/, /problema (de|na) (rede|conexao)/],
  },
  {
    id: "site",
    titulo: "Site que não abre ou dá erro",
    passos: [
      "Abra outro site para ver se o problema é só nesse.",
      "Atualize a página segurando Ctrl e apertando F5.",
      "Tente em outro navegador (Chrome ou Edge) ou numa janela anônima.",
    ],
    aviso: "Sites do governo e de bancos às vezes ficam fora do ar para todos. Nesse caso só resta esperar um pouco e tentar de novo.",
    tipos: [2, 3],
    quando: [/\bsite/, /pagina (nao|fora)/, /fora do ar/, /navegador|chrome/],
  },
  {
    id: "plataformas",
    titulo: "OMIE, Zappy ou outra plataforma com problema",
    passos: [
      "Saia da conta, feche o navegador e entre de novo.",
      "Tente numa janela anônima do navegador.",
      "Pergunte a um colega se está funcionando para ele: se não estiver para ninguém, provavelmente a plataforma está instável.",
    ],
    aviso: "Não crie conta nova. Se for pedido de acesso ou de permissão, é só abrir o chamado.",
    tipos: [7, 3],
    quando: [/(omie|zappy|dominio|multi ?(integrada|sus))\b.*(nao|erro|lent|trav|fora|instav)/, /(nao|erro|lent|instav).*\b(omie|zappy|multi ?integrada)\b/],
  },
  {
    id: "nao-liga",
    titulo: "Computador ou notebook não liga",
    passos: [
      "Confira se o carregador está na tomada e no notebook, e teste em outra tomada.",
      "Deixe carregando por 10 minutos antes de tentar ligar.",
      "Segure o botão de ligar por 15 segundos, solte e ligue normalmente.",
    ],
    aviso: "Se houver cheiro de queimado, líquido derramado ou o aparelho esquentar muito, desligue da tomada e chame a TI.",
    tipos: [0],
    quando: [/nao (esta |ta |quer )?(liga|ligando)\b/, /tela preta/],
    exceto: /impressora|\bar\b|condicionado|telefone|\btv\b|televis|ventilador|\bluz/,
  },
  {
    id: "lento",
    titulo: "Computador lento ou travando",
    passos: [
      "Salve o que está fazendo e reinicie (use Reiniciar, não só Desligar nem fechar a tampa).",
      "Feche as abas e programas que não está usando.",
      "Deixe as atualizações terminarem, se o computador pedir.",
    ],
    tipos: [0],
    quando: [/(computador|notebook|note\b|maquina|sistema|pc\b).*(lent|trav|reiniciando)/, /(lent|travando|travamento)\w*.*(computador|notebook|note\b|maquina|sistema|pc\b)/, /^travando|^travamento/],
  },
  {
    id: "mouse-teclado",
    titulo: "Mouse ou teclado falhando",
    passos: [
      "Troque a pilha, se for sem fio.",
      "Tire o receptor ou o cabo USB e coloque em outra entrada.",
      "Teste o mouse em outra superfície (vidro e mesa brilhante atrapalham).",
    ],
    tipos: [6],
    quando: [/mouse/, /teclado/, /teclas?\b/],
  },
  {
    id: "audio",
    titulo: "Microfone ou som não funciona",
    passos: [
      "Confira se não está no mudo, no computador, no fone e na reunião.",
      "Na reunião, abra as configurações e escolha o microfone e a saída de som certos.",
      "Se o navegador perguntar, permita o uso do microfone.",
      "Desconecte o fone, conecte de novo e reinicie o programa.",
    ],
    tipos: [0, 6],
    quando: [/microfone/, /sem (som|audio)\b|\b(som|audio) nao/, /\bfones?\b/],
  },
  {
    id: "armazenamento",
    titulo: "E-mail ou Drive cheio",
    passos: [
      "Olhe a Lixeira e o Spam: se não houver nada importante lá, esvazie (não dá para recuperar depois).",
      "Procure e-mails com anexos grandes e apague só o que tiver certeza de que não precisa.",
      "No Drive, veja os arquivos maiores e a lixeira.",
    ],
    aviso: "Na dúvida, ou se mais gente usa essa caixa, não apague nada: abra o chamado.",
    tipos: [5],
    quando: [/(e-?mail|drive|armazenamento|caixa de (e-?mail|entrada)).*(chei|lotad|limite|espaco)/, /(chei|sem espaco|armazenamento).*(e-?mail|drive|nuvem)/],
  },
  {
    id: "word",
    titulo: "Símbolos estranhos ou linhas vermelhas no Word",
    passos: [
      "Pontinhos e o símbolo ¶ no texto: clique no botão ¶, na aba Página Inicial, para esconder.",
      "Linha vermelha em tudo: na aba Revisão, em Idioma, escolha Português (Brasil).",
    ],
    tipos: [3],
    quando: [/word.*(simbolo|linha|vermelh|sublinhad)/, /(simbolo|linha vermelha).*(word|texto|palavra)/],
  },
  {
    id: "planilha",
    titulo: "Planilha saindo cortada ou fora de ordem",
    passos: [
      "Para imprimir: em Arquivo, Imprimir, escolha ajustar a planilha em uma página e a orientação Paisagem.",
      "Linhas sumidas ou fora de ordem: confira se há um filtro ligado, na aba Dados.",
    ],
    tipos: [3],
    quando: [/(planilha|excel).*(imprim|impress|cortad|ordem|filtro|ajust)/, /(imprim|ajust)\w*.*(planilha|excel)/],
  },
]

const MAX_DICAS = 2

export function semAcento(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

/** Até duas dicas para o texto digitado. Sem palavra reconhecida, nenhuma (o tipo sozinho não basta). */
export function dicasPara(texto: string, tipo?: number): Dica[] {
  const t = semAcento(texto)
  if (t.length < 4) return []
  if (PERIGO.test(t)) return [DICA_PERIGO]
  if (PEDIDO.test(t) && !DEFEITO.test(t)) return []
  return DICAS.map((dica, ordem) => {
    if (dica.exceto?.test(t)) return { dica, ordem, pontos: 0 }
    const acertos = dica.quando.filter((r) => r.test(t)).length
    return { dica, ordem, pontos: acertos ? acertos + (tipo != null && dica.tipos.includes(tipo) ? 0.5 : 0) : 0 }
  })
    .filter((d) => d.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || a.ordem - b.ordem)
    .slice(0, MAX_DICAS)
    .map((d) => d.dica)
}
