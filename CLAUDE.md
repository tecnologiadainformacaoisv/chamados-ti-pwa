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
├── push-worker.js      ← fonte do Cloudflare Worker de push (deploy separado em workers.dev)
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

### Painel de admin (`admin.html`/`admin.js`, Fase 2)
- Página separada do app principal, fora do `manifest.json`/`sw.js` (não é instalável, não é PWA) — só a TI acessa, direto pela URL do GitHub Pages (`/admin.html`).
- **O `ADMIN_SECRET` nunca é hardcoded em `admin.js`** — diferente do `APP_SHARED_SECRET` (que é público por design), o segredo de admin dá acesso a dados de todo mundo, então não pode estar em código público no GitHub Pages. Em vez disso: tela de "gate" pede o segredo, valida com um `GET /admin/users` (chamada leve, só lê o KV) e, se aceito, guarda em `localStorage.admin_secret` **do navegador de quem digitou** — nunca no código. Toda chamada a `/admin/*` manda esse valor no header `X-Admin-Secret`. Se o Worker responder 403 em qualquer chamada (segredo trocado/revogado), `admin.js` limpa o `localStorage` e volta pro gate.
- Consome `GET /admin/tasks` (tabela com filtros de status/setor/tipo/operador/solicitante) e `GET /admin/metrics` (cards de total por status, % dentro do SLA vs atrasado, volume por tipo/setor, tempo médio de atendimento por operador, gráfico donut de SLA em SVG puro). Lista de solicitantes pro filtro é buscada em runtime da ClickUp (`GET /api/field`, mesmo `APP_SHARED_SECRET` público do app principal — não precisa do `ADMIN_SECRET` pra isso).
- **Busca por título, paginação e exportação CSV são client-side** — sobre o resultado que o servidor já filtrou (`allTasks` em `admin.js`), sem endpoint novo nem nova chamada ao Worker a cada tecla digitada. Paginação fixa em 25 linhas/página. CSV exporta o conjunto visível (filtros + busca, todas as páginas), com BOM UTF-8 pra acentuação abrir certo no Excel.
- Continua **só leitura** — sem ações que alterem chamado (reatribuir operador etc.); isso é o que resta da Fase 3, e não foi implementado ainda porque exigiria endpoint novo mutando dados reais da ClickUp (decisão deliberada, ver "Próximos passos").

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

> Última atualização: 2026-08-06

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
  - **Painel de admin** (`admin.html`/`admin.js`) — tela própria de leitura consumindo `GET /admin/tasks`/`GET /admin/metrics` (backend Fase 1 + frontend Fase 2, ver "Painel de admin"). Segredo de admin nunca fica no código, só no `localStorage` de quem loga na tela de gate.
- **Tratamento de erros amigável** e suporte offline básico implementados (v0.2.0) — obs: o boot atual (busca da lista de solicitantes) depende de rede mesmo pra quem já tinha configurado o app; ver "Próximos passos".
- **Testes unitários** em `tests/app.test.js` e `tests/push-worker.test.js` (sem dependências — `node vm`/`fetch` nativo + `assert`; rodar com `node tests/app.test.js` e `node tests/push-worker.test.js`).

## Decisões técnicas tomadas

- **ClickUp como backend** — cada chamado é uma task; sem banco de dados próprio. A chave da API do ClickUp mora só no Cloudflare Worker (`env.CLICKUP_API_KEY`, secret) — `app.js` nunca a recebe; ele fala com `WORKER_URL/api/*`, autenticado por `APP_SHARED_SECRET` (header `X-App-Secret`), que o Worker valida contra `env.SUBSCRIBE_SECRET` antes de repassar pra ClickUp.
- **Zero dependências** — HTML/CSS/JS puro, sem framework/bundler (decisão explícita). Os testes usam só `node vm`/`fetch` nativo + `assert`, nada instalado.
- **Push e proxy da ClickUp desacoplados** no mesmo Cloudflare Worker (`push-worker.js`, deploy separado em workers.dev — colar manualmente no editor do dashboard, sem CI/CD); `VAPID_PUBLIC_KEY`/`APP_SHARED_SECRET` hardcoded em `app.js` por serem identificadores públicos/de baixo risco (não dão acesso à ClickUp por si só).
- **Contratos de sincronização** que devem permanecer idênticos entre `app.js` e `push-worker.js`: chaves de `STATUS_MAP` ↔ `NOTIFY_STATUSES`, e o field_id de `SOLICITANTE` em `FIELD_IDS`.
- **Prioridade nunca é manual** — sempre derivada do tipo; não expor seletor de prioridade ao usuário.
- **Login com senha, sem banco novo** — reaproveita o KV do Worker (`auth_<nome>`, `session_<token>`); senha em PBKDF2-SHA256 com formato autodescritivo (dá pra trocar de algoritmo/migrar de storage no futuro sem invalidar senha de ninguém — decisão tomada em 2026-07-24 pensando em evolução sem perda de acesso). Identidade sempre resolvida no servidor a partir da sessão, nunca do que o cliente manda — é isso que impede um solicitante ver/criar chamado como outro.
- **Lista de solicitantes buscada em runtime da ClickUp** — decisão tomada em 2026-07-23 após bug de nome trocado causado pela lista fixa desincronizar (ver `LEGACY_USER_IDX_TO_NAME` pra contexto da migração). Adicionar colaborador agora é só no ClickUp, sem tocar no código.
- **Versão declarada em três lugares** a manter sincronizados: `<meta name="app-version">` e o `<footer>` no `index.html`, e `APP_VERSION` no `sw.js` (esse último precisa mudar mesmo em fixes só de `app.js`, pra forçar a invalidação do cache do Service Worker). `admin.html`/`admin.js` ficam de fora dessa obrigação — página separada, sem versão própria declarada.
- **`ADMIN_SECRET` nunca é hardcoded em `admin.js`** — decisão tomada ao construir a Fase 2 (2026-08-06): diferente do `APP_SHARED_SECRET` (público por design, só libera o proxy), o segredo de admin dá acesso a dados de todo mundo, então não pode existir em código publicado no GitHub Pages. `admin.html` pede o segredo numa tela de gate e guarda só no `localStorage` de quem digitou.

## Próximos passos

1. **Concluir o teste de usabilidade** e incorporar o feedback antes de promover a versão.
2. Avaliar caminho para **v1.0** (primeiro deploy "oficial") quando a usabilidade estiver validada.
3. **`POST /webhook` não tem autenticação** — diferente de toda outra rota, aceita qualquer POST sem checar segredo/assinatura. Quem souber a URL do Worker (hardcoded em `app.js`, pública) e um `task_id` real pode forjar uma mudança de status e disparar a automação de SLA/push. Corrigir exige também mudar a URL configurada na automação do ClickUp (coordenar antes de implementar).
4. **Nota de atendimento no chamado encerrado** (sugerida, não implementada) — 1 a 5 estrelas ou 👍/👎 quando o usuário abre um chamado recém-encerrado; precisa de campo novo na ClickUp + endpoint novo no Worker.
5. **Decisão de arquitetura (alinhada com o gestor, 2026-08-03): ClickUp permanece como backend.** Em vez de trocar de backend pra escalar, o caminho escolhido é construir um **painel de admin** por cima do que já existe, em fases.
   - ✅ **Fase 1 (2026-08-06):** endpoints de backend no Worker — `GET /admin/users` (já existia), mais `GET /admin/tasks` (todos os chamados, com filtros) e `GET /admin/metrics` (agregados de SLA/volume/tempo de atendimento). Ver "Autenticação". Testado, implantado e publicado.
   - ✅ **Fase 2 (2026-08-06):** frontend próprio (`admin.html`/`admin.js`/`css/admin.css`, mesma filosofia zero-dependência) consumindo esses endpoints — tela de gate pro `ADMIN_SECRET` (nunca hardcoded, ver "Painel de admin"), cards de métricas, filtros e tabela de chamados.
   - 🔶 **Fase 3 (2026-08-06, parcial):** busca por título + paginação na tabela, exportação CSV e gráfico de SLA nativo (SVG puro, sem lib) — tudo client-side, sem endpoint novo no Worker. **Falta**: ações rápidas (reatribuir operador etc.) — deliberadamente não implementado ainda, porque exigiria um endpoint novo que *muta* chamado real na ClickUp (diferente de tudo que existe em `/admin/*` até aqui, que é só leitura); requer decisão explícita antes de implementar.
6. Possíveis melhorias futuras: histórico de notificações, refinamento do fluxo offline.

> ⚠️ **Regra de commit/versão deste projeto:** nenhuma mudança (visual OU lógica) versiona/commita/pusha sozinha. Agrupar em lote e só quando o usuário sinalizar.
