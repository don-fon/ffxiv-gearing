const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadTypeScript(file, dependencies = {}, transform = source => source) {
  const source = transform(fs.readFileSync(require.resolve(file), 'utf8'));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, module: { exports }, WebAssembly,
    require: name => dependencies[name] ?? require(name),
  });
  return exports;
}
const formulas = loadTypeScript('../src/statFormulas.ts');
const solver = loadTypeScript('../src/optimizer.ts', { './statFormulas': formulas }, source => source
  .replace('const maximumStateExpansion = 1_000_000;', 'const maximumStateExpansion = 4;')
  .replace('const maximumContractionProduct = 250_000;', 'const maximumContractionProduct = 0;') + '\nexport const testPareto = paretoFrontier; export const testAttributeTree = buildAttributeTree;');
const adapter = loadTypeScript('../src/optimizerWasm.ts');
const bytes = fs.readFileSync(require.resolve('../src/optimizerSearch.wasm'));

function fixture(seed) {
  const jobs = ['WAR', 'DRG', 'WHM', 'BLU'];
  const job = jobs[seed % jobs.length];
  const tank = job === 'WAR';
  const magic = job === 'WHM' || job === 'BLU';
  const mainStat = magic ? job === 'WHM' ? 'MND' : 'INT' : 'STR';
  const speedStat = magic ? 'SPS' : 'SKS';
  const sub = seed % 3 ? 364 : 420;
  const main = sub === 364 ? 292 : 440;
  const div = sub === 364 ? 900 : 2780;
  const fixedStats = { [mainStat]: 1800, CRT: sub, DET: main, DHT: sub, [speedStat]: sub,
    [magic ? 'MDMG' : 'PDMG']: 100, ...(tank ? { TEN: sub } : {}) };
  const slots = [3, 4, 5, 7, 8];
  const secondary = ['CRT', 'DET', 'DHT', ...(tank ? ['TEN'] : []), speedStat];
  const gears = slots.flatMap((slot, index) => Array.from({ length: 3 }, (_, option) => ({
    id: index * 3 + option + 1, name: `${index}-${option}`, slot, unique: true, level: 350,
    stats: { [mainStat]: 10 + (index * 7 + option * 3 + seed) % 9,
      CRT: (index * 11 + option * 17 + seed * 5) % 91,
      DET: (index * 19 + option * 7 + seed * 3) % 89,
      DHT: (index * 13 + option * 23 + seed * 7) % 97,
      VIT: (index * 5 + option * 11 + seed) % 73, ...(job === 'WHM' ? { PIE: option * 13 } : {}),
      ...(tank ? { TEN: option * 80 } : {}), [speedStat]: seed % 3 === 0 ? 0 : option * 25 },
    caps: Object.fromEntries(secondary.map(stat => [stat, 120])),
    materiaSlots: index === 0 && seed % 5 === 0 ? [{ grade: 6, value: 16 }, { grade: 5, value: 12 }] : [],
    synced: false,
  })));
  const food = seed % 7 === 0
    ? { id: 99, name: 'flat food', stats: { CRT: 23, DET: 17 }, statRates: {} }
    : { id: 99, name: 'capped food', stats: { CRT: 23, DET: 17, [mainStat]: 30 },
      statRates: { CRT: 10, DET: 10, [mainStat]: 10 } };
  return {
    fixedStats, gears, slots, lockedGearIds: seed % 11 === 0 ? [1] : [],
    lockedGears: seed % 13 === 0 ? [{ id: 1, slot: 3, melds: [] }] : undefined,
    materiaStats: secondary, speedStat, targetGcd: seed % 2 ? 2.49 : 2.50,
    food, objective: { type: 'minimumTenacity', minimumTenacityMitigation: tank && seed % 8 === 0 ? 0.02 : 0 },
    damage: {
      job, jobLevel: sub === 364 ? 70 : 100, mainStat: tank ? 'VIT' : mainStat,
      statModifiers: { [mainStat]: 115 }, traitDamageMultiplier: magic ? 1.3 : 1,
      partyBonus: seed % 2 ? 1.05 : 1,
      level: { main, sub, div, det: div, detTrunc: seed % 3 ? 1 : 10, ap: 125, apTank: 105 },
      baseStats: { ...fixedStats }, bluMdmgAdditions: Array.from({ length: 3000 }, (_, i) => 12 + Math.floor(i / 100)),
    },
  };
}

function compare(input, backend) {
  let expected;
  try { expected = solver.optimizeGearset(input); } catch (error) {
    assert.match(error.message, /没有找到/);
    assert.throws(() => solver.optimizeGearset(input, undefined, backend), /没有找到/);
    return;
  }
  const updates = [];
  const actual = solver.optimizeGearset(input, value => updates.push(value), backend);
  assert.ok(Math.abs(actual.damage - expected.damage) <= 1e-11,
    `${input.damage.job}: ${actual.damage} != ${expected.damage}`);
  assert.equal(actual.gears.length, expected.gears.length);
  for (const result of [expected, actual]) {
    const total = { ...input.fixedStats };
    for (const choice of result.gears) {
      const item = input.gears.find(gear => gear.id === choice.id);
      const stats = { ...item.stats };
      for (const meld of choice.melds) {
        const current = stats[meld.stat] ?? 0;
        stats[meld.stat] = Math.min(current + meld.value, Math.max(current, item.caps[meld.stat] ?? Infinity));
      }
      for (const [stat, value] of Object.entries(stats)) total[stat] = (total[stat] ?? 0) + value;
    }
    for (const [stat, cap] of Object.entries(result.food?.stats ?? {})) {
      const rate = result.food.statRates[stat];
      total[stat] = (total[stat] ?? 0) + (rate === undefined ? cap :
        Math.min(cap, Math.trunc((total[stat] ?? 0) * rate / 100 + 1e-7)));
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result.stats)), total, 'all reported stats must reconstruct from chosen gear');
  }
  assert.ok(actual.tenacityMitigation + 1e-12 >= input.objective.minimumTenacityMitigation);
  assert.ok(updates.every(value => value.searchProgress === undefined ||
    value.searchProgress >= 0 && value.searchProgress <= 1));
}

test('WASM matches JavaScript across jobs, levels, foods, meld caps, locks and objectives', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, 0, 0);
  const jobs = new Set();
  let improvements = 0;
  const counted = (task, report) => {
    jobs.add(task.input.damage.job);
    const result = backend(task, report);
    if (result.prefix !== undefined) improvements++;
    return result;
  };
  for (let seed = 0; seed < 80; seed++) compare(fixture(seed), counted);
  assert.equal(jobs.size, 4, 'all four job types must enter the WASM kernel');
  assert.ok(improvements > 0, 'exercise actual improvements over greedy initialization');
});

test('WASM preserves unique-ring pairing and multiple food searches', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, 0, 0);
  const input = fixture(1);
  input.slots = [12];
  input.lockedGearIds = [];
  input.lockedGears = undefined;
  input.targetGcd = 2.50;
  input.gears = [
    { ...input.gears[0], id: 100, slot: 12, stats: { STR: 10, CRT: 50 }, unique: true },
    { ...input.gears[1], id: 101, slot: 12, stats: { STR: 10, DET: 50 }, unique: false },
  ];
  input.foods = [input.food, { id: 98, name: 'other food', stats: { DET: 31 }, statRates: { DET: 10 } }];
  compare(input, backend);
  const result = solver.optimizeGearset(input, undefined, backend);
  assert.ok(result.gears.filter(gear => gear.id === 100).length <= 1);
});

test('WASM can leave small final tree products on the JavaScript backend', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, Infinity);
  compare(fixture(2), backend);
});


test('WASM dominance frontier matches JavaScript with duplicates and signed coordinates', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, 0, 0);
  const dimensions = ['STR', 'DEX', 'INT', 'MND', 'CRT', 'DET', 'DHT', 'TEN', 'PDMG', 'MDMG'];
  let randomState = 17;
  const random = maximum => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState % maximum;
  };
  for (let iteration = 0; iteration < 30; iteration++) {
    const options = Array.from({ length: 300 }, (_, index) => ({
      stats: Object.fromEntries(dimensions.map((stat, dimension) => [stat,
        dimension < iteration % 9 + 1 ? random(53) - 20 : 0])),
      choices: [{ id: index }],
    }));
    options.push(...options.slice(0, 20));
    const signature = option => dimensions.map(stat => option.stats[stat] ?? 0).join(',');
    const expected = new Set(solver.testPareto(options.slice()).map(signature));
    const actual = new Set(backend.pareto(options).map(signature));
    assert.deepEqual(actual, expected);
  }
});

test('candidate shards cover the exact optimum across objectives, locks and food inputs', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, 0, 0);
  for (let seed = 0; seed < 32; seed++) {
    const input = fixture(seed);
    let expected;
    try { expected = solver.optimizeGearset(input); } catch { continue; }
    const seedDamage = solver.planGearOptimization(input).heuristicResult.damage;
    const results = Array.from({ length: 4 }, (_, index) => solver.optimizeGearset({
      ...input, candidateShard: { index, count: 4 }, globalMinimumDamage: index % 2 ? seedDamage : 0,
    }, undefined, index % 2 ? backend : undefined));
    const best = Math.max(seedDamage, ...results.map(result => result.damage));
    assert.ok(Math.abs(best - expected.damage) <= 1e-11);
    assert.ok(results.every(result => !result.empty || result.gears.length === 0 && result.damage === -Infinity));
  }
  assert.throws(() => solver.optimizeGearset({ ...fixture(1), candidateShard: { index: 4, count: 4 } }), /shard/);
});

test('bounded pair warm starts preserve the exact optimum', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, 0, 0);
  backend.warmStartMinimumWork = 0;
  for (let seed = 0; seed < 40; seed++) compare(fixture(seed), backend);
});

test('large-search bounds preserve exhaustive optima across raw CRT bands, including fractional stats', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, 0, 0);
  let state = 713;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0;return state % n; };
  const add = (left, right) => {
    const stats = { ...left };
    for (const [stat, value] of Object.entries(right)) stats[stat] = (stats[stat] ?? 0) + value;
    return stats;
  };
  const foodStats = (raw, food) => {
    const stats = { ...raw };
    for (const [stat, cap] of Object.entries(food?.stats ?? {})) {
      const rate = food.statRates[stat];
      stats[stat] = (stats[stat] ?? 0) + (rate === undefined ? cap :
        Math.min(cap, Math.trunc((stats[stat] ?? 0) * rate / 100 + 1e-7)));
    }
    return stats;
  };
  for (let seed = 0; seed < 180; seed++) {
    const input = fixture(seed * 4);
    input.damage.partyBonus = seed % 2 ? 1.05 : 1;
    if (seed % 7) input.food = { id: 81, name: 'food-cap crossings',
      stats: { CRT: 100 + random(700), DET: 100 + random(700), DHT: 100 + random(700),
        TEN: 50 + random(500), STR: 30 + random(90), PDMG: 3 },
      statRates: { CRT: 5 + random(31), DET: 5 + random(31), DHT: 5 + random(31),
        TEN: 5 + random(31), STR: 10, PDMG: 10 } };
    input.objective = { type: 'minimumTenacity', minimumTenacityMitigation: seed % 3 ? 0 : 0.01 };
    const prefix = [0, 1].map(index => ({ stats: add(input.fixedStats,
      { STR: index * 7 + (seed % 4 === 0 ? 0.25 : 0), CRT: index * 13 + (seed % 4 === 0 ? 0.125 : 0) }), choices: [] }));
    const groups = Array.from({ length: 3 }, (_, group) => Array.from({ length: 4 }, (_, option) => ({
      stats: { STR: random(37), CRT: random(1700) + (seed % 4 === 0 ? 0.25 : 0),
        DET: random(1400), DHT: random(1300), TEN: random(500), PDMG: random(4) },
      choices: [{ id: group * 4 + option }],
    })));
    let combinations = prefix.map(point => point.stats);
    for (const group of groups) combinations = combinations.flatMap(point => group.map(option => add(point, option.stats)));
    const valid = combinations.map(point => foodStats(point, input.food)).filter(point =>
      solver.calculateTenacityMitigation(point.TEN, input.damage.level) + 1e-12 >= input.objective.minimumTenacityMitigation);
    assert.ok(valid.length > 0);
    if (seed % 3) {
      const minimum = Math.min(...valid.map(point => point.CRT));
      const maximum = Math.max(...valid.map(point => point.CRT));
      input.criticalPreference = seed % 3 === 1 ? 'high' : 'low';
      input.criticalRange = { minimum, maximum, midpoint: (minimum + maximum) / 2 };
    }
    const eligible = valid.filter(point => !input.criticalRange || (input.criticalPreference === 'high'
      ? point.CRT >= input.criticalRange.midpoint : point.CRT <= input.criticalRange.midpoint));
    const expected = Math.max(...eligible.map(point => solver.calculateExpectedDamage(point, input.damage)));
    const result = backend({ input, prefix: solver.testAttributeTree(prefix, 16),
      options: groups.map(group => solver.testAttributeTree(group, 1)), reference: combinations[0], minimumDamage: 0 }, () => {});
    assert.ok(result.complete);
    assert.ok(Math.abs(result.damage - expected) <= 1e-11, `raw-band seed ${seed}: ${result.damage} != ${expected}`);
  }
});


test('adjacent CRT bands leave no gaps for fractional custom stats', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes, 0, 0);
  const input = fixture(0);
  input.food = undefined;
  input.objective = { type: 'damage' };
  const stats = { ...input.fixedStats, CRT: input.fixedStats.CRT + 0.125 };
  const options = [
    { stats: { STR: 0, CRT: 0.5 }, choices: [{ id: 1 }] },
    { stats: { STR: 150, CRT: 63.75 }, choices: [{ id: 2 }] },
    { stats: { STR: 0, CRT: 128.5 }, choices: [{ id: 3 }] },
  ];
  const result = backend({ input, prefix: solver.testAttributeTree([{ stats, choices: [] }], 1),
    options: [solver.testAttributeTree(options, 1)], reference: stats, minimumDamage: 0 }, () => {});
  assert.ok(result.complete);
  assert.equal(result.options[0].choices[0].id, 2);
  assert.equal(result.damage, solver.calculateExpectedDamage({ ...stats, STR: stats.STR + 150,
    CRT: stats.CRT + 63.75 }, input.damage));
});
