'use strict';
// Testes unitários leves para as funções puras de js/app.js.
// Sem framework/dependência: usa vm+assert do Node. Rodar com `node tests/app.test.js`.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP_PATH = path.join(__dirname, '..', 'js', 'app.js');
const src = fs.readFileSync(APP_PATH, 'utf8');

// localStorage em memória (de verdade, não só stub) — permite testar store.get/set/remove.
const fakeLocalStorage = (() => {
  let data = {};
  return {
    getItem:    k => (k in data ? data[k] : null),
    setItem:    (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    __reset:    () => { data = {}; },
  };
})();

// Stubs mínimos de globals de browser para o script carregar fora do navegador.
const noop = () => {};
const sandbox = {
  window:   { addEventListener: noop },
  document: { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [] },
  navigator: { onLine: true },
  localStorage: fakeLocalStorage,
  location: { hash: '', href: 'http://localhost/', pathname: '/' },
  console,
  Notification: undefined,
};
vm.createContext(sandbox);

// Expõe as funções/constantes internas do app.js (top-level do mesmo script) pra fora do vm.
const exportLine = `
;globalThis.__exports = {
  escHtml, fmtMs, fmtDate, timeAgo, timeUntil, isOverdue, overdueFor,
  optionName, buildSolicitanteMaps, myCuIdx, solicitanteDisplayName, migrateLegacyUserIdx,
  filtrarAnexosValidos, waNumberForTask, getCustomField, slaProgressInfo,
  CATEGORIA_PRIORIDADE, PRIORITY, LEGACY_USER_IDX_TO_NAME, TIPOS, SETORES,
  OPERADOR_WHATSAPP, OPERADORES, STATUS_MAP, store,
};`;
vm.runInContext(src + exportLine, sandbox, { filename: 'app.js' });
const A = sandbox.__exports;

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fakeLocalStorage.__reset();
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

console.log('escHtml');
test('escapa tags e aspas', () => {
  assert.strictEqual(A.escHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});
test('escapa &', () => {
  assert.strictEqual(A.escHtml('a & b'), 'a &amp; b');
});
test('converte não-string', () => {
  assert.strictEqual(A.escHtml(123), '123');
});

console.log('fmtMs');
test('null/zero retorna null', () => {
  assert.strictEqual(A.fmtMs(0), null);
  assert.strictEqual(A.fmtMs(null), null);
});
test('minutos', () => {
  assert.strictEqual(A.fmtMs(5 * 60000), '5min');
});
test('horas e minutos', () => {
  assert.strictEqual(A.fmtMs(90 * 60000), '1h 30min');
});
test('dias e horas', () => {
  assert.strictEqual(A.fmtMs(25 * 3600000), '1d 1h');
});

console.log('timeUntil (regressão: faltavam os minutos, só mostrava hora cheia)');
test('menos de 1 minuto retorna "em breve"', () => {
  assert.strictEqual(A.timeUntil(Date.now() + 30000), 'em breve');
});
test('menos de 1h mostra só minutos', () => {
  assert.strictEqual(A.timeUntil(Date.now() + 45 * 60000), 'em 45min');
});
test('3h59min mostra horas E minutos, não arredonda pra 3h', () => {
  const ts = Date.now() + (3 * 3600000 + 59 * 60000);
  assert.strictEqual(A.timeUntil(ts), 'em 3h 59min');
});
test('hora exata (sem minutos) não mostra "0min" sobrando', () => {
  assert.strictEqual(A.timeUntil(Date.now() + 4 * 3600000), 'em 4h');
});
test('mais de 24h mostra dias e horas', () => {
  const ts = Date.now() + (25 * 3600000);
  assert.strictEqual(A.timeUntil(ts), 'em 1d 1h');
});
test('ts no passado ou nulo retorna null', () => {
  assert.strictEqual(A.timeUntil(Date.now() - 1000), null);
  assert.strictEqual(A.timeUntil(null), null);
});

console.log('isOverdue / overdueFor');
test('encerrado nunca está atrasado', () => {
  assert.strictEqual(A.isOverdue({ status: { status: 'encerrado' }, due_date: String(Date.now() - 100000) }), false);
});
test('pendente nunca está atrasado (SLA pausado)', () => {
  assert.strictEqual(A.isOverdue({ status: { status: 'pendente' }, due_date: String(Date.now() - 100000) }), false);
});
test('due_date no passado e status aberto -> atrasado', () => {
  assert.strictEqual(A.isOverdue({ status: { status: 'aberto' }, due_date: String(Date.now() - 100000) }), true);
});
test('due_date no futuro -> não atrasado', () => {
  assert.strictEqual(A.isOverdue({ status: { status: 'aberto' }, due_date: String(Date.now() + 100000) }), false);
});
test('sem due_date -> não atrasado', () => {
  assert.strictEqual(A.isOverdue({ status: { status: 'aberto' } }), false);
});

console.log('optionName (usado hoje só por TIPOS/SETORES)');
test('encontra pelo orderindex', () => {
  assert.strictEqual(A.optionName(A.TIPOS, 0), 'Notebooks');
});
test('orderindex como string numérica funciona (Number())', () => {
  assert.strictEqual(A.optionName(A.TIPOS, '0'), 'Notebooks');
});
test('null/undefined retorna placeholder', () => {
  assert.strictEqual(A.optionName(A.TIPOS, null), '—');
  assert.strictEqual(A.optionName(A.TIPOS, undefined), '—');
});
test('orderindex inexistente retorna placeholder', () => {
  assert.strictEqual(A.optionName(A.TIPOS, 999), '—');
});

console.log('filtrarAnexosValidos');
test('separa arquivos acima do limite de 10MB', () => {
  const pequeno = { name: 'a.png', size: 1024 };
  const grande  = { name: 'b.png', size: 11 * 1024 * 1024 };
  const { validos, rejeitados } = A.filtrarAnexosValidos([pequeno, grande]);
  assert.strictEqual(validos.length, 1);
  assert.strictEqual(validos[0], pequeno);
  assert.strictEqual(rejeitados.length, 1);
  assert.strictEqual(rejeitados[0], grande);
});

console.log('waNumberForTask (regressão do bug do dígito 9 do Everson)');
test('Everson (170628721) tem número de 13 dígitos com o 9 do celular', () => {
  const num = A.waNumberForTask({ assignees: [{ id: 170628721 }] });
  assert.strictEqual(num, '5585989304648');
  assert.strictEqual(num.length, 13);
});
test('Henrique (200498355) tem número de 13 dígitos', () => {
  const num = A.waNumberForTask({ assignees: [{ id: 200498355 }] });
  assert.strictEqual(num, '5585999419866');
  assert.strictEqual(num.length, 13);
});
test('operador desconhecido cai no número padrão', () => {
  assert.strictEqual(A.waNumberForTask({ assignees: [{ id: 999 }] }), A.OPERADOR_WHATSAPP['200498355']);
});
test('sem assignee cai no número padrão', () => {
  assert.strictEqual(A.waNumberForTask({ assignees: [] }), A.OPERADOR_WHATSAPP['200498355']);
});

console.log('CATEGORIA_PRIORIDADE (regra de negócio: nunca expor prioridade Baixa)');
test('toda categoria de TIPOS tem mapeamento de prioridade', () => {
  A.TIPOS.forEach(t => {
    assert.ok(A.CATEGORIA_PRIORIDADE[t.orderindex] !== undefined, `TIPO ${t.name} sem prioridade mapeada`);
  });
});
test('nenhuma categoria mapeia para prioridade inexistente em PRIORITY', () => {
  Object.values(A.CATEGORIA_PRIORIDADE).forEach(p => {
    assert.ok(A.PRIORITY[p], `prioridade ${p} não existe em PRIORITY`);
  });
});
test('prioridade "Baixa" (4) nunca é usada', () => {
  assert.ok(!Object.values(A.CATEGORIA_PRIORIDADE).includes(4));
  assert.strictEqual(A.PRIORITY[4], undefined);
});

console.log('getCustomField');
test('retorna null quando campo ausente', () => {
  assert.strictEqual(A.getCustomField({ custom_fields: [] }, 'x'), null);
});
test('extrai orderindex de objeto de dropdown', () => {
  const task = { custom_fields: [{ id: 'f1', value: { orderindex: 3, id: 'abc', name: 'X' } }] };
  assert.strictEqual(A.getCustomField(task, 'f1'), 3);
});
test('retorna valor primitivo diretamente', () => {
  const task = { custom_fields: [{ id: 'f1', value: 5 }] };
  assert.strictEqual(A.getCustomField(task, 'f1'), 5);
});

console.log('slaProgressInfo');
test('null para status encerrado/pendente', () => {
  assert.strictEqual(A.slaProgressInfo({ status: { status: 'encerrado' } }), null);
  assert.strictEqual(A.slaProgressInfo({ status: { status: 'pendente' } }), null);
});
test('null sem due_date/date_created válidos', () => {
  assert.strictEqual(A.slaProgressInfo({ status: { status: 'aberto' } }), null);
});
test('pct fica sempre entre 0 e 100', () => {
  const start = Date.now() - 1000000;
  const end   = Date.now() + 1000000;
  const info  = A.slaProgressInfo({ status: { status: 'aberto' }, date_created: String(start), due_date: String(end) });
  assert.ok(info.pct >= 0 && info.pct <= 100);
});

console.log('STATUS_MAP (integridade de dados)');
test('STATUS_MAP tem exatamente os 4 status esperados', () => {
  assert.deepStrictEqual(Object.keys(A.STATUS_MAP).sort(), ['aberto', 'em atendimento', 'encerrado', 'pendente']);
});

console.log('buildSolicitanteMaps (lista de solicitantes agora vem direto da ClickUp)');
const FAKE_CU_OPTIONS = [
  { name: 'Ana Clara', orderindex: 0 },
  { name: 'Ariele Santo', orderindex: 1 },
  { name: 'Késsia Rodrigues', orderindex: 19 },
  { name: 'Michael Vasconcelos', orderindex: 26 },
  { name: 'Natália Leandro', orderindex: 28 },
  { name: 'Outros', orderindex: 29 },
];
test('monta o mapa nome -> orderindex da ClickUp corretamente', () => {
  const { nameToIdx } = A.buildSolicitanteMaps(FAKE_CU_OPTIONS);
  assert.strictEqual(nameToIdx['Michael Vasconcelos'], 26);
  assert.strictEqual(nameToIdx['Késsia Rodrigues'], 19);
});
test('monta o mapa reverso orderindex -> nome corretamente', () => {
  const { idxToName } = A.buildSolicitanteMaps(FAKE_CU_OPTIONS);
  assert.strictEqual(idxToName[26], 'Michael Vasconcelos');
  assert.strictEqual(idxToName[19], 'Késsia Rodrigues');
  // regressão do bug de 2026-07-23: 26 tinha que resolver pro Michael, não pra outra pessoa
  assert.notStrictEqual(idxToName[26], 'Késsia Rodrigues');
});
test('sortedOptions fica em ordem alfabética, independente da ordem de entrada', () => {
  const { sortedOptions } = A.buildSolicitanteMaps(FAKE_CU_OPTIONS);
  const names = sortedOptions.map(o => o.name);
  const expected = [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  assert.strictEqual(names.join('|'), expected.join('|'));
});
test('sortedOptions preserva o orderindex original de cada nome (não reindexa)', () => {
  const { sortedOptions } = A.buildSolicitanteMaps(FAKE_CU_OPTIONS);
  const michael = sortedOptions.find(o => o.name === 'Michael Vasconcelos');
  assert.strictEqual(michael.orderindex, 26);
});

console.log('LEGACY_USER_IDX_TO_NAME (tabela de migração — não deve mais ser editada)');
test('tem os 42 nomes da versão antiga (0.2.4), sem duplicar orderindex', () => {
  const idxs = Object.keys(A.LEGACY_USER_IDX_TO_NAME).map(Number);
  assert.strictEqual(idxs.length, 42);
  assert.strictEqual(new Set(idxs).size, 42);
});
test('trava os índices do bug reportado em 2026-07-23', () => {
  assert.strictEqual(A.LEGACY_USER_IDX_TO_NAME[18], 'Késsia Rodrigues');
  assert.strictEqual(A.LEGACY_USER_IDX_TO_NAME[25], 'Michael Vasconcelos');
});

console.log('migrateLegacyUserIdx (migra quem já tinha configurado antes da v0.2.5)');
test('converte user_idx antigo pra user_name e remove a chave antiga', () => {
  A.store.set('user_idx', '25');
  A.migrateLegacyUserIdx();
  assert.strictEqual(A.store.get('user_name'), 'Michael Vasconcelos');
  assert.strictEqual(A.store.get('user_idx'), null);
});
test('não faz nada se já existe user_name', () => {
  A.store.set('user_name', 'Alguém');
  A.store.set('user_idx', '25');
  A.migrateLegacyUserIdx();
  assert.strictEqual(A.store.get('user_name'), 'Alguém');
});
test('não faz nada se nunca configurou (sem user_idx nem user_name)', () => {
  A.migrateLegacyUserIdx();
  assert.strictEqual(A.store.get('user_name'), null);
});

console.log('myCuIdx / solicitanteDisplayName (sem mapa carregado — app recém-aberto)');
test('myCuIdx sem user_name retorna undefined', () => {
  assert.strictEqual(A.myCuIdx(), undefined);
});
test('solicitanteDisplayName sem mapa carregado retorna placeholder', () => {
  assert.strictEqual(A.solicitanteDisplayName(26), '—');
});
test('solicitanteDisplayName com null/undefined retorna placeholder', () => {
  assert.strictEqual(A.solicitanteDisplayName(null), '—');
  assert.strictEqual(A.solicitanteDisplayName(undefined), '—');
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed > 0 ? 1 : 0);
