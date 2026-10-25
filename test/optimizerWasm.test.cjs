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
  .replace('const maximumContractionProduct = 250_000;', 'const maximumContractionProduct = 0;') + '\nexport const testPareto = paretoFrontier;');
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
  const backend = await adapter.createWasmSearchBackend(bytes);
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
  const backend = await adapter.createWasmSearchBackend(bytes);
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
  const backend = await adapter.createWasmSearchBackend(bytes);
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

test('bounded pair warm starts preserve the exact optimum', async () => {
  const backend = await adapter.createWasmSearchBackend(bytes);
  backend.warmStartMinimumWork = 0;
  for (let seed = 0; seed < 40; seed++) compare(fixture(seed), backend);
});
