const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const statFormulaSource = fs.readFileSync(require.resolve('../src/statFormulas.ts'), 'utf8');
const statFormulaCompiled = ts.transpileModule(statFormulaSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const statFormulas = {};
vm.runInNewContext(statFormulaCompiled, {
  exports: statFormulas,
  module: { exports: statFormulas },
});

const source = fs.readFileSync(require.resolve('../src/optimizer.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const optimizer = {};
vm.runInNewContext(compiled, {
  exports: optimizer,
  module: { exports: optimizer },
  require: request => request === './statFormulas' ? statFormulas : require(request),
});

const {
  calculateExpectedDamage,
  calculateTenacityMitigation,
  findTargetSpeedContributions,
  optimizeGearset,
  planGearOptimization,
} = optimizer;

const damage = {
  job: 'DRG',
  jobLevel: 100,
  mainStat: 'STR',
  statModifiers: { STR: 115, VIT: 105, hp: 115 },
  traitDamageMultiplier: 1,
  level: {
    main: 440,
    sub: 420,
    div: 2780,
    det: 2780,
    detTrunc: 1,
    ap: 237,
    apTank: 190,
  },
  baseStats: { STR: 508, CRT: 420, DET: 440, DHT: 420 },
  bluMdmgAdditions: [],
};

function gear(id, name, level, slot, stats, cap, materiaSlot, unique = true) {
  return {
    id,
    name,
    level,
    slot,
    unique,
    stats,
    caps: { CRT: cap, DET: cap, DHT: cap },
    materiaSlots: Array.from({ length: materiaSlot }, () => ({ grade: 12, value: 54 })),
    synced: false,
  };
}

const tankDamage = {
  ...damage,
  job: 'PLD',
  mainStat: 'VIT',
};

function tenacityInput(objective) {
  return {
    syncLevel: 1,
    fixedStats: {
      STR: 2000, VIT: 2000, CRT: 420, DET: 440, DHT: 420, TEN: 420, SKS: 420, PDMG: 100,
    },
    gears: [
      gear(1, 'damage', 1, 3, { STR: 10, VIT: 10, DHT: 500 }, 1000, 0),
      gear(2, 'mitigation', 1, 3, { STR: 10, VIT: 10, TEN: 280 }, 1000, 0),
    ],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'TEN', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    objective,
    damage: tankDamage,
  };
}

test('minimum tenacity mitigation is an exact hard constraint', () => {
  const unconstrained = optimizeGearset(tenacityInput({ type: 'damage' }));
  const zeroMinimum = optimizeGearset(tenacityInput({
    type: 'minimumTenacity',
    minimumTenacityMitigation: 0,
  }));
  const constrained = optimizeGearset(tenacityInput({
    type: 'minimumTenacity',
    minimumTenacityMitigation: 0.02,
  }));

  assert.equal(unconstrained.gears[0].id, 1);
  assert.equal(zeroMinimum.damage, unconstrained.damage);
  assert.equal(zeroMinimum.gears[0].id, unconstrained.gears[0].id);
  assert.equal(constrained.gears[0].id, 2);
  assert.equal(constrained.tenacityMitigation, 0.02);
  assert.equal(calculateTenacityMitigation(constrained.stats.TEN, tankDamage.level), 0.02);
  assert.ok(constrained.damage < unconstrained.damage);
});

test('unreachable minimum tenacity mitigation is rejected during planning', () => {
  assert.throws(() => planGearOptimization(tenacityInput({
    type: 'minimumTenacity',
    minimumTenacityMitigation: 0.03,
  })), /坚韧减伤不低于 3\.0%/);
});

test('minimum tenacity mitigation matches exhaustive multi-slot enumeration', () => {
  const slots = [3, 4, 5, 7];
  const choices = [
    { DHT: 220, TEN: 0 },
    { CRT: 150, TEN: 100 },
    { DET: 100, TEN: 220 },
  ];
  const gears = slots.flatMap((slot, slotIndex) => choices.map((stats, optionIndex) =>
    gear(100 + slotIndex * 3 + optionIndex, `${slotIndex}-${optionIndex}`, 1, slot,
      { STR: 10, VIT: 10, ...stats }, 1000, 0)));
  const fixedStats = {
    STR: 2000, VIT: 2000, CRT: 420, DET: 440, DHT: 420, TEN: 420, SKS: 420, PDMG: 100,
  };
  const baseInput = {
    syncLevel: 1,
    fixedStats,
    gears,
    slots,
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'TEN', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage: tankDamage,
  };
  let totals = [{ ...fixedStats }];
  for (const slot of slots) {
    totals = totals.flatMap(stats => gears.filter(item => item.slot === slot).map(item => {
      const combined = { ...stats };
      for (const [stat, value] of Object.entries(item.stats)) {
        combined[stat] = (combined[stat] ?? 0) + value;
      }
      return combined;
    }));
  }
  const evaluated = totals.map(stats => ({
    stats,
    damage: calculateExpectedDamage(stats, tankDamage),
    tenacityMitigation: calculateTenacityMitigation(stats.TEN, tankDamage.level),
  }));
  const minimumTenacityMitigation = 0.03;
  const constrainedExpected = Math.max(...evaluated
    .filter(item => item.tenacityMitigation >= minimumTenacityMitigation)
    .map(item => item.damage));
  const constrained = optimizeGearset({
    ...baseInput,
    objective: { type: 'minimumTenacity', minimumTenacityMitigation },
  });
  assert.equal(constrained.damage, constrainedExpected);
});

test('minimum tenacity mitigation filters exact GCD speed partitions', () => {
  const input = {
    syncLevel: 1,
    fixedStats: {
      STR: 2000, VIT: 2000, CRT: 420, DET: 440, DHT: 420, TEN: 420, SKS: 420, PDMG: 100,
    },
    gears: [
      gear(1, 'head damage', 1, 3, { STR: 10, VIT: 10, DHT: 300, SKS: 22 }, 1000, 0),
      gear(2, 'head tenacity', 1, 3, { STR: 10, VIT: 10, TEN: 140, SKS: 60 }, 1000, 0),
      gear(3, 'body damage', 1, 4, { STR: 10, VIT: 10, DHT: 300 }, 1000, 0),
      gear(4, 'body tenacity', 1, 4, { STR: 10, VIT: 10, TEN: 140, SKS: 40 }, 1000, 0),
    ],
    slots: [3, 4],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'TEN', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.49,
    objective: { type: 'minimumTenacity', minimumTenacityMitigation: 0.02 },
    damage: tankDamage,
  };

  const plan = planGearOptimization(input);
  const result = optimizeGearset(input);
  assert.equal(plan.partitions.map(partition => partition.contribution).join(','), '100');
  assert.equal(result.gears.map(item => item.id).sort().join(','), '2,4');
  assert.equal(result.tenacityMitigation, 0.02);
});

test('735 DRG share case is improved with the configured weapon and food', () => {
  const input = {
    syncLevel: 735,
    // Level-100 DRG base stats plus the synced il795 Phantasmal Spear.
    fixedStats: { STR: 1136, CRT: 813, DET: 833, DHT: 528, SKS: 420, PDMG: 146 },
    gears: [
      gear(44610, '黯云制敌头盔', 730, 3, { STR: 371, CRT: 236, DET: 165 }, 236, 2),
      gear(47114, '雾忆制敌战铠', 735, 4, { STR: 605, DHT: 379, CRT: 265 }, 379, 2),
      gear(47115, '雾忆制敌臂甲', 735, 5, { STR: 381, DHT: 167, DET: 239 }, 239, 2),
      gear(47116, '雾忆制敌束膝裤', 735, 7, { STR: 605, DHT: 379, CRT: 265 }, 379, 2),
      gear(43132, '黑马冠军制敌胫甲', 730, 8, { STR: 371, CRT: 236, DET: 165 }, 236, 2),
      gear(47144, '雾忆强攻耳坠', 735, 9, { STR: 300, CRT: 188, DET: 132 }, 188, 1),
      gear(43087, '改良型绿咬鹃强攻项链', 730, 10, { STR: 292, DHT: 130, CRT: 186 }, 186, 2),
      gear(43169, '黑马冠军强攻手镯', 730, 11, { STR: 292, DHT: 130, CRT: 186 }, 186, 2),
      gear(43097, '改良型绿咬鹃强攻戒指', 730, 12, { STR: 292, DHT: 186, DET: 130 }, 186, 2),
      gear(43174, '黑马冠军强攻指环', 730, 12, { STR: 292, CRT: 130, DET: 186 }, 186, 2),
      gear(47159, '雾忆强攻戒指', 735, 12, { STR: 300, CRT: 188, DET: 132 }, 188, 1),
    ],
    slots: [3, 4, 5, 7, 8, 9, 10, 11, 12],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    food: {
      id: 49240,
      name: '焦糖爆米花',
      stats: { DET: 151, VIT: 297, CRT: 91 },
      statRates: { DET: 10, VIT: 10, CRT: 10 },
  },
    damage,
  };

  const baselineDamage = calculateExpectedDamage({
    STR: 4937,
    CRT: 3082,
    DET: 2217,
    DHT: 2223,
    SKS: 420,
    PDMG: 146,
  }, damage);
  const result = optimizeGearset(input);

  assert.equal(baselineDamage.toFixed(5), '70.47624');
  assert.ok(result.damage > baselineDamage);
  assert.equal(result.damage.toFixed(5), '70.54110');
  assert.equal(result.stats.STR, 4945);
  assert.equal(result.stats.CRT, 3162);
  assert.equal(result.stats.DET, 2327);
  assert.equal(result.stats.DHT, 1983);
  assert.equal(result.stats.SKS, 420);
  assert.equal(result.gears.filter(item => item.slot === 12).map(item => item.id).sort().join(','), '43174,47159');
});

test('swapped slot attributes contract before the main search', () => {
  const simpleDamage = {
    ...damage,
    level: { ...damage.level, main: 0, sub: 0 },
    statModifiers: { STR: 100 },
  };
  const make = (id, slot, crt, det) => ({
    id,
    name: String(id),
    level: 1,
    slot,
    unique: true,
    stats: { STR: 1, CRT: crt, DET: det, DHT: 0, PDMG: 1 },
    caps: {},
    materiaSlots: [],
    synced: false,
  });
  const progress = [];
  optimizeGearset({
    syncLevel: 1,
    fixedStats: {},
    gears: [
      make(1, 4, 5, 10), make(2, 4, 10, 5),
      make(3, 7, 5, 10), make(4, 7, 10, 5),
      make(5, 8, 5, 10), make(6, 8, 10, 5),
    ],
    slots: [4, 7, 8],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage: simpleDamage,
  }, value => progress.push(value));

  assert.equal(progress.length, 1);
  assert.equal(progress[0].totalGroups, 1);
});

test('locking a gear ID restricts that slot without preserving old melds', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 100, CRT: 100, DET: 100, DHT: 100, PDMG: 1 },
    gears: [
      gear(1, 'locked', 1, 3, { STR: 1, CRT: 1 }, 10, 0),
      gear(2, 'better', 1, 3, { STR: 10, CRT: 10 }, 10, 0),
    ],
    slots: [3],
    lockedGearIds: [1],
    materiaStats: ['CRT', 'DET', 'DHT'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage: {
      ...damage,
      level: { ...damage.level, main: 1, sub: 1 },
    },
  });
  assert.equal(result.gears[0].id, 1);
});

test('target GCD is an exact constraint and can be reached with speed materia', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'speed meld', 1, 3, { STR: 1, SKS: 20 }, 1000, 1)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.49,
    damage,
  });

  assert.equal(result.stats.SKS, 494);
  assert.equal(result.gears[0].melds[0].stat, 'SKS');
});

test('different speed values in the same target GCD tier remain eligible', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [
      gear(1, 'base speed', 1, 3, { STR: 1 }, 1000, 0),
      gear(2, 'same GCD tier', 1, 3, { STR: 10, SKS: 10 }, 1000, 0),
    ],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage,
  });

  assert.equal(result.gears[0].id, 2);
  assert.equal(result.stats.SKS, 430);
});

test('target GCD calculation includes the job GCD modifier', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'fixed', 1, 3, { STR: 1 }, 1000, 0)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.00,
    damage: {
      ...damage,
      statModifiers: { ...damage.statModifiers, gcd: 80 },
    },
  });

  assert.equal(result.stats.SKS, 420);
});

test('low critical hit does not force critical hit materia', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'one meld', 1, 3, {}, 1000, 1)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage,
  });

  assert.equal(result.gears[0].melds[0].stat, 'DHT');
});

test('speed food is included in the exact final GCD constraint', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'food speed', 1, 3, { SKS: 20 }, 1000, 0)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.49,
    food: {
      id: 1,
      name: 'speed food',
      stats: { SKS: 10 },
      statRates: { SKS: 10 },
    },
    damage,
  });

  assert.equal(result.stats.SKS, 450);
});

test('globally impossible speed options are removed before the search', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [
      gear(1, 'zero speed head', 1, 3, { CRT: 10 }, 1000, 0),
      gear(2, 'speed head', 1, 3, { DET: 10, SKS: 74 }, 1000, 0),
      gear(3, 'zero speed body', 1, 4, { DHT: 10 }, 1000, 0),
      gear(4, 'speed body', 1, 4, { CRT: 10, SKS: 74 }, 1000, 0),
    ],
    slots: [3, 4],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage,
  });

  assert.equal(result.gears.map(item => item.id).sort().join(','), '1,3');
  assert.ok(result.exploredStates <= 2);
});

test('an unreachable exact target GCD reports no solution', () => {
  assert.throws(() => optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'fixed speed', 1, 3, { SKS: 20 }, 1000, 0)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.48,
    damage,
  }), /2\.48/);
});

test('speed-only planning rejects unreachable speed sums before attribute search', () => {
  let progressCalls = 0;
  assert.throws(() => optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [3, 4, 5].flatMap(slot => [
      gear(slot * 10, `zero speed ${slot}`, 1, slot, { CRT: 10 }, 1000, 0),
      gear(slot * 10 + 1, `high speed ${slot}`, 1, slot, { DET: 10, SKS: 100 }, 1000, 0),
    ]),
    slots: [3, 4, 5],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.48,
    damage,
  }, () => progressCalls++), /2\.48/);

  assert.equal(progressCalls, 0);
});

test('exact speed partitions cover the complete target GCD search', () => {
  const input = {
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [3, 4, 5].flatMap((slot, groupIndex) => [0, 20, 40].map((speed, optionIndex) =>
      gear(slot * 100 + optionIndex, `${slot}-${speed}`, 1, slot, {
        STR: optionIndex + 1,
        CRT: groupIndex * 7 + optionIndex * 5,
        DET: groupIndex * 3 + optionIndex * 11,
        DHT: groupIndex * 13 + optionIndex * 2,
        SKS: speed,
      }, 1000, 0))),
    slots: [3, 4, 5],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.49,
    damage,
  };
  const contributions = findTargetSpeedContributions(input);
  const complete = optimizeGearset(input);
  const partitioned = contributions.map(targetSpeedContribution =>
    optimizeGearset({ ...input, targetSpeedContribution }));

  assert.equal(contributions.join(','), '40,60,80,100');
  assert.equal(Math.max(...partitioned.map(result => result.damage)), complete.damage);

  const plan = planGearOptimization(input);
  const bounded = plan.partitions.map(partition => optimizeGearset({
    ...input,
    targetSpeedContribution: partition.contribution,
    globalMinimumDamage: plan.heuristicResult.damage,
  }));
  assert.equal(Math.max(plan.heuristicResult.damage, ...bounded.map(result => result.damage)),
    complete.damage);
});

test('equivalent synced rings collapse before distinct-ID pairing', () => {
  const equivalentRings = Array.from({ length: 200 }, (_, index) => ({
    ...gear(1000 + index, `synced ring ${index}`, 795, 12,
      { STR: 100, CRT: 80, DET: 50 }, 80 + index, 0),
    synced: true,
  }));
  const result = optimizeGearset({
    syncLevel: 630,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: equivalentRings,
    slots: [12],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage,
  });

  assert.equal(result.gears.length, 2);
  assert.notEqual(result.gears[0].id, result.gears[1].id);
  assert.ok(result.exploredStates <= 1);
});

test('a repeatable ring can occupy both slots with independent melds', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'repeatable', 1, 12, {}, 1000, 1, false)],
    slots: [12],
    lockedGearIds: [1, 1],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.49,
    damage,
  });

  assert.equal(result.gears.length, 2);
  assert.equal(result.gears.map(item => item.id).join(','), '1,1');
  assert.equal(result.gears.map(item => item.melds[0].stat).sort().join(','), 'DHT,SKS');
});

test('a unique ring cannot occupy both slots', () => {
  assert.throws(() => optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'unique', 1, 12, {}, 1000, 0, true)],
    slots: [12],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage,
  }), /唯一品/);
});

test('generated gear data distinguishes unique and repeatable rings', () => {
  const gearModule = { exports: undefined };
  const gearSource = fs.readFileSync(require.resolve('../data/out/gears-recent.js'), 'utf8')
    .replace(/^export default /, 'module.exports = ');
  vm.runInNewContext(gearSource, { module: gearModule });
  const recentGears = gearModule.exports;

  assert.equal(recentGears.find(item => item.id === 50965).unique, true);
  assert.equal(recentGears.find(item => item.id === 51182).unique, undefined);
});

test('cumulative state pruning does not exceed the component-wise dominance frontier', () => {
  const groups = [
    [[5, 10, 1], [0, 7, 10]],
    [[6, 7, 2], [1, 9, 7]],
    [[9, 2, 9], [9, 3, 2]],
    [[4, 7, 6], [5, 3, 4]],
  ];
  const gears = [gear(1, 'fixed', 1, 3, {}, 1000, 0)];
  groups.forEach((options, groupIndex) => options.forEach((stats, optionIndex) => {
    gears.push(gear(10 + groupIndex * 2 + optionIndex, `${groupIndex}-${optionIndex}`,
      1, [4, 5, 7, 8][groupIndex],
      { CRT: stats[0], DET: stats[1], DHT: stats[2] }, 1000, 0));
  }));
  const progress = [];
  optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears,
    slots: [3, 4, 5, 7, 8],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage,
  }, value => progress.push(value));

  assert.ok(progress[3].states <= 7);
});

test('dual-tree final search matches exhaustive enumeration', () => {
  const slots = [3, 4, 5, 7, 8];
  const gears = slots.flatMap((slot, groupIndex) => Array.from({ length: 4 }, (_, optionIndex) =>
    gear(100 + groupIndex * 4 + optionIndex, `${groupIndex}-${optionIndex}`, 1, slot, {
      STR: 10 + (groupIndex * 7 + optionIndex * 3) % 9,
      CRT: (groupIndex * 11 + optionIndex * 17) % 31,
      DET: (groupIndex * 19 + optionIndex * 7) % 29,
      DHT: (groupIndex * 13 + optionIndex * 23) % 37,
      SKS: (groupIndex * 5 + optionIndex * 11) % 31,
    }, 1000, 0)));
  const fixedStats = { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 };
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats,
    gears,
    slots,
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.49,
    damage,
  });

  let combinations = [{ ...fixedStats }];
  for (const slot of slots) {
    combinations = combinations.flatMap(stats => gears.filter(item => item.slot === slot).map(item => {
      const combined = { ...stats };
      for (const [stat, value] of Object.entries(item.stats)) {
        combined[stat] = (combined[stat] ?? 0) + value;
      }
      return combined;
    }));
  }
  const matchingCombinations = combinations.filter(stats => {
    const speedReduction = Math.trunc(130 * (stats.SKS - damage.level.sub) / damage.level.div);
    const gcdMilliseconds = Math.trunc((1000 - speedReduction) * 2500 / 1000);
    return Math.trunc(gcdMilliseconds * 100 / 1000) / 100 === 2.49;
  });
  const exhaustiveDamage = Math.max(...matchingCombinations.map(stats =>
    calculateExpectedDamage(stats, damage)));
  assert.equal(result.damage, exhaustiveDamage);
});

test('same-speed candidates dominated in every damage stat are removed', () => {
  const result = optimizeGearset({
    syncLevel: 630,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [
      gear(1, 'dominated', 630, 3, { STR: 90, CRT: 70, DET: 40 }, 100, 0),
      gear(2, 'dominant', 630, 3, { STR: 100, CRT: 80, DET: 50 }, 100, 0),
    ],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetGcd: 2.50,
    damage,
  });

  assert.equal(result.gears[0].id, 2);
  assert.ok(result.exploredStates <= 1);
});
