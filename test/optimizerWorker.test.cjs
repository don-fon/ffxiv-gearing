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

function worker(fail, exercise = true) {
  const messages = [];
  const calls = [];
  const logs = [];
  const backend = () => ({ complete: true, visitedBranches: 17, states: 3, damage: 1 });
  backend.pareto = options => options.length >= 64 ? options.slice(0, 1) : undefined;
  backend.memoryBytes = () => 8388608;
  const self = { postMessage: message => messages.push(message) };
  vm.runInNewContext(compiled, {
    exports: {}, self, URL,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level =>
      [level, (...args) => logs.push({ level, args })])),
    fetch: async () => ({ ok: !fail, status: fail ? 404 : 200, arrayBuffer: async () => new ArrayBuffer(0) }),
    require: name => name === './optimizerWasm' ? { createWasmSearchBackend: async () => backend } : {
      planGearOptimization: (input, engine) => { calls.push(engine);return { partitions: [] }; },
      optimizeGearset: (input, report, engine) => {
        calls.push(engine);
        if (exercise) {
          engine?.pareto?.(Array.from({ length: 64 }, () => ({ stats: {}, choices: [] })));
          engine?.({}, () => {});
        }
        return { damage: 1 };
      },
    },
  });
  return { messages, calls, logs, backend, send: data => self.onmessage({ data }) };
}

test('normal workers fall back to JavaScript if WASM cannot initialize', async () => {
  const run = worker(true);
  await run.send({ type: 'optimize', input: {} });
  assert.equal(run.calls[0], undefined);
  assert.equal(run.messages.find(message => message.type === 'result').engine, 'javascript');
  assert.ok(run.logs.some(log => log.level === 'warn' && /WASM/.test(log.args[0])));
  const status = run.messages.find(message => message.type === 'diagnostics').diagnostics;
  assert.equal(status.engine, 'JavaScript');
  assert.match(status.fallbackReason, /404/);
});

test('explicit WASM benchmarks report initialization failure', async () => {
  const run = worker(true);
  await run.send({ type: 'optimize', input: {}, engine: 'wasm' });
  assert.equal(run.calls.length, 0);
  assert.equal(run.messages[0].type, 'error');
  assert.match(run.messages[0].message, /404/);
});

test('normal workers use the measured native configuration and requested shard count', async () => {
  const run = worker(false);
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
  assert.equal(status.wasmParetoInputOptions, 64);
  assert.equal(status.wasmParetoOutputOptions, 1);
  assert.equal(status.wasmMemoryMiB, 8);
});


test('diagnostics distinguish WASM availability from actual kernel calls', async () => {
  const run = worker(false, false);
  await run.send({ type: 'optimize', input: {} });
  const status = run.messages.filter(message => message.type === 'diagnostics').at(-1).diagnostics;
  assert.equal(status.engine, 'WASM');
  assert.equal(status.wasmUsed, false);
  assert.equal(status.wasmSearchCalls, 0);
  assert.equal(status.wasmParetoCalls, 0);
});
