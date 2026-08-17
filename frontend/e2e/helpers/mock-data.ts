// Fixtures de dados realistas — mesmo shape que push-worker.js devolve de verdade
// (d1RowToTaskShape), pra não desviar do contrato real. Ver frontend/src/lib/constants.ts
// pros orderindex/ids reais usados aqui.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
}

export function jsonRoute(body: unknown, status = 200) {
  return { status, contentType: "application/json", headers: CORS_HEADERS, body: JSON.stringify(body) }
}

const NOW = Date.now()

export function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    name: "Notebook não liga",
    description: "",
    text_content: "",
    status: { status: "aberto" },
    priority: { priority: "urgent" },
    assignees: [{ id: 170628721, username: "Everson" }],
    solicitante: "Fulano de Tal",
    due_date: NOW + 3600_000,
    date_created: NOW - 60_000,
    date_updated: NOW - 60_000,
    date_closed: null,
    start_date: null,
    custom_fields: [
      { id: "47e475fe-e911-40cd-b4a2-23625fbf57f1", value: 0 }, // TIPO: Notebooks
      { id: "c1ca88de-4b01-4933-93ff-24494bed59e2", value: 0 }, // SETOR: Administrativo
    ],
    attachments: [],
    ...overrides,
  }
}

export function makeTaskWithAnexo(overrides: Record<string, unknown> = {}) {
  return makeTask({
    id: "task-anexo",
    attachments: [{ url: "https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev/api/anexos/anexo-1", title: "print.png", name: "print.png", extension: "png" }],
    ...overrides,
  })
}

export const SOLICITANTES = ["Fulano de Tal", "Ciclana Souza", "Beltrano Lima"]

export const EMPTY_METRICS = {
  total: 0,
  truncated: false,
  porStatus: {},
  porTipo: {},
  porSetor: {},
  sla: { dentroDoSla: 0, atrasado: 0, dentroDoSlaPercent: null, atrasadoPercent: null },
  tempoMedioPorOperador: {},
}

export function makeMetrics(overrides: Record<string, unknown> = {}) {
  return {
    ...EMPTY_METRICS,
    total: 2,
    porStatus: { aberto: 1, "em atendimento": 0, pendente: 0, encerrado: 1 },
    porTipo: { 0: 1, 3: 1 },
    porSetor: { 0: 2 },
    sla: { dentroDoSla: 1, atrasado: 1, dentroDoSlaPercent: 50, atrasadoPercent: 50 },
    tempoMedioPorOperador: { "170628721": 3600_000 },
    ...overrides,
  }
}

// String sem espaço nenhum, mesmo padrão do print real que motivou o fix de
// 2026-08-17 (overflow de texto livre em modal/card) — usada nas specs de regressão
// pra garantir que essa classe de bug não volta.
export const PATHOLOGICAL_STRING = "sgds".repeat(75) // 300 caracteres, zero espaço
