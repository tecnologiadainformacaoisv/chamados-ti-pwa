'use strict';
// Testes unitários leves para as funções puras de js/app.js.
// Sem framework/dependência: usa vm+assert do Node. Rodar com `node tests/app.test.js`.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP_PATH = path.join(__dirname, '..', 'js', 'app.js');
const src = fs.readFileSync(APP_PATH, 'utf8');

// Stubs mínimos de globals de browser para o script carregar fora do navegador.
const noop = () => {};
const sandbox = {
  window:   { addEventListener: noop },
  document: { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [] },
  navigator: { onLine: true },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { hash: '', href: 'http://localhost/', pathname: '/' },
  console,
  Notification: undefined,
};
vm.createContext(sandbox);

// Expõe as funções/constantes internas do app.js (top-level do mesmo script) pra fora do vm.
const exportLine = `
;globalThis.__exports = {
  escHtml, fmtMs, fmtDate, timeAgo, timeUntil, isOverdue, overdueFor,
  optionName, cuSolIdx, filtrarAnexosValidos, waNumberForTask,
  getCustomField, slaProgressInfo,
  CATEGORIA_PRIORIDADE, PRIORITY, SOLICITANTES, TIPOS, SETORES,
  OPERADOR_WHATSAPP, OPERADORES, STATUS_MAP,
};`;
vm.runInContext(src + exportLine, sandbox, { filename: 'app.js' });
const A = sandbox.__exports;

let passed = 0, failed = 0;
function test(name, fn) {
  try {
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

console.log('optionName');
test('encontra pelo orderindex', () => {
  assert.strictEqual(A.optionName(A.SOLICITANTES, 11), 'Jhuliany Mendes');
});
test('orderindex como string numérica funciona (Number())', () => {
  assert.strictEqual(A.optionName(A.SOLICITANTES, '11'), 'Jhuliany Mendes');
});
test('null/undefined retorna placeholder', () => {
  assert.strictEqual(A.optionName(A.SOLICITANTES, null), '—');
  assert.strictEqual(A.optionName(A.SOLICITANTES, undefined), '—');
});
test('orderindex inexistente retorna placeholder', () => {
  assert.strictEqual(A.optionName(A.SOLICITANTES, 999), '—');
});

console.log('cuSolIdx (mapeamento de orderindex ClickUp)');
test('sem mapa carregado, retorna o índice local inalterado', () => {
  assert.strictEqual(A.cuSolIdx(11), 11);
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

console.log('SOLICITANTES / STATUS_MAP (integridade de dados)');
test('40 solicitantes com orderindex sequencial sem lacunas/duplicatas', () => {
  const idxs = A.SOLICITANTES.map(s => s.orderindex).sort((a, b) => a - b);
  assert.strictEqual(idxs.length, 40);
  idxs.forEach((v, i) => assert.strictEqual(v, i, `orderindex ${i} ausente/duplicado`));
});
test('STATUS_MAP tem exatamente os 4 status esperados', () => {
  assert.deepStrictEqual(Object.keys(A.STATUS_MAP).sort(), ['aberto', 'em atendimento', 'encerrado', 'pendente']);
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed > 0 ? 1 : 0);
