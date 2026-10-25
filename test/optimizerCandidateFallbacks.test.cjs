const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/optimizerCandidateFallbacks.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const candidates = {};
vm.runInNewContext(compiled, { exports: candidates, module: { exports: candidates }, require });

const { selectPieFreeFallbacks, selectRequiredSlotFallbacks } = candidates;

function gear(id, level, slot, unique, pie = 0) {
  return { id, level, slot, unique, stats: pie === 0 ? {} : { PIE: pie } };
}

test('one unique preferred ring is completed by the highest lower tier', () => {
  const preferred = [gear(1, 790, 12, true)];
  const lower = [gear(2, 780, 12, true), gear(3, 770, 12, true)];
  assert.equal(selectRequiredSlotFallbacks(preferred, lower, [12]).map(item => item.id).join(','), '2');
});

test('a repeatable preferred ring does not require a lower-tier partner', () => {
  const preferred = [gear(1, 790, 12, false)];
  assert.equal(selectRequiredSlotFallbacks(preferred, [gear(2, 780, 12, true)], [12]).length, 0);
});

test('an empty regular slot is filled from the highest lower tier', () => {
  const lower = [gear(1, 780, 4, true), gear(2, 780, 4, true), gear(3, 770, 4, true)];
  assert.equal(selectRequiredSlotFallbacks([], lower, [4]).map(item => item.id).join(','), '1,2');
});

test('a speed-free lower-tier item is added when the preferred slot always has speed', () => {
  const preferred = [{ ...gear(1, 790, 5, true), stats: { SKS: 188 } }];
  const lower = [
    { ...gear(2, 780, 5, true), stats: { SKS: 184 } },
    gear(3, 780, 5, true),
  ];
  const speedFree = item => (item.stats.SKS ?? 0) === 0;
  assert.equal(selectRequiredSlotFallbacks(preferred, lower.filter(speedFree), [5], speedFree)
    .map(item => item.id).join(','), '3');
});

test('PIE-free fallbacks are not added when regular gear fills the slot', () => {
  const standard = [gear(1, 790, 9, true)];
  const lower = [gear(2, 780, 9, true)];
  assert.equal(selectPieFreeFallbacks(standard, lower, [9]).length, 0);
});

test('rings relax item level until two legal PIE-free copies are available', () => {
  const standard = [gear(1, 790, 12, true), gear(2, 790, 12, true, 100)];
  const lower = [
    gear(3, 780, 12, true),
    gear(4, 780, 12, true),
    gear(5, 780, 12, true, 100),
    gear(6, 770, 12, true),
  ];
  assert.equal(selectPieFreeFallbacks(standard, lower, [12]).map(item => item.id).join(','), '3,4');
});

test('a repeatable PIE-free ring supplies both ring slots', () => {
  const standard = [gear(1, 790, 12, false), gear(2, 790, 12, true, 100)];
  assert.equal(selectPieFreeFallbacks(standard, [gear(3, 780, 12, true)], [12]).length, 0);
});

test('fallback selection continues to the next lower tier when necessary', () => {
  const lower = [gear(1, 780, 12, true), gear(2, 770, 12, true)];
  assert.equal(selectPieFreeFallbacks([], lower, [12]).map(item => item.id).join(','), '1,2');
});

const { maximumSecondaryStatTotal, selectSecondaryStatFallbacks } = candidates;
const secondaryStats = ['CRT', 'DET', 'DHT', 'TEN', 'SKS'];
function meldableGear(id, level, stats, caps, values, slot = 4) {
  return { ...gear(id, level, slot, true), stats, caps, synced: false,
    materiaSlots: values.map(value => ({ grade: 6, value })) };
}

test('350 Anemos armor can enter the 375-sync pool despite a populated 370 slot', async () => {
  const { default: data } = await import('../data/out/gears-340.js');
  const prepare = id => {
    const item = data.find(entry => entry.id === id);
    return meldableGear(id, item.level, item.stats,
      { CRT: 124, DET: 124, DHT: 124, TEN: 124, SKS: 124 },
      Array.from({ length: item.materiaSlot }, () => 16), item.slot);
  };
  const anemos = prepare(22232);
  const regular = prepare(21416);
  regular.caps = { CRT: 129, DET: 129, DHT: 129, TEN: 129, SKS: 129 };
  assert.equal(maximumSecondaryStatTotal(anemos, secondaryStats), 291);
  assert.equal(maximumSecondaryStatTotal(regular, secondaryStats), 251);
  assert.equal(selectSecondaryStatFallbacks([regular], [anemos], secondaryStats)[0].id, 22232);
});

test('meld totals account for individual slot overflow, not just total headroom', () => {
  const item = meldableGear(1, 350, { CRT: 9, DET: 9 },
    { CRT: 10, DET: 10 }, [16]);
  assert.equal(maximumSecondaryStatTotal(item, ['CRT', 'DET']), 19);
  item.synced = true;
  assert.equal(maximumSecondaryStatTotal(item, ['CRT', 'DET']), 18);
});

test('compare against the strongest original candidate per slot with strict inequality', () => {
  const item = (id, total, slot = 4) => meldableGear(id, 350, { CRT: total }, {}, [], slot);
  const preferred = [item(1, 200), item(2, 250), item(3, 100, 5)];
  const lower = [item(4, 240), item(5, 250), item(6, 260), item(7, 255), item(8, 101, 5), item(9, 999, 7)];
  assert.equal(selectSecondaryStatFallbacks(preferred, lower, secondaryStats)
    .map(entry => entry.id).join(','), '6,7,8');
  assert.equal(selectSecondaryStatFallbacks(preferred, lower.slice().reverse(), secondaryStats)
    .map(entry => entry.id).sort().join(','), '6,7,8');
});

test('ignore main stats and piety, and do not duplicate existing candidates', () => {
  const preferred = meldableGear(1, 370, { CRT: 100 }, {}, []);
  const lower = meldableGear(2, 350, { CRT: 99, STR: 999, PIE: 999 }, {}, []);
  assert.equal(selectSecondaryStatFallbacks([preferred], [preferred, lower], secondaryStats).length, 0);
});
