# Chamados de TI — Front-end (React)

Reescrita em React do painel de admin (`admin.html`/`admin.js` na raiz do
repositório) — parte do roadmap de modernização documentado em `CLAUDE.md`.

**Status: Fase F1 (setup) — só o shell visual, sem dados reais ainda.**
`admin.html` continua sendo o painel de admin em produção; nada aqui está
publicado ou ligado a nada além de um ambiente local.

## Stack

- [Vite](https://vite.dev/) + React + TypeScript
- [Tailwind CSS v4](https://tailwindcss.com/)
- [shadcn/ui](https://ui.shadcn.com/) (componentes copiados pro projeto via
  `npx shadcn@latest add <componente>`, não são dependência de runtime)

Diferente do resto do repositório (zero-dependência, propositalmente), esta
pasta tem `package.json`/`node_modules` próprios — é uma exceção já decidida
(ver `CLAUDE.md`, "Stack do futuro front-end").

## Rodando localmente

```bash
npm install
npm run dev      # servidor de desenvolvimento
npm run build    # build de produção (dist/)
npm run preview  # serve o build de produção localmente
```

## Design tokens

`src/index.css` espelha os mesmos valores reais de `css/style.css`/
`css/admin.css` (cores de primary/accent/status, etc.) — não é uma paleta
genérica do shadcn, é a identidade visual que já existe hoje.
