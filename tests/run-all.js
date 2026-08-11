'use strict';
// Roda as 4 suítes de teste do projeto em sequência e resume o resultado no final.
// Fase B6 do roadmap — formaliza o que já vinha sendo feito manualmente a cada fase
// (rodar cada arquivo separado e conferir "N passaram, 0 falharam" em cada um).
// Zero dependência: usa só child_process.execFileSync (nativo do Node).
// Rodar com `node tests/run-all.js`.
const path = require('path');
const { execFileSync } = require('child_process');

const SUITES = ['app.test.js', 'push-worker.test.js', 'd1-layer.test.js', 'r2-layer.test.js'];

let algumFalhou = false;
const resumo = [];

for (const suite of SUITES) {
  const file = path.join(__dirname, suite);
  console.log(`\n=== ${suite} ===`);
  try {
    const output = execFileSync(process.execPath, [file], { encoding: 'utf8' });
    process.stdout.write(output);
    const match = output.match(/(\d+) passaram, (\d+) falharam/);
    const passou = match ? Number(match[2]) === 0 : false;
    resumo.push({ suite, ok: passou, linha: match ? match[0] : '(sem resumo reconhecido)' });
    if (!passou) algumFalhou = true;
  } catch (err) {
    // execFileSync lança se o processo sair com código != 0 — a suíte já imprimiu o
    // próprio detalhe do que falhou antes de sair, só precisamos registrar e seguir
    // pras próximas (não parar no primeiro arquivo que falhar).
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || String(err.message));
    resumo.push({ suite, ok: false, linha: '(processo saiu com erro)' });
    algumFalhou = true;
  }
}

console.log('\n' + '='.repeat(60));
console.log('RESUMO');
console.log('='.repeat(60));
for (const r of resumo) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.suite.padEnd(24)} ${r.linha}`);
}
console.log('='.repeat(60));

process.exit(algumFalhou ? 1 : 0);
