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

const {
  isOptimizerGearEligible,
  maximumMateriaGradeForSlot,
  optimizerGearCategoryOf,
  optimizerGearCategoryOptions,
} = optimizerInput;
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

test('relic weapon series are classified separately from their armor', () => {
  const weapon = source => optimizerGearCategoryOf({ slot: 13, source });
  assert.equal(weapon('古武'), 'zodiacWeapon');
  assert.equal(weapon('魂武'), 'animaWeapon');
  assert.equal(weapon('优雷卡/常风之地'), 'eurekaWeapon');
  assert.equal(weapon('义军武器'), 'resistanceWeapon');
  assert.equal(weapon('曼德维尔武器'), 'mandervilleWeapon');
  assert.equal(weapon('幻境武器'), 'phantomWeapon');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '优雷卡/常风之地' }), 'eurekaGear');
});

test('common gear sources are classified for pre-search exclusion', () => {
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '零式/重量级' }), 'savage');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '迷宫挑战/先锋营' }), 'dungeon');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '大型任务/重量级' }), 'normalRaid');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '团队任务/桑多利亚' }), 'allianceRaid');
  assert.equal(optimizerGearCategoryOf({ slot: 1, source: '歼殛战/恩欧' }), 'trial');
  assert.equal(optimizerGearCategoryOf({ slot: 1, source: '绝境战/欧米茄' }), 'ultimate');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '天佑女王/博兹雅战线' }), 'bozjaGear');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '新月岛/南征之章' }), 'crescentIsleGear');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '职业校服' }), 'artifactGear');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '狼印战绩/牙狼联动' }), 'wolfMarkGear');
  assert.equal(optimizerGearCategoryOf({ slot: 13, source: '深层迷宫/天之御柱' }), 'deepDungeonGear');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '天书奇谈' }), 'wondrousTailsGear');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '生产制作' }), 'craftedGear');
  assert.equal(optimizerGearCategoryOf({ slot: 3, source: '制作装强化' }), 'craftedGear');
});

test('raid source labels distinguish normal and 24-player raids', () => {
  const labels = Object.fromEntries(optimizerGearCategoryOptions.map(option => [option.id, option.label]));
  assert.equal(labels.normalRaid, '大型');
  assert.equal(labels.allianceRaid, '团本');
});

test('375 sync can include item-level 500 outside a 350–375 filter only through the capped-stat rule', () => {
  const selected = { ...store, minLevel: 350, maxLevel: 375 };
  assert.equal(isOptimizerGearEligible(selected, gear(500), twoCappedStats, 375, secondaryStats), true);
  assert.equal(isOptimizerGearEligible(selected, gear(500), oneCappedStat, 375, secondaryStats), false);
  assert.equal(isOptimizerGearEligible(selected, gear(500), twoCappedStats, undefined, secondaryStats), false);
});
