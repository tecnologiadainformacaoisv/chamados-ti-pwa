import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AdminApp } from './AdminApp.tsx'

// Entry do painel de admin — vira o admin.html real em produção (Fase F5).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
)
