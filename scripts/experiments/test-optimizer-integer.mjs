import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import loadHighs from 'highs';
import { compileOptimizerSupport } from './optimizer-integer-support.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ allowNegative: true, options: {
  count: { type: 'string', default: '900' }, output: { type: 'string' },
  preprocess: { type: 'string', default: 'baseline' },
  recovery: { type: 'boolean', default: false },
  'real-subsets': { type: 'string', default: '0' },
  'real-regression': { type: 'boolean', default: true },
} });
const count = Number(values.count);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid fixture count.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-integer-test-'));
try {
  const support = compileOptimizerSupport(root, { preprocess: values.preprocess });
  for (const [name, text] of Object.entries(support)) fs.writeFileSync(path.join(temporary, name + '.mjs'), text);
  fs.copyFileSync(new URL('./optimizer-integer-direct-groups.mjs', import.meta.url), path.join(temporary, 'direct-groups.mjs'));
  fs.copyFileSync(new URL('./optimizer-integer-model.mjs', import.meta.url), path.join(temporary, 'model.mjs'));
  fs.copyFileSync(new URL('./optimizer-integer-certified.mjs', import.meta.url), path.join(temporary, 'certified.mjs'));
  const source = fs.readFileSync(path.join(root, 'test/optimizerWasm.test.cjs'), 'utf8');
  const begin = source.indexOf('function fixture(seed)'); const end = source.indexOf('function compare(input');
  if (begin < 0 || end < begin) throw new Error('Review the shared WASM fixture adapter.');
  fs.writeFileSync(path.join(temporary, 'fixture.mjs'), source.slice(begin, end) + '\nexport { fixture };');
  const { fixture } = await import(pathToFileURL(path.join(temporary, 'fixture.mjs')));
  const referenceDirectory = path.join(temporary, 'reference');
  fs.mkdirSync(referenceDirectory);
  for (const [name, text] of Object.entries(compileOptimizerSupport(root))) {
    fs.writeFileSync(path.join(referenceDirectory, name + '.mjs'), text);
  }
  const { optimizeGearset, milpFood, milpEvaluate, milpGcd } = await import(pathToFileURL(path.join(referenceDirectory, 'optimizer.mjs')));
  const { milpMinimalPlan } = await import(pathToFileURL(path.join(temporary, 'optimizer.mjs')));
  const { build: legacyBuild } = await import(pathToFileURL(path.join(temporary, 'model.mjs')));
  const { buildIntegerObjective, solveIntegerObjective } = await import(pathToFileURL(path.join(temporary, 'certified.mjs')));
  const build = values.recovery ? buildIntegerObjective : legacyBuild;
  const highs = await loadHighs(); const started = performance.now();
  let orderingRegression, lowCriticalRegression, numericalRegression;
  if (values.recovery) {
    // A has lower rounded cost (0), but B has the better TRUE cost (.51 < .98).
    // Merely returning the first rounded optimum must fail this regression.
    const data = { numCols: 4, numRows: 3, colCost: [0, 1, 0, 0],
      colLower: [0, 0, 0, 0], colUpper: [1, 1, 1, 1], integrality: [1, 1, 1, 1],
      rowLower: [1, 1, 0], rowUpper: [1, 1, 0],
      matrix: { format: 'csc', numRows: 3, numCols: 4,
        starts: [0, 2, 3, 5, 6], indices: [0, 2, 0, 1, 2, 1], values: [1, 1, 1, 1, -1, 1] } };
    const exactCost = [.49, .51, .49, 0];
    const prepared = { data, exactCost, base: 1, scale: 1, error: 1.01, minimum: 0,
      ceiling: score => Math.ceil(-Math.log(score) + 1.01),
      costEntries: [[1, 1]], scoreGroups: [[0, 1], [2, 3]],
      reconstruct: solution => ({ damage: Math.exp(-solution.reduce((sum, value, j) => sum + value * exactCost[j], 0)) }),
    };
    const solved = solveIntegerObjective(highs, prepared);
    assert.ok(Math.abs(solved.result.damage - Math.exp(-.51)) < 1e-12);
    assert.equal(solved.recoveredOrdering, 1);
    const empty = solveIntegerObjective(highs, { ...prepared, minimum: Math.exp(-.51) + 1e-7 });
    assert.equal(empty.result, undefined);
    orderingRegression = { recoveredOrdering: solved.recoveredOrdering, passes: solved.passes, passed: true };
  }

  if (values.recovery) {
    const regression = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/integer-low-critical-dominance-regression.json')));
    const reference = optimizeGearset(regression.input);
    assert.ok(Math.abs(reference.damage - regression.expectedDamage) < 1e-10, 'low CRT reference changed');
    const prepared = build(regression.input);
    assert.ok(prepared.groups.some(group => group.options.some(option => option.choices.some(choice => choice.id === regression.requiredCandidateId))),
      'lower-CRT candidate was removed before integer modeling');
    const solved = solveIntegerObjective(highs, prepared, { timeLimit: 30 });
    assert.ok(solved.result && Math.abs(solved.result.damage - reference.damage) < 1e-10, 'low CRT dominance regression');
    lowCriticalRegression = { passed: true, damage: solved.result.damage, candidateId: regression.requiredCandidateId };
  }

  if (values.recovery) {
    const regression = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/integer-presolve-score-exclusion-regression.json')));
    let best = -Infinity;
    for (const food of regression.input.foods) {
      const input = { ...regression.input, food, foods: undefined };
      const solved = solveIntegerObjective(highs, build(input), { timeLimit: 30 });
      if (solved.result) best = Math.max(best, solved.result.score ?? solved.result.damage);
    }
    assert.ok(Math.abs(best - regression.expectedScore) < 1e-10, 'score exclusion presolve regression');
    numericalRegression = { passed: true, score: best };
  }

  let empty = 0; let withBound = 0; let recoveryPasses = 0; let recoveredOrdering = 0;
  const score = result => result.score ?? result.damage;
  for (let seed = 0; seed < count; seed++) {
    const input = fixture(seed);
    if (seed % 4 === 0) {
      input.slots.push(12);
      input.gears.push(...input.gears.slice(0, 3).map((gear, index) => ({
        ...gear, id: 1001 + index, slot: 12, unique: index !== 2, materiaSlots: [], stats: { ...gear.stats },
      })));
    }
    if (seed % 10 === 0) input.food = undefined;
    if (seed % 7 === 0) for (const gear of input.gears.filter(item => item.slot === 3)) {
      gear.materiaSlots = [{ grade: 10, value: 36 }, { grade: 9, value: 12 }];
      for (const stat of input.materiaStats) gear.caps[stat] = (gear.stats[stat] ?? 0) + 5 + seed % 29;
    }
    if (seed % 17 === 0) input.targetSpeedContribution = seed % 3 * 25;
    input.criticalPreference = ['none', 'high', 'low'][seed % 3];
    if (input.damage.job === 'WAR' && seed % 8 === 4) {
      input.objective = { type: 'tenacityTradeoff', mitigationPointsPerDamagePercent: 0.1 };
    }
    if (input.damage.job === 'BLU' && seed < 64) input.gears.forEach((gear, index) => { gear.stats.MDMG = index % 3; });
    let expected;
    try { expected = optimizeGearset(input); } catch (error) {
      if (!error.message.includes('没有找到')) throw error;
    }
    try {
      const plan = milpMinimalPlan(input);
      assert.equal(plan.partitions.length, (input.foods?.length || 1));
      assert.equal(plan.heuristicResult.empty, true);
      assert.equal(plan.heuristicResult.damage, 0);
      if (expected) assert.deepEqual(plan.criticalRange, expected.criticalRange);
    } catch (error) {
      if (expected || !error.message.includes('没有找到')) throw error;
    }
    if (expected?.criticalRange) input.criticalRange = expected.criticalRange;
    let infeasible = expected === undefined;
    if (expected && seed % 5 === 0) { input.globalMinimumDamage = score(expected) * 0.999;withBound++; }
    if (expected && seed % 13 === 0) { input.globalMinimumDamage = score(expected) + 1e-7;infeasible = true;withBound++; }
    const prepared = build(input);
    if (!prepared) { assert.ok(infeasible, 'unexpected empty model ' + seed);empty++;continue; }
    const model = values.recovery ? undefined : highs.createModel(prepared.data);
    try {
      let actual;
      if (values.recovery) {
        const solved = solveIntegerObjective(highs, prepared, { timeLimit: 10 });
        recoveryPasses += solved.passes;recoveredOrdering += solved.recoveredOrdering;
        if (infeasible) { assert.equal(solved.result, undefined, 'seed ' + seed);empty++;continue; }
        assert.ok(solved.result, 'Unexpected empty seed ' + seed);actual = solved.result;
      } else {
      model.options.set({ output_flag: false, time_limit: 10, mip_rel_gap: 0, mip_abs_gap: 0,
        mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9, dual_feasibility_tolerance: 1e-9 });
      model.run();
      if (infeasible) { assert.equal(model.getModelStatus(), highs.constants.modelStatus.infeasible, 'seed ' + seed);empty++;continue; }
      assert.equal(model.getModelStatus(), highs.constants.modelStatus.optimal, 'unfinished seed ' + seed);
      actual = prepared.reconstruct(model.getSolution().colValue);
      }
      assert.ok(Math.abs(score(actual) - score(expected)) < 1e-10, JSON.stringify({ seed, expected: score(expected), actual: score(actual) }));
      // Independently reconstruct the submitted gear rather than trusting solver variables.
      const raw = { ...input.fixedStats }; const seen = new Set(); const actualSlots = new Map();
      for (const choice of actual.gears) {
        const gear = input.gears.find(item => item.id === choice.id && item.slot === choice.slot);
        assert.ok(gear, 'unknown gear');
        if (gear.unique) { assert.ok(!seen.has(gear.id), 'duplicate unique gear');seen.add(gear.id); }
        actualSlots.set(gear.slot, (actualSlots.get(gear.slot) ?? 0) + 1);
        const part = { ...gear.stats }; const meldSlots = new Set();
        for (const meld of choice.melds) {
          assert.ok(!gear.synced && !meldSlots.has(meld.slot));meldSlots.add(meld.slot);
          const slot = gear.materiaSlots[meld.slot];
          assert.ok(slot && slot.grade === meld.grade && slot.value === meld.value);
          assert.ok(input.materiaStats.includes(meld.stat));
          const before = part[meld.stat] ?? 0;
          part[meld.stat] = Math.min(before + meld.value, Math.max(before, gear.caps[meld.stat] ?? Infinity));
        }
        for (const [stat, value] of Object.entries(part)) raw[stat] = (raw[stat] ?? 0) + value;
      }
      for (const slot of input.slots) assert.equal(actualSlots.get(slot), slot === 12 ? 2 : 1);
      const stats = milpFood(raw, input.food);
      assert.deepEqual(actual.stats, stats);
      assert.ok(Math.abs(milpEvaluate(stats, input).damage - score(actual)) < 1e-10);
      if (input.targetSpeedContribution !== undefined) assert.equal(raw[input.speedStat],
        (input.fixedStats[input.speedStat] ?? 0) + input.targetSpeedContribution);
    } finally { model?.dispose(); }
  }
  let realSubsets = 0;
  if (values.recovery) {
    const subsetCount = Number(values['real-subsets']);
    assert.ok(Number.isSafeInteger(subsetCount) && subsetCount >= 0);
    let randomSeed = 71234651;
    const random = () => { randomSeed ^= randomSeed << 13;randomSeed ^= randomSeed >>> 17;randomSeed ^= randomSeed << 5;return (randomSeed >>> 0) / 2 ** 32; };
    const names = ['paladin-605-minimum-10-gcd-245.json', 'warrior-375-minimum-15-gcd-248.json',
      'pictomancer-375-phantom-input.json', 'monk-605-phantom-input.json'];
    for (let sample = 0; sample < subsetCount; sample++) {
      const input = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures', names[sample % names.length])));
      input.lockedGearIds = [];input.lockedGears = [];input.excludedGearIds = [];
      delete input.globalMinimumDamage;delete input.criticalRange;delete input.targetSpeedContribution;
      input.food = sample % 5 === 0 ? undefined : input.foods[Math.floor(random() * input.foods.length)];
      input.foods = undefined;
      // Restrict to one legal materia stat so independent JS enumeration of
      // 11 real slots stays tractable. Candidate gear stats/caps remain real.
      input.materiaStats = [input.materiaStats[Math.floor(random() * input.materiaStats.length)]];
      const gears = [], chosen = [];
      for (const slot of input.slots) {
        const pool = input.gears.filter(gear => gear.slot === slot);
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));[pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const selected = pool.slice(0, slot === 12 ? 4 : 3);
        gears.push(...selected);chosen.push(selected[0]);
        if (slot === 12) { assert.ok(selected.length >= 2);chosen.push(selected[1]); }
      }
      input.gears = gears;
      const raw = { ...input.fixedStats }, stat = input.materiaStats[0];
      for (const gear of chosen) {
        const part = { ...gear.stats };
        for (const materia of gear.materiaSlots) {
          const before = part[stat] ?? 0;
          part[stat] = Math.min(before + materia.value, Math.max(before, gear.caps[stat] ?? Infinity));
        }
        for (const [key, value] of Object.entries(part)) raw[key] = (raw[key] ?? 0) + value;
      }
      const stats = milpFood(raw, input.food);
      input.targetGcd = milpGcd(stats[input.speedStat] ?? 0, input) / 100;
      const mitigation = Math.trunc(200 * ((stats.TEN ?? input.damage.level.sub) - input.damage.level.sub) / input.damage.level.div + 1e-7) / 1000;
      input.objective = input.damage.mainStat !== 'VIT' ? { type: 'damage' }
        : sample % 3 === 0 ? { type: 'tenacityTradeoff', mitigationPointsPerDamagePercent: 0.1 + random() * 10 }
          : { type: 'minimumTenacity', minimumTenacityMitigation: Math.max(0, mitigation * [0, 0.5, 0.9][sample % 3]) };
      input.criticalPreference = ['none', 'high', 'low'][sample % 3];
      const expected = optimizeGearset(input);
      if (expected.criticalRange) input.criticalRange = expected.criticalRange;
      const solved = solveIntegerObjective(highs, build(input), { timeLimit: 30 });
      if ((!solved.result || Math.abs(score(solved.result) - score(expected)) >= 1e-10) && values.output)
        fs.writeFileSync(values.output + '.failure.json', JSON.stringify({ sample, input, expected, solved }, null, 2) + '\n');
      assert.ok(solved.result && Math.abs(score(solved.result) - score(expected)) < 1e-10,
        JSON.stringify({ sample, fixture: names[sample % 4], gcd: input.targetGcd, objective: input.objective, expected: score(expected), actual: solved.result && score(solved.result) }));
      recoveryPasses += solved.passes;recoveredOrdering += solved.recoveredOrdering;realSubsets++;
    }
  }
  let realRegression;
  if (values['real-regression']) {
    const input = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/monk-605-phantom-input.json')));
    input.targetGcd = 1.93;input.criticalPreference = 'none';
    input.food = input.foods.find(food => food.id === 49245);input.foods = undefined;
    input.globalMinimumDamage = 27.06995332364717;
    const prepared = build(input);
    const model = values.recovery ? undefined : highs.createModel(prepared.data);
    try {
      let result;
      if (values.recovery) {
        const solved = solveIntegerObjective(highs, prepared, { timeLimit: 180 });
        recoveryPasses += solved.passes;recoveredOrdering += solved.recoveredOrdering;result = solved.result;
      } else {
      model.options.set({ output_flag: false, time_limit: 180, mip_rel_gap: 0, mip_abs_gap: 0,
        mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9, dual_feasibility_tolerance: 1e-9 });
      model.run();assert.equal(model.getModelStatus(), highs.constants.modelStatus.optimal);
      result = prepared.reconstruct(model.getSolution().colValue);
      }
      assert.ok(Math.abs(result.damage - 27.16929816050764) < 1e-10,
        'Full MNK 1.93 regression: Optimal status must not accept the inferior 27.161766661934365');
      realRegression = { case: 'MNK605-GCD1.93-food49245', damage: result.damage, status: 'passed' };
    } finally { model?.dispose(); }
  }
  const report = { knownBrowserRegression: values.recovery ? 'recovery prototype; browser checks required' : 'unresolved; Node checks are not an adoption certificate', recovery: values.recovery, recoveryPasses, recoveredOrdering, orderingRegression, lowCriticalRegression, numericalRegression, realSubsets, preprocess: values.preprocess, realRegression, tested: count, empty, withBound, seconds: (performance.now() - started) / 1000 };
  if (values.output) fs.writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
