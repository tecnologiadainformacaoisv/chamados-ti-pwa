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

const STATUS_MAP = {
  'aberto':          { label: 'Aberto',          bg: '#e3f2fd', color: '#1565c0', dot: '#1976d2' },
  'em atendimento':  { label: 'Em Atendimento',  bg: '#ede7f6', color: '#4527a0', dot: '#5f55ee' },
  'pendente':        { label: 'Pendente',         bg: '#fce4ec', color: '#880e4f', dot: '#b660e0' },
  'encerrado':       { label: 'Encerrado',        bg: '#e8f5e9', color: '#1b5e20', dot: '#008844' }
};

// ============================================================
// STATE
// ============================================================
let allTasks = [];
let myTasks  = [];
let deferredInstallPrompt = null;

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
  setupPriorityInfo();

  document.getElementById('chamado-form')?.addEventListener('submit', onFormSubmit);

  loadTickets();
  setInterval(loadTickets, 180000); // refresh every 3 min

  const hash = location.hash.replace('#', '') || 'novo-chamado';
  switchTab(hash);
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

  const em = store.get('user_email');
  if (em) document.getElementById('f-email').value = em;

  updateSlaInfo();
}

function updateSlaInfo() {
  const prio = parseInt(document.querySelector('input[name="prioridade"]:checked')?.value || 3);
  const info = PRIORITY[prio] || PRIORITY[3];
  document.getElementById('sla-label').textContent = info.slaLabel;
}

async function onFormSubmit(e) {
  e.preventDefault();

  const solicitante = parseInt(store.get('user_idx'));
  const setor       = document.getElementById('f-setor').value;
  const tipo        = document.getElementById('f-tipo').value;
  const email       = document.getElementById('f-email').value.trim();
  const prio        = parseInt(document.querySelector('input[name="prioridade"]:checked')?.value || 3);
  const descricao   = document.getElementById('f-descricao').value.trim();
  const detalhes    = document.getElementById('f-detalhes').value.trim();

  if (isNaN(solicitante) || !setor || !tipo || !descricao) {
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
  if (email) customFields.push({ id: FIELD_IDS.EMAIL, value: email });

  try {
    const task = await createTask({
      name: taskName,
      description: taskDesc || undefined,
      status: 'aberto',
      priority: prio,
      due_date: dueDate,
      due_date_time: true,
      custom_fields: customFields
    });

    toast(`Chamado aberto! ${solName} – ${tipoName}`, 'success');
    e.target.reset();
    populateForm();
    await loadTickets();
    switchTab('meus-chamados');
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
    const [all, mine] = await Promise.all([fetchTasks(), fetchMyTasks(userIdx)]);
    allTasks = all;
    // Server-side filter is primary; fall back to client-side if API filter returns nothing
    myTasks = mine.length > 0
      ? mine
      : all.filter(t => Number(getCustomField(t, FIELD_IDS.SOLICITANTE)) === userIdx);
    renderAll();
    updateAlertBadge();
  } catch (err) {
    toast(`Erro ao carregar chamados: ${err.message}`, 'error');
  } finally {
    setLoadingState('all', false);
  }
}

function renderAll() {
  const activeTasks = allTasks.filter(t => t.status?.status !== 'encerrado');

  renderList('list-meus',  applyStatusFilter(myTasks,     getFilterValue('filter-status-meus')));
  renderList('list-todos', applyStatusFilter(activeTasks, getFilterValue('filter-status-todos')));

  const myActive = myTasks.filter(t => t.status?.status !== 'encerrado');
  setCount('count-meus',  myActive.length);
  setCount('count-todos', activeTasks.length);

  const myOverdue = myActive.filter(isOverdue);
  const meusTab   = document.querySelector('[data-tab="meus-chamados"]');
  if (meusTab) meusTab.classList.toggle('has-overdue', myOverdue.length > 0);
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

function renderList(containerId, tasks) {
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

  el.innerHTML = tasks.map(renderCard).join('');
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
<div class="ticket-card${overdue ? ' is-overdue' : ''}">
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
    <a href="https://app.clickup.com/t/${escHtml(task.id)}" target="_blank" rel="noopener" class="ticket-cu-link">
      Ver no ClickUp ↗
    </a>
  </div>
</div>`;
}

// ============================================================
// ALERT BADGE & MODAL
// ============================================================
function updateAlertBadge() {
  const overdue = allTasks.filter(isOverdue);
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
  const overdue = allTasks.filter(isOverdue);
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
    <a href="https://app.clickup.com/t/${escHtml(t.id)}" target="_blank" rel="noopener" class="ticket-cu-link">Ver ↗</a>
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
// FILTERS
// ============================================================
function setupFilters() {
  document.getElementById('filter-status-meus')?.addEventListener('change', () => {
    renderList('list-meus', applyStatusFilter(myTasks, getFilterValue('filter-status-meus')));
  });

  document.getElementById('filter-status-todos')?.addEventListener('change', () => {
    const active = allTasks.filter(t => t.status?.status !== 'encerrado');
    renderList('list-todos', applyStatusFilter(active, getFilterValue('filter-status-todos')));
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
// PRIORITY SLA INFO
// ============================================================
function setupPriorityInfo() {
  document.querySelectorAll('input[name="prioridade"]').forEach(r => {
    r.addEventListener('change', updateSlaInfo);
  });
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

  if (store.get('cu_key') && store.get('user_idx') !== null) {
    initApp();
  } else {
    showSetup();
    document.getElementById('setup-form')?.addEventListener('submit', onSetupSubmit);
  }
});
