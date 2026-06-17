'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const LIST_ID = '901324490220';
const API_BASE = 'https://api.clickup.com/api/v2';

const FIELD_IDS = {
  EMAIL: '2d8d4780-1d48-44dc-b605-0b5dd76c9d0f',
  TIPO: '47e475fe-e911-40cd-b4a2-23625fbf57f1',
  SOLICITANTE: '9f111ee8-923a-4080-bf8f-1c03eee2f7cb',
  SETOR: 'c1ca88de-4b01-4933-93ff-24494bed59e2'
};

const TIPOS = [
  { orderindex: 0, name: 'Notebooks', full: 'Notebooks (Configuração, Desligamento e Travamento)', color: '#30a46c' },
  { orderindex: 1, name: 'Multifuncionais', full: 'Multifuncionais (Tinta, Toner, Obstrução e Falhas nas impressões)', color: '#0091ff' },
  { orderindex: 2, name: 'Redes', full: 'Redes (Sem internet, Sites fora do ar e Lentidão na rede)', color: '#ffc53d' },
  { orderindex: 3, name: 'Programas', full: 'Programas (Excel, Word e Adobe)', color: '#f76808' },
  { orderindex: 4, name: 'Design', full: 'Design (Criação de artes, Capas e Imagens)', color: '#8d8d8d' },
  { orderindex: 5, name: 'E-mails', full: 'E-mails (Deslogamento, Armazenamento cheio e Falha no envio)', color: '#a18072' },
  { orderindex: 6, name: 'Periféricos', full: 'Periféricos (Teclado, Mouse, Pendrive e Webcam)', color: '#ab4aba' },
  { orderindex: 7, name: 'Plataformas', full: 'Plataformas (Google Drive, OMIE, Domínio e ZAPPY)', color: '#b6b6ff' }
];

const SOLICITANTES = [
  { orderindex: 0,  name: 'Ariele Santo' },
  { orderindex: 1,  name: 'Brena Larissa' },
  { orderindex: 2,  name: 'Brenda Ruivo' },
  { orderindex: 3,  name: 'Bruno Guilherme' },
  { orderindex: 4,  name: 'Eduarda Ribeiro' },
  { orderindex: 5,  name: 'Emanuel Dylan' },
  { orderindex: 6,  name: 'Felipe Carvalho' },
  { orderindex: 7,  name: 'Gabriela Silva' },
  { orderindex: 8,  name: 'Gean Silva' },
  { orderindex: 9,  name: 'Glória Feitosa' },
  { orderindex: 10, name: 'Ítalo Costa' },
  { orderindex: 11, name: 'Jhuliany Mendes' },
  { orderindex: 12, name: 'João Mário' },
  { orderindex: 13, name: 'Joel Abner' },
  { orderindex: 14, name: 'Josy de Athaide' },
  { orderindex: 15, name: 'Júlia Emily' },
  { orderindex: 16, name: 'Juliano Ragnini' },
  { orderindex: 17, name: 'Karolyni Tibúrcio' },
  { orderindex: 18, name: 'Késsia Rodrigues' },
  { orderindex: 19, name: 'Levy Perdigão' },
  { orderindex: 20, name: 'Lourdes Arráis' },
  { orderindex: 21, name: 'Marcelino Agostinho' },
  { orderindex: 22, name: 'Márcio Delukken' },
  { orderindex: 23, name: 'Maria Clara' },
  { orderindex: 24, name: 'Mariana Maia' },
  { orderindex: 25, name: 'Michael Vasconcelos' },
  { orderindex: 26, name: 'Mikaelly Lima' },
  { orderindex: 27, name: 'Outros' },
  { orderindex: 28, name: 'Rayane Bernardo' },
  { orderindex: 29, name: 'Riccardo Mandrini' },
  { orderindex: 30, name: 'Rosa Júlia' },
  { orderindex: 31, name: 'Ruci Teles' },
  { orderindex: 32, name: 'Saulo Victor' },
  { orderindex: 33, name: 'Taina Martins' },
  { orderindex: 34, name: 'Tatiana Bernardino' },
  { orderindex: 35, name: "Tereza D'avila" },
  { orderindex: 36, name: 'Vitor Cruz' },
  { orderindex: 37, name: 'Wendel Cardoso' },
  { orderindex: 38, name: 'Yasly Silva' },
  { orderindex: 39, name: 'Yasmin Rocha' }
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

const PRIORITY = {
  1: { label: 'Urgente', color: '#ef5350', slaMs: 4  * 3600000, slaLabel: '4 horas'   },
  2: { label: 'Alta',    color: '#ff9800', slaMs: 24 * 3600000, slaLabel: '24 horas'  },
  3: { label: 'Normal',  color: '#2196f3', slaMs: 72 * 3600000, slaLabel: '72 horas'  },
  4: { label: 'Baixa',   color: '#9e9e9e', slaMs: 168 * 3600000, slaLabel: '7 dias'   }
};

// Mapeamento categoria (orderindex de TIPOS) -> prioridade (id de PRIORITY)
// Confirmado com a automação real do ClickUp (Alterações de campo personalizado -> Alterar prioridade)
const CATEGORIA_PRIORIDADE = {
  0: 1, // Notebooks       -> Urgente
  1: 1, // Multifuncionais -> Urgente
  2: 1, // Redes           -> Urgente
  3: 2, // Programas       -> Alta
  4: 3, // Design          -> Normal
  5: 2, // E-mails         -> Alta
  6: 3, // Periféricos     -> Normal
  7: 2  // Plataformas     -> Alta
};

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

// VAPID public key (65-byte uncompressed P-256, URL-safe base64)
const VAPID_PUBLIC_KEY = 'BMgcsTAUEhUr-dau-LaPhTHktmCZ90q4GXFF6CX0p3IvmeB51v68JqZLeuKrO3swUcSXKiNhQ6Ur5I74fm6tp2Q';
// Worker URL: fill in after deploying to Cloudflare
const WORKER_URL = 'https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev';

// ============================================================
// STATE
// ============================================================
let myTasks                = [];
let deferredInstallPrompt  = null;
let pendingHighlightTaskId = null;

// ============================================================
// STORAGE
// ============================================================
const store = {
  get:    key => localStorage.getItem(key),
  set:    (key, val) => localStorage.setItem(key, val),
  remove: key => localStorage.removeItem(key)
};

// ============================================================
// API
// ============================================================
async function apiRequest(method, path, body = null) {
  const key = store.get('cu_key');
  if (!key) throw new Error('API key não configurada');
  const opts = {
    method,
    headers: { 'Authorization': key, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.err || `Erro HTTP ${res.status}`);
  }
  return res.json();
}

async function createTask(payload) {
  return apiRequest('POST', `/list/${LIST_ID}/task`, payload);
}

async function fetchTasks() {
  const params = new URLSearchParams({
    order_by: 'created',
    reverse: 'true',
    include_closed: 'true',
    page: '0'
  });
  const data = await apiRequest('GET', `/list/${LIST_ID}/task?${params}`);
  return data.tasks || [];
}

async function fetchMyTasks(userIdx) {
  try {
    const cf = JSON.stringify([{
      field_id: FIELD_IDS.SOLICITANTE,
      operator: '=',
      value: userIdx
    }]);
    const params = new URLSearchParams({
      order_by: 'created',
      reverse: 'true',
      include_closed: 'true',
      page: '0',
      custom_fields: cf
    });
    const data = await apiRequest('GET', `/list/${LIST_ID}/task?${params}`);
    return data.tasks || [];
  } catch {
    return [];
  }
}

// ============================================================
// HELPERS
// ============================================================
function getCustomField(task, fieldId) {
  const f = task.custom_fields?.find(cf => cf.id === fieldId);
  if (!f || f.value === undefined || f.value === null) return null;
  // ClickUp list endpoint may return dropdown value as {orderindex, id, name} object
  if (typeof f.value === 'object' && 'orderindex' in f.value) return f.value.orderindex;
  return f.value;
}

function optionName(list, orderindex) {
  if (orderindex === null || orderindex === undefined) return '—';
  const item = list.find(o => o.orderindex === Number(orderindex));
  return item?.name || '—';
}

function isOverdue(task) {
  if (task.status?.status === 'encerrado') return false;
  if (!task.due_date) return false;
  return Date.now() > Number(task.due_date);
}

function overdueFor(task) {
  if (!task.due_date) return '';
  const diff = Date.now() - Number(task.due_date);
  if (diff <= 0) return '';
  const h = Math.floor(diff / 3600000);
  if (h < 24) return `${h}h em atraso`;
  return `${Math.floor(h / 24)}d em atraso`;
}

function timeAgo(ts) {
  const d = Date.now() - Number(ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m}m atrás`;
  const h = Math.floor(d / 3600000);
  if (h < 24) return `${h}h atrás`;
  return `${Math.floor(h / 24)}d atrás`;
}

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

function timeUntil(ts) {
  if (!ts) return null;
  const diff = Number(ts) - Date.now();
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'em breve';
  if (h < 24) return `em ${h}h`;
  return `em ${Math.floor(h / 24)}d`;
}

// ============================================================
// TOAST
// ============================================================
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
// SETUP SCREEN
// ============================================================
function showSetup() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  populateSelect('setup-name', SOLICITANTES);

  // Remove key field if already configured via invite link
  if (store.get('cu_key')) {
    document.getElementById('setup-key-field')?.remove();
  }

  // Eye toggle
  const eyeBtn = document.getElementById('toggle-key');
  const keyInput = document.getElementById('setup-api-key');
  eyeBtn?.addEventListener('click', () => {
    if (keyInput) keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
  });
}

function onSetupSubmit(e) {
  e.preventDefault();
  const nameEl  = document.getElementById('setup-name');
  const email   = document.getElementById('setup-email').value.trim();
  if (nameEl.value === '') {
    toast('Selecione seu nome para continuar', 'error');
    return;
  }

  // Key field only exists in DOM when not pre-configured via invite link
  const keyField = document.getElementById('setup-key-field');
  if (keyField) {
    const key = document.getElementById('setup-api-key')?.value.trim();
    if (!key) { toast('Informe a chave de API', 'error'); return; }
    store.set('cu_key', key);
  }

  store.set('user_idx', nameEl.value);
  store.set('user_email', email);

  document.getElementById('setup-screen').classList.add('hidden');
  initApp();
}

// ============================================================
// APP INIT
// ============================================================
function initApp() {
  document.getElementById('app').classList.remove('hidden');

  const idx = parseInt(store.get('user_idx'));
  document.getElementById('user-name-display').textContent = optionName(SOLICITANTES, idx);

  populateForm();
  setupTabs();
  setupFilters();
  setupSettings();
  setupAlertsModal();
  setupInstallBanner();
  setupRefresh();
  setupCharCounter();
  setupNotifications();

  document.getElementById('chamado-form')?.addEventListener('submit', onFormSubmit);
  document.getElementById('wa-modal-close')?.addEventListener('click', closeWaModal);
  document.getElementById('wa-modal-overlay')?.addEventListener('click', closeWaModal);

  loadTickets();
  setupRefreshPolling();

  // Suporte a deep-link via hash: #tab:taskId (ex: #meus-chamados:abc123)
  const hashFull             = location.hash.replace('#', '') || 'novo-chamado';
  const [hashTab, hashTaskId] = hashFull.split(':');
  if (hashTaskId) pendingHighlightTaskId = hashTaskId;
  switchTab(hashTab);
}

// ============================================================
// TABS
// ============================================================
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  const validTabs = ['novo-chamado', 'meus-chamados', 'todos-chamados'];
  if (!validTabs.includes(tab)) tab = 'novo-chamado';

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });

  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tab}`);
    p.classList.toggle('hidden', p.id !== `panel-${tab}`);
  });

  location.hash = tab;
}

// ============================================================
// FORM
// ============================================================
function populateSelect(id, list, labelKey = 'name') {
  const sel = document.getElementById(id);
  const cur = sel.value;
  const placeholder = sel.querySelector('option[value=""]')?.textContent || 'Selecione...';
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  list.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.orderindex;
    opt.textContent = item[labelKey];
    sel.appendChild(opt);
  });
  if (cur !== '') sel.value = cur;
}

function populateForm() {
  // Solicitante: read-only display, value comes from logged-in user
  const idx = parseInt(store.get('user_idx'));
  const solName = optionName(SOLICITANTES, idx);
  const display = document.getElementById('f-solicitante-display');
  if (display) display.textContent = solName;

  populateSelect('f-setor', SETORES);
  populateSelect('f-tipo', TIPOS, 'full');
}

async function onFormSubmit(e) {
  e.preventDefault();

  const solicitante = parseInt(store.get('user_idx'));
  const setor       = document.getElementById('f-setor').value;
  const tipo        = document.getElementById('f-tipo').value;
  const operador    = document.querySelector('input[name="operador"]:checked')?.value;
  const descricao   = document.getElementById('f-descricao').value.trim();
  const detalhes    = document.getElementById('f-detalhes').value.trim();

  if (isNaN(solicitante) || !setor || !tipo || !operador || !descricao) {
    toast('Preencha todos os campos obrigatórios (*)', 'error');
    return;
  }

  const btn = document.getElementById('form-submit-btn');
  btn.disabled = true;
  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="10" cy="10" r="7"/><path d="M10 3v7l4 2"/>
    </svg>
    Enviando...`;

  const solName  = optionName(SOLICITANTES, parseInt(solicitante));
  const tipoName = TIPOS.find(t => t.orderindex === parseInt(tipo))?.name || '';
  const prio     = CATEGORIA_PRIORIDADE[parseInt(tipo)] || 3;
  const pInfo    = PRIORITY[prio] || PRIORITY[3];
  const dueDate  = Date.now() + pInfo.slaMs;

  const taskName = descricao;
  let taskDesc   = '';
  if (detalhes) taskDesc = `Detalhes adicionais:\n${detalhes}`;

  const customFields = [
    { id: FIELD_IDS.SOLICITANTE, value: solicitante },
    { id: FIELD_IDS.SETOR,       value: parseInt(setor) },
    { id: FIELD_IDS.TIPO,        value: parseInt(tipo) }
  ];

  try {
    const task = await createTask({
      name: taskName,
      description: taskDesc || undefined,
      status: 'aberto',
      priority: prio,
      due_date: dueDate,
      due_date_time: true,
      assignees: [parseInt(operador)],
      custom_fields: customFields
    });

    toast(`Chamado aberto! ${solName} – ${tipoName} (atendente: ${OPERADORES[operador] || ''})`, 'success');
    e.target.reset();
    populateForm();
    await loadTickets();
    switchTab('meus-chamados');
    openWaModal(task, pInfo.slaLabel);
  } catch (err) {
    toast(`Erro ao abrir chamado: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <line x1="2" y1="8" x2="14" y2="8"/><polyline points="9,3 14,8 9,13"/>
      </svg>
      Abrir Chamado`;
  }
}

// ============================================================
// LOAD & RENDER TICKETS
// ============================================================
function setLoadingState(which, loading) {
  ['meus', 'todos'].forEach(key => {
    const el = document.getElementById(`loading-${key}`);
    if (el && (which === key || which === 'all')) {
      el.classList.toggle('hidden', !loading);
    }
  });
}

async function loadTickets() {
  setLoadingState('all', true);
  try {
    const userIdx = parseInt(store.get('user_idx'));
    const fetched = await fetchMyTasks(userIdx);
    if (fetched.length > 0) {
      checkStatusChanges(fetched);
      myTasks = fetched;
    } else {
      // Fallback: fetch all tasks and filter client-side
      const all = await fetchTasks();
      const filtered = all.filter(t => Number(getCustomField(t, FIELD_IDS.SOLICITANTE)) === userIdx);
      checkStatusChanges(filtered);
      myTasks = filtered;
    }
    renderAll();
    updateAlertBadge();
    if (pendingHighlightTaskId) {
      highlightTask(pendingHighlightTaskId);
      pendingHighlightTaskId = null;
    }
  } catch (err) {
    toast(`Erro ao carregar chamados: ${err.message}`, 'error');
  } finally {
    setLoadingState('all', false);
  }
}

function renderAll() {
  const myActive  = myTasks.filter(t => t.status?.status !== 'encerrado');
  const myClosed  = myTasks.filter(t => t.status?.status === 'encerrado');

  renderList('list-meus',  applyStatusFilter(myActive,  getFilterValue('filter-status-meus')),  renderDetailCard);
  renderList('list-todos', applyStatusFilter(myClosed,  getFilterValue('filter-status-todos')), renderDetailCard);

  setCount('count-meus',  myActive.length);
  setCount('count-todos', myClosed.length);

  const meusTab = document.querySelector('[data-tab="meus-chamados"]');
  if (meusTab) meusTab.classList.toggle('has-overdue', myActive.filter(isOverdue).length > 0);
}

function applyStatusFilter(tasks, filterVal) {
  if (!filterVal) return tasks;
  return tasks.filter(t => t.status?.status === filterVal);
}

function getFilterValue(id) {
  return document.getElementById(id)?.value || '';
}

function setCount(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = n;
  el.classList.toggle('hidden', n === 0);
}

const WA_NUMBER = '5585999419866';

function waLink(task) {
  const status = STATUS_MAP[task.status?.status]?.label || 'Aberto';
  const msg = `Olá! Gostaria de informações sobre meu chamado de TI:\n*${task.name}*\nStatus: ${status}`;
  return `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(msg)}`;
}

function slaProgressInfo(task) {
  const status = task.status?.status || 'aberto';
  if (status === 'encerrado') return null;
  const start = Number(task.date_created);
  const end   = Number(task.due_date);
  if (!start || !end || end <= start) return null;

  const pct = ((Date.now() - start) / (end - start)) * 100;
  let color = '#22c55e';
  if (pct >= 100) color = '#ef4444';
  else if (pct >= 70) color = '#f59e0b';

  return { pct: Math.max(0, Math.min(pct, 100)), color };
}

function renderDetailCard(task) {
  const status  = task.status?.status || 'aberto';
  const sInfo   = STATUS_MAP[status] || STATUS_MAP['aberto'];
  const prioId  = task.priority?.id ? parseInt(task.priority.id) : 3;
  const pInfo   = PRIORITY[prioId] || PRIORITY[3];
  const overdue = isOverdue(task);
  const oText   = overdueFor(task);
  const sla     = slaProgressInfo(task);

  const tipoIdx  = getCustomField(task, FIELD_IDS.TIPO);
  const setorIdx = getCustomField(task, FIELD_IDS.SETOR);
  const email    = getCustomField(task, FIELD_IDS.EMAIL);

  const tipoObj   = TIPOS.find(t => t.orderindex === Number(tipoIdx));
  const tipoName  = tipoObj?.name || optionName(TIPOS, tipoIdx);
  const setorName = optionName(SETORES, setorIdx);

  const desc      = (task.text_content || task.description || '').trim();
  const estimate  = fmtMs(task.time_estimate);
  const spent     = (task.time_spent > 0) ? fmtMs(task.time_spent) : null;
  const dueStr    = fmtDate(task.due_date);
  const dueFuture = timeUntil(task.due_date);
  const assignees = (task.assignees || []).map(a => a.username).join(', ');

  const hasMeta = dueStr || estimate || spent || assignees || email;

  const cardBg = sInfo.bg;

  return `
<div class="ticket-card detail-card${overdue ? ' is-overdue' : ''}" data-task-id="${task.id}"${cardBg ? ` style="background:${cardBg}"` : ''}>
  ${sla ? `<div class="sla-progress"><div class="sla-progress-fill" style="width:${sla.pct}%;background:${sla.color}"></div></div>` : ''}
  ${overdue ? `<div class="overdue-banner">⚠ ${oText}</div>` : ''}

  <div class="ticket-top-meta">
    <span class="ticket-time">${timeAgo(task.date_created)}</span>
  </div>

  <div class="status-center">
    <span class="status-badge-lg" style="background:${sInfo.bg};color:${sInfo.color}">
      <span class="status-dot-lg" style="background:${sInfo.dot}"></span>${sInfo.label}
    </span>
  </div>

  <div class="detail-title">${escHtml(task.name)}</div>

  ${desc ? `<div class="detail-desc">${escHtml(desc)}</div>` : ''}

  <div class="ticket-tags">
    ${tipoObj ? `<span class="tipo-tag" style="background:${tipoObj.color}1a;color:${tipoObj.color}">${escHtml(tipoName)}</span>` : ''}
    ${setorIdx !== null ? `<span class="setor-tag">${escHtml(setorName)}</span>` : ''}
    <span class="prio-tag" style="background:${pInfo.color}1a;color:${pInfo.color}">${pInfo.label}</span>
  </div>

  ${hasMeta ? `<div class="detail-meta-grid">
    ${dueStr ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Prazo</span>
      <span class="detail-meta-value${overdue ? ' text-danger' : ''}">
        ${escHtml(dueStr)}${dueFuture ? ` <span class="due-remaining">(${dueFuture})</span>` : ''}
      </span>
    </div>` : ''}
    ${estimate ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Estimado</span>
      <span class="detail-meta-value">${estimate}</span>
    </div>` : ''}
    ${spent ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Tempo gasto</span>
      <span class="detail-meta-value">${spent}</span>
    </div>` : ''}
    ${assignees ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Atendente</span>
      <span class="detail-meta-value">${escHtml(assignees)}</span>
    </div>` : ''}
    ${email ? `<div class="detail-meta-item">
      <span class="detail-meta-label">E-mail</span>
      <span class="detail-meta-value">${escHtml(String(email))}</span>
    </div>` : ''}
  </div>` : ''}

  <div class="detail-footer">
    <span class="detail-update">Atualizado ${timeAgo(task.date_updated)}</span>
    <a href="${waLink(task)}" target="_blank" rel="noopener" class="btn-whatsapp">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
        <path d="M12 0C5.373 0 0 5.373 0 12c0 2.125.558 4.119 1.529 5.845L.057 23.571a.75.75 0 0 0 .921.921l5.726-1.472A11.945 11.945 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75a9.694 9.694 0 0 1-4.945-1.352l-.355-.21-3.676.944.981-3.565-.23-.366A9.694 9.694 0 0 1 2.25 12C2.25 6.615 6.615 2.25 12 2.25S21.75 6.615 21.75 12 17.385 21.75 12 21.75z"/>
      </svg>
      Falar com TI
    </a>
  </div>
</div>`;
}

function renderList(containerId, tasks, cardFn = renderCard) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (tasks.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>Nenhum chamado encontrado</p>
      </div>`;
    return;
  }

  el.innerHTML = tasks.map(cardFn).join('');
}

function renderCard(task) {
  const status   = task.status?.status || 'aberto';
  const sInfo    = STATUS_MAP[status] || STATUS_MAP['aberto'];
  const prioId   = task.priority?.id ? parseInt(task.priority.id) : 3;
  const pInfo    = PRIORITY[prioId] || PRIORITY[3];
  const overdue  = isOverdue(task);
  const oText    = overdueFor(task);

  const solIdx   = getCustomField(task, FIELD_IDS.SOLICITANTE);
  const tipoIdx  = getCustomField(task, FIELD_IDS.TIPO);
  const setorIdx = getCustomField(task, FIELD_IDS.SETOR);
  const email    = getCustomField(task, FIELD_IDS.EMAIL);

  const solName  = optionName(SOLICITANTES, solIdx);
  const tipoObj  = TIPOS.find(t => t.orderindex === Number(tipoIdx));
  const tipoName = tipoObj?.name || optionName(TIPOS, tipoIdx);
  const setorName = optionName(SETORES, setorIdx);

  return `
<div class="ticket-card${overdue ? ' is-overdue' : ''}" data-task-id="${task.id}">
  ${overdue ? `<div class="overdue-banner">⚠ ${oText}</div>` : ''}
  <div class="ticket-header">
    <div class="ticket-badges">
      <span class="status-badge" style="background:${sInfo.bg};color:${sInfo.color}">
        <span class="status-dot" style="background:${sInfo.dot}"></span>
        ${sInfo.label}
      </span>
      <span class="prio-dot" style="color:${pInfo.color}">${pInfo.label}</span>
    </div>
    <span class="ticket-time">${timeAgo(task.date_created)}</span>
  </div>
  <div class="ticket-name">${escHtml(task.name)}</div>
  <div class="ticket-tags">
    ${tipoObj ? `<span class="tipo-tag" style="background:${tipoObj.color}1a;color:${tipoObj.color}">${escHtml(tipoName)}</span>` : ''}
    ${setorIdx !== null ? `<span class="setor-tag">${escHtml(setorName)}</span>` : ''}
  </div>
  <div class="ticket-footer">
    <span class="ticket-sol">👤 ${escHtml(solName)}</span>
    ${email ? `<span class="ticket-email">✉ ${escHtml(String(email))}</span>` : ''}
  </div>
</div>`;
}

// ============================================================
// ALERT BADGE & MODAL
// ============================================================
function updateAlertBadge() {
  const overdue = myTasks.filter(isOverdue);
  const badge   = document.getElementById('alert-badge');
  badge.textContent = overdue.length;
  badge.classList.toggle('hidden', overdue.length === 0);
}

function setupAlertsModal() {
  document.getElementById('btn-alerts')?.addEventListener('click', openAlertsModal);
  document.getElementById('alerts-close')?.addEventListener('click', closeAlertsModal);
  document.getElementById('alerts-overlay')?.addEventListener('click', closeAlertsModal);
}

function openAlertsModal() {
  const overdue = myTasks.filter(isOverdue);
  const list    = document.getElementById('alerts-list');

  if (overdue.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>Nenhum chamado em atraso!</p></div>`;
  } else {
    list.innerHTML = overdue.map(t => {
      const solIdx  = getCustomField(t, FIELD_IDS.SOLICITANTE);
      const solName = optionName(SOLICITANTES, solIdx);
      const oText   = overdueFor(t);
      const status  = t.status?.status || 'aberto';
      const sInfo   = STATUS_MAP[status] || STATUS_MAP['aberto'];
      return `
<div class="alert-item">
  <div class="alert-item-name">${escHtml(t.name)}</div>
  <div class="alert-item-meta">
    <span class="alert-item-sol">👤 ${escHtml(solName)}</span>
    <span class="status-badge" style="background:${sInfo.bg};color:${sInfo.color};font-size:.72rem;padding:2px 8px">
      <span class="status-dot" style="background:${sInfo.dot}"></span>${sInfo.label}
    </span>
    ${oText ? `<span class="overdue-time">${oText}</span>` : ''}
  </div>
</div>`;
    }).join('');
  }

  document.getElementById('alerts-modal').classList.remove('hidden');
}

function closeAlertsModal() {
  document.getElementById('alerts-modal').classList.add('hidden');
}

// ============================================================
// WA SUCCESS MODAL
// ============================================================
function openWaModal(task, slaLabel) {
  const msg = `Olá! Acabei de abrir um chamado de TI:\n*${task.name}*\nGostaria de acompanhar meu atendimento.`;
  document.getElementById('wa-modal-link').href = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(msg)}`;
  document.getElementById('wa-modal-sla').textContent = `Prazo de atendimento: ${slaLabel}`;
  document.getElementById('wa-modal').classList.remove('hidden');
}

function closeWaModal() {
  document.getElementById('wa-modal').classList.add('hidden');
}

// ============================================================
// FILTERS
// ============================================================
function setupFilters() {
  document.getElementById('filter-status-meus')?.addEventListener('change', () => {
    const myActive = myTasks.filter(t => t.status?.status !== 'encerrado');
    renderList('list-meus', applyStatusFilter(myActive, getFilterValue('filter-status-meus')), renderDetailCard);
  });

  document.getElementById('filter-status-todos')?.addEventListener('change', () => {
    const myClosed = myTasks.filter(t => t.status?.status === 'encerrado');
    renderList('list-todos', applyStatusFilter(myClosed, getFilterValue('filter-status-todos')), renderDetailCard);
  });
}

// ============================================================
// SETTINGS MODAL
// ============================================================
function setupSettings() {
  document.getElementById('btn-settings')?.addEventListener('click',  openSettings);
  document.getElementById('settings-close')?.addEventListener('click', closeSettings);
  document.getElementById('settings-cancel')?.addEventListener('click', closeSettings);
  document.getElementById('settings-overlay')?.addEventListener('click', closeSettings);
  document.getElementById('settings-save')?.addEventListener('click',  saveSettings);
  document.getElementById('settings-logout')?.addEventListener('click', doLogout);
}

function openSettings() {
  const sel = document.getElementById('settings-name');
  sel.innerHTML = '<option value="">Selecione...</option>';
  SOLICITANTES.forEach(s => {
    const o = document.createElement('option');
    o.value = s.orderindex;
    o.textContent = s.name;
    sel.appendChild(o);
  });
  sel.value = store.get('user_idx') || '';

  document.getElementById('settings-email').value = store.get('user_email') || '';

  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function saveSettings() {
  const nameVal  = document.getElementById('settings-name').value;
  const emailVal = document.getElementById('settings-email').value.trim();

  if (nameVal === '') { toast('Selecione seu nome', 'error'); return; }

  store.set('user_idx',    nameVal);
  store.set('user_email',  emailVal);

  document.getElementById('user-name-display').textContent = optionName(SOLICITANTES, parseInt(nameVal));
  populateForm();
  renderAll();
  closeSettings();
  toast('Configurações salvas!');
}

function doLogout() {
  if (!confirm('Desconectar e remover todas as configurações?')) return;
  localStorage.clear();
  location.reload();
}

// ============================================================
// SMART POLLING (Page Visibility API)
// ============================================================
function setupRefreshPolling() {
  let pollTimer = null;

  function scheduleNext() {
    clearTimeout(pollTimer);
    // 60s when tab is visible, 5min when hidden/background
    const delay = document.hidden ? 300000 : 60000;
    pollTimer = setTimeout(async () => {
      await loadTickets();
      scheduleNext();
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // User switched back to this tab: refresh immediately
      loadTickets();
    }
    scheduleNext();
  });

  scheduleNext();
}

// ============================================================
// REFRESH BUTTON
// ============================================================
function setupRefresh() {
  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.style.opacity = '.5';
    btn.style.pointerEvents = 'none';
    await loadTickets();
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
    toast('Chamados atualizados', 'info');
  });
}

// ============================================================
// CHAR COUNTER
// ============================================================
function setupCharCounter() {
  const ta  = document.getElementById('f-descricao');
  const cnt = document.getElementById('char-count');
  if (!ta || !cnt) return;
  ta.addEventListener('input', () => { cnt.textContent = ta.value.length; });
}

// ============================================================
// INSTALL BANNER (PWA)
// ============================================================
function setupInstallBanner() {
  if (!deferredInstallPrompt) return;

  const banner = document.createElement('div');
  banner.className = 'install-banner';
  banner.innerHTML = `
    <p><strong>Instalar app</strong> – Adicione ao seu computador para acesso rápido</p>
    <div class="install-banner-actions">
      <button id="install-dismiss" class="btn-secondary">Agora não</button>
      <button id="install-accept" class="btn-primary">Instalar</button>
    </div>`;
  document.body.appendChild(banner);

  document.getElementById('install-accept')?.addEventListener('click', async () => {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    banner.remove();
    if (outcome === 'accepted') toast('App instalado com sucesso!');
  });

  document.getElementById('install-dismiss')?.addEventListener('click', () => {
    banner.remove();
    deferredInstallPrompt = null;
  });
}

// ============================================================
// NOTIFICATIONS
// ============================================================
const NOTIFY_STATUSES = {
  'em atendimento': 'Em Atendimento',
  'pendente':       'Pendente',
  'encerrado':      'Encerrado'
};

function setupNotifications() {
  if (!('Notification' in window)) return;

  // Already granted: ensure push subscription is registered with the worker
  if (Notification.permission === 'granted') {
    subscribeToPush().catch(console.warn);
    return;
  }

  if (Notification.permission !== 'default') return;

  // Re-show 24h after last dismissal
  const dismissedAt = parseInt(store.get('notif_dismissed_at') || '0');
  if (dismissedAt > 0 && (Date.now() - dismissedAt) < 86400000) return;

  const banner = document.getElementById('notif-banner');
  if (!banner) return;
  banner.classList.remove('hidden');

  document.getElementById('notif-enable')?.addEventListener('click', async () => {
    banner.classList.add('hidden');
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      await subscribeToPush().catch(console.warn);
      toast('Notificações ativadas! Você será avisado em tempo real.', 'success');
    } else if (perm === 'denied') {
      toast('Permissão negada. Ative nas configurações do navegador se mudar de ideia.', 'error');
    }
  });

  document.getElementById('notif-dismiss')?.addEventListener('click', () => {
    banner.classList.add('hidden');
    store.set('notif_dismissed_at', String(Date.now()));
  });
}

async function subscribeToPush() {
  if (!WORKER_URL) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  const reg = await navigator.serviceWorker.ready;
  let   sub = await reg.pushManager.getSubscription();

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY)
    });
  }

  const userIdx = parseInt(store.get('user_idx'));
  await fetch(`${WORKER_URL}/subscribe`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ user_idx: userIdx, subscription: sub.toJSON() })
  });
}

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function checkStatusChanges(newTasks) {
  if (Notification.permission !== 'granted') return;

  const stored      = JSON.parse(store.get('cu_task_statuses') || '{}');
  const isFirstLoad = Object.keys(stored).length === 0;
  const updated     = {};

  newTasks.forEach(task => {
    const newStatus  = task.status?.status || '';
    const prevStatus = stored[task.id];
    updated[task.id] = newStatus;

    if (!isFirstLoad && prevStatus && prevStatus !== newStatus && NOTIFY_STATUSES[newStatus]) {
      fireNotification(task, newStatus);
    }
  });

  store.set('cu_task_statuses', JSON.stringify(updated));
}

function fireNotification(task, status) {
  const label = NOTIFY_STATUSES[status];
  // Quando Web Push está ativo, o Worker já mostra a notificação do SO —
  // evitar duplicata disparando apenas o toast local
  if (!WORKER_URL) {
    try {
      const n = new Notification('Chamados de TI – ISV', {
        body: `"${task.name}" está agora: ${label}`,
        icon: './icon.svg',
        tag:  `task-${task.id}`,
        renotify: true
      });
      n.onclick = () => { window.focus(); switchTab('meus-chamados'); n.close(); };
    } catch {}
  }
  toast(`Chamado atualizado: ${label}`, 'info');
}

// ============================================================
// DEEP LINK / TASK HIGHLIGHT
// ============================================================
function highlightTask(taskId) {
  if (!taskId) return;
  setTimeout(() => {
    const card = document.querySelector(`[data-task-id="${taskId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('task-highlight');
    setTimeout(() => card.classList.remove('task-highlight'), 2500);
  }, 350);
}

// ============================================================
// BOOT
// ============================================================
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  // Auto-configure via invite link: #setup=API_KEY
  const hash = location.hash;
  if (hash.startsWith('#setup=')) {
    const key = decodeURIComponent(hash.slice(7));
    if (key) {
      store.set('cu_key', key);
      history.replaceState(null, '', location.pathname); // remove key from URL
    }
  }

  // Listener para mensagens do Service Worker (notificationclick com app aberto)
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'OPEN_TASK') {
      switchTab(e.data.tab);
      highlightTask(e.data.task_id);
    }
  });

  if (store.get('cu_key') && store.get('user_idx') !== null) {
    initApp();
  } else {
    showSetup();
    document.getElementById('setup-form')?.addEventListener('submit', onSetupSubmit);
  }
});
