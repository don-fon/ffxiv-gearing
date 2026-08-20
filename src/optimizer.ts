export type OptimizerStat =
  'STR' | 'DEX' | 'INT' | 'MND' | 'VIT' |
  'CRT' | 'DET' | 'DHT' | 'TEN' | 'PIE' | 'SKS' | 'SPS' |
  'PDMG' | 'MDMG' | 'DLY';

export type OptimizerStats = Partial<Record<OptimizerStat, number>>;

export interface OptimizerMateriaSlot {
  grade: number;
  value: number;
}

export interface OptimizerGear {
  id: number;
  name: string;
  level: number;
  slot: number;
  stats: OptimizerStats;
  caps: OptimizerStats;
  materiaSlots: OptimizerMateriaSlot[];
  synced: boolean;
}

export interface OptimizerFood {
  id: number;
  name: string;
  stats: OptimizerStats;
  statRates: OptimizerStats;
}

export interface OptimizerDamageContext {
  job: string;
  jobLevel: number;
  mainStat: 'STR' | 'DEX' | 'INT' | 'MND' | 'VIT';
  statModifiers: Partial<Record<OptimizerStat | 'hp' | 'gcd', number>>;
  traitDamageMultiplier: number;
  partyBonus?: number;
  level: {
    main: number;
    sub: number;
    div: number;
    det: number;
    detTrunc: number;
    ap: number;
    apTank: number;
  };
  baseStats: OptimizerStats;
  bluMdmgAdditions: number[];
}

export interface NoSpeedOptimizationInput {
  syncLevel: number;
  fixedStats: OptimizerStats;
  gears: OptimizerGear[];
  slots: number[];
  lockedGearIds: number[];
  materiaStats: Array<'CRT' | 'DET' | 'DHT' | 'TEN'>;
  food?: OptimizerFood;
  damage: OptimizerDamageContext;
}

export interface OptimizerMeld {
  stat: 'CRT' | 'DET' | 'DHT' | 'TEN';
  grade: number;
}

export interface OptimizerGearChoice {
  id: number;
  name: string;
  level: number;
  slot: number;
  synced: boolean;
  melds: OptimizerMeld[];
}

export interface NoSpeedOptimizationResult {
  damage: number;
  stats: OptimizerStats;
  gears: OptimizerGearChoice[];
  exploredStates: number;
}

export interface OptimizerProgress {
  completedGroups: number;
  totalGroups: number;
  states: number;
}

interface GearOption {
  stats: OptimizerStats;
  choices: OptimizerGearChoice[];
}

interface SearchState extends GearOption {
  previous?: SearchState;
  selected?: OptimizerGearChoice[];
}

const damageStats: OptimizerStat[] = [
  'STR', 'DEX', 'INT', 'MND', 'CRT', 'DET', 'DHT', 'TEN', 'PDMG', 'MDMG',
];

const floor = (value: number) => Math.trunc(value + 1e-7);

function addStats(left: OptimizerStats, right: OptimizerStats): OptimizerStats {
  const result = { ...left };
  for (const [ stat, value ] of Object.entries(right) as [OptimizerStat, number][]) {
    result[stat] = (result[stat] ?? 0) + value;
  }
  return result;
}

function statSignature(stats: OptimizerStats): string {
  return damageStats.map(stat => stats[stat] ?? 0).join(',');
}

function addMeld(stats: OptimizerStats, caps: OptimizerStats,
  stat: 'CRT' | 'DET' | 'DHT' | 'TEN', value: number): OptimizerStats {
  const current = stats[stat] ?? 0;
  return {
    ...stats,
    [stat]: Math.min(current + value, Math.max(current, caps[stat] ?? Infinity)),
  };
}

function gearOptions(gear: OptimizerGear,
  materiaStats: NoSpeedOptimizationInput['materiaStats']): GearOption[] {
  let options: GearOption[] = [{
    stats: gear.stats,
    choices: [{
      id: gear.id,
      name: gear.name,
      level: gear.level,
      slot: gear.slot,
      synced: gear.synced,
      melds: [],
    }],
  }];

  for (const materia of gear.materiaSlots) {
    const next = new Map<string, GearOption>();
    for (const option of options) {
      const critRemaining = (gear.caps.CRT ?? 0) - (option.stats.CRT ?? 0);
      // At most 10% of a materia may be wasted. For a +54 materia this means
      // that at least 49 points must remain before CRT is forced.
      const stats = critRemaining >= Math.ceil(materia.value * 0.9)
        ? ['CRT'] as const
        : materiaStats.filter(stat => stat !== 'CRT');
      for (const stat of stats) {
        const meldedStats = addMeld(option.stats, gear.caps, stat, materia.value);
        const choice = option.choices[0];
        const melded: GearOption = {
          stats: meldedStats,
          choices: [{
            ...choice,
            melds: choice.melds.concat({ stat, grade: materia.grade }),
          }],
        };
        next.set(statSignature(meldedStats), melded);
      }
    }
    options = Array.from(next.values());
  }
  return options;
}

function deduplicateOptions(options: GearOption[]): GearOption[] {
  const unique = new Map<string, GearOption>();
  for (const option of options) {
    const signature = statSignature(option.stats);
    if (!unique.has(signature)) {
      unique.set(signature, option);
    }
  }
  return Array.from(unique.values());
}

function buildGroups(input: NoSpeedOptimizationInput): GearOption[][] {
  const lockedGearIds = new Set(input.lockedGearIds);
  const bySlot = new Map<number, OptimizerGear[]>();
  for (const gear of input.gears) {
    const gears = bySlot.get(gear.slot) ?? [];
    gears.push(gear);
    bySlot.set(gear.slot, gears);
  }

  const groups: GearOption[][] = [];
  for (const slot of input.slots) {
    let gears = bySlot.get(slot) ?? [];
    const lockedGears = gears.filter(gear => lockedGearIds.has(gear.id));
    if (slot !== 12 && lockedGears.length > 0) {
      if (lockedGears.length > 1) {
        throw new Error(`部位 ${slot} 同时锁定了多件装备。`);
      }
      gears = lockedGears;
    }
    if (gears.length === 0) {
      throw new Error(`部位 ${slot} 没有满足条件的装备。`);
    }
    const options = gears.flatMap(gear => gearOptions(gear, input.materiaStats));
    if (slot !== 12) {
      groups.push(deduplicateOptions(options));
      continue;
    }

    // Rings form one group. Pair before deduplication so two damage-equivalent
    // rings with different IDs are still available as a legal pair.
    const pairs: GearOption[] = [];
    for (let i = 0; i < options.length; i++) {
      for (let j = i + 1; j < options.length; j++) {
        if (options[i].choices[0].id === options[j].choices[0].id) continue;
        const selectedIds = new Set([options[i].choices[0].id, options[j].choices[0].id]);
        if (lockedGears.some(gear => !selectedIds.has(gear.id))) continue;
        pairs.push({
          stats: addStats(options[i].stats, options[j].stats),
          choices: options[i].choices.concat(options[j].choices),
        });
      }
    }
    if (pairs.length === 0) {
      throw new Error('没有两枚不同 ID 且满足条件的戒指。');
    }
    groups.push(deduplicateOptions(pairs));
  }
  return groups;
}

function applyFood(stats: OptimizerStats, food?: OptimizerFood): OptimizerStats {
  if (food === undefined) return stats;
  const result = { ...stats };
  for (const [ stat, maximum ] of Object.entries(food.stats) as [OptimizerStat, number][]) {
    const rate = food.statRates[stat];
    const increase = rate === undefined
      ? maximum
      : Math.min(maximum, floor((result[stat] ?? 0) * rate / 100));
    result[stat] = (result[stat] ?? 0) + increase;
  }
  return result;
}

export function calculateExpectedDamage(stats: OptimizerStats,
  context: OptimizerDamageContext): number {
  const { main, sub, div, det, detTrunc } = context.level;
  const { CRT, DET, DHT, TEN, PDMG, MDMG } = stats;
  const attackMainStat = context.mainStat === 'VIT' ? 'STR' : context.mainStat;
  const bluAetherialMimicry = context.job === 'BLU' ? 200 : 0;
  const crtChance = floor(200 * (CRT! - sub) / div + 50 + bluAetherialMimicry) / 1000;
  const crtDamage = floor(200 * (CRT! - sub) / div + 1400) / 1000;
  const detDamage = floor((140 * (DET! - main) / det + 1000) / detTrunc) * detTrunc / 1000;
  const dhtChance = floor(550 * (DHT! - sub) / div + bluAetherialMimicry) / 1000;
  const tenDamage = floor(112 * ((TEN ?? sub) - sub) / div + 1000) / 1000;
  const weaponDamage = floor(main * context.statModifiers[attackMainStat]! / 1000) +
    ((context.mainStat === 'MND' || context.mainStat === 'INT' ? MDMG : PDMG) ?? 0) +
    (context.job === 'BLU'
      ? context.bluMdmgAdditions[stats.INT! - context.baseStats.INT!] ?? 0
      : 0);
  const mainDamage = floor((context.mainStat === 'VIT' ? context.level.apTank : context.level.ap) *
    (floor((stats[attackMainStat] ?? 0) * (context.partyBonus ?? 1.05)) - main) / main + 100) / 100;
  return 0.01 * weaponDamage * mainDamage * detDamage * tenDamage * context.traitDamageMultiplier *
    ((crtDamage - 1) * crtChance + 1) * (0.25 * dhtChance + 1);
}

function reconstruct(state: SearchState): OptimizerGearChoice[] {
  const groups: OptimizerGearChoice[][] = [];
  let current: SearchState | undefined = state;
  while (current?.previous !== undefined) {
    groups.push(current.selected!);
    current = current.previous;
  }
  return groups.reverse().flat();
}

export function optimizeNoSpeedGearset(input: NoSpeedOptimizationInput,
  onProgress?: (progress: OptimizerProgress) => void): NoSpeedOptimizationResult {
  const groups = buildGroups(input);
  let exploredStates = 0;
  let states = new Map<string, SearchState>();
  states.set(statSignature(input.fixedStats), { stats: input.fixedStats, choices: [] });

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const next = new Map<string, SearchState>();
    for (const state of states.values()) {
      for (const option of groups[groupIndex]) {
        exploredStates++;
        const stats = addStats(state.stats, option.stats);
        const signature = statSignature(stats);
        if (!next.has(signature)) {
          next.set(signature, {
            stats,
            choices: [],
            previous: state,
            selected: option.choices,
          });
        }
      }
    }
    states = next;
    onProgress?.({ completedGroups: groupIndex + 1, totalGroups: groups.length, states: states.size });
  }

  let bestState: SearchState | undefined;
  let bestStats: OptimizerStats | undefined;
  let bestDamage = -Infinity;
  for (const state of states.values()) {
    const stats = applyFood(state.stats, input.food);
    const damage = calculateExpectedDamage(stats, input.damage);
    if (damage > bestDamage) {
      bestDamage = damage;
      bestState = state;
      bestStats = stats;
    }
  }
  if (bestState === undefined || bestStats === undefined) {
    throw new Error('没有找到满足条件的完整配装。');
  }
  return {
    damage: bestDamage,
    stats: bestStats,
    gears: reconstruct(bestState),
    exploredStates,
  };
}
