// Archived research entry only; see docs/optimizer-highs-future-option.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import ts from 'typescript';
import { compileOptimizerSupport } from './optimizer-integer-support.mjs';
import { certifyOptimization } from './optimizer-strict-proof.mjs';
import { usesIntegerForJointResources } from './optimizer-integer-routing.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  engine: { type: 'string', default: 'wasm-warm' }, workers: { type: 'string', default: '4' },
  critical: { type: 'string', default: 'none' },
  shards: { type: 'string' }, locks: { type: 'string', default: '0' }, food: { type: 'string' },
  timeout: { type: 'string', default: '300000' }, runs: { type: 'string', default: '1' },
  output: { type: 'string' }, input: { type: 'string' }, chromium: { type: 'string' },
  'skip-build': { type: 'boolean', default: false },
  'fixed-plan': { type: 'string' }, dist: { type: 'string' },
  'restart-limit': { type: 'string' },
  'integer-model': { type: 'boolean', default: false },
  'integer-recovery': { type: 'boolean', default: false },
  'proof-timeout': { type: 'string', default: '30000' },
  'proof-nodes': { type: 'string', default: '1000000' },
  'integer-adaptive': { type: 'boolean', default: false },
  'integer-probe-ms': { type: 'string', default: '0' },
  'integer-preprocess': { type: 'string', default: 'baseline' },
  'integer-partitions': { type: 'string', default: 'original' },
  'integer-planner': { type: 'string', default: 'source' },
  'integer-minimum-cut': { type: 'string', default: 'on' },
} });
if (values['integer-adaptive'] || Number(values['integer-probe-ms']) > 0) throw Error('Conditional algorithm dispatch is disabled until an advantage region is established.');
for (const key of ['proof-timeout', 'proof-nodes']) if (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 0) throw Error('Invalid proof budget.');
if (!['baseline', 'no-pareto', 'direct'].includes(values['integer-preprocess'])) throw new Error('Invalid integer preprocessing.');
if (!['on', 'off'].includes(values['integer-minimum-cut'])) throw new Error('Invalid integer minimum cut.');
if (!['source', 'minimal'].includes(values['integer-planner'])) throw new Error('Invalid integer planner.');
if (values['integer-planner'] === 'minimal' && (!values['integer-model'] || values['fixed-plan'])) throw new Error('Minimal planner requires a generated integer-model plan.');
if (!['original', 'food'].includes(values['integer-partitions'])) throw new Error('Invalid integer partitions.');
if (values['fixed-plan'] && values['integer-partitions'] === 'food') throw new Error('Food regrouping requires a complete generated plan.');
values['restart-limit'] ??= values['integer-model'] ? '0' : '4';
if (values['integer-recovery'] && values['integer-minimum-cut'] === 'off') throw new Error('Recovery uses its own rounding-safe cutoff; legacy cutoff flag is unsupported.');
if (!Number.isInteger(Number(values['integer-probe-ms'])) || Number(values['integer-probe-ms']) < 0 || Number(values['integer-probe-ms']) > 60000 || Number(values['integer-probe-ms']) > 0 && !values['integer-adaptive']) throw new Error('Native probe requires adaptive dispatch and a budget between0 and60000ms.');
if (values['integer-adaptive'] && !values['integer-recovery']) throw new Error('Adaptive dispatch requires integer recovery.');
if (values['integer-recovery'] && !values['integer-model']) throw new Error('Integer recovery requires integer model.');
if (values['integer-model'] && !values['integer-recovery']) console.warn('Experimental integer model failed a full browser optimality regression. Results are diagnostic only; see docs/optimizer-algorithm-retest.md.');
if (!['none', 'high', 'low'].includes(values.critical)) throw new Error('Unknown critical preference.');
if (!['auto', 'javascript', 'wasm', 'wasm-warm'].includes(values.engine)) throw new Error('Unknown benchmark engine.');
for (const [name, minimum, maximum] of [['workers', 1, 4], ['locks', 0, 4], ['runs', 1, 10], ['timeout', 1000, 3600000]]) {
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}.`);
}
if (values.shards !== undefined && (!Number.isInteger(Number(values.shards)) ||
    Number(values.shards) < 1 || Number(values.shards) > 64)) throw new Error('Invalid shards.');
if (values.dist && !values['skip-build']) throw new Error('--dist requires --skip-build.');
if (!values['skip-build']) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Production build failed.');
}
const input = JSON.parse(fs.readFileSync(values.input || path.join(root, 'test/fixtures/warrior-375-input.json'), 'utf8'));
input.criticalPreference = values.critical;
const fixedPlan = values['fixed-plan'] ? JSON.parse(fs.readFileSync(values['fixed-plan'], 'utf8')) : undefined;
const expected = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/warrior-375-result.json'), 'utf8'));
const lockedSlots = [13, 5, 8, 3].slice(0, Number(values.locks));
input.lockedGears = expected.gears.filter(gear => lockedSlots.includes(gear.slot))
  .map(gear => ({ id: gear.id, slot: gear.slot, melds: gear.melds }));
input.lockedGearIds = input.lockedGears.map(gear => gear.id);
if (values.food) input.foods = input.foods.filter(food => food.id === Number(values.food));
const dist = path.resolve(values.dist || path.join(root, 'dist'));
if (!/^[0-4]$/.test(values['restart-limit'])) throw new Error('Invalid restart limit.');
const poolCode = ts.transpileModule(fs.readFileSync(path.join(root, 'src/optimizerPool.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const integerAssets = new Map();
if (values['integer-model']) {
  const support = compileOptimizerSupport(root, { preprocess: values['integer-preprocess'] });
  const directory = path.dirname(fileURLToPath(import.meta.resolve('highs')));
  const experiment = name => fs.readFileSync(path.join(root, 'scripts/experiments', name), 'utf8');
  for (const [name, source] of [
    ['optimizer.mjs', support.optimizer], ['statFormulas.mjs', support.statFormulas],
    ['model.mjs', experiment('optimizer-integer-model.mjs')],
    ['certified.mjs', experiment('optimizer-integer-certified.mjs')],
    ['direct-groups.mjs', experiment('optimizer-integer-direct-groups.mjs')],
    ['planner.mjs', experiment('optimizer-integer-planner.mjs')],
    ['planner-optimizer.mjs', compileOptimizerSupport(root).optimizer],
    ['native.mjs', ts.transpileModule(fs.readFileSync(path.join(root, 'src/optimizerWasm.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll("'./optimizer'", "'./optimizer.mjs'")],
    ['worker.mjs', experiment('optimizer-integer.worker.mjs')],
    ['highs.mjs', fs.readFileSync(path.join(directory, 'highs.mjs'), 'utf8')],
  ]) integerAssets.set('/__optimizer_integer/' + name, { source, type: 'application/javascript' });
  integerAssets.set('/__optimizer_integer/native.wasm', { source: fs.readFileSync(path.join(root, 'src/optimizerSearch.wasm')), type: 'application/wasm' });
  integerAssets.set('/__optimizer_integer/highs.wasm', {
    source: fs.readFileSync(path.join(directory, 'highs.wasm')), type: 'application/wasm',
  });
}
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (integerAssets.has(pathname)) {
    const asset = integerAssets.get(pathname);
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }).end(asset.source);return;
  }
  if (pathname === '/ffxiv-gearing/benchmark-pool.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' }).end(poolCode);return;
  }
  const relative = pathname.replace(/^\/ffxiv-gearing\//, '') || 'index.html';
  const target = path.resolve(dist, relative);
  if (!target.startsWith(dist + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    response.writeHead(404).end();return;
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png' };
  response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream',
    'Cache-Control': 'no-store' });
  fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/ffxiv-gearing/`;
const results = [];
try {
  for (let run = 0; run < Number(values.runs); run++) {
    // Fresh browser/worker contexts: module startup, fetch and WASM initialization
    // are included in the timed worker pipeline, as are planning and serialization.
    const browser = await chromium.launch({ executablePath: values.chromium || process.env.BENCHMARK_CHROMIUM });
    try {
      const page = await browser.newPage();
      if (values['integer-model']) await page.addInitScript(settings => {
        const plannerKind = settings.planner;
        const useInteger = (0, eval)('(' + settings.routingFunction + ')');
        const Original = window.Worker;
        let incumbent, nativeDeadline;
        const score = result => result?.score ?? result?.damage ?? 0;
        const observe = result => { if (result && !result.empty && score(result) > score(incumbent)) incumbent = result; };
        window.Worker = class {
          constructor(url, options) { this.url = url;this.options = options; }
          launch(kind, message) {
            const generation = this.generation = (this.generation ?? 0) + 1;
            const integer = kind === 'integer';
            if (!this.delegate || this.kind !== kind) {
              this.delegate?.terminate();this.kind = kind;
              this.delegate = new Original(message.type === 'plan' && plannerKind === 'minimal' ?
                new URL('/__optimizer_integer/planner.mjs', location.href) : integer ?
                  new URL('/__optimizer_integer/worker.mjs', location.href) : this.url,
              integer || message.type === 'plan' && plannerKind === 'minimal' ? { type: 'module' } : this.options);
            }
            const request = integer && settings.probeMs > 0 && incumbent ?
              { ...message, input: { ...message.input, globalMinimumDamage: Math.max(message.input.globalMinimumDamage ?? 0, score(incumbent)) } } : message;
            this.delegate.onmessage = event => {
              if (generation !== this.generation) return;
              let data = event.data;
              if (data.type === 'result' || data.type === 'error') clearTimeout(this.probeTimer);
              if (settings.probeMs > 0) {
                if (data.type === 'plan') observe(data.plan.heuristicResult);
                if (message.type === 'optimize' && data.type === 'candidate') {
                  const result = window.benchmarkVerifyCandidate(data.result, request.input);
                  if (!result) return;
                  data = { ...data, result };observe(result);
                }
                if (message.type === 'optimize' && data.type === 'result') observe(data.result);
              }
              this.onmessage?.({ data });
            };
            this.delegate.onerror = event => { if (generation !== this.generation) return;clearTimeout(this.probeTimer);this.onerror?.(event); };
            this.delegate.postMessage(integer ?
              { ...request, modelOptions: { useMinimumCut: settings.minimumCut === 'on', integerRecovery: settings.recovery } } : request);
          }
          postMessage(message) {
            clearTimeout(this.probeTimer);
            const eligible = message.type === 'optimize' && (!settings.adaptive || useInteger(message.input));
            if (eligible && settings.probeMs > 0) nativeDeadline ??= Date.now() + settings.probeMs;
            const wait = eligible && settings.probeMs > 0 ? Math.max(0, nativeDeadline - Date.now()) : 0;
            const integer = eligible && wait === 0;
            const kind = message.type === 'plan' ? 'plan' : integer ? 'integer' : 'native';
            if (message.type === 'optimize' && settings.adaptive) this.onmessage?.({ data: { type: 'diagnostics', diagnostics: { stage: '算法选择', engine: integer ? '整数目标补查' : '原生WASM', jointGearResources: eligible, integerSelected: integer, probeMs: settings.probeMs, foodId: message.input.food?.id } } });
            this.launch(kind, message);
            const generation = this.generation;
            if (wait > 0) this.probeTimer = setTimeout(() => {
              if (generation !== this.generation) return;
              this.onmessage?.({ data: { type: 'diagnostics', diagnostics: { stage: '切换整数模型', nativeBudgetMs: settings.probeMs, minimumScore: score(incumbent), foodId: message.input.food?.id } } });
              this.launch('integer', message);
            }, wait);
          }
          terminate() { this.generation = (this.generation ?? 0) + 1;clearTimeout(this.probeTimer);this.delegate?.terminate(); }
        };
      }, { planner: values['integer-planner'], minimumCut: values['integer-minimum-cut'], recovery: values['integer-recovery'], adaptive: values['integer-adaptive'], probeMs: Number(values['integer-probe-ms']), routingFunction: usesIntegerForJointResources.toString() });
      page.on('console', message => {
        if (message.text().startsWith('BENCH ')) console.error(message.text());
      });
      await page.addInitScript(() => {
        window.benchmarkWorker = Worker;
        window.Worker = class {
          constructor(url) { window.benchmarkWorkerUrl = String(url); }
          postMessage() {}
          terminate() {}
        };
      });
      await page.goto(base);
      await page.getByRole('link', { name: '战士', exact: true }).click();
      await page.getByRole('button', { name: '自动配装', exact: true }).click();
      await page.getByRole('button', { name: '开始计算', exact: true }).click();
      await page.waitForFunction(() => Boolean(window.benchmarkWorkerUrl));
      const result = await page.evaluate(async config => {
        const { runOptimizationPool } = await import(config.poolUrl);
        if (config.probeMs > 0) {
          const { materializeOptimizationCandidate } = await import('/__optimizer_integer/optimizer.mjs');
          window.benchmarkVerifyCandidate = (candidate, input) => {
            if (!candidate || candidate.empty) return;
            try {
              const raw = { ...input.fixedStats };
              for (const choice of candidate.gears) {
                const gear = input.gears.find(item => item.id === choice.id && item.slot === choice.slot);
                if (!gear || gear.synced && choice.melds.length) return;
                const part = { ...gear.stats }, seen = new Set();
                const locked = input.lockedGears?.some(lock => lock.id === choice.id && Math.abs(lock.slot) === choice.slot && lock.melds?.length === choice.melds.length && lock.melds.every((meld, index) => {
                  const actual = choice.melds[index];
                  return meld.stat === actual.stat && meld.grade === actual.grade && meld.value === actual.value && (meld.slot ?? index) === actual.slot;
                }));
                for (const meld of choice.melds) {
                  const slot = gear.materiaSlots[meld.slot];
                  if (seen.has(meld.slot) || !locked && (!slot || !input.materiaStats.includes(meld.stat) || slot.grade !== meld.grade || slot.value !== meld.value)) return;
                  seen.add(meld.slot);
                  part[meld.stat] = (part[meld.stat] ?? 0) + Math.min(meld.value, Math.max(0, (gear.caps[meld.stat] ?? Infinity) - (part[meld.stat] ?? 0)));
                }
                for (const [stat, value] of Object.entries(part)) raw[stat] = (raw[stat] ?? 0) + value;
              }
              const state = { stats: raw, choices: [], selected: candidate.gears, previous: { stats: input.fixedStats, choices: [] } };
              return materializeOptimizationCandidate(input, { prefix: state, options: [], damage: candidate.score ?? candidate.damage, states: candidate.exploredStates, visitedBranches: 0, complete: false });
            } catch { return undefined; }
          };
        }
        return new Promise(resolve => {
        const started = performance.now();
        const WorkerClass = window.benchmarkWorker;
        const active = [];
        const diagnostics = [];
        let settled = false, completed = 0, taskCount = 0, best, explored = 0, pool;
        let lastLog = performance.now();
        const finish = detail => {
          if (settled) return;settled = true;clearTimeout(timer);
          pool?.cancel();
          for (const worker of active) worker.terminate();
          resolve({ ...detail, milliseconds: performance.now() - started,
            completed, partitions: taskCount, exploredStates: explored, diagnostics });
        };
        const timer = setTimeout(() => finish({ status: 'timeout', candidate: best, bestDamage: best?.damage }), config.timeout);
        const planner = config.fixedPlan === undefined ? new WorkerClass(window.benchmarkWorkerUrl) : {
          terminate() {},
          postMessage() { queueMicrotask(() => planner.onmessage({ data: { type: 'plan', plan: config.fixedPlan } })); },
        };
        active.push(planner);
        planner.onerror = event => finish({ status: 'error', message: event.message });
        planner.onmessage = event => {
          if (event.data.type === 'diagnostics') {
            diagnostics.push({ worker: 'planner', ...event.data.diagnostics });return;
          }
          if (event.data.type === 'error') { finish({ status: 'error', message: event.data.message });return; }
          if (event.data.type !== 'plan') return;
          planner.terminate();
          let plan = event.data.plan;
          if (config.integerPartitions === 'food') {
            const foods = new Map();
            for (const partition of plan.partitions) {
              const current = foods.get(partition.foodId);
              foods.set(partition.foodId, current === undefined ? { ...partition } :
                { ...current, estimatedWork: current.estimatedWork + partition.estimatedWork });
            }
            plan = { ...plan, partitions: Array.from(foods.values(), partition =>
              ({ ...partition, contribution: undefined, candidateShard: undefined })) };
          }
          best = plan.heuristicResult;taskCount = plan.partitions.length;
          pool = runOptimizationPool({ input: config.input, plan,
            workerCount: config.workers, createWorker: () => new WorkerClass(window.benchmarkWorkerUrl),
            engine: config.engine, maxRestarts: config.restartLimit,
            shareCandidates: config.restartLimit > 0 || config.probeMs > 0,
            fixedMinimumDamage: config.fixedPlan?.heuristicResult.score ?? config.fixedPlan?.heuristicResult.damage,
            onBest: result => {
              best = result;
              console.log('BENCH ' + JSON.stringify({ elapsed: performance.now() - started,
                candidateDamage: result.damage, candidateScore: result.score ?? result.damage }));
            },
            onDiagnostics: snapshot => {
              diagnostics.push(snapshot);
              if (snapshot.stage === '重启分片') console.log('BENCH ' + JSON.stringify({
                elapsed: performance.now() - started, ...snapshot }));
            },
            onProgress: progress => {
              completed = progress.completedGroups;
              if (performance.now() - lastLog > 10000) {
                lastLog = performance.now();console.log('BENCH ' + JSON.stringify({ engine: config.engine,
                  elapsed: lastLog - started, completed, partitions: taskCount, progress }));
              }
            },
            onError: message => finish({ status: 'error', message }),
            onDone: (result, restarts) => {
              best = result;explored = result.exploredStates;
              finish({ status: 'completed', result, restarts });
            },
          });
        };
        planner.postMessage({ type: 'plan', input: config.input, engine: config.engine,
          workers: config.workers, shards: config.shards });
        });
      }, { input, fixedPlan, integerPartitions: values['integer-model'] ? values['integer-partitions'] : 'original', poolUrl: new URL('benchmark-pool.js', base).href, restartLimit: Number(values['restart-limit']), engine: values.engine === 'auto' ? undefined : values.engine, workers: Number(values.workers),
        shards: values.shards ? Number(values.shards) : undefined, probeMs: Number(values['integer-probe-ms']), timeout: Number(values.timeout) });
      let strict;
      const searchStatus = result.status;
      if (values['integer-recovery']) {
        strict = certifyOptimization(input, result.result ?? result.candidate, {
          timeoutMs: Number(values['proof-timeout']), maxNodes: Number(values['proof-nodes']),
          outputPrefix: values.output ? path.resolve(values.output) + '.run' + run : undefined,
        });
        if (strict.proofVerified) {
          result.status = strict.status === 'certified-optimal' ? 'completed' : 'infeasible';
          result.result = strict.result;
        } else {
          result.candidate = result.result ?? result.candidate;delete result.result;result.status = 'unproven';
        }
      }
      const record = { ...result, searchMilliseconds: result.milliseconds, milliseconds: result.milliseconds + (strict?.totalProofMs ?? 0), searchStatus, optimality: strict ?? { status: 'unproven', proofVerified: false }, run, engine: values.engine, workers: Number(values.workers),
        shards: values.shards ? Number(values.shards) : 'auto', lockedSlots, food: values.food || 'auto', criticalPreference: values.critical,
        browser: browser.version(), integerModel: values['integer-model'],
        integerCorrectness: values['integer-model'] ? (values['integer-recovery'] ? (strict?.proofVerified ? 'independent-exact-raw-domain-proof' : 'unproven') : 'failed-known-browser-regression') : undefined,
        integerRecovery: values['integer-recovery'], integerAdaptive: values['integer-adaptive'], integerProbeMs: Number(values['integer-probe-ms']),
        integerPreprocess: values['integer-preprocess'], integerPartitions: values['integer-partitions'], integerPlanner: values['integer-planner'], integerMinimumCut: values['integer-recovery'] ? 'integer-rounding-envelope' : values['integer-minimum-cut'],
        source: values['integer-adaptive'] ? 'production planner + joint-resource native/integer dispatch' : values['integer-model'] ? 'production planner + experimental direct integer workers' : 'production worker pipeline' };
      if (result.status === 'completed' && values.critical !== 'none') {
        const range = result.result.criticalRange;
        const critical = result.result.stats.CRT;
        if (!range || (values.critical === 'high' ? critical < (range.threshold ?? range.midpoint) : critical > (range.threshold ?? range.midpoint))) {
          throw new Error('Result violates the shared critical constraint.');
        }
      }
      if (result.status === 'completed' && values.critical === 'none' && !values.input &&
          (!values.food || Number(values.food) === expected.food.id) &&
          Math.abs(result.result.damage - expected.damage) > 1e-10) {
        throw new Error(`Unexpected damage: ${result.result.damage} != ${expected.damage}`);
      }
      results.push(record);console.log(JSON.stringify(record));
      if (values.output) fs.writeFileSync(values.output, JSON.stringify(results, null, 2));
      if (result.status === 'unproven') process.exitCode = 2;
      if (result.status === 'error') throw new Error(result.message);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
