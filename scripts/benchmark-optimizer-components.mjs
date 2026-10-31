import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

// One fresh Node process per sample; no browser/Worker planning in this diagnostic.
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  engine: { type: 'string', default: 'wasm' }, baseline: { type: 'string', default: 'a83d506' },
} });
if (!['javascript', 'wasm-final', 'wasm-pareto', 'wasm'].includes(values.engine)) throw new Error('Unknown engine.');
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const load = (source, dependencies = {}) => {
  const exports = {};
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const requireDependency = name => {
      if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
      return dependencies[name];
  };
  // Execute the repository's transpiled modules in Node's normal realm, matching
  // CommonJS production probes rather than timing cross-realm VM wrappers.
  const execute = new Function('exports', 'module', 'require', compiled);
  execute(exports, { exports }, requireDependency);
  return exports;
};
const source = values.engine === 'javascript' && values.baseline !== 'current'
  ? execFileSync('git', ['show', `${values.baseline}:src/optimizer.ts`], { cwd: root, encoding: 'utf8' })
  : read('src/optimizer.ts');
const solver = load(source, { './statFormulas': load(read('src/statFormulas.ts')) });
const adapter = load(read('src/optimizerWasm.ts'), { './optimizer': load(read('src/optimizer.ts'), { './statFormulas': load(read('src/statFormulas.ts')) }) });
const input = JSON.parse(read('test/fixtures/warrior-375-input.json'));
const expected = JSON.parse(read('test/fixtures/warrior-375-result.json'));
input.lockedGears = expected.gears.filter(gear => [13, 5, 8].includes(gear.slot))
  .map(gear => ({ id: gear.id, slot: gear.slot, melds: gear.melds }));
input.lockedGearIds = input.lockedGears.map(gear => gear.id);
input.food = input.foods.find(food => food.id === 49240);
input.foods = undefined;
input.targetSpeedContribution = 0;
// Same legal full-input greedy lower bound used in the recorded ablation.
input.globalMinimumDamage = 8.068407103464912;
const started = performance.now();
let backend = values.engine === 'javascript' ? undefined : await adapter.createWasmSearchBackend(
  fs.readFileSync(new URL('../src/optimizerSearch.wasm', import.meta.url)));
if (values.engine === 'wasm-final') delete backend.pareto;
if (values.engine === 'wasm-pareto') {
  const native = backend;
  backend = () => undefined;
  backend.pareto = native.pareto;
}
const result = solver.optimizeGearset(input, undefined, backend);
const milliseconds = performance.now() - started;
assert.ok(Math.abs(result.damage - expected.damage) < 1e-10);
console.log(JSON.stringify({ engine: values.engine, baseline: values.engine === 'javascript' ? values.baseline : 'current',
  milliseconds, damage: result.damage, stats: result.stats, exploredStates: result.exploredStates }));
