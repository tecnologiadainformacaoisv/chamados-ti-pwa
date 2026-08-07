'use strict';

// ============================================================
// PAINEL DE ADMIN — consome GET /admin/tasks e GET /admin/metrics do
// mesmo Worker (push-worker.js). Ver CLAUDE.md, seção "Painel de admin":
// Fase 2 (gate, métricas, filtros, tabela) + parte da Fase 3 (busca,
// paginação, exportação CSV e gráfico de SLA — tudo client-side, sem
// endpoint novo). Segue só leitura — nenhuma ação muta chamado na ClickUp.
//
// ⚠️ Nunca coloque o ADMIN_SECRET aqui — este arquivo é público (GitHub
// Pages). O segredo é digitado pelo usuário na tela de gate e fica só no
// localStorage do navegador dele, mandado via header X-Admin-Secret.
// ============================================================

// ⚠️ Mesmos valores de app.js/push-worker.js — mantenha sincronizado (mesma
// obrigação de sync já documentada no CLAUDE.md).
const WORKER_URL  = 'https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev';
const API_BASE    = `${WORKER_URL}/api`;
const ADMIN_BASE  = `${WORKER_URL}/admin`;
// Público por design — só libera o proxy /api/* (ver "ClickUp como backend" no CLAUDE.md),
// não é o ADMIN_SECRET e não dá acesso a nada sensível por si só.
const APP_SHARED_SECRET = 'isv-chamados-2k26-9fQ3vM7xZp';

const SOLICITANTE_FIELD_ID = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const TIPO_FIELD_ID        = '47e475fe-e911-40cd-b4a2-23625fbf57f1';
const SETOR_FIELD_ID       = 'c1ca88de-4b01-4933-93ff-24494bed59e2';
const SOLUCAO_FIELD_ID     = '16144175-845e-4e3c-baaa-a2517325cd43';

const TIPOS = [
  { orderindex: 0, name: 'Notebooks', color: '#30a46c' },
  { orderindex: 1, name: 'Multifuncionais', color: '#0091ff' },
  { orderindex: 2, name: 'Redes', color: '#ffc53d' },
  { orderindex: 3, name: 'Programas', color: '#f76808' },
  { orderindex: 4, name: 'Design', color: '#8d8d8d' },
  { orderindex: 5, name: 'E-mails', color: '#a18072' },
  { orderindex: 6, name: 'Periféricos', color: '#ab4aba' },
  { orderindex: 7, name: 'Plataformas', color: '#b6b6ff' }
];

const SETORES = [
  { orderindex: 0, name: 'Administrativo',     color: '#3e63dd' },
  { orderindex: 1, name: 'Assistencial',       color: '#ffc53d' },
  { orderindex: 2, name: 'RH',                 color: '#eabd71' },
  { orderindex: 3, name: 'Financeiro',          color: '#ab4aba' },
  { orderindex: 4, name: 'Suprimentos',         color: '#30a46c' },
  { orderindex: 5, name: 'Prestação de Contas', color: '#cf516c' },
  { orderindex: 6, name: 'Controladoria',       color: '#a18072' },
  { orderindex: 7, name: 'Diretoria',           color: '#e5484d' },
  { orderindex: 8, name: 'Outro',               color: '#8d8d8d' }
];

const OPERADORES = {
  '170628721': 'Everson',
  '200498355': 'Henrique'
};

const STATUS_MAP = {
  'aberto':          { label: 'Aberto',          bg: '#e3f2fd', color: '#1565c0', dot: '#1976d2' },
  'em atendimento':  { label: 'Em Atendimento',  bg: '#e3e0fb', color: '#4527a0', dot: '#5f55ee' },
  'pendente':        { label: 'Pendente',         bg: '#fce4ec', color: '#880e4f', dot: '#b660e0' },
  'encerrado':       { label: 'Encerrado',        bg: '#e8f5e9', color: '#1b5e20', dot: '#008844' }
};

const store = {
  get:    key => localStorage.getItem(key),
  set:    (key, val) => localStorage.setItem(key, val),
  remove: key => localStorage.removeItem(key)
};

// ============================================================
// HELPERS (mesmas funções puras de app.js, duplicadas — página standalone,
// sem bundler pra compartilhar módulo entre os dois)
// ============================================================
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtMs(ms) {
  if (!ms || ms <= 0) return null;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}min` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function fmtDate(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts));
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
         d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function optionName(list, orderindex) {
  if (orderindex === null || orderindex === undefined) return '—';
  const item = list.find(o => o.orderindex === Number(orderindex));
  return item?.name || '—';
}

function getCF(task, fieldId) {
  const f = task.custom_fields?.find(cf => cf.id === fieldId);
  if (!f || f.value === undefined || f.value === null) return null;
  if (typeof f.value === 'object' && 'orderindex' in f.value) return f.value.orderindex;
  return f.value;
}

// Mesma lógica informativa de atraso usada em /admin/metrics no Worker: fechado compara com
// date_closed, ainda aberto compara com "agora" (ver CLAUDE.md, "SLA exibido é informativo").
function isAtrasado(task) {
  if (!task.due_date) return false;
  const status = (task.status?.status || '').toLowerCase();
  const dueDate = Number(task.due_date);
  const referencia = (status === 'encerrado' && task.date_closed) ? Number(task.date_closed) : Date.now();
  return referencia > dueDate;
}

function toast(msg, type = 'success') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${escHtml(msg)}</span>`;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

// ============================================================
// GATE — segredo de admin (nunca fica hardcoded, só no localStorage de quem digitou)
// ============================================================
let adminSecret = store.get('admin_secret') || '';
let solicitanteIdxToName = {}; // preenchido por loadSolicitanteOptions()

// Estado da tabela (Fase 3: busca/paginação são client-side, sobre o resultado já
// filtrado pelo servidor — evita reconsultar o Worker a cada tecla digitada).
let allTasks = [];          // último resultado bruto de /admin/tasks (filtros de servidor já aplicados)
let lastVisibleTasks = [];  // allTasks após a busca por título — é o que a exportação CSV usa
let currentPage = 1;
const PAGE_SIZE = 25;

// fetchAllTasks (no Worker) tem um teto de páginas — se algum dos dois endpoints bater
// nele, mostra um aviso (ver LIMITAÇÃO CONHECIDA em push-worker.js). Qualquer um dos dois
// marcando true já é suficiente pra avisar, por isso dois flags separados.
let metricsTruncated = false;
let tasksTruncated = false;

function updateTruncatedBanner() {
  document.getElementById('truncated-banner').classList.toggle('hidden', !metricsTruncated && !tasksTruncated);
}

function showGate(msg) {
  document.getElementById('admin-app').classList.add('hidden');
  document.getElementById('gate-screen').classList.remove('hidden');
  const errEl = document.getElementById('gate-error');
  if (msg) {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }
}

function showApp() {
  document.getElementById('gate-screen').classList.add('hidden');
  document.getElementById('admin-app').classList.remove('hidden');
}

async function adminRequest(path) {
  const res = await fetch(`${ADMIN_BASE}${path}`, { headers: { 'X-Admin-Secret': adminSecret } });
  if (res.status === 403) {
    store.remove('admin_secret');
    adminSecret = '';
    const err = new Error('Segredo de admin inválido ou expirado. Entre de novo.');
    err.status = 403;
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erro HTTP ${res.status}`);
  }
  return res.json();
}

document.getElementById('gate-form').addEventListener('submit', async e => {
  e.preventDefault();
  const secretInput = document.getElementById('gate-secret').value.trim();
  if (!secretInput) return;

  const btn   = document.getElementById('gate-btn');
  const errEl = document.getElementById('gate-error');
  errEl.classList.add('hidden');
  btn.disabled = true;

  try {
    // Ping leve (só lê o KV, não toca na ClickUp) só pra validar o segredo antes de trocar de tela.
    const res = await fetch(`${ADMIN_BASE}/users`, { headers: { 'X-Admin-Secret': secretInput } });
    if (res.status === 403) throw new Error('Segredo incorreto.');
    if (!res.ok) throw new Error(`Erro HTTP ${res.status} ao validar o segredo.`);

    adminSecret = secretInput;
    store.set('admin_secret', secretInput);
    showApp();
    await initPanelData();
  } catch (err) {
    errEl.textContent = err.message || 'Não foi possível entrar. Verifique sua conexão.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-sair').addEventListener('click', () => {
  store.remove('admin_secret');
  location.reload();
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  loadMetrics();
  loadTasks();
});

// ============================================================
// FILTROS
// ============================================================
function populateSelect(id, items, placeholder = 'Todos') {
  const el = document.getElementById(id);
  el.innerHTML = `<option value="">${placeholder}</option>` +
    items.map(it => `<option value="${escHtml(it.value)}">${escHtml(it.label)}</option>`).join('');
}

function populateFilters() {
  populateSelect('f-status', Object.entries(STATUS_MAP).map(([key, info]) => ({ value: key, label: info.label })));
  populateSelect('f-setor', SETORES.map(s => ({ value: String(s.orderindex), label: s.name })));
  populateSelect('f-tipo', TIPOS.map(t => ({ value: String(t.orderindex), label: t.name })));
  populateSelect('f-operador', Object.entries(OPERADORES).map(([id, nome]) => ({ value: id, label: nome })));
}

// Lista de solicitantes buscada em runtime da ClickUp, igual app.js faz — mesmo endpoint
// (/api/field), mesmo secret público (APP_SHARED_SECRET). Não precisa do ADMIN_SECRET pra isso.
async function loadSolicitanteOptions() {
  const res = await fetch(`${API_BASE}/field`, { headers: { 'X-App-Secret': APP_SHARED_SECRET } });
  if (!res.ok) throw new Error(`Erro HTTP ${res.status} ao buscar solicitantes`);
  const data = await res.json();
  const field = data.fields?.find(f => f.id === SOLICITANTE_FIELD_ID);
  const options = field?.type_config?.options || [];

  solicitanteIdxToName = {};
  options.forEach(o => { solicitanteIdxToName[o.orderindex] = o.name; });

  const names = options.map(o => o.name).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  populateSelect('f-solicitante', names.map(name => ({ value: name, label: name })));
}

function currentFilterParams() {
  const params = new URLSearchParams();
  const fields = ['status', 'setor', 'tipo', 'operador', 'solicitante'];
  fields.forEach(f => {
    const val = document.getElementById(`f-${f}`).value;
    if (val) params.set(f, val);
  });
  return params;
}

document.getElementById('btn-filtrar').addEventListener('click', () => loadTasks());
document.getElementById('btn-limpar').addEventListener('click', () => {
  ['f-status', 'f-setor', 'f-tipo', 'f-operador', 'f-solicitante', 'f-busca'].forEach(id => {
    document.getElementById(id).value = '';
  });
  loadTasks();
});

// ============================================================
// MÉTRICAS
// ============================================================
function metricCardHtml(value, label, variant) {
  const cls = variant ? ` metric-${variant}` : '';
  return `<div class="metric-card${cls}"><div class="metric-value">${escHtml(value ?? '—')}</div><div class="metric-label">${escHtml(label)}</div></div>`;
}

function fmtPercent(n) {
  return (n === null || n === undefined) ? '—' : `${n}%`;
}

function renderBarList(elId, counts, list) {
  const el = document.getElementById(elId);
  const entries = list
    .map(item => ({ name: item.name, color: item.color, count: counts?.[item.orderindex] || 0 }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count);

  if (entries.length === 0) {
    el.innerHTML = '<p class="empty-mini">Sem chamados nessa categoria ainda.</p>';
    return;
  }
  const max = Math.max(...entries.map(e => e.count));
  el.innerHTML = entries.map(e => `
    <div class="bar-row">
      <span class="bar-label">${escHtml(e.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round((e.count / max) * 100)}%; background:${e.color}"></span></span>
      <span class="bar-count">${e.count}</span>
    </div>`).join('');
}

// Não restringe a Everson/Henrique — mostra qualquer operador que apareça nos dados
// (o Worker já resolve o nome via task.assignees[].username, ver push-worker.js).
function renderOperadores(tempoMedio) {
  const el = document.getElementById('metrics-operadores');
  const entries = Object.entries(tempoMedio || {});
  if (entries.length === 0) {
    el.innerHTML = '<p class="empty-mini">Nenhum chamado encerrado com tempo de atendimento registrado ainda.</p>';
    return;
  }
  entries.sort((a, b) => (a[1].nome || '').localeCompare(b[1].nome || '', 'pt-BR'));
  el.innerHTML = entries.map(([id, dado]) => {
    const nome = dado.nome || OPERADORES[id] || `Operador #${id}`;
    const plural = dado.totalChamados === 1 ? '' : 's';
    return `<div class="operador-card">
      <div>
        <div class="operador-nome">${escHtml(nome)}</div>
        <div class="operador-qtd">${dado.totalChamados} chamado${plural} encerrado${plural}</div>
      </div>
      <span class="operador-tempo">${fmtMs(dado.mediaMs) || '—'}</span>
    </div>`;
  }).join('');
}

// Donut de SLA em SVG puro (stroke-dasharray por segmento) — sem lib de gráfico,
// mesma filosofia zero-dependência do resto do projeto.
function renderSlaChart(sla) {
  const el = document.getElementById('metrics-sla-chart');
  const pctDentro   = sla?.dentroDoSlaPercent;
  const pctAtrasado = sla?.atrasadoPercent;

  if (pctDentro === null || pctDentro === undefined) {
    el.innerHTML = '<p class="empty-mini">Nenhum chamado com prazo definido ainda.</p>';
    return;
  }

  const r = 50, cx = 60, cy = 60;
  const circumference = 2 * Math.PI * r;
  const dentroLen   = circumference * (pctDentro / 100);
  const atrasadoLen = circumference * (pctAtrasado / 100);

  el.innerHTML = `
    <svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Dentro do SLA: ${pctDentro}%, Atrasado: ${pctAtrasado}%">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="14"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#22c55e" stroke-width="14"
        stroke-dasharray="${dentroLen} ${circumference - dentroLen}"
        transform="rotate(-90 ${cx} ${cy})"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ef4444" stroke-width="14"
        stroke-dasharray="${atrasadoLen} ${circumference - atrasadoLen}"
        stroke-dashoffset="${-dentroLen}"
        transform="rotate(-90 ${cx} ${cy})"/>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text)">${pctDentro}%</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9" fill="var(--text-muted)">dentro do SLA</text>
    </svg>
    <div class="sla-legend">
      <div class="sla-legend-item"><span class="sla-legend-dot" style="background:#22c55e"></span><span class="sla-legend-label">Dentro do SLA</span><span class="sla-legend-value">${pctDentro}%</span></div>
      <div class="sla-legend-item"><span class="sla-legend-dot" style="background:#ef4444"></span><span class="sla-legend-label">Atrasado</span><span class="sla-legend-value">${pctAtrasado}%</span></div>
    </div>`;
}

function renderMetrics(data) {
  const cardsEl = document.getElementById('metrics-cards');
  const statusOrder = ['aberto', 'em atendimento', 'pendente', 'encerrado'];
  const cards = [metricCardHtml(data.total ?? 0, 'Total de chamados')];
  statusOrder.forEach(key => {
    cards.push(metricCardHtml(data.porStatus?.[key] || 0, STATUS_MAP[key]?.label || key));
  });
  cards.push(metricCardHtml(fmtPercent(data.sla?.dentroDoSlaPercent), 'Dentro do SLA', 'success'));
  cards.push(metricCardHtml(fmtPercent(data.sla?.atrasadoPercent), 'Atrasado', 'danger'));
  cardsEl.innerHTML = cards.join('');

  renderBarList('metrics-por-tipo', data.porTipo, TIPOS);
  renderBarList('metrics-por-setor', data.porSetor, SETORES);
  renderOperadores(data.tempoMedioPorOperador);
  renderSlaChart(data.sla);
}

async function loadMetrics() {
  const loadingEl = document.getElementById('metrics-loading');
  const errEl     = document.getElementById('metrics-error');
  const contentEl = document.getElementById('metrics-content');

  loadingEl.classList.remove('hidden');
  errEl.classList.add('hidden');

  try {
    const data = await adminRequest('/metrics');
    renderMetrics(data);
    contentEl.classList.remove('hidden');
    metricsTruncated = !!data.truncated;
    updateTruncatedBanner();
  } catch (err) {
    errEl.textContent = err.message || 'Não foi possível carregar as métricas.';
    errEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    if (err.status === 403) showGate(err.message);
  } finally {
    loadingEl.classList.add('hidden');
  }
}

// ============================================================
// TABELA DE CHAMADOS
// ============================================================
function taskRowHtml(task) {
  const statusKey = (task.status?.status || '').toLowerCase();
  const info = STATUS_MAP[statusKey] || { label: task.status?.status || '—', bg: 'transparent', color: 'inherit', dot: '#94a3b8' };

  const tipoNome  = optionName(TIPOS, getCF(task, TIPO_FIELD_ID));
  const setorNome = optionName(SETORES, getCF(task, SETOR_FIELD_ID));
  const solIdx    = getCF(task, SOLICITANTE_FIELD_ID);
  const solNome   = solicitanteIdxToName[solIdx] ?? '—';
  const operadores = (task.assignees || [])
    .map(a => a.username || OPERADORES[String(a.id)] || `#${a.id}`)
    .join(', ') || '—';

  const atrasado  = isAtrasado(task);
  const prazoTxt  = task.due_date ? fmtDate(task.due_date) : '—';
  const criadoTxt = task.date_created ? fmtDate(task.date_created) : '—';

  return `<tr>
    <td><span class="status-badge" style="background:${info.bg};color:${info.color}"><span class="status-dot" style="background:${info.dot}"></span>${escHtml(info.label)}</span></td>
    <td><span class="task-name" title="${escHtml(task.name || '')}">${escHtml(task.name || '(sem título)')}</span></td>
    <td>${escHtml(tipoNome)}</td>
    <td>${escHtml(setorNome)}</td>
    <td>${escHtml(solNome)}</td>
    <td>${escHtml(operadores)}</td>
    <td class="${atrasado ? 'cell-atrasado' : ''}">${escHtml(prazoTxt)}${atrasado ? ' ⚠' : ''}</td>
    <td class="cell-muted">${escHtml(criadoTxt)}</td>
    <td><button type="button" class="btn-gerenciar" data-task-id="${escHtml(task.id)}">Gerenciar</button></td>
  </tr>`;
}

// ============================================================
// MODAL DE GERENCIAMENTO — status/operador/solução mutam a ClickUp por trás
// (POST /admin/tasks/:id). É isso que substitui a ClickUp como interface de
// trabalho da TI (ver CLAUDE.md, "Painel de admin" — decisão de 2026-08-07).
// ============================================================
let modalTaskId = null;

function populateModalOperadores() {
  const el = document.getElementById('modal-operador');
  el.innerHTML = '<option value="">Sem atribuição</option>' +
    Object.entries(OPERADORES).map(([id, nome]) => `<option value="${id}">${escHtml(nome)}</option>`).join('');
}

function openTaskModal(task) {
  modalTaskId = task.id;
  document.getElementById('task-modal-title').textContent = task.name || '(sem título)';
  document.getElementById('modal-status').value = (task.status?.status || 'aberto').toLowerCase();
  const currentAssignee = (task.assignees || [])[0]?.id;
  document.getElementById('modal-operador').value = currentAssignee ? String(currentAssignee) : '';
  document.getElementById('modal-solucao').value = getCF(task, SOLUCAO_FIELD_ID) || '';
  document.getElementById('task-modal-error').classList.add('hidden');
  document.getElementById('task-modal-overlay').classList.remove('hidden');
}

function closeTaskModal() {
  document.getElementById('task-modal-overlay').classList.add('hidden');
  modalTaskId = null;
}

document.getElementById('tasks-tbody').addEventListener('click', e => {
  const btn = e.target.closest('.btn-gerenciar');
  if (!btn) return;
  const task = allTasks.find(t => String(t.id) === btn.dataset.taskId);
  if (task) openTaskModal(task);
});

document.getElementById('btn-modal-cancelar').addEventListener('click', closeTaskModal);
document.getElementById('task-modal-overlay').addEventListener('click', e => {
  if (e.target.id === 'task-modal-overlay') closeTaskModal(); // clique fora do card fecha
});

document.getElementById('btn-modal-salvar').addEventListener('click', async () => {
  if (!modalTaskId) return;
  const btn   = document.getElementById('btn-modal-salvar');
  const errEl = document.getElementById('task-modal-error');
  errEl.classList.add('hidden');
  btn.disabled = true;

  try {
    const operadorVal = document.getElementById('modal-operador').value;
    const body = {
      status: document.getElementById('modal-status').value,
      solucao: document.getElementById('modal-solucao').value,
      assigneeId: operadorVal ? Number(operadorVal) : null, // null = "Sem atribuição" remove quem estava atribuído
    };

    const res = await fetch(`${ADMIN_BASE}/tasks/${modalTaskId}`, {
      method: 'POST',
      headers: { 'X-Admin-Secret': adminSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 403) {
      store.remove('admin_secret');
      adminSecret = '';
      closeTaskModal();
      showGate('Segredo de admin inválido ou expirado. Entre de novo.');
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Erro HTTP ${res.status}`);
    }

    toast('Chamado atualizado.', 'success');
    closeTaskModal();
    loadTasks();
    loadMetrics();
  } catch (err) {
    errEl.textContent = err.message || 'Não foi possível salvar.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// Busca por título (client-side, sobre o que o servidor já filtrou) + paginação —
// não refaz a chamada ao Worker a cada tecla digitada, só reaplica sobre allTasks.
function applySearchAndRender() {
  const term = document.getElementById('f-busca').value.trim().toLowerCase();
  lastVisibleTasks = term
    ? allTasks.filter(t => (t.name || '').toLowerCase().includes(term))
    : allTasks;
  renderTasksTable(lastVisibleTasks, term);
}

function renderTasksTable(list, term) {
  const emptyEl = document.getElementById('tasks-empty');
  const wrapEl  = document.getElementById('tasks-table-wrap');
  const tbody   = document.getElementById('tasks-tbody');
  const pagEl   = document.getElementById('tasks-pagination');
  const countEl = document.getElementById('tasks-count');

  countEl.textContent = term
    ? `Chamados (${list.length} de ${allTasks.length})`
    : `Chamados (${allTasks.length})`;

  if (list.length === 0) {
    emptyEl.classList.remove('hidden');
    wrapEl.classList.add('hidden');
    pagEl.classList.add('hidden');
    tbody.innerHTML = '';
    return;
  }
  emptyEl.classList.add('hidden');
  wrapEl.classList.remove('hidden');

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE;
  tbody.innerHTML = list.slice(start, start + PAGE_SIZE).map(taskRowHtml).join('');

  if (totalPages > 1) {
    pagEl.classList.remove('hidden');
    document.getElementById('pagination-label').textContent = `Página ${currentPage} de ${totalPages}`;
    document.getElementById('btn-prev-page').disabled = currentPage <= 1;
    document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
  } else {
    pagEl.classList.add('hidden');
  }
}

document.getElementById('f-busca').addEventListener('input', () => {
  clearTimeout(window.__buscaDebounce);
  window.__buscaDebounce = setTimeout(() => { currentPage = 1; applySearchAndRender(); }, 200);
});

document.getElementById('btn-prev-page').addEventListener('click', () => { currentPage--; applySearchAndRender(); });
document.getElementById('btn-next-page').addEventListener('click', () => { currentPage++; applySearchAndRender(); });

// ============================================================
// EXPORTAÇÃO CSV — exporta o conjunto visível (filtros de servidor + busca por
// título), não só a página atual. Tudo no cliente, sem endpoint novo no Worker.
// ============================================================
// Proteção contra "formula injection": task.name é texto livre digitado por qualquer
// solicitante (ver js/app.js, campo de descrição) — se abrir com =, +, -, @ ou tab/CR, o
// Excel/Sheets pode interpretar como fórmula ao abrir o CSV exportado. Prefixa com aspas
// simples pra forçar leitura como texto puro, antes do escaping normal de CSV.
function csvEscape(value) {
  let str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function taskToCsvRow(task) {
  const statusKey = (task.status?.status || '').toLowerCase();
  const info = STATUS_MAP[statusKey];
  const tipoNome  = optionName(TIPOS, getCF(task, TIPO_FIELD_ID));
  const setorNome = optionName(SETORES, getCF(task, SETOR_FIELD_ID));
  const solNome   = solicitanteIdxToName[getCF(task, SOLICITANTE_FIELD_ID)] ?? '—';
  const operadores = (task.assignees || [])
    .map(a => a.username || OPERADORES[String(a.id)] || `#${a.id}`)
    .join('; ') || '—';

  return [
    task.id,
    task.name || '',
    info?.label || task.status?.status || '',
    tipoNome,
    setorNome,
    solNome,
    operadores,
    task.date_created ? new Date(Number(task.date_created)).toISOString() : '',
    task.due_date ? new Date(Number(task.due_date)).toISOString() : '',
    isAtrasado(task) ? 'Sim' : 'Não',
  ];
}

function exportCsv() {
  if (!lastVisibleTasks || lastVisibleTasks.length === 0) {
    toast('Nada para exportar com os filtros/busca atuais.', 'info');
    return;
  }
  const headers = ['ID', 'Chamado', 'Status', 'Tipo', 'Setor', 'Solicitante', 'Operador(es)', 'Criado em', 'Prazo', 'Atrasado'];
  const csv = [headers, ...lastVisibleTasks.map(taskToCsvRow)]
    .map(row => row.map(csvEscape).join(','))
    .join('\r\n');

  // BOM (﻿) na frente — sem isso o Excel abre acento errado em UTF-8.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  const a = document.createElement('a');
  a.href = url;
  a.download = `chamados-ti-isv-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`${lastVisibleTasks.length} chamado(s) exportado(s).`, 'success');
}

document.getElementById('btn-export-csv').addEventListener('click', exportCsv);

async function loadTasks() {
  const loadingEl = document.getElementById('tasks-loading');
  const errEl     = document.getElementById('tasks-error');
  const wrapEl    = document.getElementById('tasks-table-wrap');

  loadingEl.classList.remove('hidden');
  errEl.classList.add('hidden');
  wrapEl.classList.add('hidden');

  try {
    const qs   = currentFilterParams().toString();
    const data = await adminRequest(`/tasks${qs ? '?' + qs : ''}`);
    allTasks = data.tasks || [];
    currentPage = 1;
    applySearchAndRender();
    tasksTruncated = !!data.truncated;
    updateTruncatedBanner();
  } catch (err) {
    errEl.textContent = err.message || 'Não foi possível carregar os chamados.';
    errEl.classList.remove('hidden');
    if (err.status === 403) showGate(err.message);
  } finally {
    loadingEl.classList.add('hidden');
  }
}

// ============================================================
// BOOT
// ============================================================
async function initPanelData() {
  populateFilters();
  populateModalOperadores();
  try {
    await loadSolicitanteOptions();
  } catch (err) {
    console.error(err);
    toast('Não foi possível carregar a lista de solicitantes para o filtro.', 'error');
  }
  await Promise.all([loadMetrics(), loadTasks()]);
}

async function boot() {
  if (!adminSecret) return; // fica na tela de gate esperando o form
  try {
    const res = await fetch(`${ADMIN_BASE}/users`, { headers: { 'X-Admin-Secret': adminSecret } });
    if (!res.ok) throw new Error('segredo salvo não é mais válido');
    showApp();
    await initPanelData();
  } catch (err) {
    console.error(err);
    store.remove('admin_secret');
    adminSecret = '';
  }
}

boot();
