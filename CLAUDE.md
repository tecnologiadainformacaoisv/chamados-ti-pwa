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
├── admin.html          ← painel de admin (fase 2) — página separada, não faz parte do PWA/manifest
├── sw.js               ← service worker (cache offline + interceptação fetch) — escopo raiz
├── push-worker.js      ← fonte do Cloudflare Worker de push (deploy automatizado, ver "Deploy do Worker")
├── wrangler.toml       ← config do Worker pro Wrangler (nome, entrypoint, binding do KV) — sem secrets
├── manifest.json       ← manifesto PWA
├── css/
│   ├── style.css       ← estilos do app principal
│   └── admin.css       ← estilos exclusivos do painel de admin (reaproveita tokens/componentes de style.css)
├── js/
│   ├── app.js          ← toda a lógica do app principal: state, API, render, eventos
│   └── admin.js        ← lógica do painel de admin: gate de segredo, filtros, métricas, tabela
├── tests/
│   ├── app.test.js         ← testes de js/app.js
│   └── push-worker.test.js ← testes do Worker (auth, isolamento entre solicitantes, rotas /admin/*)
└── assets/
    ├── icon.svg            ← ícone principal
    ├── icon-maskable.svg   ← ícone adaptável (Android)
    ├── favicon-isv.png     ← ícone da aba do navegador (logo ISV invertido pro fundo escuro)
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
- **Login com senha (pedido da diretoria, 2026-07-24):** ver seção "Autenticação" abaixo — identidade agora é decidida pelo Worker a partir do token de sessão, nunca pelo que o cliente alega.

### Autenticação
- **Motivo:** antes, qualquer um podia selecionar o nome de outra pessoa no seletor e ver os chamados dela — o Worker confiava cegamente em qual "solicitante" o navegador dizia ser. A diretoria pediu senha justamente pra impedir isso.
- **Sem banco novo** — reaproveita o mesmo KV `SUBSCRIPTIONS` do Worker, com prefixos de chave diferentes: `auth_<nome>` (senha), `session_<token>` (sessão), `loginfail_<nome>` (contador de tentativas erradas).
- **Senha:** PBKDF2-SHA256 (100.000 iterações), salt aleatório por pessoa. Formato de armazenamento autodescritivo (`{algo, iterations, salt, hash}`) — permite trocar de algoritmo/parâmetros no futuro sem invalidar senha de ninguém (rehash silencioso no próximo login bem-sucedido, se um dia for preciso).
- **Primeiro acesso = cadastro:** se `POST /auth/login` devolve 404 (sem senha cadastrada pra aquele nome), `app.js` chama `POST /auth/register` com a mesma senha digitada — não existe cadastro em separado.
- **Sessão:** token opaco de 256 bits, guardado em `localStorage.session_token`, válido por `SESSION_TTL_SECONDS` (90 dias) e mandado no header `X-Session-Token` em toda chamada a `/api/*` e `/subscribe`.
- **Identidade sempre resolvida no servidor:** `handleGetMyTasks`, `handleCreateTask`, `handleGetTask`, `handleUploadAttachment` e `handleSubscribe` nunca confiam em nenhum índice/nome que o cliente mande — resolvem a partir do `name` gravado na sessão. `handleCreateTask` **sobrescreve** SOLICITANTE **e** recalcula `priority`/`due_date` a partir do TIPO (mesma regra de `CATEGORIA_PRIORIDADE`/`PRIORITY` do app.js, duplicada no Worker) — sem isso, dava pra chamar o proxy direto com o `APP_SHARED_SECRET` (público por design) e forjar prioridade/prazo. `handleGetTask` e `handleUploadAttachment` confirmam que a task pertence a quem está logado antes de devolver/anexar (403 se não for dono).
- **Brute-force:** 5 tentativas erradas de senha bloqueiam novos logins daquele nome por 15min (`loginfail_<nome>`, expira sozinho). Senha mínima de 8 caracteres.
- **`hasValidSecret` falha fechado:** se `SUBSCRIBE_SECRET` não estiver configurado no Worker (deploy manual — dá pra esquecer), o proxy fica bloqueado por padrão, não aberto.
- **Esqueceu a senha / nome "roubado":** sem tela de admin — a TI apaga a chave `auth_<nome>` direto no painel do KV da Cloudflare, e a pessoa cadastra de novo no próximo login.
- **Não dá mais pra "trocar de nome"** nas configurações do app — quem você é vem da sessão autenticada. Pra usar como outra pessoa, precisa deslogar e logar com a senha dela.
- **`GET /admin/users`** (2026-07-24) — visão geral de quem já tem senha cadastrada (nome, `createdAt`, `lastLoginAt`; nunca hash/salt), protegida por `env.ADMIN_SECRET` (header `X-Admin-Secret`) — segredo **separado** do `APP_SHARED_SECRET`, nunca fica no app.js/navegador. Não é um painel visual, só um endpoint — a TI consulta via curl (ou uma páginazinha própria, se um dia quiser). Serve pra: acompanhar quem já entrou no rollout, e desconfiar/checar se alguém pode ter cadastrado o nome errado por engano.
- **`GET /admin/tasks` e `GET /admin/metrics`** (2026-08-06, Fase 1 do painel de admin) — mesma proteção por `ADMIN_SECRET`/`X-Admin-Secret` de `/admin/users`. `/admin/tasks` devolve todos os chamados da lista (paginando a ClickUp internamente via `fetchAllTasks`, não só a primeira página), com filtros opcionais por query string: `status`, `setor` (orderindex), `tipo` (orderindex), `operador` (id do assignee), `solicitante` (nome — resolvido pro orderindex real via `getSolicitanteMaps`, mesmo padrão anti-forjamento do resto do arquivo; nome inexistente devolve lista vazia, não erro). `/admin/metrics` devolve agregados: total por status (`porStatus`), volume por tipo/setor (`porTipo`/`porSetor`, chaves = orderindex — mapear pro nome no painel via `TIPOS`/`SETORES` de app.js), % dentro do SLA vs atrasado (`sla`, comparando `due_date` com `date_closed` pra encerrados ou "agora" pra tasks ainda abertas) e tempo médio de atendimento por operador (`tempoMedioPorOperador`, calculado como `date_closed - start_date` das tasks encerradas, agrupado pelo `id` de cada assignee).
- **`POST /admin/tasks/:id`** (2026-08-07) — única rota de admin que **muta** a ClickUp; mesma proteção `ADMIN_SECRET`. Body aceita qualquer subconjunto de `{ status, solucao, assigneeId }`: `status` dá um `PUT` direto na task (precisa ser um dos 4 valores de `VALID_STATUSES`); `solucao` grava no campo customizado SOLUCAO via `POST /task/:id/field/:field_id` (endpoint de campo da ClickUp é diferente do PUT geral de task); `assigneeId` busca quem já está atribuído e manda o diff `{add, rem}` pra ClickUp (ela não tem "set assignee", só add/rem) — `assigneeId: null` remove todo mundo que estava atribuído ("Sem atribuição" no painel). Não duplica a automação de SLA: mudar o status aqui já é suficiente pra disparar `runStatusAutomation`, porque ela reage ao webhook da automação configurada na ClickUp, que dispara em qualquer mudança de status — não importa se veio da UI dela ou da API.

### Painel de admin (`admin.html`/`admin.js`, Fase 2)
- Página separada do app principal, fora do `manifest.json`/`sw.js` (não é instalável, não é PWA) — só a TI acessa, direto pela URL do GitHub Pages (`/admin.html`).
- **O `ADMIN_SECRET` nunca é hardcoded em `admin.js`** — diferente do `APP_SHARED_SECRET` (que é público por design), o segredo de admin dá acesso a dados de todo mundo, então não pode estar em código público no GitHub Pages. Em vez disso: tela de "gate" pede o segredo, valida com um `GET /admin/users` (chamada leve, só lê o KV) e, se aceito, guarda em `localStorage.admin_secret` **do navegador de quem digitou** — nunca no código. Toda chamada a `/admin/*` manda esse valor no header `X-Admin-Secret`. Se o Worker responder 403 em qualquer chamada (segredo trocado/revogado), `admin.js` limpa o `localStorage` e volta pro gate.
- Consome `GET /admin/tasks` (tabela com filtros de status/setor/tipo/operador/solicitante) e `GET /admin/metrics` (cards de total por status, % dentro do SLA vs atrasado, volume por tipo/setor, tempo médio de atendimento por operador, gráfico donut de SLA em SVG puro). Lista de solicitantes pro filtro é buscada em runtime da ClickUp (`GET /api/field`, mesmo `APP_SHARED_SECRET` público do app principal — não precisa do `ADMIN_SECRET` pra isso).
- **Busca por título e exportação CSV são client-side** — sobre o resultado que o servidor já filtrou (`allTasks` em `admin.js`), sem endpoint novo nem nova chamada ao Worker a cada tecla digitada. CSV exporta o conjunto visível (filtros + busca), com BOM UTF-8 pra acentuação abrir certo no Excel, e prefixa com `'` qualquer célula que comece com `=`, `+`, `-`, `@` ou tab/CR — proteção contra "formula injection" (`task.name` é texto livre de qualquer solicitante; sem isso, um título de chamado como `=HYPERLINK(...)` viraria fórmula executável ao abrir o CSV no Excel).
- **Tabela agrupada por status, com expandir/recolher** (2026-08-07, pedido explícito pra ficar parecido com a própria tela da ClickUp) — substituiu a paginação global de 25/página: cada status (Aberto/Em Atendimento/Pendente/Encerrado) é uma seção própria, com ícone (círculo vazado pra Aberto, círculo com check colorido pros demais — mesmo padrão visual da ClickUp), contador e chevron que gira ao recolher (`groupCollapsed` em `admin.js`, lembra o estado entre re-renders da sessão). Sem coluna de Status na linha da task (fica implícito pelo grupo). Teto de 200 linhas por grupo (`GROUP_TABLE_LIMIT`), mesma ideia do teto de card do Quadro.
- **Prioridade e Tipo com a mesma linguagem visual da ClickUp** — Prioridade como bolinha colorida + label (reaproveita `.prio-dot` de `css/style.css`, já usado no app principal; cores vêm de `task.priority.priority`, valor bruto da ClickUp: urgent/high/normal/low). Tipo como chip colorido (`.tipo-chip`), reaproveitando as mesmas cores já usadas nos gráficos de "Volume por tipo".
- **Deixou de ser só leitura em 2026-08-07** — decisão do gestor: a TI (Everson/Henrique) para de abrir a ClickUp pra trabalhar e passa a aceitar chamado, mudar status, escrever solução e atribuir operador direto pelo painel (ver `POST /admin/tasks/:id` acima). A ClickUp **continua guardando o dado** (nenhuma migração, nenhuma automação de SLA reescrita) — só deixou de ser a *interface* de trabalho. Cada linha/card tem um botão "Gerenciar" que abre um modal (descrição, status/operador/solução) pré-preenchido com o estado atual do chamado. Se o chamado tiver 2+ operadores atribuídos, o modal avisa (só dá pra pré-selecionar 1 no campo) — e só manda `assigneeId` no `POST` se o admin realmente tocar nesse campo (`operadorTouched` em `admin.js`), senão os outros atribuídos ficam intactos (correção de 2026-08-07: antes disso, salvar qualquer campo do modal apagava silenciosamente um segundo operador já atribuído).
- **Navegação lateral (sidebar) recolhível, separando Gestão de Dashboard** (2026-08-07) — protótipo de navegação pra uma futura evolução em CRM completo (ver "Decisões técnicas tomadas" e a memória `future-crm-stack-decision`). **Gestão** (filtros, Quadro/Tabela, modal "Gerenciar") e **Dashboard** (métricas/gráficos) são seções separadas — filtros só existem em Gestão, já que `/admin/metrics` nunca dependeu de filtro. Estado (seção ativa, sidebar recolhida ou não, view Quadro/Tabela, grupos recolhidos na Tabela) persiste em `localStorage` entre sessões.
- **Quadro (Kanban) é a visão padrão** dentro de Gestão, com **arrastar-e-soltar entre colunas** — mover um card muda só o status (mesma rota `POST /admin/tasks/:id`, sem tocar operador/solução), convivendo com o clique-abre-modal (um drag de verdade não dispara `click` no navegador). Tabela fica a um clique, útil pra buscar/exportar muita coisa de uma vez. Cores dos ícones de status (`STATUS_MAP` em `admin.js`/`app.js`) foram confirmadas direto na configuração real da lista na ClickUp — "Aberto" é cinza (cor padrão do tipo "open" da própria ClickUp), não uma cor customizada.
- **`fetchAllTasks` (push-worker.js) tem teto de 20 páginas (~2000 chamados)** e devolve `truncated: true` em `/admin/tasks`/`/admin/metrics` se bater nesse teto — o painel mostra um banner de aviso quando isso acontece, em vez de mostrar dado incompleto sem avisar. `/admin/tasks` e `/admin/metrics` chamam essa função de forma independente (double-fetch); aceitável no volume atual, mas documentado como limitação conhecida pro dia que o volume crescer (ver comentário no código — a solução seria cachear por 15-30s no KV).
- **`ADMIN_SECRET` também tem lockout por IP** (`adminfail_<ip>`, 5 tentativas erradas / 15min, mesmo padrão do `loginfail_<nome>` de usuário) — só conta como tentativa quando o header `X-Admin-Secret` é mandado com valor errado; requisição sem esse header não conta (senão qualquer chamada "esquecendo" o header já contribuiria pro lockout).

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

## Deploy do Worker

- **Automatizado desde 2026-08-10** — substitui o processo antigo (colar `push-worker.js` inteiro no editor do dashboard da Cloudflare, sem CI/CD, que já causou mais de um "colei a versão errada" ao longo do projeto). Agora: `git push` na `main` que toque em `push-worker.js`, `wrangler.toml` ou no próprio workflow dispara `.github/workflows/deploy-worker.yml`, que roda `wrangler deploy` via `cloudflare/wrangler-action@v3`. Também pode ser disparado manualmente em Actions → "Deploy Cloudflare Worker" → Run workflow (`workflow_dispatch`).
- **Autenticação do pipeline:** `CLOUDFLARE_API_TOKEN` (token com o template "Edit Cloudflare Workers") e `CLOUDFLARE_ACCOUNT_ID`, guardados como secrets do repositório no GitHub (`gh secret set`) — nunca em arquivo versionado.
- **`wrangler.toml` não declara nenhum secret do Worker** (`CLICKUP_API_KEY`, `SUBSCRIBE_SECRET`, `ADMIN_SECRET`, `VAPID_PRIVATE_JWK`) — só `name`, `main` e o binding do KV `SUBSCRIPTIONS` (com o ID real da conta). Esses secrets continuam geridos manualmente (dashboard da Cloudflare ou `wrangler secret put`, uma vez só) — `wrangler deploy` nunca os toca, então não há risco do deploy automático apagar/sobrescrever nenhum deles.
- Testado de ponta a ponta em 2026-08-10: push → workflow disparado automaticamente → `wrangler deploy` publicado com sucesso → Worker respondendo em produção com os secrets intactos (confirmado via chamada real a `/admin/users`).

---

## Fluxo do usuário

1. **Login** — usuário seleciona seu nome (lista buscada em runtime do campo customizado SOLICITANTE na ClickUp) e digita sua senha. Primeira vez pra aquele nome: a senha digitada vira a senha de acesso (sem tela de cadastro separada). Não pede mais código de acesso — a chave da ClickUp nunca chega ao navegador (ver "ClickUp como backend" e "Autenticação").
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

> Última atualização: 2026-08-10

- **Versão:** v0.3.0. Branch `main`. Pré-teste de usabilidade (UX já tratada para essa etapa).
- **PWA funcional** integrado ao ClickUp como backend (lista `901324490220`), sem banco próprio.
- **O que funciona hoje:**
  - Abertura de chamado com tipo/setor/descrição e **anexo opcional** (limite 10 MB; suporta colar print via Ctrl+V).
  - **Prioridade automática** pelo tipo do chamado (`CATEGORIA_PRIORIDADE`); prioridade "Baixa" não existe.
  - Acompanhamento "Meus Chamados"/"Meu Histórico" filtrando tasks pelo campo `SOLICITANTE`, com SLA informativo e indicação de atraso.
  - **SLA pausa em "Pendente"**; solução aplicada lida de campo customizado dedicado e destacada em chamados encerrados.
  - Visualização de anexo em modal central; WhatsApp roteado pelo operador atribuído.
  - **Notificações push** via Cloudflare Worker (`chamados-ti-push.tecnologiadainformacao-isv.workers.dev`), acionadas por automação do ClickUp na mudança de status.
  - **Login com senha** (pedido da diretoria) — identidade decidida pelo Worker via sessão, ninguém vê chamado de outra pessoa mesmo selecionando o nome dela. Ver seção "Autenticação".
  - **Lista de solicitantes buscada em runtime da ClickUp** (`loadSolicitantes()`), com tela de boot/loading antes do login; sem mais array fixo pra manter sincronizado a cada colaborador novo.
  - **Painel de admin** (`admin.html`/`admin.js`) — deixou de ser só leitura: além de consumir `GET /admin/tasks`/`GET /admin/metrics`, agora tem `POST /admin/tasks/:id` pra mudar status, escrever solução e atribuir operador (botão "Gerenciar" por linha) — é onde a TI trabalha, sem precisar mais abrir a ClickUp. Ver "Painel de admin". Segredo de admin nunca fica no código, só no `localStorage` de quem loga na tela de gate.
- **Tratamento de erros amigável** e suporte offline básico implementados (v0.2.0) — obs: o boot atual (busca da lista de solicitantes) depende de rede mesmo pra quem já tinha configurado o app; ver "Próximos passos".
- **Testes unitários** em `tests/app.test.js` e `tests/push-worker.test.js` (sem dependências — `node vm`/`fetch` nativo + `assert`; rodar com `node tests/app.test.js` e `node tests/push-worker.test.js`).
- **Deploy do Worker automatizado** (2026-08-10) — `push-worker.js` deixou de ser colado manualmente no dashboard da Cloudflare; agora publica via Wrangler + GitHub Actions a cada push na `main`. Ver "Deploy do Worker".
- **🔥 Incidente de produção (2026-08-10): "Abrir Chamado" não funcionava pra ninguém.** Detectado no dia do rollout pra todo o escritório. Três causas, achadas e corrigidas na sequência (a 3ª era a raiz real):
  1. `sw.js` desviava do cache só pra `api.clickup.com`, domínio que o app não chama mais direto (fala com o Worker via `workers.dev` há muito tempo) — qualquer chamada de API, principalmente POST, caía num `caches.match()` que quebra com "Failed to fetch" ao tentar reler o corpo da requisição. Corrigido: bypass do cache pra qualquer chamada de API (não só `api.clickup.com`) e pra qualquer método != GET.
  2. Efeito colateral do próprio deploy automatizado: os 2 primeiros deploys via Wrangler apagaram `VAPID_PRIVATE_JWK`/`VAPID_PUBLIC_KEY` (não eram `secret_text`, não estavam declaradas no `wrangler.toml`, e não existia `keep_vars`). Corrigido com `keep_vars = true` (ver "Deploy do Worker") + par VAPID novo gerado (o antigo não tinha backup, foi perdido de vez) — quem já tinha push ativado precisou reabrir o app uma vez pra reinscrever.
  3. **Causa raiz real:** `handleCreateTask` grava um throttle anti-duplo-clique no KV com `expirationTtl: 10` — o Cloudflare KV exige mínimo de 60s, então esse `PUT` sempre falhava com 400, sem tratamento, derrubando a função antes de criar o chamado na ClickUp. Isso **sempre esteve quebrado desde que o throttle foi escrito**; só ficou visível agora porque o pipeline novo publicou, pela primeira vez de verdade, a versão atual do arquivo (deploys manuais anteriores estavam desatualizados e nunca chegaram a incluir essa linha em produção). Corrigido: TTL 10 → 60. O mock de KV nos testes (`makeMockKV`) ignorava `expirationTtl` por completo, deixando esse bug invisível em 106 testes que sempre passaram — reforçado pra validar isso de verdade (ver `tests/push-worker.test.js`).
  Diagnosticado com `wrangler tail` (log em tempo real do Worker em produção) — foi o que revelou a exceção real por trás do que os navegadores reportavam como bloqueio de CORS.

## Decisões técnicas tomadas

- **ClickUp como backend** — cada chamado é uma task; sem banco de dados próprio. A chave da API do ClickUp mora só no Cloudflare Worker (`env.CLICKUP_API_KEY`, secret) — `app.js` nunca a recebe; ele fala com `WORKER_URL/api/*`, autenticado por `APP_SHARED_SECRET` (header `X-App-Secret`), que o Worker valida contra `env.SUBSCRIBE_SECRET` antes de repassar pra ClickUp.
- **Zero dependências** — HTML/CSS/JS puro, sem framework/bundler (decisão explícita). Os testes usam só `node vm`/`fetch` nativo + `assert`, nada instalado.
- **Push e proxy da ClickUp desacoplados** no mesmo Cloudflare Worker (`push-worker.js`, deploy automatizado via Wrangler + GitHub Actions desde 2026-08-10 — ver "Deploy do Worker"); `VAPID_PUBLIC_KEY`/`APP_SHARED_SECRET` hardcoded em `app.js` por serem identificadores públicos/de baixo risco (não dão acesso à ClickUp por si só).
- **Contratos de sincronização** que devem permanecer idênticos entre `app.js` e `push-worker.js`: chaves de `STATUS_MAP` ↔ `NOTIFY_STATUSES`, e o field_id de `SOLICITANTE` em `FIELD_IDS`.
- **Prioridade nunca é manual** — sempre derivada do tipo; não expor seletor de prioridade ao usuário.
- **Login com senha, sem banco novo** — reaproveita o KV do Worker (`auth_<nome>`, `session_<token>`); senha em PBKDF2-SHA256 com formato autodescritivo (dá pra trocar de algoritmo/migrar de storage no futuro sem invalidar senha de ninguém — decisão tomada em 2026-07-24 pensando em evolução sem perda de acesso). Identidade sempre resolvida no servidor a partir da sessão, nunca do que o cliente manda — é isso que impede um solicitante ver/criar chamado como outro.
- **Lista de solicitantes buscada em runtime da ClickUp** — decisão tomada em 2026-07-23 após bug de nome trocado causado pela lista fixa desincronizar (ver `LEGACY_USER_IDX_TO_NAME` pra contexto da migração). Adicionar colaborador agora é só no ClickUp, sem tocar no código.
- **Versão declarada em três lugares** a manter sincronizados: `<meta name="app-version">` e o `<footer>` no `index.html`, e `APP_VERSION` no `sw.js` (esse último precisa mudar mesmo em fixes só de `app.js`, pra forçar a invalidação do cache do Service Worker). `admin.html`/`admin.js` ficam de fora dessa obrigação — página separada, sem versão própria declarada.
- **`ADMIN_SECRET` nunca é hardcoded em `admin.js`** — decisão tomada ao construir a Fase 2 (2026-08-06): diferente do `APP_SHARED_SECRET` (público por design, só libera o proxy), o segredo de admin dá acesso a dados de todo mundo, então não pode existir em código publicado no GitHub Pages. `admin.html` pede o segredo numa tela de gate e guarda só no `localStorage` de quem digitou.
- **Banco Cloudflare D1 provisionado em 2026-08-10, mas ainda não usado** — explorado como alternativa/complemento à ClickUp como backend (avaliado ao lado de Supabase e Turso; D1 escolhido pra esse teste por já ser nativo da mesma conta/plataforma do Worker, sem serviço/conta externa nova). Binding `CHAMADOS_DB` em `wrangler.toml` (banco `chamados-ti-db`). **Nenhuma lógica de chamado usa isso ainda** — `push-worker.js` continua 100% ClickUp como fonte de verdade. Migrar de fato é decisão futura separada, não tomada ainda (ver "Próximos passos").
- **Fase B2 do roadmap de modernização concluída (2026-08-11): camada de dados D1 escrita, testada, sem nenhuma rota usando ainda.** Schema em `d1/schema.sql` (tabela `chamados`, já aplicado no banco real via API da Cloudflare — confirmado com smoke test de CRUD completo direto no D1 de produção). Funções `d1CreateChamado`/`d1GetChamado`/`d1ListChamados`/`d1UpdateChamado`/`d1GetMetrics` em `push-worker.js`, exportadas mas não chamadas por nenhum handler — a ClickUp continua 100% a fonte de verdade em produção, isso é só preparação pra uma migração futura (B3 em diante). 16 testes novos em `tests/d1-layer.test.js`, usando `node:sqlite` (nativo do Node, zero dependência) rodando o mesmo `d1/schema.sql` real num banco em memória — testa as funções de produção de verdade, não uma reimplementação paralela. 122 testes no total (53+53+16), 0 falhando.
- **Fase B4 concluída (2026-08-11): camada de anexos R2 escrita, testada, sem nenhuma rota usando ainda.** Bucket `chamados-ti-anexos` criado (precisou habilitar R2 na conta antes — produto separado do D1/KV, pediu aceitar termos + cartão cadastrado, mesmo ficando dentro do free tier: 10GB/mês, bem acima do volume real do projeto). Binding `ANEXOS` em `wrangler.toml`. Funções `r2UploadAnexo`/`r2GetAnexo`/`r2DeleteAnexo` em `push-worker.js` — key com prefixo `chamados/<id>/<uuid>-<nome sanitizado>` (sanitização remove separador de caminho e `..`, evita path traversal via nome de arquivo enviado pelo cliente). `handleUploadAttachment` continua 100% ClickUp — nenhum anexo real sobe pro R2 ainda. 7 testes novos em `tests/r2-layer.test.js` (mock R2 em memória). 133 testes no total (53+57+16+7), 0 falhando. CRUD completo verificado direto no bucket de produção via API (upload/download/delete).
- **Fase B3 concluída (2026-08-11): migração de histórico executada — 178 de 447 chamados importados pro D1.** `POST /admin/migrate-d1` (protegida por `ADMIN_SECRET`, aceita `{dryRun:true}` pra simular sem gravar) lê tudo da ClickUp via `fetchAllTasks` e grava no D1 com `id = task_id da ClickUp` (preserva rastreabilidade), idempotente (`INSERT OR IGNORE` — rodar de nova não duplica). **Os 269 restantes não migraram por um motivo real, não um bug**: são chamados criados antes do app entrar em produção (todos de 2026-01 a metade de 2026-05), quando o campo SOLICITANTE simplesmente não existia/não era preenchido nas tasks criadas direto na ClickUp — confirmado investigando o campo bruto (nenhum é "índice órfão", é ausência de valor mesmo). A partir de 2026-06, 100% dos chamados têm SOLICITANTE preenchido (bate exatamente com o app já estar em uso). Nada se perde — os 269 continuam intactos na ClickUp, só não entraram no D1 por enquanto. 4 testes novos em `tests/push-worker.test.js` (403 sem segredo, dry-run não grava, migração real grava os campos certos, segunda rodada é idempotente). 126 testes no total (53+57+16), 0 falhando.

## Próximos passos

1. **Concluir o teste de usabilidade** e incorporar o feedback antes de promover a versão.
2. Avaliar caminho para **v1.0** (primeiro deploy "oficial") quando a usabilidade estiver validada.
3. **`POST /webhook` não tem autenticação** — diferente de toda outra rota, aceita qualquer POST sem checar segredo/assinatura. Quem souber a URL do Worker (hardcoded em `app.js`, pública) e um `task_id` real pode forjar uma mudança de status e disparar a automação de SLA/push. Corrigir exige também mudar a URL configurada na automação do ClickUp (coordenar antes de implementar).
4. **Nota de atendimento no chamado encerrado** (sugerida, não implementada) — 1 a 5 estrelas ou 👍/👎 quando o usuário abre um chamado recém-encerrado; precisa de campo novo na ClickUp + endpoint novo no Worker.
5. **Decisão de arquitetura (2026-08-03, revisada em 2026-08-07): ClickUp continua guardando o dado, mas a TI para de usar a interface dela pra trabalhar.** A decisão original (2026-08-03) era só um painel de leitura por cima da ClickUp; em 2026-08-07 o gestor definiu o objetivo real: Everson/Henrique deixam de abrir a ClickUp no dia a dia — aceitar chamado, mudar status, escrever solução e atribuir operador passam a ser feitos direto no painel de admin, que muta a ClickUp por trás via Worker. **Não é migração de backend** (os 436+ chamados existentes, os campos customizados, a automação de SLA — nada disso muda ou é reescrito); é só a *interface de trabalho* que troca de lugar.
   - ✅ **Fase 1 (2026-08-06):** endpoints de leitura no Worker — `GET /admin/users` (já existia), mais `GET /admin/tasks` (todos os chamados, com filtros) e `GET /admin/metrics` (agregados de SLA/volume/tempo de atendimento). Ver "Autenticação". Testado, implantado e publicado.
   - ✅ **Fase 2 (2026-08-06):** frontend próprio (`admin.html`/`admin.js`/`css/admin.css`, mesma filosofia zero-dependência) consumindo esses endpoints — tela de gate pro `ADMIN_SECRET` (nunca hardcoded, ver "Painel de admin"), cards de métricas, filtros e tabela de chamados.
   - ✅ **Fase 3 (2026-08-06):** busca por título + paginação na tabela, exportação CSV e gráfico de SLA nativo (SVG puro, sem lib) — tudo client-side, sem endpoint novo no Worker.
   - 🛡️ **Auditoria do agente `revisor` (2026-08-06)** sobre as Fases 1-3: nada crítico (sem quebra de isolamento, sem `ADMIN_SECRET` exposto, sem XSS). Corrigido: formula-injection na exportação CSV, teto silencioso de `fetchAllTasks` (agora avisa via `truncated`), falta de lockout no `ADMIN_SECRET` (agora tem, por IP). Documentado como limitação conhecida (não corrigido, baixo risco no volume atual): double-fetch entre `/admin/tasks`/`/admin/metrics`.
   - ✅ **Fase 4 (2026-08-07): primeira rota que muta a ClickUp — `POST /admin/tasks/:id`.** Status, solução (campo customizado) e atribuição de operador, com modal de gerenciamento por chamado no painel (botão "Gerenciar" em cada linha/card). Reaproveita a automação de SLA já existente (`runStatusAutomation`) sem duplicar lógica — ela dispara pelo webhook da automação da ClickUp, que reage a qualquer mudança de status, API ou UI. Testado (mock de fetch/KV + verificação end-to-end no Chromium via Playwright).
   - ✅ **Quadro (Kanban) + sidebar + drag-and-drop (2026-08-07)** — ver "Painel de admin" pra detalhes. Quadro é a visão padrão, com arrastar-e-soltar mudando status; sidebar separa Gestão de Dashboard; cores de status confirmadas direto na ClickUp via MCP.
   - 🛡️ **Auditoria do agente `revisor` (2026-08-07)** sobre a Fase 4 + Quadro/sidebar/drag-and-drop: nada crítico de segurança novo. Achado mais grave (corrigido): o modal "Gerenciar" sempre mandava `assigneeId` no `POST`, então salvar qualquer campo (ex.: só status) num chamado com 2+ operadores atribuídos apagava um deles em silêncio — agora só manda esse campo se o admin realmente tocá-lo (`operadorTouched`), e o modal avisa quando há múltiplos atribuídos. Também corrigido: validação de tipo de `solucao`/`assigneeId` no Worker (antes aceitava valor errado sem avisar), modal não assume mais "Aberto" em silêncio pra status desconhecido (avisa), cor do "Aberto" sincronizada entre `app.js`/`admin.js`, `viewMode`/grupos recolhidos da Tabela agora persistem em `localStorage`. Documentado como limitação aceita (não corrigido): as 3 sub-mutações de `POST /admin/tasks/:id` não são atômicas (sem rollback entre elas, já que cada uma é uma chamada separada à ClickUp) — em caso de falha no meio, a resposta de erro agora inclui `updated` com o que já tinha sido aplicado, pra não mascarar estado parcial.
   - ⏳ **Ainda não implementado:** exportar/reatribuir em lote (várias tasks de uma vez), histórico de quem mudou o quê (a ClickUp guarda isso nativamente, mas o painel não expõe), qualquer validação de transição de status (o painel aceita qualquer um dos 4 status a qualquer momento, igual a própria ClickUp permite pela UI dela), suporte de verdade a múltiplos operadores atribuídos no modal (hoje só pré-seleciona 1 e avisa se houver mais), e testes automatizados pro `admin.js` (busca/paginação por grupo/Kanban/drag-and-drop hoje dependem só de verificação manual via Playwright).
6. Possíveis melhorias futuras: histórico de notificações, refinamento do fluxo offline.

> ⚠️ **Regra de commit/versão deste projeto:** nenhuma mudança (visual OU lógica) versiona/commita/pusha sozinha, **exceto durante a janela de prazo pedida pelo usuário em 2026-08-06/07** (projeto precisava estar pronto até 2026-08-07) — nesse período, comitar/publicar direto após verificar (testes + Chromium), sem pausar pra confirmar. Fora dessa janela, volta a valer agrupar em lote e só publicar quando o usuário sinalizar.
