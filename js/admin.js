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

// ⚠️ Mesmas cores de PRIORITY em app.js — chave aqui é a string que a própria ClickUp
// devolve em task.priority.priority (raw da API, não passa por CATEGORIA_PRIORIDADE).
// "low" não é usado pela regra de negócio do app (nenhuma categoria mapeia pra ela),
// mas fica mapeado por segurança caso apareça em algum chamado antigo/editado direto na ClickUp.
const PRIORITY_MAP = {
  urgent: { label: 'Urgente', color: '#ef5350' },
  high:   { label: 'Alta',    color: '#ff9800' },
  normal: { label: 'Normal',  color: '#2196f3' },
  low:    { label: 'Baixa',   color: '#8d8d8d' },
};

// ⚠️ Cores confirmadas direto na configuração real da lista na ClickUp (GET /list/:id via
// MCP, 2026-08-07) — não são só uma aproximação visual. "aberto" usa a cor padrão do tipo
// "open" da própria ClickUp (var(--cu-status-open), sem hex customizado — por isso aparece
// cinza/vazado nas telas da ClickUp, nunca foi azul de verdade); as outras 3 já batiam.
const STATUS_MAP = {
  'aberto':          { label: 'Aberto',          bg: '#e3f2fd', color: '#1565c0', dot: '#87909e' },
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

// Reaproveita .prio-dot de css/style.css (já usado nos cards de chamado do app principal) —
// bolinha colorida + label, mesma linguagem visual em vez de inventar componente novo.
function priorityHtml(task) {
  const info = PRIORITY_MAP[task.priority?.priority];
  if (!info) return '<span class="cell-muted">—</span>';
  return `<span class="prio-dot" style="color:${info.color}">${escHtml(info.label)}</span>`;
}

// Chip colorido de Tipo — mesma cor usada em "Volume por tipo", pra bater com a
// linguagem visual de tag colorida que a própria ClickUp usa nessa coluna.
function tipoChipHtml(tipoIdx) {
  const tipo = TIPOS.find(t => t.orderindex === Number(tipoIdx));
  if (!tipo) return '—';
  return `<span class="tipo-chip" style="background:${tipo.color}22;color:${tipo.color}">${escHtml(tipo.name)}</span>`;
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

// 'quadro' ou 'tabela' — mesma lógica de filtro/busca por trás, só muda como renderiza.
// Quadro é o padrão (2026-08-07): é a visão que a TI usa pra trabalhar no dia a dia,
// igual ao board que eles já usavam na ClickUp. A Tabela fica pra quando precisa
// varrer/exportar muita coisa de uma vez. Lembra a última escolha entre sessões,
// igual a seção da sidebar já faz.
let viewMode = store.get('admin_view_mode') || 'quadro';

// Tabela agrupada por status (mesma ideia visual da própria ClickUp: seção por status,
// expande/recolhe) — substitui a paginação global antiga. Lembra estado entre re-renders
// e agora também entre sessões (localStorage), igual viewMode/sidebar já fazem.
const DEFAULT_GROUP_COLLAPSED = { aberto: false, 'em atendimento': false, pendente: false, encerrado: false };
let groupCollapsed = { ...DEFAULT_GROUP_COLLAPSED, ...JSON.parse(store.get('admin_group_collapsed') || '{}') };

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
  // Sai do estado "Verificando sessão salva…" (se estava nele) e mostra o form de
  // verdade — chegou aqui é porque o boot() desistiu de tentar sozinho.
  document.getElementById('gate-checking').classList.add('hidden');
  document.getElementById('gate-form').classList.remove('hidden');
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
    setupAdminPolling();
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
// SIDEBAR — protótipo de navegação lateral recolhível, base pra um futuro
// SaaS de CRM completo (ver CLAUDE.md, "Painel de admin"). Só troca qual
// <div class="admin-section"> fica visível — os dados de ambas as seções
// já são carregados juntos no boot (loadMetrics + loadTasks em paralelo),
// trocar de seção não refaz nenhuma chamada ao Worker.
// ============================================================
const SECTION_META = {
  gestao:    { title: 'Gestão',    subtitle: 'Aceite, mudança de status, atribuição de operador e solução dos chamados.' },
  dashboard: { title: 'Dashboard', subtitle: 'Indicadores e relatórios — volume por tipo/setor, SLA e tempo médio de atendimento.' },
};

function setActiveSection(section) {
  document.querySelectorAll('.sidebar-nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.section === section));
  document.getElementById('section-gestao').classList.toggle('hidden', section !== 'gestao');
  document.getElementById('section-dashboard').classList.toggle('hidden', section !== 'dashboard');
  document.getElementById('page-title').textContent = SECTION_META[section].title;
  document.getElementById('page-subtitle').textContent = SECTION_META[section].subtitle;
  store.set('admin_active_section', section);
}

document.querySelectorAll('.sidebar-nav-item[data-section]').forEach(btn => {
  btn.addEventListener('click', () => setActiveSection(btn.dataset.section));
});

document.getElementById('btn-sidebar-toggle').addEventListener('click', () => {
  const collapsed = document.getElementById('sidebar').classList.toggle('collapsed');
  store.set('admin_sidebar_collapsed', collapsed ? '1' : '0');
});

// Restaura a seção/estado da sidebar de uma visita anterior; sem preferência salva,
// telas estreitas (celular/tablet) já nascem com a sidebar recolhida (só ícones).
(function restoreSidebarState() {
  const savedSection = store.get('admin_active_section');
  if (savedSection && SECTION_META[savedSection]) setActiveSection(savedSection);

  const savedCollapsed = store.get('admin_sidebar_collapsed');
  const shouldCollapse = savedCollapsed !== null ? savedCollapsed === '1' : window.matchMedia('(max-width: 900px)').matches;
  document.getElementById('sidebar').classList.toggle('collapsed', shouldCollapse);
})();

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

// Filtros aplicam sozinhos ao mudar — sem botão "Filtrar". São filtros de servidor
// (viram query string em /admin/tasks), então cada mudança é 1 chamada ao Worker;
// como são selects (não digitação), não precisa de debounce. A busca por título é
// que é client-side e tem debounce próprio, ver o listener de #f-busca.
const FILTER_SELECT_IDS = ['f-status', 'f-setor', 'f-tipo', 'f-operador', 'f-solicitante'];
FILTER_SELECT_IDS.forEach(id => {
  document.getElementById(id).addEventListener('change', () => loadTasks());
});

document.getElementById('btn-limpar').addEventListener('click', () => {
  [...FILTER_SELECT_IDS, 'f-busca'].forEach(id => {
    document.getElementById(id).value = '';
  });
  loadTasks();
});

// O filtro de Status não faz sentido no Quadro — ele já é agrupado por status, então
// filtrar por um status só deixa as outras 3 colunas vazias em vez de "filtrar" algo.
// Some no Quadro, volta na Tabela.
function updateFilterVisibility() {
  document.getElementById('filter-field-status').classList.toggle('hidden', viewMode === 'quadro');
}

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
  const setorNome = optionName(SETORES, getCF(task, SETOR_FIELD_ID));
  const solIdx    = getCF(task, SOLICITANTE_FIELD_ID);
  const solNome   = solicitanteIdxToName[solIdx] ?? '—';
  const operadores = (task.assignees || [])
    .map(a => a.username || OPERADORES[String(a.id)] || `#${a.id}`)
    .join(', ') || '—';

  const atrasado  = isAtrasado(task);
  const prazoTxt  = task.due_date ? fmtDate(task.due_date) : '—';
  const criadoTxt = task.date_created ? fmtDate(task.date_created) : '—';

  // Sem coluna de Status aqui — já fica implícito pelo cabeçalho do grupo (ver renderTableGrouped).
  return `<tr>
    <td><span class="task-name" title="${escHtml(task.name || '')}">${escHtml(task.name || '(sem título)')}</span></td>
    <td>${priorityHtml(task)}</td>
    <td>${tipoChipHtml(getCF(task, TIPO_FIELD_ID))}</td>
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

// Só true depois que o admin de fato interage com o select de operador — usado pra decidir
// se manda "assigneeId" no POST ou não (ver comentário no listener de #modal-operador abaixo,
// achado do revisor 2026-08-07: mandar sempre colapsava silenciosamente chamado com 2+
// assignees pra só 1, mesmo quando o admin só queria mudar status/solução).
let operadorTouched = false;

function openTaskModal(task) {
  modalTaskId = task.id;
  operadorTouched = false;
  document.getElementById('task-modal-title').textContent = task.name || '(sem título)';
  // description é texto puro que já vem no payload da ClickUp (passa direto por /admin/tasks,
  // sem custom field nenhum) — text_content é o fallback que a API usa quando description
  // vem vazio em algumas versões da task.
  document.getElementById('modal-descricao').textContent = task.description || task.text_content || '(sem descrição)';

  // Se o status real não for um dos 4 esperados, não assume "Aberto" em silêncio — avisa,
  // pra ninguém salvar sem querer e sobrescrever um status que o painel não reconhece.
  const statusKey = (task.status?.status || '').toLowerCase();
  const statusWarningEl = document.getElementById('modal-status-warning');
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, statusKey)) {
    document.getElementById('modal-status').value = statusKey;
    statusWarningEl.classList.add('hidden');
  } else {
    document.getElementById('modal-status').value = 'aberto';
    statusWarningEl.textContent = `⚠ Status real ("${task.status?.status || '—'}") não é reconhecido pelo painel — "Aberto" foi pré-selecionado só como padrão. Confira antes de salvar.`;
    statusWarningEl.classList.remove('hidden');
  }

  // Só dá pra pré-preencher UM operador no select (é um select simples, não múltiplo) — se
  // o chamado já tiver 2+ atribuídos, avisa explicitamente, porque mudar esse campo e salvar
  // substitui TODOS pelo único escolhido aqui (ver postTaskUpdate/handleAdminUpdateTask).
  const assignees = task.assignees || [];
  document.getElementById('modal-operador').value = assignees[0] ? String(assignees[0].id) : '';
  const operadorHintEl = document.getElementById('modal-operador-hint');
  if (assignees.length > 1) {
    const nomes = assignees.map(a => a.username || OPERADORES[String(a.id)] || `#${a.id}`).join(', ');
    operadorHintEl.textContent = `⚠ ${assignees.length} operadores atribuídos (${nomes}). Deixe como está se não quiser mudar quem está atribuído — mudar aqui substitui todos por só 1.`;
    operadorHintEl.classList.remove('hidden');
  } else {
    operadorHintEl.classList.add('hidden');
  }

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

// Marca que o admin realmente tocou no campo — é isso que decide se "assigneeId" vai no
// POST (ver handler de #btn-modal-salvar). Sem essa marcação, salvar uma mudança de status
// num chamado com 2 assignees removeria um deles mesmo sem o admin ter pedido isso.
document.getElementById('modal-operador').addEventListener('change', () => { operadorTouched = true; });

// POST /admin/tasks/:id compartilhado entre o modal "Gerenciar" e o arrastar-e-soltar do
// Quadro — os dois mutam chamado do mesmo jeito, só o body que muda (completo vs. só status).
// 403 aqui já limpa a sessão e devolve pro gate, igual o resto do arquivo já faz.
async function postTaskUpdate(taskId, body) {
  const res = await fetch(`${ADMIN_BASE}/tasks/${taskId}`, {
    method: 'POST',
    headers: { 'X-Admin-Secret': adminSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 403) {
    store.remove('admin_secret');
    adminSecret = '';
    showGate('Segredo de admin inválido ou expirado. Entre de novo.');
    const err = new Error('Segredo de admin inválido ou expirado.');
    err.status = 403;
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erro HTTP ${res.status}`);
  }
  return res.json();
}

document.getElementById('btn-modal-salvar').addEventListener('click', async () => {
  if (!modalTaskId) return;
  const btn   = document.getElementById('btn-modal-salvar');
  const errEl = document.getElementById('task-modal-error');
  errEl.classList.add('hidden');
  btn.disabled = true;

  try {
    const body = {
      status: document.getElementById('modal-status').value,
      solucao: document.getElementById('modal-solucao').value,
    };
    // Só manda assigneeId se o admin realmente tocou o campo — senão, um chamado com 2+
    // operadores atribuídos teria um deles removido só por salvar uma mudança de status
    // (achado do revisor 2026-08-07). Sem essa chave, o Worker nem toca nos assignees.
    if (operadorTouched) {
      const operadorVal = document.getElementById('modal-operador').value;
      body.assigneeId = operadorVal ? Number(operadorVal) : null; // null = "Sem atribuição" remove quem estava atribuído
    }

    await postTaskUpdate(modalTaskId, body);

    toast('Chamado atualizado.', 'success');
    closeTaskModal();
    loadTasks();
    loadMetrics();
  } catch (err) {
    if (err.status === 403) { closeTaskModal(); return; }
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
  const emptyEl  = document.getElementById('tasks-empty');
  const wrapEl   = document.getElementById('tasks-table-wrap');
  const kanbanEl = document.getElementById('kanban-board');
  const countEl  = document.getElementById('tasks-count');

  countEl.textContent = term
    ? `Chamados (${list.length} de ${allTasks.length})`
    : `Chamados (${allTasks.length})`;

  if (list.length === 0) {
    emptyEl.classList.remove('hidden');
    wrapEl.classList.add('hidden');
    kanbanEl.classList.add('hidden');
    document.getElementById('tasks-tbody').innerHTML = '';
    return;
  }
  emptyEl.classList.add('hidden');

  if (viewMode === 'quadro') {
    wrapEl.classList.add('hidden');
    kanbanEl.classList.remove('hidden');
    renderKanban(list);
  } else {
    kanbanEl.classList.add('hidden');
    wrapEl.classList.remove('hidden');
    renderTableGrouped(list);
  }
}

// ============================================================
// TABELA AGRUPADA POR STATUS — mesma ideia visual da própria ClickUp: cada
// status é uma seção com ícone+contador, expande/recolhe (substitui a
// paginação global de 25/página; cada grupo já é uma divisão natural).
// ============================================================
const STATUS_GROUP_ORDER = ['aberto', 'em atendimento', 'pendente', 'encerrado'];
const GROUP_TABLE_LIMIT = 200; // teto por grupo, mesma ideia do KANBAN_CARD_LIMIT
const TABLE_COLSPAN = 9; // Chamado, Prioridade, Tipo, Setor, Solicitante, Operador, Prazo, Criado em, Ações

// Círculo vazado pra "Aberto" (nada feito ainda) e círculo preenchido com check pra
// qualquer status que já teve algum andamento (Em Atendimento/Pendente/Encerrado) —
// mesmo padrão de ícone da própria ClickUp nas seções agrupadas por status.
function statusGroupIconHtml(statusKey, color) {
  if (statusKey === 'aberto') {
    return `<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
  }
  return `<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${color}"/><path d="M4.5 8.2l2.3 2.3L11.5 5.8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function groupHeaderRowHtml(statusKey, count) {
  const info = STATUS_MAP[statusKey] || { label: statusKey, dot: '#94a3b8' };
  const collapsed = !!groupCollapsed[statusKey];
  return `<tr class="group-header-row">
    <td colspan="${TABLE_COLSPAN}">
      <button type="button" class="group-toggle-btn" data-group-toggle="${statusKey}">
        <span class="group-chevron${collapsed ? ' collapsed' : ''}">▾</span>
        <span class="group-status-icon">${statusGroupIconHtml(statusKey, info.dot)}</span>
        <span class="group-status-label">${escHtml(info.label)}</span>
        <span class="group-status-count">${count}</span>
      </button>
    </td>
  </tr>`;
}

function renderTableGrouped(list) {
  const tbody = document.getElementById('tasks-tbody');
  const byStatus = { aberto: [], 'em atendimento': [], pendente: [], encerrado: [] };
  for (const t of list) {
    const key = (t.status?.status || '').toLowerCase();
    if (byStatus[key]) byStatus[key].push(t);
    // status fora dos 4 esperados não aparece agrupado (raro).
  }

  let html = '';
  for (const statusKey of STATUS_GROUP_ORDER) {
    const tasks = byStatus[statusKey];
    html += groupHeaderRowHtml(statusKey, tasks.length);
    if (groupCollapsed[statusKey]) continue;

    if (tasks.length === 0) {
      html += `<tr class="group-body-row"><td colspan="${TABLE_COLSPAN}" class="group-empty-cell">Nenhum chamado.</td></tr>`;
      continue;
    }
    const shown = tasks.slice(0, GROUP_TABLE_LIMIT);
    html += shown.map(taskRowHtml).join('');
    if (tasks.length > GROUP_TABLE_LIMIT) {
      html += `<tr class="group-body-row"><td colspan="${TABLE_COLSPAN}" class="group-empty-cell">+${tasks.length - GROUP_TABLE_LIMIT} chamado(s) — refine os filtros/busca pra ver todos</td></tr>`;
    }
  }
  tbody.innerHTML = html;
}

document.getElementById('tasks-tbody').addEventListener('click', e => {
  const toggleBtn = e.target.closest('[data-group-toggle]');
  if (toggleBtn) {
    const key = toggleBtn.dataset.groupToggle;
    groupCollapsed[key] = !groupCollapsed[key];
    store.set('admin_group_collapsed', JSON.stringify(groupCollapsed));
    renderTableGrouped(lastVisibleTasks);
  }
});

// ============================================================
// QUADRO (Kanban) — mesmos dados/filtros da tabela, só outra forma de olhar.
// Clique no card abre o mesmo modal de "Gerenciar" (sem arrastar-e-soltar,
// decisão deliberada: reaproveita 100% do modal já testado, menor risco).
// ============================================================
const KANBAN_CARD_LIMIT = 100; // teto por coluna, só pra não desenhar milhares de cards de uma vez
const KANBAN_COLUMN_IDS = {
  'aberto':          'aberto',
  'em atendimento':  'em-atendimento',
  'pendente':        'pendente',
  'encerrado':       'encerrado',
};

function kanbanCardHtml(task) {
  const setorNome = optionName(SETORES, getCF(task, SETOR_FIELD_ID));
  const solNome   = solicitanteIdxToName[getCF(task, SOLICITANTE_FIELD_ID)] ?? '—';
  const operadores = (task.assignees || [])
    .map(a => a.username || OPERADORES[String(a.id)] || `#${a.id}`)
    .join(', ') || '—';
  const atrasado = isAtrasado(task);
  const prazoTxt = task.due_date ? fmtDate(task.due_date) : '—';

  return `<div class="kanban-card${atrasado ? ' is-atrasado' : ''}" data-task-id="${escHtml(task.id)}" draggable="true">
    <div class="kanban-card-title" title="${escHtml(task.name || '')}">${escHtml(task.name || '(sem título)')}</div>
    <div class="kanban-card-tags">
      ${tipoChipHtml(getCF(task, TIPO_FIELD_ID))}
      ${priorityHtml(task)}
    </div>
    <div class="kanban-card-meta">
      <span>${escHtml(setorNome)}</span>
      <span>${escHtml(solNome)}</span>
      <span>${escHtml(operadores)}</span>
      <span class="kanban-card-prazo${atrasado ? ' atrasado' : ''}">${escHtml(prazoTxt)}${atrasado ? ' ⚠' : ''}</span>
    </div>
  </div>`;
}

function renderKanban(list) {
  const byStatus = { aberto: [], 'em atendimento': [], pendente: [], encerrado: [] };
  for (const task of list) {
    const key = (task.status?.status || '').toLowerCase();
    if (byStatus[key]) byStatus[key].push(task);
    // status fora dos 4 esperados não aparece no quadro (raro — a tabela continua mostrando).
  }

  for (const [statusKey, idSuffix] of Object.entries(KANBAN_COLUMN_IDS)) {
    const tasks = byStatus[statusKey];
    document.getElementById(`kanban-count-${idSuffix}`).textContent = tasks.length;
    const cardsEl = document.getElementById(`kanban-cards-${idSuffix}`);
    if (tasks.length === 0) {
      cardsEl.innerHTML = '<p class="kanban-empty-mini">Nenhum chamado.</p>';
      continue;
    }
    const shown = tasks.slice(0, KANBAN_CARD_LIMIT);
    cardsEl.innerHTML = shown.map(kanbanCardHtml).join('') +
      (tasks.length > KANBAN_CARD_LIMIT ? `<p class="kanban-empty-mini">+${tasks.length - KANBAN_CARD_LIMIT} chamado(s) — refine os filtros/busca pra ver todos</p>` : '');
  }
}

document.getElementById('kanban-board').addEventListener('click', e => {
  const card = e.target.closest('.kanban-card');
  if (!card) return;
  const task = allTasks.find(t => String(t.id) === card.dataset.taskId);
  if (task) openTaskModal(task);
});

// ============================================================
// ARRASTAR E SOLTAR — mover um card entre colunas muda só o status (não toca
// operador/solução). Mesma rota de mutação do modal "Gerenciar" (postTaskUpdate).
// Um drag-and-drop de verdade não dispara o 'click' que abre o modal (comportamento
// nativo do navegador), então os dois convivem sem conflito.
// ============================================================
document.getElementById('kanban-board').addEventListener('dragstart', e => {
  const card = e.target.closest('.kanban-card');
  if (!card) return;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.taskId);
});

document.getElementById('kanban-board').addEventListener('dragend', e => {
  const card = e.target.closest('.kanban-card');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.kanban-cards.drag-over').forEach(el => el.classList.remove('drag-over'));
});

document.querySelectorAll('.kanban-cards').forEach(coluna => {
  coluna.addEventListener('dragover', e => {
    e.preventDefault(); // sem isso o navegador nunca dispara o evento 'drop'
    coluna.classList.add('drag-over');
  });
  coluna.addEventListener('dragleave', () => coluna.classList.remove('drag-over'));
  coluna.addEventListener('drop', async e => {
    e.preventDefault();
    coluna.classList.remove('drag-over');

    const taskId = e.dataTransfer.getData('text/plain');
    const novoStatus = coluna.dataset.status;
    if (!taskId || !novoStatus) return;

    const task = allTasks.find(t => String(t.id) === taskId);
    if (!task) return;
    if ((task.status?.status || '').toLowerCase() === novoStatus) return; // soltou na mesma coluna

    try {
      await postTaskUpdate(taskId, { status: novoStatus });
      toast(`Chamado movido para ${STATUS_MAP[novoStatus]?.label || novoStatus}.`, 'success');
      loadTasks();
      loadMetrics();
    } catch (err) {
      if (err.status !== 403) toast(err.message || 'Não foi possível mover o chamado.', 'error');
    }
  });
});

function setViewMode(mode) {
  if (viewMode === mode) return;
  viewMode = mode;
  store.set('admin_view_mode', mode); // sobrevive a reload, igual a seção da sidebar já faz
  document.getElementById('btn-view-tabela').classList.toggle('active', mode === 'tabela');
  document.getElementById('btn-view-quadro').classList.toggle('active', mode === 'quadro');
  updateFilterVisibility();

  // Indo pro Quadro com filtro de status ativo: limpa e recarrega, senão ficaria um
  // filtro aplicado que o usuário não consegue mais ver nem desfazer (o campo sumiu).
  const statusEl = document.getElementById('f-status');
  if (mode === 'quadro' && statusEl.value) {
    statusEl.value = '';
    loadTasks();
    return;
  }
  applySearchAndRender();
}

document.getElementById('btn-view-tabela').addEventListener('click', () => setViewMode('tabela'));
document.getElementById('btn-view-quadro').addEventListener('click', () => setViewMode('quadro'));

document.getElementById('f-busca').addEventListener('input', () => {
  clearTimeout(window.__buscaDebounce);
  window.__buscaDebounce = setTimeout(applySearchAndRender, 200);
});

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
  const prioridadeNome = PRIORITY_MAP[task.priority?.priority]?.label || '';

  return [
    task.id,
    task.name || '',
    info?.label || task.status?.status || '',
    prioridadeNome,
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
  const headers = ['ID', 'Chamado', 'Status', 'Prioridade', 'Tipo', 'Setor', 'Solicitante', 'Operador(es)', 'Criado em', 'Prazo', 'Atrasado'];
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

// ============================================================
// POLLING (mesmo padrão de "smart polling" do app.js principal: 60s com a aba
// visível, 5min em background, refresh imediato ao voltar pra aba) — antes disso
// o painel só atualizava a lista de chamados com F5 manual.
// ============================================================
let adminPollingStarted = false;

async function loadTasksSilently() {
  // Não atropela o admin no meio de um drag-and-drop ou com o modal "Gerenciar"
  // aberto — um re-render nesse momento reconstruiria o Kanban/Tabela debaixo da
  // mão de quem está usando, ou fecharia o que estava sendo editado.
  if (modalTaskId != null) return;
  if (document.querySelector('.kanban-card.dragging')) return;
  try {
    const qs   = currentFilterParams().toString();
    const data = await adminRequest(`/tasks${qs ? '?' + qs : ''}`);
    allTasks = data.tasks || [];
    applySearchAndRender();
    tasksTruncated = !!data.truncated;
    updateTruncatedBanner();
  } catch (err) {
    // Poll de fundo é silencioso de propósito — não vale popup de erro a cada 60s.
    // 403 ainda precisa voltar pro gate (segredo pode ter sido revogado nesse meio-tempo).
    if (err.status === 403) showGate(err.message);
  }
}

function setupAdminPolling() {
  if (adminPollingStarted) return; // boot() e o login pelo form podem chamar isso os dois
  adminPollingStarted = true;
  let pollTimer = null;

  function scheduleNext() {
    clearTimeout(pollTimer);
    const delay = document.hidden ? 300000 : 60000; // 60s visível, 5min em background
    pollTimer = setTimeout(async () => {
      await loadTasksSilently();
      scheduleNext();
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadTasksSilently(); // volta pra aba: atualiza na hora
    scheduleNext();
  });

  scheduleNext();
}

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
  // viewMode pode ter sido restaurado do localStorage (sessão anterior) — sincroniza os
  // botões de toggle com o valor real, já que só setViewMode() faz isso e não é chamado no boot.
  document.getElementById('btn-view-tabela').classList.toggle('active', viewMode === 'tabela');
  document.getElementById('btn-view-quadro').classList.toggle('active', viewMode === 'quadro');
  updateFilterVisibility(); // depende do viewMode já sincronizado acima
  try {
    await loadSolicitanteOptions();
  } catch (err) {
    console.error(err);
    toast('Não foi possível carregar a lista de solicitantes para o filtro.', 'error');
  }
  await Promise.all([loadMetrics(), loadTasks()]);
}

// Confere o segredo salvo contra /admin/users. Só trata como "segredo inválido de
// verdade" quando o servidor responde 403 (igual adminRequest() já faz pro resto do
// painel) — qualquer outra falha (rede, 5xx, deploy em andamento) é transitória e NÃO
// deve forçar a pessoa a digitar o segredo de novo (bug 2026-08-10: essa função tratava
// qualquer !res.ok como "inválido" e limpava o localStorage, então uma falha passageira
// bastava pra pedir o segredo de novo a cada F5). Tenta 1 vez extra antes de desistir.
async function checkStoredSecret(isRetry = false) {
  try {
    const res = await fetch(`${ADMIN_BASE}/users`, { headers: { 'X-Admin-Secret': adminSecret } });
    if (res.status === 403) {
      store.remove('admin_secret');
      adminSecret = '';
      showGate('Segredo de admin inválido ou expirado. Entre de novo.');
      return;
    }
    if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
    showApp();
    await initPanelData();
    setupAdminPolling();
  } catch (err) {
    console.error(err);
    if (!isRetry) {
      await new Promise(r => setTimeout(r, 1500));
      return checkStoredSecret(true);
    }
    // Falha transitória mesmo depois do retry: mantém o segredo salvo (não é culpa
    // dele) e só avisa — a pessoa pode recarregar a página pra tentar de novo.
    showGate('Não foi possível confirmar sua sessão agora (falha de rede ou o servidor está temporariamente indisponível). Seu segredo salvo continua válido — recarregue a página pra tentar de novo, ou entre normalmente abaixo.');
  }
}

async function boot() {
  if (!adminSecret) return; // fica na tela de gate esperando o form
  await checkStoredSecret();
}

boot();
