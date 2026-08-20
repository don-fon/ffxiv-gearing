const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/optimizer.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const optimizer = {};
vm.runInNewContext(compiled, { exports: optimizer, module: { exports: optimizer } });

const {
  calculateExpectedDamage,
  optimizeGearset,
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
    targetSpeed: 420,
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
    targetSpeed: 0,
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
    targetSpeed: 0,
    damage: {
      ...damage,
      level: { ...damage.level, main: 1, sub: 1 },
    },
  });
  assert.equal(result.gears[0].id, 1);
});

test('target speed is an exact constraint and can be reached with speed materia', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'speed meld', 1, 3, { STR: 1, SKS: 20 }, 1000, 1)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetSpeed: 494,
    damage,
  });

  assert.equal(result.stats.SKS, 494);
  assert.equal(result.gears[0].melds[0].stat, 'SKS');
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
    targetSpeed: 420,
    damage,
  });

  assert.equal(result.gears[0].melds[0].stat, 'DHT');
});

test('speed food is included in the exact final speed constraint', () => {
  const result = optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'food speed', 1, 3, { SKS: 20 }, 1000, 0)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetSpeed: 450,
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
      gear(2, 'speed head', 1, 3, { DET: 10, SKS: 1 }, 1000, 0),
      gear(3, 'zero speed body', 1, 4, { DHT: 10 }, 1000, 0),
      gear(4, 'speed body', 1, 4, { CRT: 10, SKS: 1 }, 1000, 0),
    ],
    slots: [3, 4],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetSpeed: 420,
    damage,
  });

  assert.equal(result.gears.map(item => item.id).sort().join(','), '1,3');
  assert.equal(result.exploredStates, 2);
});

test('an unreachable exact target speed reports no solution', () => {
  assert.throws(() => optimizeGearset({
    syncLevel: 1,
    fixedStats: { STR: 2000, CRT: 420, DET: 440, DHT: 420, SKS: 420, PDMG: 100 },
    gears: [gear(1, 'fixed speed', 1, 3, { SKS: 20 }, 1000, 0)],
    slots: [3],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT', 'SKS'],
    speedStat: 'SKS',
    targetSpeed: 441,
    damage,
  }), /441/);
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
    targetSpeed: 420,
    damage,
  });

  assert.equal(result.gears.length, 2);
  assert.notEqual(result.gears[0].id, result.gears[1].id);
  assert.equal(result.exploredStates, 1);
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
    targetSpeed: 474,
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
    targetSpeed: 420,
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

test('cumulative states are pruned only after component-wise dominance becomes provable', () => {
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
    targetSpeed: 420,
    damage,
  }, value => progress.push(value));

  assert.equal(progress[3].states, 7);
});

test('dual-tree final search matches exhaustive enumeration', () => {
  const slots = [3, 4, 5, 7, 8];
  const gears = slots.flatMap((slot, groupIndex) => Array.from({ length: 4 }, (_, optionIndex) =>
    gear(100 + groupIndex * 4 + optionIndex, `${groupIndex}-${optionIndex}`, 1, slot, {
      STR: 10 + (groupIndex * 7 + optionIndex * 3) % 9,
      CRT: (groupIndex * 11 + optionIndex * 17) % 31,
      DET: (groupIndex * 19 + optionIndex * 7) % 29,
      DHT: (groupIndex * 13 + optionIndex * 23) % 37,
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
    targetSpeed: 420,
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
  const exhaustiveDamage = Math.max(...combinations.map(stats => calculateExpectedDamage(stats, damage)));
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
    targetSpeed: 420,
    damage,
  });

  assert.equal(result.gears[0].id, 2);
  assert.equal(result.exploredStates, 1);
});
