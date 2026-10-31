import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import loadHighs from 'highs';
import { compileOptimizerSupport } from './optimizer-integer-support.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { count: { type: 'string', default: '512' }, seed: { type: 'string', default: '20261030' }, output: { type: 'string' }, corpus: { type: 'string' } } });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-raw-oracle-'));
try {
  const corpusPath = values.corpus ?? path.join(temporary, 'corpus.json');
  if (!values.corpus || !fs.existsSync(values.corpus)) {
    const process = spawnSync('python', [path.join(root, 'scripts/experiments/optimizer-raw-oracle.py'), '--root', root,
      '--count', values.count, '--seed', values.seed, '--output', corpusPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(process.status, 0, process.stderr);
  }
  const corpus = JSON.parse(fs.readFileSync(corpusPath));
  for (const [name, text] of Object.entries(compileOptimizerSupport(root))) fs.writeFileSync(path.join(temporary, name + '.mjs'), text);
  for (const [to, from] of [['model', 'optimizer-integer-model'], ['certified', 'optimizer-integer-certified'], ['direct-groups', 'optimizer-integer-direct-groups']])
    fs.copyFileSync(path.join(root, 'scripts/experiments', from + '.mjs'), path.join(temporary, to + '.mjs'));
  const { optimizeGearset, milpMinimalPlan } = await import(pathToFileURL(path.join(temporary, 'optimizer.mjs')));
  const { buildIntegerObjective, solveIntegerObjective } = await import(pathToFileURL(path.join(temporary, 'certified.mjs')));
  const highs = await loadHighs();const started = performance.now();
  let empty = 0, passes = 0, criticalEndpointCasesVerified = 0, criticalEndpointInfeasibleVerified = 0;const plans = [];
  for (const test of corpus.cases) {
    const input = test.input;let integer, native;
    try {
      let resolved = input;
      if (input.criticalPreference !== 'none') {
        try {
          const plan = milpMinimalPlan({ ...input, criticalRange: undefined });
          assert.deepEqual(plan.criticalRange, input.criticalRange, 'raw oracle CRT endpoints differ: ' + test.id);
          resolved = { ...input, criticalRange: plan.criticalRange };criticalEndpointCasesVerified++;
        } catch (error) {
          if (input.criticalRange || !error.message.includes('没有找到')) throw error;
          criticalEndpointInfeasibleVerified++;
        }
      }
      for (const food of input.food ? [input.food] : input.foods ?? [undefined]) {
        const part = { ...resolved, food, foods: undefined };
        const prepared = buildIntegerObjective(part);
        const result = solveIntegerObjective(highs, prepared, { timeLimit: 30 });passes += result.passes;
        if (result.result && (!integer || (result.result.score ?? result.result.damage) > (integer.score ?? integer.damage))) integer = result.result;
      }
      try { native = optimizeGearset({ ...input, criticalRange: undefined }); } catch (error) {
        if (!error.message.includes('没有找到')) throw error;
      }
      // Native's public optimizer does not consume the distributed-search
      // incumbent cutoff. Apply it here before comparing to the raw oracle.
      if (native && (native.score ?? native.damage) < (input.globalMinimumDamage ?? 0)) native = undefined;
      for (const [name, result] of [['integer', integer], ['native', native]]) {
        const actual = result ? result.score ?? result.damage : null;
        assert.ok(test.expectedScore === null ? actual === null : actual !== null && Math.abs(actual - test.expectedScore) <= 1e-10 * Math.max(1, test.expectedScore),
          JSON.stringify({ id: test.id, algorithm: name, expected: test.expectedScore, actual }));
      }
      if (test.expectedScore === null) empty++;
      plans.push({ id: test.id, integer: integer ?? null, native: native ?? null });
    } catch (error) {
      if (values.output) fs.writeFileSync(values.output + '.failure.json', JSON.stringify({ test, integer, native, error: String(error) }, null, 2) + '\n');
      throw error;
    }
  }
  const plansPath = values.output ? values.output + '.plans.json' : path.join(temporary, 'plans.json');
  const verificationPath = path.join(temporary, 'verification.json');
  fs.writeFileSync(plansPath, JSON.stringify(plans));
  const verification = spawnSync('python', [path.join(root, 'scripts/experiments/optimizer-raw-oracle.py'), '--root', root,
    '--corpus', corpusPath, '--verify', plansPath, '--output', verificationPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(verification.status, 0, verification.stderr);
  const verified = JSON.parse(fs.readFileSync(verificationPath));
  const result = { passed: true, independentRawOracle: true, scoreArithmetic: 'Python Fraction', exactReturnedPlansVerified: verified.exactReturnedPlansVerified, count: corpus.cases.length,
    assignments: corpus.assignments, seed: corpus.seed, empty, passes, criticalEndpointCasesVerified, criticalEndpointInfeasibleVerified, oracleSeconds: corpus.seconds, solverSeconds: (performance.now() - started) / 1000 };
  if (values.output) fs.writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
