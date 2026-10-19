import * as G from './game';
import { gearDataOrdered } from './stores';
import type { IFood, IGear, IStore } from './stores';
import type {
  GearOptimizationInput,
  OptimizerFood,
  OptimizerGear,
  OptimizerLockedGear,
  OptimizerMeld,
  OptimizerMeldStat,
  OptimizerMateriaStat,
  OptimizerStat,
  OptimizerStats,
} from './optimizer';
import { selectPieFreeFallbacks, selectRequiredSlotFallbacks } from './optimizerCandidateFallbacks';

const damageSecondaryStats: OptimizerMateriaStat[] = ['CRT', 'DET', 'DHT', 'TEN'];

export type OptimizerGearCategory =
  'zodiacWeapon' | 'animaWeapon' | 'eurekaWeapon' | 'resistanceWeapon' |
  'mandervilleWeapon' | 'phantomWeapon' | 'savage' | 'dungeon' | 'normalRaid' |
  'allianceRaid' | 'trial' | 'ultimate' | 'eurekaGear' | 'bozjaGear' |
  'crescentIsleGear' | 'artifactGear' | 'wolfMarkGear' | 'deepDungeonGear' |
  'wondrousTailsGear' | 'craftedGear';

export const optimizerGearCategoryOptions: Array<{
  id: OptimizerGearCategory,
  label: string,
}> = [
  { id: 'phantomWeapon', label: '幻武' },
  { id: 'mandervilleWeapon', label: '曼武' },
  { id: 'eurekaWeapon', label: '优武' },
  { id: 'resistanceWeapon', label: '义武' },
  { id: 'zodiacWeapon', label: '古武' },
  { id: 'animaWeapon', label: '魂武' },
  { id: 'eurekaGear', label: '优装' },
  { id: 'bozjaGear', label: '博兹雅' },
  { id: 'crescentIsleGear', label: '新月岛' },
  { id: 'artifactGear', label: '校服' },
  { id: 'wolfMarkGear', label: '狼印' },
  { id: 'deepDungeonGear', label: '深层' },
  { id: 'wondrousTailsGear', label: '天书' },
  { id: 'savage', label: '零式' },
  { id: 'ultimate', label: '绝本' },
  { id: 'dungeon', label: '四人' },
  { id: 'normalRaid', label: '大型' },
  { id: 'allianceRaid', label: '团本' },
  { id: 'trial', label: '极神' },
  { id: 'craftedGear', label: '制作' },
];

export function optimizerGearCategoryOf(
  gear: Pick<G.Gear, 'slot' | 'source'>): OptimizerGearCategory | undefined {
  const source = gear.source ?? '';
  const weapon = gear.slot === 1 || gear.slot === 2 || gear.slot === 13;
  if (weapon && source.startsWith('古武')) return 'zodiacWeapon';
  if (weapon && source.startsWith('魂武')) return 'animaWeapon';
  if (weapon && source.startsWith('优雷卡')) return 'eurekaWeapon';
  if (weapon && source.startsWith('义军武器')) return 'resistanceWeapon';
  if (weapon && source.startsWith('曼德维尔武器')) return 'mandervilleWeapon';
  if (weapon && source.startsWith('幻境武器')) return 'phantomWeapon';
  if (!weapon && source.startsWith('优雷卡')) return 'eurekaGear';
  if (source.startsWith('天佑女王/')) return 'bozjaGear';
  if (source.startsWith('新月岛/')) return 'crescentIsleGear';
  if (source.startsWith('职业校服')) return 'artifactGear';
  if (source.startsWith('狼印战绩')) return 'wolfMarkGear';
  if (source.startsWith('深层迷宫/')) return 'deepDungeonGear';
  if (source.startsWith('天书奇谈')) return 'wondrousTailsGear';
  if (source.startsWith('零式/')) return 'savage';
  if (source.startsWith('迷宫挑战/')) return 'dungeon';
  if (source.startsWith('大型任务/')) return 'normalRaid';
  if (source.startsWith('团队任务/')) return 'allianceRaid';
  if (source.startsWith('歼灭战/') || source.startsWith('歼殛战/') ||
      source.startsWith('诛灭战/')) return 'trial';
  if (source.startsWith('绝境战/')) return 'ultimate';
  if (source.startsWith('生产制作') || source.startsWith('制作装强化')) return 'craftedGear';
  return undefined;
}

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

const optimizerMeldStats: OptimizerMeldStat[] = [
  'CRT', 'DET', 'DHT', 'TEN', 'PIE', 'SKS', 'SPS',
];

function prepareLockedMelds(store: IStore, gear: IGear): OptimizerMeld[] {
  return gear.materias.flatMap((materia, slot) => {
    if (materia.stat === undefined || materia.grade === undefined) return [];
    const stat = concretizeStat(store, materia.stat);
    if (!optimizerMeldStats.includes(stat as OptimizerMeldStat)) {
      throw new Error(`“${gear.name}”上有自动配装不支持的魔晶石属性。`);
    }
    const value = G.materias[materia.stat]?.[materia.grade - 1];
    if (value === undefined) {
      throw new Error(`“${gear.name}”上有无效的魔晶石。`);
    }
    return [{ stat: stat as OptimizerMeldStat, grade: materia.grade, value, slot }];
  });
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
  lockedSlots: number[], targetGcd: number, excludedGearIds: number[] = [],
  lockedMateriaSlots: number[] = [],
  excludedGearCategories: OptimizerGearCategory[] = []): GearOptimizationInput {
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
  const lockedEntries = lockedSlots.flatMap(slot => {
    const gear = store.equippedGears.get(slot.toString());
    return gear === undefined || gear.isFood ? [] : [{ slot, gear }];
  });
  const lockedModels = lockedEntries.map(entry => entry.gear);
  const lockedGearIds = lockedModels.map(gear => Math.abs(gear.id));
  const lockedMateriaSlotSet = new Set(lockedMateriaSlots);
  const invalidLockedMateriaSlot = lockedMateriaSlots.find(slot =>
    !lockedEntries.some(entry => entry.slot === slot));
  if (invalidLockedMateriaSlot !== undefined) {
    throw new Error('只有已锁定的装备才能连带锁定魔晶石。');
  }
  const lockedGears: OptimizerLockedGear[] = lockedEntries.map(({ slot, gear }) => ({
    id: Math.abs(gear.id),
    slot,
    melds: lockedMateriaSlotSet.has(slot) ? prepareLockedMelds(store, gear) : undefined,
  }));
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
  const excludedCategorySet = new Set(excludedGearCategories);
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
    if (excludedCategorySet.size > 0 && !lockedIdSet.has(gear.id)) {
      const category = optimizerGearCategoryOf(gear);
      if (category !== undefined && excludedCategorySet.has(category)) continue;
    }
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
    lockedGears,
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
