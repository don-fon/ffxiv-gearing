const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

function load(file, dependencies = {}, transform = value => value) {
  const exports = {};
  const code = ts.transpileModule(transform(fs.readFileSync(require.resolve(file), 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInThisContext('(function(exports, module, require) {' + code + '\n})')(
    exports, { exports }, name => dependencies[name]);
  return exports;
}
const formulas = load('../src/statFormulas.ts');
const transform = source => source
  .replace('const maximumStateExpansion = 1_000_000;', 'const maximumStateExpansion = 4;')
  .replace('const maximumContractionProduct = 250_000;', 'const maximumContractionProduct = 0;');
const solver = load('../src/optimizer.ts', { './statFormulas': formulas }, transform);
const production = load('../src/optimizer.ts', { './statFormulas': formulas });
const adapter = load('../src/optimizerWasm.ts');
const bytes = fs.readFileSync(require.resolve('../src/optimizerSearch.wasm'));
const floor = value => Math.trunc(value + 1e-7);
function add(left, right) {
  const result = { ...left };
  for (const [stat, value] of Object.entries(right)) result[stat] = (result[stat] ?? 0) + value;
  return result;
}
function melded(stats, meld, gear) {
  return { ...stats, [meld.stat]: Math.min((stats[meld.stat] ?? 0) + meld.value,
    Math.max(stats[meld.stat] ?? 0, gear.caps[meld.stat] ?? Infinity)) };
}
function oracle(input) {
  const grouped = input.slots.map(slot => input.gears.filter(gear => gear.slot === slot &&
    !(input.excludedGearIds ?? []).includes(gear.id) &&
    (!(input.lockedGears ?? []).some(lock => lock.slot === slot) ||
      input.lockedGears.some(lock => lock.slot === slot && lock.id === gear.id)))
    .flatMap(gear => {
      const locked = input.lockedGears?.find(lock => lock.slot === slot && lock.id === gear.id);
      if (locked?.melds !== undefined) return [locked.melds.reduce((stats, meld) => melded(stats, meld, gear), gear.stats)];
      let choices = [gear.stats];
      for (const materia of gear.materiaSlots) choices = choices.flatMap(stats => input.materiaStats
        .map(stat => melded(stats, { stat, value: materia.value }, gear)));
      return choices;
    }));
  let combinations = [input.fixedStats];
  for (const group of grouped) combinations = combinations.flatMap(stats => group.map(choice => add(stats, choice)));
  return combinations.flatMap(raw => input.foods.map(food => {
    const stats = { ...raw };
    for (const [stat, cap] of Object.entries(food.stats)) stats[stat] = (stats[stat] ?? 0) +
      (food.statRates[stat] === undefined ? cap : Math.min(cap, floor((stats[stat] ?? 0) * food.statRates[stat] / 100)));
    return stats;
  })).filter(stats => {
    const speed = stats.SKS;
    const level = input.damage.level;
    const modifier = input.damage.jobLevel >= 80 ? input.damage.statModifiers.gcd ?? 100 : 100;
    const gcd = floor(floor((1000 - floor(130 * (speed - level.sub) / level.div)) * 2500 / 1000) * modifier / 1000) / 100;
    return gcd === input.targetGcd && (input.objective.type !== 'minimumTenacity' ||
      formulas.calculateTenacityMitigation(stats.TEN, level) + 1e-12 >= input.objective.minimumTenacityMitigation);
  });
}
function fixture(seed) {
  const tank = seed % 2 === 0;
  const slots = [3, 4, 5, 7];
  const fixedStats = { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100,
    ...(tank ? { TEN: 420 } : {}) };
  const modifier = seed % 5 ? 100 : 80;
  return {
    fixedStats, slots, speedStat: 'SKS', targetGcd: (modifier === 80 ? 2 : 2.5) - (seed % 3 ? 0 : 0.01),
    lockedGearIds: seed % 7 ? [] : [1],
    lockedGears: seed % 7 ? [] : [{ id: 1, slot: 3, ...(seed % 14 ? {} : { melds: [] }) }],
    excludedGearIds: seed % 11 ? [] : [3],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS', ...(tank ? ['TEN'] : [])],
    gears: slots.flatMap((slot, index) => Array.from({ length: 3 }, (_, option) => ({
      id: index * 3 + option + 1, name: `${index}-${option}`, slot, unique: true, level: 350, synced: false,
      stats: { STR: 10 + (index + option + seed) % 9, CRT: (index * 11 + option * 17 + seed * 5) % 91,
        DET: (index * 19 + option * 7 + seed * 3) % 89, DHT: (index * 13 + option * 23 + seed * 7) % 97,
        SKS: [0, 15, 35][option], ...(tank ? { TEN: (index * 19 + option * 67 + seed * 11) % 190 } : {}) },
      caps: { CRT: 95, DET: 95, DHT: 95, SKS: 95, TEN: 190 },
      materiaSlots: index === 0 ? [{ grade: 6, value: 16 }] : [],
    }))),
    foods: [
      { id: 1, name: 'crit', stats: { CRT: 30, SKS: 10 }, statRates: { CRT: 10, SKS: 10 } },
      { id: 2, name: 'other', stats: { CRT: 7, DET: 20, ...(tank ? { TEN: 20 } : {}) },
        statRates: { ...(seed % 4 ? { CRT: 10 } : {}), DET: 10, TEN: 10 } },
    ],
    objective: tank ? { type: 'minimumTenacity', minimumTenacityMitigation: seed % 4 ? 0 : 0.01 } : { type: 'damage' },
    damage: { job: tank ? 'WAR' : 'MNK', jobLevel: 100, mainStat: tank ? 'VIT' : 'STR',
      statModifiers: { STR: 110, gcd: modifier }, traitDamageMultiplier: 1, baseStats: fixedStats,
      level: { main: 440, sub: 420, div: 2780, det: 2780, detTrunc: 1, ap: 237, apTank: 190 }, bluMdmgAdditions: [] },
  };
}

test('critical halves match exhaustive legal ranges and optimal damage in JS and WASM', async () => {
  const native = await adapter.createWasmSearchBackend(bytes);
  let checked = 0;
  for (let seed = 0; seed < 64; seed++) {
    const input = fixture(seed);
    const valid = oracle(input);
    for (const preference of ['high', 'low']) {
      const selected = { ...input, criticalPreference: preference };
      if (!valid.length) {
        assert.throws(() => solver.optimizeGearset(selected), /没有找到/);
        continue;
      }
      const minimum = Math.min(...valid.map(stats => stats.CRT));
      const maximum = Math.max(...valid.map(stats => stats.CRT));
      const midpoint = (minimum + maximum) / 2;
      const eligible = valid.filter(stats => preference === 'high' ? stats.CRT >= midpoint : stats.CRT <= midpoint);
      const expected = Math.max(...eligible.map(stats => solver.calculateExpectedDamage(stats, input.damage)));
      for (const backend of [undefined, native]) {
        const result = solver.optimizeGearset(selected, undefined, backend);
        assert.deepEqual(result.criticalRange, { minimum, maximum, midpoint }, `range seed ${seed}`);
        assert.ok(Math.abs(result.damage - expected) < 1e-12, `damage seed ${seed}, ${preference}`);
        assert.ok(preference === 'high' ? result.stats.CRT >= midpoint : result.stats.CRT <= midpoint);
      }
      if (seed < 12) {
        const result = production.optimizeGearset(selected, undefined, native);
        assert.ok(Math.abs(result.damage - expected) < 1e-12, `contracted seed ${seed}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 100);
});

test('critical range is shared across worker food/speed/candidate shards', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes);
  for (const preference of ['high', 'low']) {
    const input = { ...fixture(9), criticalPreference: preference };
    const expected = solver.optimizeGearset(input, undefined, backend);
    const plan = solver.planGearOptimization(input, backend);
    let best = plan.heuristicResult;
    for (const task of plan.partitions) {
      for (let index = 0; index < 3; index++) {
        const result = solver.optimizeGearset({ ...input, foods: undefined,
          food: input.foods.find(food => food.id === task.foodId),
          targetSpeedContribution: task.contribution, criticalRange: plan.criticalRange,
          candidateShard: { index, count: 3 }, globalMinimumDamage: best.damage,
        }, undefined, index % 2 ? undefined : backend);
        if (result.damage > best.damage) best = result;
      }
    }
    assert.deepEqual(plan.criticalRange, expected.criticalRange);
    assert.equal(best.damage, expected.damage);
  }
});

test('equal endpoints keep both modes feasible; invalid preferences are rejected', async () => {
  const input = fixture(1);
  input.gears = input.gears.filter(gear => gear.id % 3 === 1);
  for (const gear of input.gears) gear.materiaSlots = [];
  input.foods = [input.foods[0]];
  const expected = production.optimizeGearset(input);
  for (const criticalPreference of ['high', 'low']) {
    const result = production.optimizeGearset({ ...input, criticalPreference });
    assert.equal(result.damage, expected.damage);
    assert.equal(result.criticalRange.minimum, result.criticalRange.maximum);
  }
  assert.throws(() => production.optimizeGearset({ ...input, criticalPreference: 'invalid' }), /暴击偏好/);
});

test('critical endpoints respect unique rings, repeatable pairs, exclusions and a locked right ring', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes);
  const input = fixture(1);
  input.slots = [12];
  input.foods = [{ id: 1, name: 'flat crit', stats: { CRT: 7 }, statRates: {} }];
  input.gears = [0, 80, 15].map((critical, index) => ({ id: index + 1, name: `ring-${index}`,
    slot: 12, unique: index !== 0, level: 350, stats: { STR: 10, CRT: critical },
    caps: {}, materiaSlots: [], synced: false }));
  for (const locked of [false, true]) {
    input.lockedGearIds = locked ? [2] : [];
    input.lockedGears = locked ? [{ id: 2, slot: -12, melds: [] }] : [];
    const minimum = locked ? 507 : 427;
    const maximum = 522;
    for (const criticalPreference of ['high', 'low']) {
      const result = production.optimizeGearset({ ...input, criticalPreference }, undefined, backend);
      assert.deepEqual(result.criticalRange, { minimum, maximum, midpoint: (minimum + maximum) / 2 });
      assert.ok(result.gears.filter(gear => gear.id === 2).length <= 1);
      if (locked) assert.equal(result.gears.filter(gear => gear.id === 2).length, 1);
    }
  }
  input.lockedGearIds = [];
  input.lockedGears = [];
  input.excludedGearIds = [3];
  assert.equal(production.optimizeGearset({ ...input, criticalPreference: 'high' }).criticalRange.maximum, 507);
});
