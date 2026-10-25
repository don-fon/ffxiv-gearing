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

function worker(fail) {
  const messages = [];
  const calls = [];
  const backend = () => undefined;
  const self = { postMessage: message => messages.push(message) };
  vm.runInNewContext(compiled, {
    exports: {}, self, URL,
    fetch: async () => ({ ok: !fail, status: fail ? 404 : 200, arrayBuffer: async () => new ArrayBuffer(0) }),
    require: name => name === './optimizerWasm' ? { createWasmSearchBackend: async () => backend } : {
      planGearOptimization: (input, engine) => { calls.push(engine);return { partitions: [] }; },
      optimizeGearset: (input, report, engine) => { calls.push(engine);return { damage: 1 }; },
    },
  });
  return { messages, calls, backend, send: data => self.onmessage({ data }) };
}

test('normal workers fall back to JavaScript if WASM cannot initialize', async () => {
  const run = worker(true);
  await run.send({ type: 'optimize', input: {} });
  assert.equal(run.calls[0], undefined);
  assert.equal(run.messages[0].type, 'result');
  assert.equal(run.messages[0].engine, 'javascript');
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
  assert.equal(run.calls[0], run.backend);
  assert.equal(run.backend.candidateShardCount, 4);
  assert.equal(run.backend.warmStartMinimumWork, 10_000_000_000);
  await run.send({ type: 'optimize', input: {} });
  assert.equal(run.messages[1].engine, 'wasm-warm');
});
