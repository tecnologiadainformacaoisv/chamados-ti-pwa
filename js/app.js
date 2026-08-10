'use strict';

// ============================================================
// CONSTANTS
// ============================================================
// Lista "Chamados" na ClickUp. Não é mais usado em nenhuma chamada daqui (o Worker já embute
// o LIST_ID dele em /api/*) — fica só como referência pra quem for ler o código.
// ⚠️ Mantenha sincronizado com LIST_ID em push-worker.js
const LIST_ID = '901324490220';
// Worker que faz proxy autenticado pra ClickUp — o app NUNCA guarda/recebe a chave da ClickUp.
// O Worker injeta essa chave (env.CLICKUP_API_KEY, secret só do lado do servidor) antes de
// repassar pra api.clickup.com. Ver push-worker.js.
const WORKER_URL = 'https://chamados-ti-push.tecnologiadainformacao-isv.workers.dev';
const API_BASE   = `${WORKER_URL}/api`;
const AUTH_BASE  = `${WORKER_URL}/auth`;

// ⚠️ SOLICITANTE deve ficar sincronizado com SOLICITANTE_FIELD_ID em push-worker.js
const FIELD_IDS = {
  EMAIL: '2d8d4780-1d48-44dc-b605-0b5dd76c9d0f',
  TIPO: '47e475fe-e911-40cd-b4a2-23625fbf57f1',
  SOLICITANTE: '9f111ee8-923a-4080-bf8f-1c03eee2f7cb',
  SETOR: 'c1ca88de-4b01-4933-93ff-24494bed59e2',
  SOLUCAO: '16144175-845e-4e3c-baaa-a2517325cd43'
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

// Não existe mais lista fixa de solicitantes aqui — ela é buscada em runtime direto do campo
// customizado SOLICITANTE na ClickUp (ver loadSolicitantes()). Adicionar/renomear alguém lá já
// é suficiente; não precisa mais editar nem publicar o app pra isso.
//
// Tabela de migração ÚNICA — não precisa mais ser atualizada. Serve só pra traduzir o antigo
// índice numérico local (usado até a v0.2.4, salvo em `user_idx`) pro nome, na primeira vez que
// alguém que já tinha configurado o app antes abre essa versão nova (ver migrateLegacyUserIdx()).
const LEGACY_USER_IDX_TO_NAME = {
  0: 'Ariele Santo', 1: 'Brena Larissa', 2: 'Brenda Ruivo', 3: 'Bruno Guilherme',
  4: 'Eduarda Ribeiro', 5: 'Emanuel Dylan', 6: 'Felipe Carvalho', 7: 'Gabriela Silva',
  8: 'Gean Silva', 9: 'Glória Feitosa', 10: 'Ítalo Costa', 11: 'Jhuliany Mendes',
  12: 'João Mário', 13: 'Joel Abner', 14: 'Josy de Athaide', 15: 'Júlia Emily',
  16: 'Juliano Ragnini', 17: 'Karolyni Tibúrcio', 18: 'Késsia Rodrigues', 19: 'Levy Perdigão',
  20: 'Lourdes Arráis', 21: 'Marcelino Agostinho', 22: 'Márcio Delukken', 23: 'Maria Clara',
  24: 'Mariana Maia', 25: 'Michael Vasconcelos', 26: 'Mikaelly Lima', 27: 'Outros',
  28: 'Rayane Bernardo', 29: 'Riccardo Mandrini', 30: 'Rosa Júlia', 31: 'Ruci Teles',
  32: 'Saulo Victor', 33: 'Taina Martins', 34: 'Tatiana Bernardino', 35: "Tereza D'avila",
  36: 'Vitor Cruz', 37: 'Wendel Cardoso', 38: 'Yasly Silva', 39: 'Yasmin Rocha',
  40: 'Ana Clara', 41: 'Natália Leandro'
};

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

// Não usamos prioridade "Baixa" aqui — nenhuma categoria mapeia pra ela (ver CATEGORIA_PRIORIDADE)
const PRIORITY = {
  1: { label: 'Urgente', color: '#ef5350', slaMs: 1  * 3600000, slaLabel: '1 hora'   },
  2: { label: 'Alta',    color: '#ff9800', slaMs: 4  * 3600000, slaLabel: '4 horas'  },
  3: { label: 'Normal',  color: '#2196f3', slaMs: 24 * 3600000, slaLabel: '24 horas' }
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

// ⚠️ As chaves de status devem ficar sincronizadas com NOTIFY_STATUSES em push-worker.js
const STATUS_MAP = {
  // ⚠️ dot confirmado direto na configuração real da lista na ClickUp (GET /list/:id via
  // MCP, 2026-08-07) — "aberto" usa a cor padrão do tipo "open" da própria ClickUp (cinza,
  // var(--cu-status-open), sem hex customizado), não um azul customizado. Mantenha igual
  // ao STATUS_MAP de js/admin.js.
  'aberto':          { label: 'Aberto',          bg: '#e3f2fd', color: '#1565c0', dot: '#87909e' },
  'em atendimento':  { label: 'Em Atendimento',  bg: '#e3e0fb', color: '#4527a0', dot: '#5f55ee' },
  'pendente':        { label: 'Pendente',         bg: '#fce4ec', color: '#880e4f', dot: '#b660e0' },
  'encerrado':       { label: 'Encerrado',        bg: '#e8f5e9', color: '#1b5e20', dot: '#008844' }
};

// VAPID public key (65-byte uncompressed P-256, URL-safe base64)
// Par gerado em 2026-08-10 (o anterior foi apagado por engano num deploy do
// Worker via Wrangler sem `keep_vars` — ver CLAUDE.md e SEGREDOS-LOCAIS.md,
// este último NUNCA versionado). Quem já tinha notificação ativa precisa
// abrir o app uma vez pra reinscrever (a inscrição antiga ficou inválida).
const VAPID_PUBLIC_KEY = 'BDvOHU44JTbhObtRGO-uFU_8wl-9oTlOFkwnf0pXjIqpnv3hhbz0VSW-OD7itFQVBNSEA7xGEQntn6e7QyEBNMY';
// Segredo compartilhado com o Worker (env SUBSCRIBE_SECRET) — vai no header X-App-Secret de toda
// chamada a WORKER_URL/api/* e no body de /subscribe. Não dá acesso à ClickUp por si só (só
// libera o proxy); a chave real da ClickUp fica só no Worker, nunca aqui.
const APP_SHARED_SECRET = 'isv-chamados-2k26-9fQ3vM7xZp';

// ============================================================
// STATE
// ============================================================
let myTasks                = [];
let deferredInstallPrompt  = null;
let pendingHighlightTaskId = null;
let cuSolicitanteMap       = null; // name → orderindex real da ClickUp (carregado em runtime)
let cuIdxToNameMap         = null; // orderindex real da ClickUp → name (reverso, pra exibição)
let solicitanteOptions     = [];   // [{name, orderindex}] pra popular os <select>, já alfabetizado

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
// Traduz erros técnicos (HTTP, rede) em mensagens que fazem sentido pra quem não é de TI.
// O erro original sempre vai pro console, pra investigação.
function userFriendlyError(err) {
  console.error(err);
  if (!navigator.onLine) return 'Sem conexão com a internet. Verifique sua rede e tente novamente.';

  const msg = err?.message || '';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) {
    return 'Não foi possível conectar. Verifique sua internet e tente novamente.';
  }
  if (/\b401\b|\b403\b/.test(msg)) {
    return 'Sessão expirada ou sem permissão. Avise o setor de TI.';
  }
  if (/aguarde alguns segundos/i.test(msg)) {
    return msg; // mensagem do throttle do Worker já é amigável, só repassa
  }
  if (/Erro HTTP 5\d\d/.test(msg)) {
    return 'O sistema está indisponível agora. Tente novamente em alguns minutos.';
  }
  return 'Algo deu errado. Tente novamente ou avise o setor de TI.';
}

async function apiRequest(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'X-App-Secret':    APP_SHARED_SECRET,
      'X-Session-Token': store.get('session_token') || '',
      'Content-Type':    'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);

  if (res.status === 401) {
    // Sessão inválida/expirada: não dá pra continuar sem novo login. Recarrega a página,
    // que já cai na tela de login por não ter mais session_token válido.
    store.remove('session_token');
    location.reload();
    throw new Error('Sessão expirada, recarregando...');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.err || data.error || `Erro HTTP ${res.status}`);
  }
  return res.json();
}

async function createTask(payload) {
  return apiRequest('POST', '/tasks', payload);
}

async function uploadAttachment(taskId, file) {
  const formData = new FormData();
  formData.append('attachment', file, file.name);

  // Sem Content-Type manual: o browser define o boundary do multipart sozinho.
  const res = await fetch(`${API_BASE}/tasks/${taskId}/attachment`, {
    method: 'POST',
    headers: { 'X-App-Secret': APP_SHARED_SECRET, 'X-Session-Token': store.get('session_token') || '' },
    body: formData
  });
  if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
  return res.json();
}

// ============================================================
// AUTENTICAÇÃO (login com senha — pedido da diretoria pra ninguém ver chamado de outro)
// ============================================================
async function authRequest(path, body) {
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: { 'X-App-Secret': APP_SHARED_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erro HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data; // { token, name }
}

function login(name, password) {
  return authRequest('/login', { name, password });
}

function register(name, password) {
  return authRequest('/register', { name, password });
}

async function logoutFromServer() {
  const token = store.get('session_token');
  if (!token) return;
  try {
    await fetch(`${AUTH_BASE}/logout`, { method: 'POST', headers: { 'X-Session-Token': token } });
  } catch {
    // se não conseguir avisar o servidor, tudo bem — a sessão vai expirar sozinha
  }
}

// O Worker decide de quem são os chamados a partir do token de sessão — não manda mais
// nenhum índice/nome daqui. Ver handleGetMyTasks em push-worker.js.
async function fetchMyTasks() {
  try {
    const data = await apiRequest('GET', '/my-tasks');
    return data.tasks || [];
  } catch {
    return [];
  }
}

// Parte pura (sem rede) — separada só pra dar pra testar sem precisar mockar a API.
function buildSolicitanteMaps(options) {
  const nameToIdx = {};
  const idxToName = {};
  for (const opt of options) {
    nameToIdx[opt.name]     = opt.orderindex;
    idxToName[opt.orderindex] = opt.name;
  }
  const sortedOptions = options
    .map(o => ({ name: o.name, orderindex: o.orderindex }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { nameToIdx, idxToName, sortedOptions };
}

async function loadSolicitantes() {
  const data = await apiRequest('GET', '/field');
  const field = data.fields?.find(f => f.id === FIELD_IDS.SOLICITANTE);
  const options = field?.type_config?.options || [];
  if (options.length === 0) throw new Error('Campo SOLICITANTE não encontrado ou sem opções na ClickUp');

  const { nameToIdx, idxToName, sortedOptions } = buildSolicitanteMaps(options);
  cuSolicitanteMap    = nameToIdx;
  cuIdxToNameMap      = idxToName;
  solicitanteOptions  = sortedOptions;
}

// Traduz o valor do campo SOLICITANTE vindo da ClickUp (orderindex real dela) pro nome a exibir.
function solicitanteDisplayName(cuValue) {
  if (cuValue === null || cuValue === undefined) return '—';
  return cuIdxToNameMap?.[cuValue] ?? '—';
}

// Migração única: quem já tinha configurado o app antes da v0.2.5 tem um índice numérico antigo
// salvo em `user_idx`. Traduz pro nome (via LEGACY_USER_IDX_TO_NAME) e passa a usar `user_name`.
function migrateLegacyUserIdx() {
  if (store.get('user_name')) return;
  const legacyIdx = store.get('user_idx');
  if (legacyIdx === null) return;
  const name = LEGACY_USER_IDX_TO_NAME[parseInt(legacyIdx)];
  if (name) store.set('user_name', name);
  store.remove('user_idx');
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
  const status = task.status?.status;
  if (status === 'encerrado' || status === 'pendente') return false;
  if (!task.due_date) return false;
  return Date.now() > Number(task.due_date);
}

function overdueFor(task) {
  if (task.status?.status === 'pendente') return '';
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
  const totalMin = Math.floor(diff / 60000);
  if (totalMin < 1) return 'em breve';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 1) return `em ${m}min`;
  if (h < 24) return m > 0 ? `em ${h}h ${m}min` : `em ${h}h`;
  const d  = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `em ${d}d ${rh}h` : `em ${d}d`;
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
function populateSolicitanteSelect(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const cur = sel.value;
  const placeholder = sel.querySelector('option[value=""]')?.textContent || 'Selecione...';
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  solicitanteOptions.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.name; // o valor agora é o nome, não mais um índice numérico
    opt.textContent = item.name;
    sel.appendChild(opt);
  });
  if (cur !== '') sel.value = cur;
}

function showSetup() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  populateSolicitanteSelect('setup-name');
  // Pré-seleciona se já sabemos quem é (ex.: sessão expirada, ou migração de versão antiga)
  const knownName = store.get('user_name');
  const nameSel = document.getElementById('setup-name');
  if (knownName && nameSel && [...nameSel.options].some(o => o.value === knownName)) {
    nameSel.value = knownName;
  }
  const passwordEl = document.getElementById('setup-password');
  if (passwordEl) passwordEl.value = '';
}

// Erros de /auth/* já vêm com mensagem pronta pra mostrar (definidas em push-worker.js,
// já em português e já pensadas pra quem não é de TI) — só cai no tradutor genérico se
// for um erro sem status definido (rede, etc.).
function authErrorMessage(err) {
  return err?.status ? err.message : userFriendlyError(err);
}

async function onSetupSubmit(e) {
  e.preventDefault();
  const nameEl     = document.getElementById('setup-name');
  const passwordEl = document.getElementById('setup-password');
  const name       = nameEl.value;
  const password   = passwordEl.value;

  if (name === '') {
    toast('Selecione seu nome para continuar', 'error');
    return;
  }
  if (!password) {
    toast('Digite sua senha para continuar', 'error');
    return;
  }

  const btn = document.getElementById('setup-btn');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Entrando...</span>';

  try {
    let result;
    try {
      result = await login(name, password);
    } catch (err) {
      // Sem senha cadastrada ainda pra esse nome: a senha digitada agora vira a senha dele.
      if (err.status === 404) {
        result = await register(name, password);
      } else {
        throw err;
      }
    }

    store.set('session_token', result.token);
    store.set('user_name', result.name);
    passwordEl.value = '';

    document.getElementById('setup-screen').classList.add('hidden');
    initApp();
  } catch (err) {
    toast(authErrorMessage(err), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// ============================================================
// APP INIT
// ============================================================
async function initApp() {
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('user-name-display').textContent = store.get('user_name') || '—';

  populateForm();
  setupTabs();
  setupFilters();
  setupSettings();
  setupAlertsModal();
  setupInstallBanner();
  setupRefresh();
  setupCharCounter();
  setupAnexo();
  setupAnexoModal();
  setupOfflineBanner();

  document.getElementById('chamado-form')?.addEventListener('submit', onFormSubmit);
  document.getElementById('wa-modal-close')?.addEventListener('click', closeWaModal);
  document.getElementById('wa-modal-overlay')?.addEventListener('click', closeWaModal);

  // solicitanteOptions/cuSolicitanteMap já foram carregados no boot (DOMContentLoaded),
  // antes da decisão entre showSetup()/initApp() — não precisa buscar de novo aqui.
  setupNotifications();
  loadTickets();
  setupRefreshPolling();

  // Suporte a deep-link via hash: #tab:taskId (ex: #meus-chamados:abc123), usado quando
  // se clica numa notificação. Fora desse caso, sempre abre em "Novo Chamado" — sem isso,
  // como switchTab() grava a aba atual no hash, o login "lembrava" da última aba visitada.
  const [hashTab, hashTaskId] = location.hash.replace('#', '').split(':');
  if (hashTaskId) {
    pendingHighlightTaskId = hashTaskId;
    switchTab(hashTab);
  } else {
    switchTab('novo-chamado');
  }
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
  const display = document.getElementById('f-solicitante-display');
  if (display) display.textContent = store.get('user_name') || '—';

  populateSelect('f-setor', SETORES);
  populateSelect('f-tipo', TIPOS, 'full');
}

async function onFormSubmit(e) {
  e.preventDefault();

  const solName     = store.get('user_name');
  const setor       = document.getElementById('f-setor').value;
  const tipo        = document.getElementById('f-tipo').value;
  const operador    = document.querySelector('input[name="operador"]:checked')?.value;
  const descricao   = document.getElementById('f-descricao').value.trim();
  const detalhes    = document.getElementById('f-detalhes').value.trim();
  const anexos      = filtrarAnexosValidos(Array.from(document.getElementById('f-anexo')?.files || [])).validos;

  if (!setor || !tipo || !operador || !descricao) {
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

  const tipoName = TIPOS.find(t => t.orderindex === parseInt(tipo))?.name || '';
  const prio     = CATEGORIA_PRIORIDADE[parseInt(tipo)] || 3;
  const pInfo    = PRIORITY[prio] || PRIORITY[3];
  const dueDate  = Date.now() + pInfo.slaMs;

  const taskName = descricao;
  const taskDesc = detalhes || '';

  // SOLICITANTE não vai daqui — o Worker sempre sobrescreve com quem está autenticado na
  // sessão (ver handleCreateTask em push-worker.js), pra ninguém conseguir abrir um chamado
  // "como" outra pessoa mesmo mexendo no que o navegador manda.
  const customFields = [
    { id: FIELD_IDS.SETOR, value: parseInt(setor) },
    { id: FIELD_IDS.TIPO,  value: parseInt(tipo) }
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

    if (anexos.length > 0) {
      try {
        await Promise.all(anexos.map(file => uploadAttachment(task.id, file)));
      } catch (err) {
        toast(`Chamado aberto, mas houve erro ao enviar o anexo. ${userFriendlyError(err)}`, 'error');
      }
    }

    toast(`Chamado aberto! ${solName} – ${tipoName} (atendente: ${OPERADORES[operador] || ''})`, 'success');
    e.target.reset();
    renderAnexoList();
    populateForm();
    await loadTickets();
    switchTab('meus-chamados');
    openWaModal(task, pInfo.slaLabel);
  } catch (err) {
    toast(`Não foi possível abrir o chamado. ${userFriendlyError(err)}`, 'error');
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
    // O Worker já devolve só os chamados de quem está logado (identidade vem da sessão, não
    // de nada que o cliente manda) — o fallback pra dados antigos com índice divergente
    // acontece lá dentro. Ver handleGetMyTasks em push-worker.js.
    const fetched = await fetchMyTasks();
    checkStatusChanges(fetched);
    myTasks = fetched;
    // Garante mais recentes no topo, independente da ordenação da API
    myTasks.sort((a, b) => Number(b.date_created) - Number(a.date_created));
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

  loadAttachments(myTasks);
}

// A API de listagem de tarefas não devolve anexos, então buscamos por tarefa,
// individualmente, depois de renderizar a lista (não bloqueia a renderização).
// Cache em memória por task.id: só refaz a busca se date_updated mudou desde a
// última vez, evitando refetch de anexos a cada poll (60s) pra tarefas inalteradas.
const attachmentsCache = new Map(); // task.id -> { dateUpdated, html }

async function loadAttachments(tasks) {
  await Promise.all(tasks.map(async task => {
    const container = document.getElementById(`anexos-${task.id}`);
    if (!container) return;

    const cached = attachmentsCache.get(task.id);
    if (cached && cached.dateUpdated === task.date_updated) {
      container.innerHTML = cached.html;
      return;
    }

    try {
      const full = await apiRequest('GET', `/tasks/${task.id}`);
      const attachments = full.attachments || [];
      const html = attachments
        .map(a => `<button type="button" class="attachment-chip" data-url="${escHtml(a.url)}" data-title="${escHtml(a.title || a.name || 'arquivo')}" data-ext="${escHtml(a.extension || '')}">📎 ${escHtml(a.title || a.name || 'arquivo')}</button>`)
        .join('');
      attachmentsCache.set(task.id, { dateUpdated: task.date_updated, html });
      container.innerHTML = html;
    } catch {
      // ignora silenciosamente — anexos são um extra, não pode quebrar a lista
    }
  }));
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

// Número de WhatsApp por operador (mesmos IDs de OPERADORES)
const OPERADOR_WHATSAPP = {
  '170628721': '5585989304648', // Everson
  '200498355': '5585999419866'  // Henrique
};
const WA_NUMBER_PADRAO = '5585999419866';

function waNumberForTask(task) {
  const assigneeId = task.assignees?.[0]?.id != null ? String(task.assignees[0].id) : null;
  return OPERADOR_WHATSAPP[assigneeId] || WA_NUMBER_PADRAO;
}

function waLink(task) {
  const status = STATUS_MAP[task.status?.status]?.label || 'Aberto';
  const msg = `Olá! Gostaria de informações sobre meu chamado de TI:\n*${task.name}*\nStatus: ${status}`;
  return `https://wa.me/${waNumberForTask(task)}?text=${encodeURIComponent(msg)}`;
}

function slaProgressInfo(task) {
  const status = task.status?.status || 'aberto';
  if (status === 'encerrado' || status === 'pendente') return null;
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
  const solucao  = status === 'encerrado' ? (getCustomField(task, FIELD_IDS.SOLUCAO) || null) : null;

  const tipoObj   = TIPOS.find(t => t.orderindex === Number(tipoIdx));
  const tipoName  = tipoObj?.name || optionName(TIPOS, tipoIdx);
  const setorName = optionName(SETORES, setorIdx);

  const desc        = (task.text_content || task.description || '').trim();
  const abertoEm  = fmtDate(task.date_created);
  const estimate  = fmtMs(task.time_estimate);
  const spent     = (status === 'em atendimento' || status === 'encerrado') ? (fmtMs(task.time_spent) || '0min') : null;
  const spentOver = spent && task.time_estimate > 0 && task.time_spent > task.time_estimate;
  const spentOk   = spent && status === 'encerrado' && task.time_estimate > 0 && task.time_spent <= task.time_estimate;
  const dueStr    = fmtDate(task.due_date);
  const dueFuture = (status === 'encerrado' || status === 'pendente') ? null : timeUntil(task.due_date);
  const assignees = (task.assignees || []).map(a => a.username).join(', ');

  const hasMeta = abertoEm || dueStr || estimate || spent || assignees || email;

  const cardBg = sInfo.bg;

  return `
<div class="ticket-card detail-card${overdue ? ' is-overdue' : ''}" data-task-id="${task.id}"${cardBg ? ` style="background:${cardBg}"` : ''}>
  ${sla ? `<div class="sla-progress"><div class="sla-progress-fill" style="width:${sla.pct}%;background:${sla.color}"></div></div>` : ''}
  ${overdue ? `<div class="overdue-banner">⚠ ${oText}</div>` : ''}

  <div class="ticket-top-meta">
    <span class="detail-update">Atualizado ${timeAgo(task.date_updated)}</span>
    <span class="ticket-time">${timeAgo(task.date_created)}</span>
  </div>

  <div class="status-center">
    <span class="status-badge-lg" style="background:${sInfo.bg};color:${sInfo.color}">
      <span class="status-dot-lg" style="background:${sInfo.dot}"></span>${sInfo.label}
    </span>
  </div>

  <div class="detail-title">${escHtml(task.name)}</div>

  ${desc ? `<div class="detail-desc">${escHtml(desc)}</div>` : ''}

  ${solucao ? `<div class="detail-solucao">
    <div class="detail-solucao-label">✓ Solução aplicada</div>
    <div class="detail-solucao-text">${escHtml(solucao)}</div>
  </div>` : ''}

  <div class="detail-attachments" id="anexos-${task.id}"></div>

  <div class="ticket-tags">
    ${tipoObj ? `<span class="tipo-tag" style="background:${tipoObj.color}1a;color:${tipoObj.color}">${escHtml(tipoName)}</span>` : ''}
    ${setorIdx !== null ? `<span class="setor-tag">${escHtml(setorName)}</span>` : ''}
    <span class="prio-tag" style="background:${pInfo.color}1a;color:${pInfo.color}">${pInfo.label}</span>
  </div>

  ${hasMeta ? `<div class="detail-meta-grid">
    ${abertoEm ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Aberto em</span>
      <span class="detail-meta-value">${escHtml(abertoEm)}</span>
    </div>` : ''}
    ${dueStr ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Prazo</span>
      <span class="detail-meta-value${overdue ? ' text-danger' : ''}">
        ${escHtml(dueStr)}${dueFuture ? ` <span class="due-remaining">(${dueFuture})</span>` : ''}${status === 'pendente' ? ` <span class="due-paused">(pausado)</span>` : ''}
      </span>
    </div>` : ''}
    ${estimate ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Estimado</span>
      <span class="detail-meta-value">${estimate}</span>
    </div>` : ''}
    ${spent ? `<div class="detail-meta-item">
      <span class="detail-meta-label">Tempo gasto</span>
      <span class="detail-meta-value${spentOver ? ' text-danger' : spentOk ? ' text-success' : ''}">${spent}</span>
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
        <button type="button" class="btn-secondary" onclick="loadTickets()">Atualizar</button>
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

  const solName  = solicitanteDisplayName(solIdx);
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
      const solName = solicitanteDisplayName(solIdx);
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
  document.getElementById('wa-modal-link').href = `https://wa.me/${waNumberForTask(task)}?text=${encodeURIComponent(msg)}`;
  document.getElementById('wa-modal-sla').textContent = `Prazo de atendimento: ${slaLabel}`;
  document.getElementById('wa-modal').classList.remove('hidden');
}

function closeWaModal() {
  document.getElementById('wa-modal').classList.add('hidden');
}

// ============================================================
// ANEXO MODAL (visualizar print/arquivo em vez de baixar)
// ============================================================
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

function openAnexoModal(url, title, ext) {
  const body = document.getElementById('anexo-modal-body');
  const isImage = IMAGE_EXTENSIONS.includes((ext || '').toLowerCase()) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);

  document.getElementById('anexo-modal-title').textContent = title || 'Anexo';

  if (isImage) {
    body.innerHTML = `<img src="${escHtml(url)}" alt="${escHtml(title || 'anexo')}" class="anexo-modal-img">`;
  } else {
    body.innerHTML = `
      <p class="anexo-modal-fallback">Pré-visualização não disponível para este tipo de arquivo.</p>
      <a href="${escHtml(url)}" target="_blank" rel="noopener" class="btn-primary">Abrir arquivo</a>
    `;
  }

  document.getElementById('anexo-modal').classList.remove('hidden');
}

function closeAnexoModal() {
  document.getElementById('anexo-modal').classList.add('hidden');
  document.getElementById('anexo-modal-body').innerHTML = '';
}

function setupAnexoModal() {
  document.getElementById('anexo-modal-close')?.addEventListener('click', closeAnexoModal);
  document.getElementById('anexo-modal-overlay')?.addEventListener('click', closeAnexoModal);

  document.addEventListener('click', e => {
    const chip = e.target.closest('.attachment-chip');
    if (!chip) return;
    openAnexoModal(chip.dataset.url, chip.dataset.title, chip.dataset.ext);
  });
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
  document.getElementById('settings-logout')?.addEventListener('click', doLogout);
}

function openSettings() {
  document.getElementById('settings-name-display').textContent = store.get('user_name') || '—';
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

// Não dá mais pra "trocar de nome" aqui — quem você é vem da sessão autenticada por senha,
// não de uma seleção livre. Pra usar o app como outra pessoa, precisa desconectar e logar
// de novo com a senha dela (é exatamente isso que impede um solicitante ver chamado de outro).
async function doLogout() {
  if (!confirm('Desconectar?')) return;
  await logoutFromServer();
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
// OFFLINE BANNER
// ============================================================
function setupOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;

  const update = () => banner.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
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
// ANEXOS (seleção de arquivo + colar print da área de transferência)
// ============================================================
const MAX_ANEXO_MB    = 10;
const MAX_ANEXO_BYTES = MAX_ANEXO_MB * 1024 * 1024;

function filtrarAnexosValidos(files) {
  const validos    = [];
  const rejeitados = [];
  files.forEach(f => (f.size > MAX_ANEXO_BYTES ? rejeitados.push(f) : validos.push(f)));
  return { validos, rejeitados };
}

function renderAnexoList() {
  const input = document.getElementById('f-anexo');
  const list  = document.getElementById('anexo-list');
  if (!input || !list) return;

  const files = Array.from(input.files || []);
  list.innerHTML = files.map((f, i) => `
    <span class="anexo-chip" data-idx="${i}">
      📎 ${escHtml(f.name)}
      <button type="button" class="anexo-remove" data-idx="${i}" aria-label="Remover anexo">×</button>
    </span>
  `).join('');

  list.querySelectorAll('.anexo-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const dt  = new DataTransfer();
      files.filter((_, i) => i !== idx).forEach(f => dt.items.add(f));
      input.files = dt.files;
      renderAnexoList();
    });
  });
}

function setupAnexo() {
  const input = document.getElementById('f-anexo');
  const form  = document.getElementById('chamado-form');
  if (!input || !form) return;

  input.addEventListener('change', () => {
    const { validos, rejeitados } = filtrarAnexosValidos(Array.from(input.files || []));
    if (rejeitados.length > 0) {
      const dt = new DataTransfer();
      validos.forEach(f => dt.items.add(f));
      input.files = dt.files;
      toast(`Arquivo(s) acima de ${MAX_ANEXO_MB}MB removido(s): ${rejeitados.map(f => f.name).join(', ')}`, 'error');
    }
    renderAnexoList();
  });

  form.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedImages = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const ext = item.type.split('/')[1] || 'png';
          pastedImages.push(new File([file], `print-${Date.now()}.${ext}`, { type: item.type }));
        }
      }
    }
    if (pastedImages.length === 0) return;

    e.preventDefault();

    const { validos, rejeitados } = filtrarAnexosValidos(pastedImages);
    if (rejeitados.length > 0) {
      toast(`Print acima de ${MAX_ANEXO_MB}MB não foi anexado`, 'error');
    }
    if (validos.length === 0) return;

    const dt = new DataTransfer();
    Array.from(input.files || []).forEach(f => dt.items.add(f));
    validos.forEach(f => dt.items.add(f));
    input.files = dt.files;

    renderAnexoList();
    toast(`Print colado: ${validos.length} imagem(ns) anexada(s)`, 'success');
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

  // Quem é o dono da subscription é resolvido pelo Worker a partir da sessão — não manda
  // mais nenhum índice daqui (ver handleSubscribe em push-worker.js).
  await fetch(`${WORKER_URL}/subscribe`, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'X-App-Secret':    APP_SHARED_SECRET,
      'X-Session-Token': store.get('session_token') || ''
    },
    body: JSON.stringify({ subscription: sub.toJSON() })
  });
}

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function checkStatusChanges(newTasks) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

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

async function boot() {
  document.getElementById('boot-loading').classList.remove('hidden');
  document.getElementById('boot-error').classList.add('hidden');
  try {
    await loadSolicitantes();
  } catch (err) {
    document.getElementById('boot-loading').classList.add('hidden');
    document.getElementById('boot-error-msg').textContent =
      `Não foi possível carregar a lista de solicitantes. ${userFriendlyError(err)}`;
    document.getElementById('boot-error').classList.remove('hidden');
    return;
  }

  document.getElementById('boot-screen').classList.add('hidden');
  migrateLegacyUserIdx(); // só preenche user_name pra pré-selecionar — não substitui o login

  const myName = store.get('user_name');
  const hasSession = !!store.get('session_token');
  if (hasSession && myName && cuSolicitanteMap[myName] !== undefined) {
    initApp();
  } else {
    showSetup();
    document.getElementById('setup-form')?.addEventListener('submit', onSetupSubmit);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  // Listener para mensagens do Service Worker (notificationclick com app aberto)
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'OPEN_TASK') {
      switchTab(e.data.tab);
      highlightTask(e.data.task_id);
    }
  });

  document.getElementById('boot-retry-btn')?.addEventListener('click', boot);
  boot();
});
