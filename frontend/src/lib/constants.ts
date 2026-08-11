// ⚠️ Mesmos valores de js/admin.js/js/app.js/push-worker.js — mantenha sincronizado
// (mesma obrigação de sync já documentada no CLAUDE.md). Fase F2 do roadmap de
// modernização: porta a lógica do painel de admin atual pro React, mesmos endpoints.

export const WORKER_URL = "https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev"
export const ADMIN_BASE = `${WORKER_URL}/admin`
export const API_BASE = `${WORKER_URL}/api`

export const SOLICITANTE_FIELD_ID = "9f111ee8-923a-4080-bf8f-1c03eee2f7cb"
export const TIPO_FIELD_ID = "47e475fe-e911-40cd-b4a2-23625fbf57f1"
export const SETOR_FIELD_ID = "c1ca88de-4b01-4933-93ff-24494bed59e2"
export const SOLUCAO_FIELD_ID = "16144175-845e-4e3c-baaa-a2517325cd43"

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
