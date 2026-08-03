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
- **O navegador nunca recebe a chave da API do ClickUp.** Toda chamada de `app.js` (`apiRequest`) vai pro Cloudflare Worker (`push-worker.js`, rotas `/api/*`), que injeta `env.CLICKUP_API_KEY` (secret, só existe no Worker) antes de repassar pra `api.clickup.com`. O que `app.js` manda é só `APP_SHARED_SECRET` num header (`X-App-Secret`), que só libera o uso do proxy — não dá acesso à ClickUp por si só.
- **Segurança básica do Worker:** CORS restrito a `ALLOWED_ORIGIN` (só o domínio do GitHub Pages, não mais `*`) e throttle de 10s por solicitante em `/api/tasks` (POST), reaproveitando o KV `SUBSCRIPTIONS` já usado pro dedup da automação — evita duplo-clique virar chamado duplicado e freia flood sem precisar de infra nova.

### Notificações push
- Arquitetura: browser → Cloudflare Worker (`chamados-ti-push.tecnologiadainformacao-isv.workers.dev`) → Web Push.
- O Worker é acionado por uma automação do ClickUp quando o status do chamado muda.
- O mesmo Worker também faz o proxy autenticado das rotas `/api/*` descrito acima (ver "ClickUp como backend").
- `VAPID_PUBLIC_KEY` e `APP_SHARED_SECRET` ficam hardcoded em `app.js` (não são credenciais de acesso a dados sensíveis — `APP_SHARED_SECRET` só libera o proxy, não substitui a chave real da ClickUp, que fica só no Worker).

### Mapeamento de dados (app.js)
| Constante | O que é |
|---|---|
| `TIPOS` | 8 categorias de chamado com prioridade automática |
| `SETORES` | 9 setores da organização |
| `PRIORITY` | 3 níveis: Urgente (1h SLA), Alta (4h), Normal (24h) |
| `CATEGORIA_PRIORIDADE` | Mapeamento categoria → prioridade automática |
| `OPERADORES` | IDs ClickUp dos operadores de TI (Everson, Henrique) |
| `STATUS_MAP` | 4 status: aberto, em atendimento, pendente, encerrado |

---

## Fluxo do usuário

1. **Setup** — usuário seleciona seu nome (lista buscada em runtime do campo customizado SOLICITANTE na ClickUp — ver seção "Lista de solicitantes" abaixo) e o app persiste em localStorage. Não pede mais código de acesso — a chave da ClickUp nunca chega ao navegador (ver "ClickUp como backend").
2. **Tela principal** — exibe "Abrir Chamado" e "Meus Chamados" / "Meu Histórico".
3. **Abertura de chamado** — formulário com tipo, setor, descrição, anexo opcional (limite 10 MB). Ao submeter, cria task no ClickUp com prioridade automática baseada no tipo.
4. **Acompanhamento** — filtra as tasks do ClickUp pelo campo SOLICITANTE. Exibe status com SLA e indicação de atraso.
5. **Notificações** — ao autorizar, o browser se inscreve via `push-worker.js`; o Cloudflare Worker envia push quando o status muda.

---

## Regras de negócio que não devem ser alteradas sem perguntar

- **Prioridade é automática** — definida pelo tipo do chamado via `CATEGORIA_PRIORIDADE`. Não expor seleção manual de prioridade ao usuário.
- **Prioridade "Baixa" não existe** — nenhuma categoria mapeia para ela; o ClickUp a ignora neste contexto.
- **SLA exibido** é informativo (calculado no cliente com `task.due_date`); quem define o `due_date` real é o ClickUp via automação (`push-worker.js`). Existem **duas fases de prazo distintas**, não uma só:
  - **Aceitação** (Aberto → Em Atendimento): contada da criação do chamado. Urgente 1h / Alta 4h / Normal 24h — vem de `PRIORITY.slaMs` em `app.js`.
  - **Finalização** (Em Atendimento → Encerrado): contada do momento em que o operador marca "Em Atendimento" (não da criação). Se a task tiver `time_estimate` preenchido manualmente na ClickUp, ele tem prioridade; senão, cai no padrão por prioridade em `DEFAULT_TIME_ESTIMATE_MS` (`push-worker.js`): **Urgente 15min / Alta 30min / Normal 1h**. "Baixa" não tem padrão (prioridade não usada pelo app).
- **Lista de solicitantes é buscada em runtime direto do campo customizado SOLICITANTE na ClickUp** (`loadSolicitantes()` em `app.js`) — não existe mais array fixo no código. Adicionar/renomear alguém só na ClickUp já é suficiente; não precisa mais editar nem publicar o app. `localStorage.user_name` guarda o nome (string), não mais um índice numérico. Existe uma tabela de migração (`LEGACY_USER_IDX_TO_NAME`) só pra traduzir o índice antigo de quem configurou o app antes da v0.2.5 — essa tabela é histórica e não deve ser editada.
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

> Última atualização: 2026-07-24

- **Versão:** v0.2.6. Branch `main`. Pré-teste de usabilidade (UX já tratada para essa etapa).
- **PWA funcional** integrado ao ClickUp como backend (lista `901324490220`), sem banco próprio.
- **O que funciona hoje:**
  - Abertura de chamado com tipo/setor/descrição e **anexo opcional** (limite 10 MB; suporta colar print via Ctrl+V).
  - **Prioridade automática** pelo tipo do chamado (`CATEGORIA_PRIORIDADE`); prioridade "Baixa" não existe.
  - Acompanhamento "Meus Chamados"/"Meu Histórico" filtrando tasks pelo campo `SOLICITANTE`, com SLA informativo e indicação de atraso.
  - **SLA pausa em "Pendente"**; solução aplicada lida de campo customizado dedicado e destacada em chamados encerrados.
  - Visualização de anexo em modal central; WhatsApp roteado pelo operador atribuído.
  - **Notificações push** via Cloudflare Worker (`chamados-ti-push.tecnologiadainformacao-isv.workers.dev`), acionadas por automação do ClickUp na mudança de status.
  - **Login sem código de acesso**, e sem chave da ClickUp em nenhum lugar do navegador — `app.js` fala só com o Worker, que faz o proxy autenticado pra ClickUp (`/api/*`, ver "ClickUp como backend").
  - **Lista de solicitantes buscada em runtime da ClickUp** (`loadSolicitantes()`), com tela de boot/loading antes do setup; sem mais array fixo pra manter sincronizado a cada colaborador novo.
- **Tratamento de erros amigável** e suporte offline básico implementados (v0.2.0) — obs: o boot atual (busca da lista de solicitantes) depende de rede mesmo pra quem já tinha configurado o app; ver "Próximos passos".
- **Testes unitários** em `tests/app.test.js` (sem dependências — `node vm`+`assert`; rodar com `node tests/app.test.js`).

## Decisões técnicas tomadas

- **ClickUp como backend** — cada chamado é uma task; sem banco de dados próprio. A chave da API do ClickUp mora só no Cloudflare Worker (`env.CLICKUP_API_KEY`, secret) — `app.js` nunca a recebe; ele fala com `WORKER_URL/api/*`, autenticado por `APP_SHARED_SECRET` (header `X-App-Secret`), que o Worker valida contra `env.SUBSCRIBE_SECRET` antes de repassar pra ClickUp.
- **Zero dependências** — HTML/CSS/JS puro, sem framework/bundler (decisão explícita). `tests/app.test.js` usa só `node vm`+`assert`, nada instalado.
- **Push e proxy da ClickUp desacoplados** no mesmo Cloudflare Worker (`push-worker.js`, deploy separado em workers.dev — colar manualmente no editor do dashboard, sem CI/CD); `VAPID_PUBLIC_KEY`/`APP_SHARED_SECRET` hardcoded em `app.js` por serem identificadores públicos/de baixo risco (não dão acesso à ClickUp por si só).
- **Contratos de sincronização** que devem permanecer idênticos entre `app.js` e `push-worker.js`: chaves de `STATUS_MAP` ↔ `NOTIFY_STATUSES`, e o field_id de `SOLICITANTE` em `FIELD_IDS`.
- **Prioridade nunca é manual** — sempre derivada do tipo; não expor seletor de prioridade ao usuário.
- **Lista de solicitantes buscada em runtime da ClickUp** — decisão tomada em 2026-07-23 após bug de nome trocado causado pela lista fixa desincronizar (ver `LEGACY_USER_IDX_TO_NAME` pra contexto da migração). Adicionar colaborador agora é só no ClickUp, sem tocar no código.
- **Versão declarada em três lugares** a manter sincronizados: `<meta name="app-version">` e o `<footer>` no `index.html`, e `APP_VERSION` no `sw.js` (esse último precisa mudar mesmo em fixes só de `app.js`, pra forçar a invalidação do cache do Service Worker).

## Próximos passos

1. **Concluir o teste de usabilidade** e incorporar o feedback antes de promover a versão.
2. Avaliar caminho para **v1.0** (primeiro deploy "oficial") quando a usabilidade estiver validada.
3. Possíveis melhorias futuras: histórico de notificações, métricas de SLA por operador, refinamento do fluxo offline.

> ⚠️ **Regra de commit/versão deste projeto:** nenhuma mudança (visual OU lógica) versiona/commita/pusha sozinha. Agrupar em lote e só quando o usuário sinalizar.
