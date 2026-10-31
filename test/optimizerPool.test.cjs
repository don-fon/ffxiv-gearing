const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync(require.resolve('../src/optimizerPool.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const candidate = (damage, extra = {}) => ({ damage, stats: {}, gears: [], tenacityMitigation: 0,
  exploredStates: 1, ...extra });
function setup(extra = {}) {
  let time = 0;
  const timers = new Map();let timerId = 0;
  const exports = {};
  vm.runInNewContext(compiled, { exports, module: { exports }, Date: { now: () => time },
    setTimeout: (fn, ms) => { const id = ++timerId;timers.set(id, { fn, due: time + ms });return id; },
    clearTimeout: id => timers.delete(id) });
  const all = [];
  const done = [];
  const errors = [];
  const diagnostics = [];
  const onBest = [];
  const factory = () => {
    const worker = { sent: [], terminated: false, postMessage(message) { this.sent.push(message); },
      terminate() { this.terminated = true; }, emit(data) { this.onmessage({ data }); } };
    all.push(worker);return worker;
  };
  const pool = exports.runOptimizationPool({ input: { foods: [{ id: 1 }, { id: 2 }] },
    plan: { partitions: [{ foodId: 1, estimatedWork: 1 }, { foodId: 2, estimatedWork: 1 }],
      heuristicResult: candidate(1) }, workerCount: 2, createWorker: factory,
    onDone: (result, restarts) => done.push({ result, restarts }), onError: message => errors.push(message),
    onDiagnostics: data => diagnostics.push(data), onBest: result => onBest.push(result), ...extra });
  return { all, pool, done, errors, diagnostics, onBest, advance: value => { time += value;
    for (const [id, timer] of Array.from(timers)) if (timer.due <= time) { timers.delete(id);timer.fn(); }
  } };
}

test('an improving intermediate candidate restarts the same partition without declaring it done', () => {
  const r = setup();r.advance(6000);
  r.all[0].emit({ type: 'candidate', result: candidate(2) });
  assert.equal(r.done.length, 0);
  assert.equal(r.all.length, 3);
  assert.equal(r.all[1].terminated, true);
  assert.equal(r.all[2].sent[0].input.food.id, 2);
  assert.equal(r.all[2].sent[0].input.globalMinimumDamage, 2);
  assert.equal(r.pool.workers.length, 2);
  r.all[1].emit({ type: 'result', result: candidate(100) });
  assert.equal(r.done.length, 0, 'a terminated worker cannot complete or improve the replacement partition');
  r.all[0].emit({ type: 'result', result: candidate(2) });
  assert.equal(r.done.length, 0);
  r.all[2].emit({ type: 'result', result: candidate(1.5) });
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].result.damage, 2);
  assert.equal(r.done[0].restarts, 1);
  assert.equal(r.errors.length, 0);
});

test('restart decisions use each worker own latest bound and have a finite budget', () => {
  const r = setup({ maxRestarts: 2 });r.advance(6000);
  r.all[0].emit({ type: 'candidate', result: candidate(1.0005) });
  assert.equal(r.all.length, 2);
  r.all[0].emit({ type: 'candidate', result: candidate(2) });
  r.advance(6000);r.all[0].emit({ type: 'candidate', result: candidate(3) });
  r.advance(6000);r.all[0].emit({ type: 'candidate', result: candidate(4) });
  assert.equal(r.all.length, 4);
  const last = r.pool.workers[1];
  last.emit({ type: 'candidate', result: candidate(4.001) });
  assert.equal(r.all.length, 4, 'the origin already uses bound 4, not its assigned bound 1');
  assert.equal(r.diagnostics.length, 2);
  r.pool.cancel();
});

test('candidate selection compares the selection score when mitigation is traded for damage', () => {
  const r = setup();r.advance(6000);
  r.all[0].emit({ type: 'candidate', result: candidate(0.8, { score: 3 }) });
  assert.equal(r.all[2].sent[0].input.globalMinimumDamage, 3);
  r.all[2].emit({ type: 'candidate', result: candidate(2, { score: 2.9 }) });
  assert.equal(r.onBest.at(-1).score, 3);
  r.pool.cancel();
});

test('cancel ignores late candidate, error and result messages and creates no new workers', () => {
  const r = setup();r.advance(6000);r.pool.cancel();
  r.all[0].emit({ type: 'candidate', result: candidate(5) });
  r.all[1].emit({ type: 'error', message: 'late' });
  r.all[0].emit({ type: 'result', result: candidate(5) });
  assert.equal(r.all.length, 2);
  assert.equal(r.done.length, 0);
  assert.equal(r.errors.length, 0);
  assert.ok(r.all.every(worker => worker.terminated));
});

test('disabled sharing/restarts preserves the original completed-result-only protocol', () => {
  const r = setup({ maxRestarts: 0, shareCandidates: false });r.advance(6000);
  r.all[0].emit({ type: 'candidate', result: candidate(5) });
  r.all[0].emit({ type: 'result', result: candidate(2) });
  r.all[1].emit({ type: 'result', result: candidate(1.5) });
  assert.equal(r.all.length, 2);
  assert.equal(r.done[0].result.damage, 2);
  assert.equal(r.done[0].restarts, 0);
});

test('a fixed-food request keeps its food when a partition supplies that food ID', () => {
  const r = setup({ input: { food: { id: 1 } },
    plan: { partitions: [{ foodId: 1, estimatedWork: 1 }], heuristicResult: candidate(1) } });
  assert.equal(r.errors.length, 0);
  assert.equal(r.all[0].sent[0].input.food.id, 1);
  r.pool.cancel();
});

test('fresh workers and empty/non-finite candidates are not restarted', () => {
  const r = setup();
  r.all[0].emit({ type: 'candidate', result: candidate(2) });
  assert.equal(r.all.length, 2);
  r.advance(1000);
  r.all[0].emit({ type: 'candidate', result: candidate(Infinity) });
  r.all[0].emit({ type: 'candidate', result: candidate(10, { empty: true }) });
  assert.equal(r.all.length, 2);
  r.pool.cancel();
});

test('an early candidate is applied after the preparation grace period even without another update', () => {
  const r = setup();r.all[0].emit({ type: 'candidate', result: candidate(3) });
  r.advance(4999);assert.equal(r.all.length, 2);
  r.advance(1);assert.equal(r.all.length, 3);
  assert.equal(r.all[2].sent[0].input.globalMinimumDamage, 3);r.pool.cancel();
});

test('external cancellation prevents a pending restart timer from recreating workers', () => {
  let active = true;
  const r = setup({ isActive: () => active });r.all[0].emit({ type: 'candidate', result: candidate(3) });
  active = false;r.pool.workers.forEach(worker => worker.terminate());r.advance(10000);
  assert.equal(r.all.length, 2);assert.equal(r.done.length, 0);r.pool.cancel();
});


test('the default refresh budget delivers the third significant improvement to a slow partition', () => {
  const r = setup();
  for (const damage of [7.8398, 7.8480, 7.8596]) {
    r.advance(6000);r.all[0].emit({ type: 'candidate', result: candidate(damage) });
  }
  assert.equal(r.pool.workers[1].sent[0].input.globalMinimumDamage, 7.8596);
  assert.equal(r.diagnostics.length, 3);
  r.pool.cancel();
});
