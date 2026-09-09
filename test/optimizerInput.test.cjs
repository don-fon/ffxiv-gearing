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
    if (request === './game') return {
      getCaps: gear => gear.syncCaps,
      materiaGrades: [12, 11],
      materiaGradeRequiredLevels: Array.from({ length: 12 }, () => 690),
      materiaGradeIsRestricted: Object.assign(Array.from({ length: 13 }, () => false), { 12: true }),
    };
    if (request === './stores') return { gearDataOrdered: { get: () => [] } };
    if (request === './optimizerCandidateFallbacks') {
      return { selectPieFreeFallbacks: () => [], selectRequiredSlotFallbacks: () => [] };
    }
    return require(request);
  },
});

const { isOptimizerGearEligible, maximumMateriaGradeForSlot } = optimizerInput;
const store = {
  minLevel: 730,
  maxLevel: 795,
  schema: { jobLevel: 100 },
  setting: { hideObsoleteGears: true },
};
const secondaryStats = ['CRT', 'DET', 'DHT', 'SPS'];
const oneCappedStat = {
  synced: true,
  stats: { CRT: 379, DET: 299 },
};
const twoCappedStats = {
  synced: true,
  stats: { CRT: 379, DET: 379 },
};
const gear = level => ({
  level,
  equipLevel: 1,
  syncCaps: { CRT: 379, DET: 379, DHT: 379, SPS: 379 },
});

test('synced gear within 15 item levels of the filter maximum remains eligible with stat loss', () => {
  assert.equal(isOptimizerGearEligible(store, gear(790), oneCappedStat, 735, secondaryStats), true);
  assert.equal(isOptimizerGearEligible(store, gear(780), oneCappedStat, 735, secondaryStats), true);
});

test('the first advanced meld slot accepts grade 12 materia', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(index =>
    maximumMateriaGradeForSlot(690, index, 2)), [12, 12, 12, 11, 11]);
});

test('the near-maximum exception does not extend below its inclusive boundary', () => {
  assert.equal(isOptimizerGearEligible(store, gear(779), oneCappedStat, 735, secondaryStats), false);
  assert.equal(isOptimizerGearEligible(store, gear(779), twoCappedStats, 735, secondaryStats), true);
});

test('the near-maximum exception stays within the selected item-level range', () => {
  const narrowStore = { ...store, minLevel: 790, maxLevel: 795 };
  assert.equal(isOptimizerGearEligible(narrowStore, gear(780), oneCappedStat, 735, secondaryStats), false);
});

test('without item-level sync, gear is selected from the configured filter range', () => {
  assert.equal(isOptimizerGearEligible(store, gear(730), oneCappedStat, undefined, secondaryStats), true);
  assert.equal(isOptimizerGearEligible(store, gear(795), oneCappedStat, undefined, secondaryStats), true);
  assert.equal(isOptimizerGearEligible(store, gear(725), oneCappedStat, undefined, secondaryStats), false);
  assert.equal(isOptimizerGearEligible(store, gear(800), oneCappedStat, undefined, secondaryStats), false);
});

test('without item-level sync, obsolete gear follows the existing visibility setting', () => {
  assert.equal(isOptimizerGearEligible(store, { ...gear(790), obsolete: true }, oneCappedStat,
    undefined, secondaryStats), false);
  assert.equal(isOptimizerGearEligible({ ...store, setting: { hideObsoleteGears: false } },
    { ...gear(790), obsolete: true }, oneCappedStat, undefined, secondaryStats), true);
});

test('gear above the job level cap is never eligible for optimization', () => {
  const beastmasterStore = { ...store, schema: { jobLevel: 50 } };
  const level54Gear = { ...gear(133), equipLevel: 54 };
  assert.equal(isOptimizerGearEligible(beastmasterStore, level54Gear, oneCappedStat,
    undefined, secondaryStats), false);
  assert.equal(isOptimizerGearEligible(beastmasterStore, level54Gear, oneCappedStat,
    130, secondaryStats), false);
});
