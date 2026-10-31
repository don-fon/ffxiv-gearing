const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseArgs } = require('node:util');
const ts = require('typescript');

const { values } = parseArgs({ options: {
  source: { type: 'string' },
  input: { type: 'string', default: 'test/fixtures/monk-605-phantom-input.json' },
  plan: { type: 'string', default: 'test/fixtures/monk-605-slow-plan.json' },
  limit: { type: 'string', default: '2000000' },
} });
const root = path.resolve(__dirname, '..');
const sourceFile = values.source || path.join(root, 'src/optimizer.ts');
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid query limit');

// Read-only benchmark of trusted local source snapshots; no production edits.
function load(source, dependencies = {}) {
  const exports = {};
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInThisContext('(function(exports,module,require){' + code + '\n})')(
    exports, { exports }, name => dependencies[name]);
  return exports;
}
const solver = load(fs.readFileSync(sourceFile, 'utf8'), {
  './statFormulas': load(fs.readFileSync(path.join(root, 'src/statFormulas.ts'), 'utf8')),
});
const adapter = load(fs.readFileSync(path.join(root, 'src/optimizerWasm.ts'), 'utf8'), { './optimizer': load(fs.readFileSync(path.join(root, 'src/optimizer.ts'), 'utf8'), {
  './statFormulas': load(fs.readFileSync(path.join(root, 'src/statFormulas.ts'), 'utf8')),
}) });

(async () => {
  const native = await adapter.createWasmSearchBackend(
    fs.readFileSync(path.join(root, 'src/optimizerSearch.wasm')));
  let calls = 0;
  let visited = 0;
  let states = 0;
  let checksum = 2166136261;
  const stop = new Error('FIXED_WORK_LIMIT');
  const backend = (task, report) => {
    if (calls === limit) throw stop;
    calls++;
    const result = native(task, report);
    if (result !== undefined) {
      visited += result.visitedBranches;
      states += result.states;
      checksum = Math.imul(checksum ^ Math.trunc(result.damage * 1e8), 16777619) >>> 0;
    }
    return result;
  };
  Object.assign(backend, native);
  backend.warmStartMinimumWork = 1e10;
  const request = JSON.parse(fs.readFileSync(values.input, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(values.plan, 'utf8'));
  if (plan.partitions.length !== 1) throw new Error('Expected exactly one fixed task');
  const task = plan.partitions[0];
  const input = {
    ...request,
    criticalPreference: 'high',
    criticalRange: plan.criticalRange,
    food: request.foods.find(food => food.id === task.foodId),
    foods: undefined,
    targetSpeedContribution: task.contribution,
    candidateShard: task.candidateShard,
    globalMinimumDamage: plan.heuristicResult.damage,
  };
  global.gc?.();
  const start = performance.now();
  let status = 'complete';
  let result;
  try {
    result = solver.optimizeGearset(input, undefined, backend);
  } catch (error) {
    if (error !== stop) throw error;
    status = 'fixed-work-complete';
  }
  // A query-limit stop is a partial performance measurement, never an optimum.
  console.log(JSON.stringify({
    variant: sourceFile, status, limit, calls,
    milliseconds: performance.now() - start,
    visited, states, checksum, result, memory: process.memoryUsage(),
  }));
})();
