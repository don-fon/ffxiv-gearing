import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  engine: { type: 'string', default: 'wasm-warm' }, workers: { type: 'string', default: '4' },
  critical: { type: 'string', default: 'none' },
  shards: { type: 'string' }, locks: { type: 'string', default: '0' }, food: { type: 'string' },
  timeout: { type: 'string', default: '300000' }, runs: { type: 'string', default: '1' },
  output: { type: 'string' }, input: { type: 'string' }, chromium: { type: 'string' },
  'skip-build': { type: 'boolean', default: false },
  'fixed-plan': { type: 'string' }, dist: { type: 'string' },
  'restart-limit': { type: 'string' },
} });
values['restart-limit'] ??= '4';
if (!['none', 'high', 'low'].includes(values.critical)) throw new Error('Unknown critical preference.');
if (!['auto', 'wasm', 'wasm-warm'].includes(values.engine)) throw new Error('Unknown benchmark engine.');
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
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
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
          const plan = event.data.plan;
          best = plan.heuristicResult;taskCount = plan.partitions.length;
          pool = runOptimizationPool({ input: config.input, plan,
            workerCount: config.workers, createWorker: () => new WorkerClass(window.benchmarkWorkerUrl),
            engine: config.engine, maxRestarts: config.restartLimit,
            shareCandidates: config.restartLimit > 0,
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
      }, { input, fixedPlan, poolUrl: new URL('benchmark-pool.js', base).href, restartLimit: Number(values['restart-limit']), engine: values.engine === 'auto' ? undefined : values.engine, workers: Number(values.workers),
        shards: values.shards ? Number(values.shards) : undefined, timeout: Number(values.timeout) });
      const record = { ...result, run, engine: values.engine, workers: Number(values.workers),
        shards: values.shards ? Number(values.shards) : 'auto', lockedSlots, food: values.food || 'auto', criticalPreference: values.critical,
        browser: browser.version(), source: 'production worker pipeline' };
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
      if (result.status === 'error') throw new Error(result.message);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
