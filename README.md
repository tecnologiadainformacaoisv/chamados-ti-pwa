# Chamados de TI — ISV

PWA de abertura e acompanhamento de chamados de suporte técnico do **Instituto São Vicente (ISV)**. Funciona direto no navegador, **sem backend próprio** — a persistência é feita via **API do ClickUp** (lista `901324490220`), com notificações push via Cloudflare Worker.

**Stack:** HTML + CSS + JS vanilla · Service Worker (offline) · API REST do ClickUp · Web Push.

## Estrutura

```
projeto-chamados-ti-pwa/
├── README.md       ← este arquivo
├── CLAUDE.md       ← contexto para o Claude Code
├── index.html      ← UI única (SPA sem roteador)
├── sw.js           ← service worker (escopo raiz)
├── push-worker.js  ← fonte do Cloudflare Worker de push (deploy separado)
├── manifest.json   ← manifesto PWA
├── css/style.css   ← estilos
├── js/app.js       ← lógica: state, API ClickUp, render, eventos
└── assets/         ← ícones e logo (svg)
```

> Os entrypoints (`index.html`, `sw.js`, `manifest.json`, `push-worker.js`) ficam na raiz por exigência do escopo do Service Worker e do GitHub Pages.

## Como usar / desenvolver

Servir a pasta (o SW exige `http`, não funciona em `file://`):

```bash
python -m http.server 8000
# acesse http://localhost:8000
```

A API key do ClickUp é digitada na primeira vez (guardada em `localStorage`) ou passada via `?key=...`.

## Notificações push

Arquitetura: browser → Cloudflare Worker (`chamados-ti-push.tecnologiadainformacao-isv.workers.dev`) → Web Push, acionado por automação do ClickUp na mudança de status. As chaves de status em `js/app.js` (`STATUS_MAP`) devem ficar idênticas a `NOTIFY_STATUSES` em `push-worker.js`.

---

Versionamento: [Semantic Versioning](https://semver.org/lang/pt-BR/) (versão atual em `<meta name="app-version">` e `APP_VERSION` no `sw.js`) · Commits: [Conventional Commits](https://www.conventionalcommits.org/pt-br/)
