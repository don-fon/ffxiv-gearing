const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'test/optimizerWasm.test.cjs'));
const source = fs.readFileSync(path.join(root, 'test/optimizerWasm.test.cjs'), 'utf8').split('function compare(')[0];
const data = JSON.parse(fs.readFileSync(path.join(root, 'docs/benchmarks/timeout-profile.json')));
const body = `
for (const row of recordedCandidates) {
  const fixture = row.job === 'PLD' ? 'gradient-expanded/pld605.json' : 'warrior-displayed-375-input.json';
  const input = JSON.parse(fs.readFileSync(projectRoot + '/test/fixtures/' + fixture));
  const actual = solver.calculateExpectedDamage(row.result.stats, input.damage);
  assert.ok(Math.abs(actual - row.result.damage) < 1e-10);
}
console.log('12 intermediate candidate damage values match the independent TypeScript calculator.');
`;
vm.runInNewContext(source + body, { require: req, console, process, WebAssembly, Buffer,
  recordedCandidates: data.validatedIntermediateCandidates, projectRoot: root });
