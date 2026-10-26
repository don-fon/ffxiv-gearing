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
const store = { minLevel: 350, maxLevel: 375, filteredIds: [350, 370, 375] };
const gear = level => ({ id: level, level, equipLevel: 1 });

test('automatic candidates come from displayed IDs without sync exceptions', () => {
  for (const level of [350, 370, 375]) assert.equal(isOptimizerGearEligible(store, gear(level)), true);
  for (const level of [349, 376, 500]) assert.equal(isOptimizerGearEligible(store, gear(level)), false);
});

test('manually selected outside gear stays eligible when retained by the display', () => {
  const selected = { ...store, filteredIds: [350, 370, 375, 500] };
  assert.equal(isOptimizerGearEligible(selected, gear(500)), true);
  assert.equal(isOptimizerGearEligible(selected, gear(510)), false);
});

test('right-ring display IDs refer to the same eligible equipment item', () => {
  assert.equal(isOptimizerGearEligible({ ...store, filteredIds: [-500] }, gear(500)), true);
});

test('eligibility cannot introduce gear hidden by the display', () => {
  assert.equal(isOptimizerGearEligible({ ...store, filteredIds: [] }, gear(370)), false);
});

test('the first advanced meld slot accepts grade 12 materia', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(index =>
    maximumMateriaGradeForSlot(690, index, 2)), [12, 12, 12, 11, 11]);
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
