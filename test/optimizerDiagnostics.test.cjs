const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync(require.resolve('../src/optimizerDiagnostics.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test('UI aggregates live diagnostics, throttles output, and retains interrupted work once', () => {
  let now = 0;
  const logs = [];
  const exports = {};
  vm.runInNewContext(compiled, { exports, structuredClone, Date: { now: () => now },
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  const logger = exports.createOptimizerLogger(0);
  logger.start({ 职业: 'WAR', GCD: 2.5 });
  const update = (partition, extra = {}) => logger.diagnostics({ task: 'optimize', partition,
    stage: '计算中', engine: 'WASM', activePhase: 'WASM 精确搜索',
    initializationMs: 20, wasmSearchMs: 1000, wasmVisitedBranches: 100, wasmEvaluatedCombinations: 10,
    wasmSearchCalls: 1, wasmMemoryMiB: 8, ...extra });
  for (now = 1000; now < 30_000; now += 1000) {
    update(0);update(1);
  }
  assert.equal(logs.length, 2, 'start plus a single readiness line, not a line per worker');
  logger.progress({ completedGroups: 0, totalGroups: 2, searchProgress: 0.1 });
  update(0);
  assert.equal(logs.length, 3);
  const details = () => logs.at(-1)[1];
  assert.equal(details().搜索分支, 200);
  assert.equal(details().完整组合, 20);
  assert.equal(details().Worker累计秒.搜索, 2);
  assert.equal(details().墙钟秒, 30);
  assert.match(details().搜索空间进度, /10.0%.*非耗时/);
  logger.diagnostics({ stage: '重启分片', partition: 0 });
  update(0, { wasmSearchMs: 2000, wasmVisitedBranches: 300, wasmEvaluatedCombinations: 30 });
  now = 60_000;
  update(1, { activePhase: 'done', wasmSearchMs: 5000, wasmVisitedBranches: 500, wasmEvaluatedCombinations: 50 });
  assert.equal(details().搜索分支, 900, '100 interrupted + 300 replacement + 500 other');
  assert.equal(details().Worker累计秒.搜索, 8);
  assert.equal(details().重启次数, 1);
  assert.equal(details().单Worker内存观测峰值MiB, 8, 'not summed across snapshots');
  logger.progress({ completedGroups: 2, totalGroups: 2, searchProgress: 1 });
  logger.done({ damage: 123, score: 124, stats: { CRT: 400 } }, 1);
  assert.equal(details().完成分片, '2/2');
  assert.equal(details().排序评分, 124);
  logger.fail('失败原因');
  assert.equal(details().原因, '失败原因');
  for (const args of logs) {
    assert.equal(args.length, 2);
    assert.equal(typeof args[1], 'object');
    assert.equal(typeof args[0], 'string');
    assert.ok(!args[0].includes('[object Object]'));
  }
});


test('summaries identify routes, slow shards, observed throughput and objective-score improvements', () => {
  let now = 0;
  const logs = [];
  const exports = {};
  vm.runInNewContext(compiled, { exports, structuredClone, Date: { now: () => now },
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  const logger = exports.createOptimizerLogger(0);
  const candidate = (damage, score) => ({ damage, score, stats: { TEN: 400 }, gears: [],
    tenacityMitigation: 0.1, food: { id: 12, name: '测试食物' } });
  logger.plan({ heuristicResult: candidate(100, 110), criticalRange: { threshold: 800 },
    partitions: [{ foodId: 12, contribution: 4 }, { foodId: 13 }] }, 2);
  const details = () => logs.at(-1)[1];
  assert.equal(details().固定速度分片数, 1);
  assert.equal(details().自动速度分片数, 1);
  assert.equal(details().暴击边界.threshold, 800);
  now = 10_000;logger.best(candidate(99, 121));
  now = 20_000;logger.best(candidate(120, 120));
  now = 30_000;
  logger.diagnostics({ task: 'optimize', partition: 4, worker: 1, stage: '计算中', engine: 'WASM',
    activePhase: 'WASM GCD 区间搜索', elapsedMs: 29_000, foodName: '测试食物',
    wasmVisitedBranches: 3000, wasmEvaluatedCombinations: 60,
    rangeSearchCalls: 1, rangeSearchMs: 20_000, warmSearchCalls: 2, warmSearchMs: 1000,
    query: { route: '整段GCD', counts: [1, 30, 50], minimumScore: 121,
      speedBounds: { minimum: 10, maximum: 20 }, fraction: 0.4, elapsedMs: 20_000 } });
  assert.equal(details().近期观测吞吐.分支每秒, 100);
  assert.equal(details().近期观测吞吐.完整组合每秒, 2);
  assert.equal(details().搜索路线.整段GCD.累计秒, 20);
  assert.equal(details().搜索路线.限额预热.查询数, 2);
  assert.equal(details().当前最好.期望威力, 99, 'tradeoff improvement follows score, not damage');
  assert.equal(details().当前最好.改善次数, 1);
  assert.equal(details().当前最好.较初始提升百分比, 10);
  assert.equal(details().当前最好.未改善秒, 20, 'a worse candidate must not reset the timer');
  assert.equal(details().最慢任务前三[0].分片, 4);
  assert.equal(details().最慢任务前三[0].食物, '测试食物');
  assert.equal(details().最慢任务前三[0].最近原生查询.剪枝评分下限, 121);
  assert.deepEqual(details().最慢任务前三[0].最近原生查询.各组属性候选数, [1, 30, 50]);
  logger.diagnostics({ stage: '重启分片', partition: 4, previousMinimumDamage: 110,
    minimumDamage: 121, elapsedMs: 30_000, restarts: 1 });
  now = 60_000;
  logger.diagnostics({ task: 'optimize', partition: 4, activePhase: 'done', stage: '分片完成',
    wasmVisitedBranches: 6000, wasmEvaluatedCombinations: 120,
    rangeSearchCalls: 1, rangeSearchMs: 20_000 });
  assert.equal(details().近期观测吞吐.分支每秒, 200, 'interrupted 3000 retained; replacement 6000 is new work');
  assert.equal(details().搜索路线.整段GCD.累计秒, 40);
  assert.equal(details().最近重启[0].新评分下限, 121);
  const previousSnapshot = details();
  logger.diagnostics({ stage: '重启分片', partition: 5 });
  assert.equal(previousSnapshot.最近重启.length, 1, 'logged objects are snapshots, not mutable references');
  logger.done(candidate(99, 121), 1);
  assert.equal(details().最终方案.食物.名称, '测试食物');
  assert.equal(details().最终方案.坚韧减伤百分比, 10);
  assert.equal(details().当前最好.状态, '全部分片已完成');
});
