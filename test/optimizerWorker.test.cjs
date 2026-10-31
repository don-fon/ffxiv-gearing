const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/optimizer.worker.ts'), 'utf8')
  .replaceAll('import.meta.url', JSON.stringify('https://example.test/worker.js'));
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

function worker(options = {}) {
  const messages = [];
  const calls = [];
  const logs = [];
  let fetches = 0;
  let initializations = 0;
  const backend = (task, report) => {
    options.search?.(report);
    return options.decline ? undefined : { complete: true, visitedBranches: 17, states: 3, damage: 1 };
  };
  backend.pareto = items => items.length >= 64 ? items.slice(0, 1) : undefined;
  backend.memoryBytes = () => 8388608;
  const self = { postMessage: message => messages.push(message) };
  vm.runInNewContext(compiled, {
    exports: {}, self, URL, AbortController, Date: options.clock ?? Date,
    WebAssembly: options.unsupported ? undefined : WebAssembly,
    setTimeout: options.timeout ? callback => { queueMicrotask(callback);return 0; } : setTimeout,
    clearTimeout,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    fetch: async (url, { signal }) => {
      fetches++;
      if (options.networkError) throw new TypeError('Failed to fetch');
      return {
        ok: !options.httpStatus, status: options.httpStatus ?? 200,
        arrayBuffer: () => options.timeout
          ? new Promise((resolve, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }) : Promise.resolve(new ArrayBuffer(0)),
      };
    },
    require: name => name === './optimizerWasm' ? { createWasmSearchBackend: async () => {
      initializations++;
      if (options.initializationError) throw new Error(options.initializationError);
      return backend;
    } } : {
      planGearOptimization: (input, engine) => { calls.push(engine);return { partitions: [] }; },
      optimizeGearset: (input, report, engine) => {
        calls.push(engine);
        if (options.exercise !== false) {
          engine.pareto(Array.from({ length: 64 }, () => ({ stats: {}, choices: [] })));
          engine({ prefix: { count: 2 }, options: [{ count: 3 }], minimumDamage: 1,
            ...options.task }, () => {});
        }
        return { damage: 1 };
      },
    },
  });
  return { messages, calls, logs, backend, options,
    get fetches() { return fetches; }, get initializations() { return initializations; },
    send: data => self.onmessage({ data }) };
}

for (const type of ['plan', 'optimize']) {
  for (const options of [{ httpStatus: 404 }, { networkError: true }]) {
    test(`${type} stops on download failure without invoking the solver`, async () => {
      const run = worker(options);
      await run.send({ type, input: {} });
      assert.equal(run.calls.length, 0);
      assert.equal(run.initializations, 0);
      assert.deepEqual(run.messages.map(message => message.type), ['error']);
      assert.match(run.messages[0].message, /下载失败.*网络.*重新计算/);
      assert.ok(run.logs.some(log => log.level === 'error'));
    });
  }
}

test('download timeout covers a stalled response body and stops the solver', async () => {
  const run = worker({ timeout: true });
  await run.send({ type: 'optimize', input: {} });
  assert.equal(run.calls.length, 0);
  assert.match(run.messages[0].message, /下载超时/);
});

test('unsupported browsers get an upgrade message before any fetch or calculation', async () => {
  const run = worker({ unsupported: true });
  await run.send({ type: 'plan', input: {} });
  assert.equal(run.fetches, 0);
  assert.equal(run.calls.length, 0);
  assert.match(run.messages[0].message, /不支持.*WebAssembly.*最新版/);
});

for (const initializationError of ['WASM code generation disallowed by embedder', 'Unsupported optimizer WASM ABI.']) {
  test(`initialization failure is actionable: ${initializationError}`, async () => {
    const run = worker({ initializationError });
    await run.send({ type: 'optimize', input: {}, engine: 'wasm' });
    assert.equal(run.calls.length, 0);
    assert.match(run.messages[0].message, /无法启动.*刷新.*WebAssembly/);
    assert.ok(run.logs.some(log => log.level === 'error' && log.args.length === 2 && log.args[1].initializationError.includes(initializationError)));
  });
}

for (const options of [{ httpStatus: 404 }, { initializationError: 'bad wasm' }]) {
  test('retry after failure fetches and initializes again in the same worker', async () => {
    const run = worker(options);
    await run.send({ type: 'optimize', input: {} });
    assert.equal(run.messages.at(-1).type, 'error');
    delete options.httpStatus;delete options.initializationError;
    await run.send({ type: 'optimize', input: {} });
    assert.equal(run.fetches, 2);
    assert.equal(run.messages.at(-1).type, 'result');
    await run.send({ type: 'optimize', input: {} });
    assert.equal(run.fetches, 2, 'successful initialization remains cached');
  });
}

test('legacy JavaScript engine requests are rejected', async () => {
  const run = worker();
  await run.send({ type: 'optimize', input: {}, engine: 'javascript' });
  assert.equal(run.fetches, 0);
  assert.equal(run.calls.length, 0);
  assert.match(run.messages[0].message, /仅支持 WebAssembly/);
});

test('a declined native search fails without silently using the JS tree solver', async () => {
  const run = worker({ decline: true });
  await run.send({ type: 'optimize', input: {} });
  assert.equal(run.messages.at(-1).type, 'error');
  assert.match(run.messages.at(-1).message, /超出计算引擎支持范围/);
  assert.ok(!run.messages.some(message => message.type === 'result'));
});

test('normal workers use the native configuration and requested shard count', async () => {
  const run = worker();
  await run.send({ type: 'plan', input: {}, workers: 4 });
  assert.equal(typeof run.calls[0], 'function');
  assert.equal(run.calls[0].candidateShardCount, 4);
  assert.equal(run.calls[0].warmStartMinimumWork, 10_000_000_000);
  await run.send({ type: 'optimize', input: {} });
  assert.equal(run.messages.find(message => message.type === 'result').engine, 'wasm-warm');
  const status = run.messages.filter(message => message.type === 'diagnostics').at(-1).diagnostics;
  assert.equal(status.engine, 'WASM');
  assert.equal(status.wasmUsed, true);
  assert.equal(status.wasmSearchCalls, 1);
  assert.equal(status.wasmParetoCalls, 1);
  assert.equal(status.wasmVisitedBranches, 17);
  assert.equal(status.wasmEvaluatedCombinations, 3);
  assert.equal(status.wasmMemoryMiB, 8);
});

test('diagnostics distinguish WASM availability from actual kernel calls', async () => {
  const run = worker({ exercise: false });
  await run.send({ type: 'optimize', input: {} });
  const status = run.messages.filter(message => message.type === 'diagnostics').at(-1).diagnostics;
  assert.equal(status.engine, 'WASM');
  assert.equal(status.wasmUsed, false);
  assert.equal(status.wasmSearchCalls, 0);
  assert.equal(status.wasmParetoCalls, 0);
});


test('worker telemetry includes the running native call without duplicate console output', async () => {
  let time = 0;
  const run = worker({ clock: { now: () => time }, search: report => {
    time = 6000;report({ fraction: 0.4, visitedBranches: 12, states: 2 });
    time = 8000;
  } });
  await run.send({ type: 'optimize', input: {} });
  const updates = run.messages.filter(message => message.type === 'diagnostics').map(message => message.diagnostics);
  const running = updates.find(update => update.stage === '计算中');
  assert.equal(running.wasmSearchMs, 6000);
  assert.equal(running.wasmVisitedBranches, 12);
  assert.equal(running.wasmEvaluatedCombinations, 2);
  assert.equal(running.otherMs, 0);
  assert.equal(updates.at(-1).wasmSearchMs, 8000);
  assert.equal(updates.at(-1).wasmVisitedBranches, 17, 'final totals must not add the partial update twice');
  assert.equal(run.logs.length, 0, 'normal worker messages are logged only by the UI aggregator');
});


for (const [route, task, label] of [
  ['fixed', {}, '固定速度'],
  ['range', { speedBounds: { minimum: 10, maximum: 20 } }, '整段GCD'],
  ['warm', { branchLimit: 500_000 }, '限额预热'],
]) {
  test(`native ${route} query metadata and elapsed time are reported live`, async () => {
    let time = 0;
    const run = worker({ task, clock: { now: () => time }, search: report => {
      time = 6000;report({ fraction: 0.4, visitedBranches: 12, states: 2 });
      time = 8000;
    } });
    await run.send({ type: 'optimize', input: {} });
    const updates = run.messages.filter(message => message.type === 'diagnostics').map(message => message.diagnostics);
    const live = updates.find(update => update.stage === '计算中');
    assert.equal(live[`${route}SearchMs`], 6000);
    assert.equal(live[`${route}SearchCalls`], 1);
    assert.equal(live.query.route, label);
    assert.deepEqual(Array.from(live.query.counts), [2, 3]);
    assert.equal(live.query.minimumScore, 1);
    assert.equal(live.query.fraction, 0.4);
    assert.equal(updates.at(-1)[`${route}SearchMs`], 8000);
    assert.equal(updates.at(-1).query.complete, true);
  });
}
