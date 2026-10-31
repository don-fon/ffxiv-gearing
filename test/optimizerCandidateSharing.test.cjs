const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const source = fs.readFileSync(require.resolve(file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, module: { exports }, WebAssembly,
    require: name => dependencies[name] ?? require(name) });
  return exports;
}
const formulas = load('../src/statFormulas.ts');
const optimizer = load('../src/optimizer.ts', { './statFormulas': formulas });
const nativeAdapter = load('../src/optimizerWasm.ts', { './optimizer': optimizer });
const input = JSON.parse(fs.readFileSync(require.resolve('./fixtures/warrior-375-input.json')));
const expected = JSON.parse(fs.readFileSync(require.resolve('./fixtures/warrior-375-result.json')));
input.food = expected.food;delete input.foods;
const raw = { ...input.fixedStats };
for (const gear of expected.gears) {
  const item = input.gears.find(value => value.id === gear.id);
  const part = { ...item.stats };
  for (const meld of gear.melds) {
    part[meld.stat] = (part[meld.stat] ?? 0) + Math.min(meld.value,
      Math.max(0, item.caps[meld.stat] - (part[meld.stat] ?? 0)));
  }
  for (const [stat, value] of Object.entries(part)) raw[stat] = (raw[stat] ?? 0) + value;
}
const selection = { prefix: { stats: raw, choices: [], selected: expected.gears, previous: { stats: input.fixedStats, choices: [] } }, options: [],
  damage: expected.damage, visitedBranches: 1, states: 1, complete: false };

test('an intermediate selection reconstructs a feasible result without any optimality claim', () => {
  const result = optimizer.materializeOptimizationCandidate(input, selection);
  assert.ok(Math.abs(result.damage - expected.damage) < 1e-10);
  assert.deepEqual(JSON.parse(JSON.stringify(result.stats)), expected.stats);
  assert.equal(result.gears.length, expected.gears.length);
  assert.equal(result.complete, undefined);
  assert.equal(optimizer.materializeOptimizationCandidate(input, { ...selection, prefix: undefined }), undefined);
});

test('candidate publication rejects incorrect score, speed, mitigation or critical preference', () => {
  assert.throws(() => optimizer.materializeOptimizationCandidate(input, { ...selection, damage: expected.damage + 1 }));
  assert.throws(() => optimizer.materializeOptimizationCandidate(input, { ...selection,
    prefix: { ...selection.prefix, stats: { ...raw, SKS: raw.SKS + 300 } } }));
  assert.throws(() => optimizer.materializeOptimizationCandidate({ ...input,
    objective: { type: 'minimumTenacity', minimumTenacityMitigation: expected.tenacityMitigation + 0.01 } }, selection));
  const midpoint = expected.stats.CRT + 1;
  assert.throws(() => optimizer.materializeOptimizationCandidate({ ...input, criticalPreference: 'high',
    criticalRange: { minimum: 0, maximum: 2 * midpoint, midpoint } }, selection));
});

test('mitigation tradeoff candidates expose actual damage separately from selection score', () => {
  const score = expected.damage * (1 + Math.max(0, expected.tenacityMitigation) / 0.1);
  const result = optimizer.materializeOptimizationCandidate({ ...input,
    objective: { type: 'tenacityTradeoff', mitigationPointsPerDamagePercent: 0.1 } }, { ...selection, damage: score });
  assert.ok(Math.abs(result.damage - expected.damage) < 1e-10);
  assert.ok(Math.abs(result.score - score) < 1e-10);
});

test('native snapshots are feasible candidates and bounded warm-ups never publish them', async () => {
  const bytes = fs.readFileSync(require.resolve('../src/optimizerSearch.wasm'));
  const backend = await nativeAdapter.createWasmSearchBackend(bytes, 0, 0);
  const tree = { maxima: raw, count: 1, minimumCritical: raw.CRT,
    maximumSecondaryTotal: raw.CRT + raw.DET + raw.DHT + raw.TEN,
    items: [selection.prefix] };
  const candidates = [];
  const task = { input, prefix: tree, options: [], reference: raw, minimumDamage: 0,
    onCandidate: value => candidates.push(value) };
  const result = backend(task, () => {});
  assert.equal(result.complete, true);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].complete, false);
  assert.ok(Math.abs(optimizer.materializeOptimizationCandidate(input, candidates[0]).damage - expected.damage) < 1e-10);
  candidates.length = 0;
  backend({ ...task, branchLimit: 10 }, () => {});
  assert.equal(candidates.length, 0);
  backend({ ...task, minimumDamage: result.damage }, () => {});
  assert.equal(candidates.length, 0, 'a pruning threshold is not a selection found by this partition');
});
