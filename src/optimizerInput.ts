import * as G from './game';
import { gearDataOrdered } from './stores';
import type { IFood, IGear, IStore } from './stores';
import type {
  GearOptimizationInput,
  OptimizerFood,
  OptimizerGear,
  OptimizerMateriaStat,
  OptimizerStat,
  OptimizerStats,
} from './optimizer';

const damageSecondaryStats: OptimizerMateriaStat[] = ['CRT', 'DET', 'DHT', 'TEN'];

function concretizeStat(store: IStore, stat: G.Stat): OptimizerStat {
  if (stat === 'main') return store.schema.mainStat!;
  if (stat === 'secondary') return store.schema.secondaryStat! as OptimizerStat;
  return stat as OptimizerStat;
}

function concretizeStats(store: IStore, stats: G.Stats): OptimizerStats {
  const result: OptimizerStats = {};
  for (const [ rawStat, value ] of Object.entries(stats) as G.StatPairs) {
    const stat = concretizeStat(store, rawStat);
    result[stat] = (result[stat] ?? 0) + value;
  }
  return result;
}

function syncedLevel(store: IStore, gear: G.Gear): number | undefined {
  const { jobLevel, syncLevel=Infinity } = store;
  if (syncLevel >= gear.level && jobLevel >= gear.equipLevel) return undefined;
  const jobLevelSyncedLevel = Math.min(gear.level, G.syncLevelOfJobLevels[jobLevel]);
  return gear.equipLevelVariable
    ? Math.min(syncLevel, jobLevelSyncedLevel)
    : syncLevel < gear.level ? syncLevel : jobLevelSyncedLevel;
}

function prepareGear(store: IStore, gear: G.Gear, current?: IGear): OptimizerGear {
  const gearSyncedLevel = syncedLevel(store, gear);
  const stats = concretizeStats(store, gear.stats);
  if (gear.customizable && current !== undefined) {
    for (const [ stat, value ] of current.customStats?.entries() ?? []) {
      stats[stat as OptimizerStat] = value;
    }
  }
  if (gearSyncedLevel !== undefined) {
    const caps = G.getCaps(gear, gearSyncedLevel);
    for (const stat of Object.keys(stats) as OptimizerStat[]) {
      stats[stat] = Math.min(stats[stat]!, caps[stat as G.Stat] ?? Infinity);
    }
    if (gearSyncedLevel === 700 && gear.occultStats !== undefined) {
      const occultStats = concretizeStats(store, gear.occultStats);
      for (const [ stat, value ] of Object.entries(occultStats) as [OptimizerStat, number][]) {
        stats[stat] = (stats[stat] ?? 0) + value;
      }
    }
  }

  // getCaps already exposes concrete stat caps. Its additional `main` and
  // `secondary` entries must not be folded into the concrete caps, otherwise
  // (for example) a DRG's DHT cap would be counted twice.
  const caps = { ...G.getCaps(gear) } as OptimizerStats;
  const materiaSlots = [];
  if (gearSyncedLevel === undefined) {
    const slotCount = gear.materiaAdvanced ? 5 : gear.materiaSlot;
    for (let index = 0; index < slotCount; index++) {
      const advanced = index >= gear.materiaSlot;
      const grade = G.materiaGrades.find(candidate =>
        gear.level >= G.materiaGradeRequiredLevels[candidate - 1] &&
        (!advanced || !G.materiaGradeIsRestricted[candidate]));
      if (grade !== undefined) {
        materiaSlots.push({ grade, value: G.materias.CRT![grade - 1] });
      }
    }
  }
  return {
    id: gear.id,
    name: gear.name,
    level: gear.level,
    slot: gear.slot,
    unique: gear.unique === true,
    stats,
    caps,
    materiaSlots,
    synced: gearSyncedLevel !== undefined,
  };
}

function isEligible(store: IStore, gear: G.Gear, prepared: OptimizerGear, syncLevel: number,
  secondaryStats: OptimizerMateriaStat[]): boolean {
  if (gear.level === syncLevel || gear.level === syncLevel - 5) return true;
  if (gear.level <= syncLevel || !prepared.synced) return false;
  const syncCaps = G.getCaps(gear, syncLevel);
  return secondaryStats.filter(stat =>
    (prepared.stats[stat] ?? 0) >= (syncCaps[stat as G.Stat] ?? Infinity)).length >= 2;
}

export function createGearOptimizationInput(store: IStore,
  lockedSlots: number[], targetSpeed: number): GearOptimizationInput {
  if (store.job === undefined || store.schema.mainStat === undefined ||
      store.schema.statModifiers === undefined || store.schema.traitDamageMultiplier === undefined) {
    throw new Error('仅支持具有每威力伤害期望的战斗职业。');
  }
  if (store.syncLevel === undefined) {
    throw new Error('请先选择一个明确的品级同步值。');
  }
  if (!Number.isInteger(targetSpeed) || targetSpeed < 0) {
    throw new Error('目标技速/咏速必须是非负整数。');
  }

  const speedStat: 'SKS' | 'SPS' = store.schema.stats.includes('SKS') ? 'SKS' : 'SPS';
  const secondaryStats: OptimizerMateriaStat[] = damageSecondaryStats.concat(speedStat);
  const baseSpeed = store.baseStats[speedStat] ?? 0;
  if (targetSpeed < baseSpeed) {
    throw new Error(`目标${speedStat === 'SKS' ? '技速' : '咏速'}不能低于基础值 ${baseSpeed}。`);
  }

  const slots = Array.from(new Set(store.schema.slots
    .filter(slot => slot.slot > 0 && slot.levelWeight !== 0)
    .map(slot => Math.abs(slot.slot))));
  const lockedModels = lockedSlots.map(slot => store.equippedGears.get(slot.toString()))
    .filter((gear): gear is IGear => gear !== undefined && !gear.isFood);
  const lockedGearIds = lockedModels.map(gear => Math.abs(gear.id));
  const duplicateLockedGear = lockedModels.find((gear, index) =>
    lockedGearIds.indexOf(Math.abs(gear.id)) !== index);
  if (duplicateLockedGear?.data.unique) {
    throw new Error('唯一品戒指不能同时装备两枚。');
  }
  const lockedIdSet = new Set(lockedGearIds);
  const currentById = new Map<number, IGear>();
  for (const gear of store.equippedGears.values()) {
    if (gear !== undefined && !gear.isFood) {
      currentById.set(Math.abs(gear.id), gear);
    }
  }

  const gears: OptimizerGear[] = [];
  for (const item of gearDataOrdered.get()) {
    if (item.slot <= 0 || !slots.includes(item.slot) || !G.jobCategories[item.jobCategory][store.job]) continue;
    const gear = item as G.Gear;
    const current = currentById.get(gear.id);
    if (gear.customizable && current === undefined) continue;
    const prepared = prepareGear(store, gear, current);
    if (lockedIdSet.has(gear.id) || isEligible(store, gear, prepared, store.syncLevel, secondaryStats)) {
      gears.push(prepared);
    }
  }

  for (const gear of lockedModels) {
    if (!gears.some(candidate => candidate.id === Math.abs(gear.id))) {
      throw new Error(`无法将锁定的“${gear.name}”加入候选。`);
    }
  }

  let food: OptimizerFood | undefined;
  const equippedFood = store.equippedGears.get('-1') as IFood | undefined;
  if (equippedFood !== undefined) {
    const stats = concretizeStats(store, equippedFood.stats);
    food = {
      id: equippedFood.id,
      name: equippedFood.name,
      stats,
      statRates: concretizeStats(store, equippedFood.statRates),
    };
  }

  const materiaStats = store.schema.stats.filter((stat): stat is OptimizerMateriaStat =>
    secondaryStats.includes(stat as OptimizerMateriaStat));
  const level = G.jobLevelModifiers[store.jobLevel];
  return {
    syncLevel: store.syncLevel,
    fixedStats: { ...store.baseStats } as OptimizerStats,
    gears,
    slots,
    lockedGearIds,
    materiaStats,
    speedStat,
    targetSpeed,
    food,
    damage: {
      job: store.job,
      jobLevel: store.jobLevel,
      mainStat: store.schema.mainStat,
      statModifiers: store.schema.statModifiers,
      traitDamageMultiplier: store.schema.traitDamageMultiplier,
      partyBonus: store.schema.partyBonus,
      level,
      baseStats: { ...store.baseStats } as OptimizerStats,
      bluMdmgAdditions: G.bluMdmgAdditions,
    },
  };
}
