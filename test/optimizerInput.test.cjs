const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/optimizerInput.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const optimizerInput = {};
vm.runInNewContext(compiled, {
  exports: optimizerInput,
  module: { exports: optimizerInput },
  require: request => {
    if (request === './game') return { getCaps: gear => gear.syncCaps };
    if (request === './stores') return { gearDataOrdered: { get: () => [] } };
    if (request === './optimizerPieFallbacks') return { selectPieFreeFallbacks: () => [] };
    return require(request);
  },
});

const { isOptimizerGearEligible } = optimizerInput;
const store = { minLevel: 730, maxLevel: 795 };
const secondaryStats = ['CRT', 'DET', 'DHT', 'SPS'];
const oneCappedStat = {
  synced: true,
  stats: { CRT: 379, DET: 299 },
};
const twoCappedStats = {
  synced: true,
  stats: { CRT: 379, DET: 379 },
};
const gear = level => ({ level, syncCaps: { CRT: 379, DET: 379, DHT: 379, SPS: 379 } });

test('synced gear within 15 item levels of the filter maximum remains eligible with stat loss', () => {
  assert.equal(isOptimizerGearEligible(store, gear(790), oneCappedStat, 735, secondaryStats), true);
  assert.equal(isOptimizerGearEligible(store, gear(780), oneCappedStat, 735, secondaryStats), true);
});

test('the near-maximum exception does not extend below its inclusive boundary', () => {
  assert.equal(isOptimizerGearEligible(store, gear(779), oneCappedStat, 735, secondaryStats), false);
  assert.equal(isOptimizerGearEligible(store, gear(779), twoCappedStats, 735, secondaryStats), true);
});

test('the near-maximum exception stays within the selected item-level range', () => {
  const narrowStore = { minLevel: 790, maxLevel: 795 };
  assert.equal(isOptimizerGearEligible(narrowStore, gear(780), oneCappedStat, 735, secondaryStats), false);
});
