// ⚠️ Mesmos valores de js/admin.js/js/app.js/push-worker.js — mantenha sincronizado
// (mesma obrigação de sync já documentada no CLAUDE.md). Fase F2 do roadmap de
// modernização: porta a lógica do painel de admin atual pro React, mesmos endpoints.

export const WORKER_URL = "https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev"
export const ADMIN_BASE = `${WORKER_URL}/admin`
export const API_BASE = `${WORKER_URL}/api`
export const AUTH_BASE = `${WORKER_URL}/auth`

export const SOLICITANTE_FIELD_ID = "9f111ee8-923a-4080-bf8f-1c03eee2f7cb"
export const TIPO_FIELD_ID = "47e475fe-e911-40cd-b4a2-23625fbf57f1"
export const SETOR_FIELD_ID = "c1ca88de-4b01-4933-93ff-24494bed59e2"
export const SOLUCAO_FIELD_ID = "16144175-845e-4e3c-baaa-a2517325cd43"
export const EMAIL_FIELD_ID = "2d8d4780-1d48-44dc-b605-0b5dd76c9d0f"

// Público por design — só libera o proxy /api/* (ver "ClickUp como backend" no CLAUDE.md),
// não dá acesso a nada sensível por si só. Mesmo valor de app.js/admin.js.
export const APP_SHARED_SECRET = "isv-chamados-2k26-9fQ3vM7xZp"

export type Opcao = { orderindex: number; name: string; color: string }

export const TIPOS: Opcao[] = [
  { orderindex: 0, name: "Notebooks", color: "#30a46c" },
  { orderindex: 1, name: "Multifuncionais", color: "#0091ff" },
  { orderindex: 2, name: "Redes", color: "#ffc53d" },
  { orderindex: 3, name: "Programas", color: "#f76808" },
  { orderindex: 4, name: "Design", color: "#8d8d8d" },
  { orderindex: 5, name: "E-mails", color: "#a18072" },
  { orderindex: 6, name: "Periféricos", color: "#ab4aba" },
  { orderindex: 7, name: "Plataformas", color: "#b6b6ff" },
]

export const SETORES: Opcao[] = [
  { orderindex: 0, name: "Administrativo", color: "#3e63dd" },
  { orderindex: 1, name: "Assistencial", color: "#ffc53d" },
  { orderindex: 2, name: "RH", color: "#eabd71" },
  { orderindex: 3, name: "Financeiro", color: "#ab4aba" },
  { orderindex: 4, name: "Suprimentos", color: "#30a46c" },
  { orderindex: 5, name: "Prestação de Contas", color: "#cf516c" },
  { orderindex: 6, name: "Controladoria", color: "#a18072" },
  { orderindex: 7, name: "Diretoria", color: "#e5484d" },
  { orderindex: 8, name: "Outro", color: "#8d8d8d" },
]

export const OPERADORES: Record<string, string> = {
  "170628721": "Everson",
  "200498355": "Henrique",
}

export const PRIORITY_MAP: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgente", color: "#ef5350" },
  high: { label: "Alta", color: "#ff9800" },
  normal: { label: "Normal", color: "#2196f3" },
  low: { label: "Baixa", color: "#8d8d8d" },
}

// Cores confirmadas direto na configuração real da lista na ClickUp (2026-08-07) —
// ver STATUS_MAP em js/admin.js pro comentário completo.
export const STATUS_ORDER = ["aberto", "em atendimento", "pendente", "encerrado"] as const
export type StatusKey = (typeof STATUS_ORDER)[number]

export const STATUS_MAP: Record<StatusKey, { label: string; dot: string }> = {
  aberto: { label: "Aberto", dot: "#87909e" },
  "em atendimento": { label: "Em Atendimento", dot: "#5f55ee" },
  pendente: { label: "Pendente", dot: "#b660e0" },
  encerrado: { label: "Encerrado", dot: "#008844" },
}

export function optionName(list: Opcao[], orderindex: number | null | undefined): string {
  if (orderindex === null || orderindex === undefined) return "—"
  return list.find((o) => o.orderindex === Number(orderindex))?.name ?? "—"
}

// ============================================================
// App dos solicitantes (Fase F4) — mesmos valores de js/app.js
// ============================================================

// Não usamos prioridade "Baixa" aqui — nenhuma categoria mapeia pra ela.
export const PRIORITY: Record<number, { label: string; color: string; slaMs: number; slaLabel: string }> = {
  1: { label: "Urgente", color: "#ef5350", slaMs: 1 * 3600000, slaLabel: "1 hora" },
  2: { label: "Alta", color: "#ff9800", slaMs: 4 * 3600000, slaLabel: "4 horas" },
  3: { label: "Normal", color: "#2196f3", slaMs: 24 * 3600000, slaLabel: "24 horas" },
}

// categoria (orderindex de TIPOS) -> prioridade (id de PRIORITY) — confirmado com a
// automação real da ClickUp.
export const CATEGORIA_PRIORIDADE: Record<number, number> = {
  0: 1, 1: 1, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3, 7: 2,
}

// Descrição completa de cada tipo, mostrada no select do formulário de abertura.
export const TIPOS_FULL: Record<number, string> = {
  0: "Notebooks (Configuração, Desligamento e Travamento)",
  1: "Multifuncionais (Tinta, Toner, Obstrução e Falhas nas impressões)",
  2: "Redes (Sem internet, Sites fora do ar e Lentidão na rede)",
  3: "Programas (Excel, Word e Adobe)",
  4: "Design (Criação de artes, Capas e Imagens)",
  5: "E-mails (Deslogamento, Armazenamento cheio e Falha no envio)",
  6: "Periféricos (Teclado, Mouse, Pendrive e Webcam)",
  7: "Plataformas (Google Drive, OMIE, Domínio e ZAPPY)",
}

export const OPERADOR_WHATSAPP: Record<string, string> = {
  "170628721": "5585989304648", // Everson
  "200498355": "5585999419866", // Henrique
}
export const WA_NUMBER_PADRAO = "5585999419866"
