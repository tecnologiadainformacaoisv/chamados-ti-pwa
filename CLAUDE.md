# Chamados de TI — ISV

> Arquivo de contexto para Claude Code. Leia este arquivo inteiro antes de qualquer tarefa.

---

## Visão geral do projeto

PWA de abertura e acompanhamento de chamados de suporte técnico do **Instituto São Vicente (ISV)**. Funciona direto no navegador, sem backend próprio — toda a persistência é feita via **API do ClickUp**. Usuários abrem chamados, acompanham o status e recebem notificações push quando há atualizações.

**Objetivo:** substituir comunicação informal (WhatsApp/verbal) com TI por um canal formal, rastreável e com SLA definido.

**Stack:** HTML + CSS + JS puro (sem framework), PWA com Service Worker, integração direta com a API REST do ClickUp, notificações push via Cloudflare Worker.

---

## Ecossistema (ISV / Desenvolvimento)

Este projeto faz parte da pasta `Desenvolvimento/`, que reúne os sistemas do Instituto São Vicente (ISV). Padrões compartilhados ficam em:

- **Comandos e agentes:** `~/.claude/` — `/atualizar`, `/encerrar`, agente `revisor`
- **Assets/estilos/componentes comuns:** `../shared/`
- **Referência de comandos:** `../COMANDOS-CLAUDE.md`

> ⚠️ **NÃO ler nem indexar as pastas dos outros projetos** (`projeto-*`, `pessoal-*`) a menos que explicitamente solicitado.

---

## Estrutura de arquivos

```
/
├── README.md           ← visão geral e instruções
├── CLAUDE.md           ← este arquivo
├── index.html          ← UI única (SPA sem roteador)
├── sw.js               ← service worker (cache offline + interceptação fetch) — escopo raiz
├── push-worker.js      ← fonte do Cloudflare Worker de push (deploy separado em workers.dev)
├── manifest.json       ← manifesto PWA
├── css/
│   └── style.css       ← estilos
├── js/
│   └── app.js          ← toda a lógica: state, API, render, eventos
└── assets/
    ├── icon.svg            ← ícone principal
    ├── icon-maskable.svg   ← ícone adaptável (Android)
    └── logo-isv.svg        ← logo do instituto
```

> ⚠️ `index.html`, `sw.js`, `manifest.json` e `push-worker.js` **permanecem na raiz**: o escopo do
> service worker é a pasta onde o `sw.js` está, e o GitHub Pages serve a partir da raiz.

---

## Arquitetura e integrações

### ClickUp como backend
- Não há banco de dados próprio. Cada chamado é uma **task do ClickUp** na lista `901324490220`.
- Campos customizados: `EMAIL`, `TIPO`, `SOLICITANTE`, `SETOR`, `SOLUCAO` (IDs em `FIELD_IDS` no app.js).
- A API key do ClickUp fica em `localStorage` (`cu_key`) — digitada na primeira vez pelo usuário ou pré-preenchida via query string `?key=...`.

### Notificações push
- Arquitetura: browser → Cloudflare Worker (`chamados-ti-push.tecnologiadainformacao-isv.workers.dev`) → Web Push.
- O Worker é acionado por uma automação do ClickUp quando o status do chamado muda.
- `VAPID_PUBLIC_KEY` e `APP_SHARED_SECRET` ficam hardcoded em `app.js` (não são credenciais de acesso a dados sensíveis — apenas identificam a chave pública VAPID).

### Mapeamento de dados (app.js)
| Constante | O que é |
|---|---|
| `TIPOS` | 8 categorias de chamado com prioridade automática |
| `SOLICITANTES` | Lista fechada de 40 colaboradores + "Outros" |
| `SETORES` | 9 setores da organização |
| `PRIORITY` | 3 níveis: Urgente (1h SLA), Alta (4h), Normal (24h) |
| `CATEGORIA_PRIORIDADE` | Mapeamento categoria → prioridade automática |
| `OPERADORES` | IDs ClickUp dos operadores de TI (Everson, Henrique) |
| `STATUS_MAP` | 4 status: aberto, em atendimento, pendente, encerrado |

---

## Fluxo do usuário

1. **Setup** — usuário seleciona seu nome e o app persiste em localStorage. API key vem por query string ou input manual.
2. **Tela principal** — exibe "Abrir Chamado" e "Meus Chamados" / "Meu Histórico".
3. **Abertura de chamado** — formulário com tipo, setor, descrição, anexo opcional (limite 10 MB). Ao submeter, cria task no ClickUp com prioridade automática baseada no tipo.
4. **Acompanhamento** — filtra as tasks do ClickUp pelo campo SOLICITANTE. Exibe status com SLA e indicação de atraso.
5. **Notificações** — ao autorizar, o browser se inscreve via `push-worker.js`; o Cloudflare Worker envia push quando o status muda.

---

## Regras de negócio que não devem ser alteradas sem perguntar

- **Prioridade é automática** — definida pelo tipo do chamado via `CATEGORIA_PRIORIDADE`. Não expor seleção manual de prioridade ao usuário.
- **Prioridade "Baixa" não existe** — nenhuma categoria mapeia para ela; o ClickUp a ignora neste contexto.
- **SLA exibido** é informativo (calculado no cliente com `task.due_date`); quem define o `due_date` real é o ClickUp via automação.
- **Lista de solicitantes** é fechada — adicionar ou remover nomes exige atualizar `SOLICITANTES` em `app.js` **e** o campo customizado correspondente no ClickUp.
- **Sincronização de status:** as chaves de `STATUS_MAP` em `app.js` devem ficar idênticas a `NOTIFY_STATUSES` em `push-worker.js`.
- **Sincronização de campo:** o field_id de `SOLICITANTE` deve ser idêntico em `FIELD_IDS` (app.js) e em `push-worker.js`.
- **Limite de anexo:** 10 MB por arquivo — validado no cliente antes do upload.

---

## Padrões de desenvolvimento

- Versionamento: **Semantic Versioning** (`MAJOR.MINOR.PATCH`); `MAJOR` = 0 enquanto pré-produção.
- Commits: **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
- Versão atual declarada em dois lugares — manter sincronizados: `<meta name="app-version">` em `index.html` e commits/tags git.
- Não introduzir frameworks ou bundlers sem decisão explícita — o projeto é propositalmente zero-dependência.
- Não usar `innerHTML` com dados do usuário sem escapar via `escHtml()`.

---

## Contexto organizacional

- **Organização:** Instituto São Vicente (ISV)
- **Responsável de TI:** Henrique (TI — ISV)
- **Operadores de TI no ClickUp:** Everson (`170628721`) e Henrique (`200498355`)
- **Público-alvo:** colaboradores administrativos, assistenciais e de suporte da ISV

---

## Estado atual do desenvolvimento

> Última atualização: 2026-06-26

- **Versão:** v0.2.1. Branch `main`. Pré-teste de usabilidade (UX já tratada para essa etapa).
- **PWA funcional** integrado ao ClickUp como backend (lista `901324490220`), sem banco próprio.
- **O que funciona hoje:**
  - Abertura de chamado com tipo/setor/descrição e **anexo opcional** (limite 10 MB; suporta colar print via Ctrl+V).
  - **Prioridade automática** pelo tipo do chamado (`CATEGORIA_PRIORIDADE`); prioridade "Baixa" não existe.
  - Acompanhamento "Meus Chamados"/"Meu Histórico" filtrando tasks pelo campo `SOLICITANTE`, com SLA informativo e indicação de atraso.
  - **SLA pausa em "Pendente"**; solução aplicada lida de campo customizado dedicado e destacada em chamados encerrados.
  - Visualização de anexo em modal central; WhatsApp roteado pelo operador atribuído.
  - **Notificações push** via Cloudflare Worker (`chamados-ti-push.tecnologiadainformacao-isv.workers.dev`), acionadas por automação do ClickUp na mudança de status.
- **Tratamento de erros amigável** e suporte offline básico implementados (v0.2.0).

## Decisões técnicas tomadas

- **ClickUp como backend** — cada chamado é uma task; sem banco de dados próprio. API key em `localStorage` (`cu_key`) ou via query string `?key=...`.
- **Zero dependências** — HTML/CSS/JS puro, sem framework/bundler (decisão explícita).
- **Push desacoplado** num Cloudflare Worker (`push-worker.js`, deploy separado em workers.dev); `VAPID_PUBLIC_KEY`/`APP_SHARED_SECRET` hardcoded por serem identificadores públicos.
- **Contratos de sincronização** que devem permanecer idênticos entre `app.js` e `push-worker.js`: chaves de `STATUS_MAP` ↔ `NOTIFY_STATUSES`, e o field_id de `SOLICITANTE` em `FIELD_IDS`.
- **Prioridade nunca é manual** — sempre derivada do tipo; não expor seletor de prioridade ao usuário.
- **Lista de solicitantes fechada** (40 nomes + "Outros") — alterar exige mexer em `SOLICITANTES` no `app.js` **e** no campo customizado do ClickUp.
- **Versão declarada em dois lugares** a manter sincronizados: `<meta name="app-version">` no `index.html` e tags/commits git.

## Próximos passos

1. **Concluir o teste de usabilidade** e incorporar o feedback antes de promover a versão.
2. Avaliar caminho para **v1.0** (primeiro deploy "oficial") quando a usabilidade estiver validada.
3. Possíveis melhorias futuras: histórico de notificações, métricas de SLA por operador, refinamento do fluxo offline.

> ⚠️ **Regra de commit/versão deste projeto:** nenhuma mudança (visual OU lógica) versiona/commita/pusha sozinha. Agrupar em lote e só quando o usuário sinalizar.
