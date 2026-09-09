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
import { selectPieFreeFallbacks, selectRequiredSlotFallbacks } from './optimizerCandidateFallbacks';

const damageSecondaryStats: OptimizerMateriaStat[] = ['CRT', 'DET', 'DHT', 'TEN'];

export function maximumMateriaGradeForSlot(gearLevel: number, materiaIndex: number,
  materiaSlotCount: number): G.MateriaGrade | undefined {
  const canUseRestrictedMateria = materiaIndex <= materiaSlotCount;
  return G.materiaGrades.find(candidate =>
    gearLevel >= G.materiaGradeRequiredLevels[candidate - 1] &&
    (canUseRestrictedMateria || !G.materiaGradeIsRestricted[candidate]));
}

function isBaselineGcd(store: IStore, speedStat: 'SKS' | 'SPS', targetGcd: number): boolean {
  const { sub, div } = G.jobLevelModifiers[store.jobLevel];
  const speed = store.baseStats[speedStat] ?? sub;
  const gcdModifier = store.jobLevel >= 80 ? store.schema.statModifiers?.gcd ?? 100 : 100;
  const floor = (value: number) => Math.trunc(value + 1e-7);
  const gcdHundredths = floor(floor((1000 - floor(130 * (speed - sub) / div)) * 2500 / 1000) *
    gcdModifier / 1000);
  return Math.round(targetGcd * 100) === gcdHundredths;
}

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
      const grade = maximumMateriaGradeForSlot(gear.level, index, gear.materiaSlot);
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

export function isOptimizerGearEligible(store: IStore, gear: G.Gear, prepared: OptimizerGear,
  syncLevel: number | undefined,
  secondaryStats: OptimizerMateriaStat[]): boolean {
  if (gear.equipLevel > store.schema.jobLevel) return false;
  if (syncLevel === undefined) {
    return gear.level >= store.minLevel && gear.level <= store.maxLevel &&
      !(gear.obsolete && store.setting.hideObsoleteGears);
  }
  if (gear.level === syncLevel || gear.level === syncLevel - 5) return true;
  if (gear.level <= syncLevel || !prepared.synced) return false;
  const nearMaximumLevel = Math.max(store.minLevel, store.maxLevel - 15);
  if (gear.level >= nearMaximumLevel && gear.level <= store.maxLevel) return true;
  const syncCaps = G.getCaps(gear, syncLevel);
  return secondaryStats.filter(stat =>
    (prepared.stats[stat] ?? 0) >= (syncCaps[stat as G.Stat] ?? Infinity)).length >= 2;
}

function prepareFood(store: IStore, food: G.Food): OptimizerFood {
  return {
    id: food.id,
    name: food.name,
    stats: concretizeStats(store, food.stats),
    statRates: concretizeStats(store, food.statRates),
  };
}

function optimizerFoods(store: IStore, locked: boolean): OptimizerFood[] {
  const equippedFood = store.equippedGears.get('-1') as IFood | undefined;
  if (locked && equippedFood !== undefined) {
    if ((equippedFood.data.stats.PIE ?? 0) > 0) {
      throw new Error('自动配装不考虑信仰食物，请取消食物锁定或更换食物。');
    }
    return [prepareFood(store, equippedFood.data)];
  }
  const eligible = gearDataOrdered.get().filter((item): item is G.Food =>
    item.slot === -1 && G.jobCategories[item.jobCategory][store.job!] === true &&
    (item as G.Food).best === true && (item.stats.PIE ?? 0) === 0);
  const maximumLevel = Math.max(...eligible.map(food => food.level));
  const candidates = eligible.filter(food => food.level === maximumLevel);
  const unique = new Map<string, { food: OptimizerFood, level: number }>();
  for (const food of candidates) {
    const prepared = prepareFood(store, food);
    const signature = JSON.stringify([prepared.stats, prepared.statRates]);
    const previous = unique.get(signature);
    if (previous === undefined || food.level > previous.level) {
      unique.set(signature, { food: prepared, level: food.level });
    }
  }
  return Array.from(unique.values(), item => item.food);
}

export function createGearOptimizationInput(store: IStore,
  lockedSlots: number[], targetGcd: number, excludedGearIds: number[] = []): GearOptimizationInput {
  if (store.job === undefined || store.schema.mainStat === undefined ||
      store.schema.statModifiers === undefined || store.schema.traitDamageMultiplier === undefined) {
    throw new Error('仅支持具有每威力伤害期望的战斗职业。');
  }
  if (!Number.isFinite(targetGcd) || targetGcd <= 0 ||
      Math.abs(targetGcd * 100 - Math.round(targetGcd * 100)) > 1e-7) {
    throw new Error('目标 GCD 必须是大于 0 且最多包含两位小数的秒数。');
  }

  const speedStat: 'SKS' | 'SPS' = store.schema.stats.includes('SKS') ? 'SKS' : 'SPS';
  const secondaryStats: OptimizerMateriaStat[] = damageSecondaryStats.concat(speedStat);

  const slots = Array.from(new Set(store.schema.slots
    .filter(slot => slot.slot > 0 && slot.levelWeight !== 0)
    .map(slot => Math.abs(slot.slot))));
  const lockedModels = lockedSlots.map(slot => store.equippedGears.get(slot.toString()))
    .filter((gear): gear is IGear => gear !== undefined && !gear.isFood);
  const lockedGearIds = lockedModels.map(gear => Math.abs(gear.id));
  const excludedIdSet = new Set(excludedGearIds.map(id => Math.abs(id)));
  const excludedLockedGear = lockedModels.find(gear => excludedIdSet.has(Math.abs(gear.id)));
  if (excludedLockedGear !== undefined) {
    throw new Error(`“${excludedLockedGear.name}”不能同时锁定和排除。`);
  }
  const duplicateLockedGear = lockedModels.find((gear, index) =>
    lockedGearIds.indexOf(Math.abs(gear.id)) !== index);
  if (duplicateLockedGear?.data.unique) {
    throw new Error('唯一品戒指不能同时装备两枚。');
  }
  const lockedIdSet = new Set(lockedGearIds);
  const configuredById = new Map<number, IGear>();
  for (const gear of store.gears.values()) {
    if (gear !== undefined && !gear.isFood) {
      configuredById.set(Math.abs(gear.id), gear);
    }
  }

  const preparedGears: Array<{ data: G.Gear, optimizer: OptimizerGear }> = [];
  for (const item of gearDataOrdered.get()) {
    if (item.slot <= 0 || !slots.includes(item.slot) || !G.jobCategories[item.jobCategory][store.job]) continue;
    const gear = item as G.Gear;
    if (gear.equipLevel > store.schema.jobLevel) continue;
    if (excludedIdSet.has(gear.id)) continue;
    const configured = configuredById.get(gear.id);
    if (gear.customizable && (configured?.customStats?.size ?? 0) === 0) continue;
    const prepared = prepareGear(store, gear, configured);
    preparedGears.push({ data: gear, optimizer: prepared });
  }

  const preferredCandidates = preparedGears.filter(({ data, optimizer }) =>
    lockedIdSet.has(data.id) ||
    isOptimizerGearEligible(store, data, optimizer, store.syncLevel, secondaryStats));
  const gears = preferredCandidates.map(candidate => candidate.optimizer);
  const preferredCandidateIds = new Set(preferredCandidates.map(candidate => candidate.data.id));
  const lowerLevelCandidates = store.syncLevel === undefined
    ? []
    : preparedGears.filter(({ data, optimizer }) =>
      !preferredCandidateIds.has(data.id) && !optimizer.synced && data.level < store.syncLevel! - 5 &&
      data.level >= store.minLevel && data.level <= store.maxLevel &&
      !(data.obsolete && store.setting.hideObsoleteGears))
      .map(candidate => candidate.optimizer);
  gears.push(...selectRequiredSlotFallbacks(gears, lowerLevelCandidates, slots));
  if (isBaselineGcd(store, speedStat, targetGcd)) {
    const selectedCandidateIds = new Set(gears.map(candidate => candidate.id));
    const lowerLevelSpeedFreeCandidates = lowerLevelCandidates.filter(candidate =>
      !selectedCandidateIds.has(candidate.id) && (candidate.stats[speedStat] ?? 0) === 0);
    gears.push(...selectRequiredSlotFallbacks(gears, lowerLevelSpeedFreeCandidates, slots,
      candidate => (candidate.stats[speedStat] ?? 0) === 0));
  }
  if (store.schema.stats.includes('PIE') && store.minLevel <= store.maxLevel) {
    const selectedCandidateIds = new Set(gears.map(candidate => candidate.id));
    const lowerLevelPieFreeCandidates = lowerLevelCandidates.filter(candidate =>
      !selectedCandidateIds.has(candidate.id) && (candidate.stats.PIE ?? 0) === 0);
    gears.push(...selectPieFreeFallbacks(gears, lowerLevelPieFreeCandidates, slots));
  }

  for (const gear of lockedModels) {
    if (!gears.some(candidate => candidate.id === Math.abs(gear.id))) {
      throw new Error(`无法将锁定的“${gear.name}”加入候选。`);
    }
  }

  const foods = optimizerFoods(store, lockedSlots.includes(-1));

  const materiaStats = store.schema.stats.filter((stat): stat is OptimizerMateriaStat =>
    secondaryStats.includes(stat as OptimizerMateriaStat));
  const level = G.jobLevelModifiers[store.jobLevel];
  return {
    syncLevel: store.syncLevel,
    fixedStats: { ...store.baseStats } as OptimizerStats,
    gears,
    slots,
    lockedGearIds,
    excludedGearIds: Array.from(excludedIdSet),
    materiaStats,
    speedStat,
    targetGcd,
    foods,
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
