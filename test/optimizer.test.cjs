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
  optimizeNoSpeedGearset,
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

function gear(id, name, level, slot, stats, cap, materiaSlot) {
  return {
    id,
    name,
    level,
    slot,
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
    materiaStats: ['CRT', 'DET', 'DHT'],
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
  const result = optimizeNoSpeedGearset(input);

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

test('swapped slot attributes collapse into one accumulated state', () => {
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
    stats: { STR: 1, CRT: crt, DET: det, DHT: 0, PDMG: 1 },
    caps: {},
    materiaSlots: [],
    synced: false,
  });
  const progress = [];
  optimizeNoSpeedGearset({
    syncLevel: 1,
    fixedStats: {},
    gears: [make(1, 4, 5, 10), make(2, 4, 10, 5), make(3, 7, 5, 10), make(4, 7, 10, 5)],
    slots: [4, 7],
    lockedGearIds: [],
    materiaStats: ['CRT', 'DET', 'DHT'],
    damage: simpleDamage,
  }, value => progress.push(value));

  assert.equal(progress[1].states, 3);
});

test('locking a gear ID restricts that slot without preserving old melds', () => {
  const result = optimizeNoSpeedGearset({
    syncLevel: 1,
    fixedStats: { STR: 100, CRT: 100, DET: 100, DHT: 100, PDMG: 1 },
    gears: [
      gear(1, 'locked', 1, 3, { STR: 1, CRT: 1 }, 10, 0),
      gear(2, 'better', 1, 3, { STR: 10, CRT: 10 }, 10, 0),
    ],
    slots: [3],
    lockedGearIds: [1],
    materiaStats: ['CRT', 'DET', 'DHT'],
    damage: {
      ...damage,
      level: { ...damage.level, main: 1, sub: 1 },
    },
  });
  assert.equal(result.gears[0].id, 1);
});
