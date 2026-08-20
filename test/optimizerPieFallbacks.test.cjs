const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/optimizerPieFallbacks.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const candidates = {};
vm.runInNewContext(compiled, { exports: candidates, module: { exports: candidates }, require });

const { selectPieFreeFallbacks } = candidates;

function gear(id, level, slot, unique, pie = 0) {
  return { id, level, slot, unique, stats: pie === 0 ? {} : { PIE: pie } };
}

test('PIE-free fallbacks are not added when regular gear fills the slot', () => {
  const standard = [gear(1, 790, 9, true)];
  const lower = [gear(2, 780, 9, true)];
  assert.equal(selectPieFreeFallbacks(standard, lower, [9]).length, 0);
});

test('rings relax item level until two legal PIE-free copies are available', () => {
  const standard = [gear(1, 790, 12, true), gear(2, 790, 12, true, 100)];
  const lower = [
    gear(3, 780, 12, true),
    gear(4, 780, 12, true),
    gear(5, 780, 12, true, 100),
    gear(6, 770, 12, true),
  ];
  assert.equal(selectPieFreeFallbacks(standard, lower, [12]).map(item => item.id).join(','), '3,4');
});

test('a repeatable PIE-free ring supplies both ring slots', () => {
  const standard = [gear(1, 790, 12, false), gear(2, 790, 12, true, 100)];
  assert.equal(selectPieFreeFallbacks(standard, [gear(3, 780, 12, true)], [12]).length, 0);
});

test('fallback selection continues to the next lower tier when necessary', () => {
  const lower = [gear(1, 780, 12, true), gear(2, 770, 12, true)];
  assert.equal(selectPieFreeFallbacks([], lower, [12]).map(item => item.id).join(','), '1,2');
});
