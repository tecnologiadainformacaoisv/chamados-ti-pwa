import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// PWA (Fase F4.5) — só serve o app dos solicitantes; admin.html/AdminApp nunca é PWA
// (ver CLAUDE.md, "Painel de admin"). `injectManifest` (em vez de `generateSW`) porque
// o Service Worker precisa dos handlers customizados de push/notificationclick — o
// mesmo comportamento de sw.js hoje, só que precache dos assets com hash do Vite feito
// pelo Workbox em vez de uma lista de nomes fixos escrita à mão (era exatamente esse
// tipo de lista fixa que causou o incidente real de cache em 2026-08-10).
//
// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // GitHub Pages deste repo é um "project site" (tecnologiadainformacaoisv.github.io/
  // chamados-ti-pwa/, não um domínio próprio) — os assets precisam ser referenciados
  // com esse subcaminho em produção, senão tudo (JS/CSS/manifest/ícones) pede na raiz
  // errada e 404. Em dev/preview local fica em "/" mesmo, por conveniência (bate com
  // como os scripts de verificação desta sessão já testam via localhost).
  base: command === 'build' ? '/chamados-ti-pwa/' : '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false, // registro feito manualmente via useRegisterSW() em SolicitanteApp.tsx
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        name: 'Chamados de TI – ISV',
        short_name: 'TI Chamados',
        description: 'Abertura e acompanhamento de chamados de TI da ISV',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#1a3a6b',
        theme_color: '#1a3a6b',
        lang: 'pt-BR',
        categories: ['utilities', 'productivity'],
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // MPA (Fase F5) — admin.html e index.html são entradas de verdade, cada uma com seu
  // próprio main-*.tsx montando só o app dela. Sem isso o Rollup só empacota o
  // index.html padrão do Vite.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        admin: path.resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
}))
