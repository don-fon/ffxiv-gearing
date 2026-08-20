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

export type OptimizerMateriaStat = 'CRT' | 'DET' | 'DHT' | 'TEN' | 'SKS' | 'SPS';

export interface GearOptimizationInput {
  syncLevel: number;
  fixedStats: OptimizerStats;
  gears: OptimizerGear[];
  slots: number[];
  lockedGearIds: number[];
  materiaStats: OptimizerMateriaStat[];
  speedStat: 'SKS' | 'SPS';
  targetSpeed: number;
  food?: OptimizerFood;
  damage: OptimizerDamageContext;
}

export interface OptimizerMeld {
  stat: OptimizerMateriaStat;
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

export interface GearOptimizationResult {
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
  'STR', 'DEX', 'INT', 'MND', 'CRT', 'DET', 'DHT', 'TEN', 'SKS', 'SPS', 'PDMG', 'MDMG',
];
const scoredStats = damageStats.filter(stat => stat !== 'SKS' && stat !== 'SPS');
const maximumContractionProduct = 50_000;
const maximumContractedOptions = 50_000;
const maximumGroupContractions = 5;

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
  stat: OptimizerMateriaStat, value: number): OptimizerStats {
  const current = stats[stat] ?? 0;
  return {
    ...stats,
    [stat]: Math.min(current + value, Math.max(current, caps[stat] ?? Infinity)),
  };
}

function gearOptions(gear: OptimizerGear,
  materiaStats: GearOptimizationInput['materiaStats']): GearOption[] {
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
      for (const stat of materiaStats) {
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

function dominates(left: GearOption, right: GearOption): boolean {
  return scoredStats.every(stat => (left.stats[stat] ?? 0) >= (right.stats[stat] ?? 0));
}

function pruneDominatedOptions(options: GearOption[], speedStat: 'SKS' | 'SPS'): GearOption[] {
  const bySpeed = new Map<number, GearOption[]>();
  for (const option of options) {
    const speed = option.stats[speedStat] ?? 0;
    const sameSpeed = bySpeed.get(speed) ?? [];
    sameSpeed.push(option);
    bySpeed.set(speed, sameSpeed);
  }

  const result: GearOption[] = [];
  for (const sameSpeed of bySpeed.values()) {
    sameSpeed.sort((left, right) => scoredStats.reduce((total, stat) =>
      total + (right.stats[stat] ?? 0) - (left.stats[stat] ?? 0), 0));
    const frontier: GearOption[] = [];
    for (const option of sameSpeed) {
      if (!frontier.some(candidate => dominates(candidate, option))) {
        frontier.push(option);
      }
    }
    result.push(...frontier);
  }
  return result;
}

function equivalentGearSignature(gear: OptimizerGear,
  materiaStats: GearOptimizationInput['materiaStats']): string {
  if (gear.synced) return `synced|${statSignature(gear.stats)}`;
  const caps = materiaStats.map(stat => gear.caps[stat] ?? '').join(',');
  const materiaSlots = gear.materiaSlots.map(slot => `${slot.grade}:${slot.value}`).join(',');
  return `${statSignature(gear.stats)}|${caps}|${materiaSlots}`;
}

function deduplicateEquivalentGears(gears: OptimizerGear[], maximumPerSignature: number,
  lockedGearIds: Set<number>, materiaStats: GearOptimizationInput['materiaStats']): OptimizerGear[] {
  const bySignature = new Map<string, OptimizerGear[]>();
  for (const gear of gears) {
    const signature = equivalentGearSignature(gear, materiaStats);
    const equivalent = bySignature.get(signature) ?? [];
    equivalent.push(gear);
    bySignature.set(signature, equivalent);
  }

  const result: OptimizerGear[] = [];
  for (const equivalent of bySignature.values()) {
    const locked = equivalent.filter(gear => lockedGearIds.has(gear.id));
    const unlocked = equivalent.filter(gear => !lockedGearIds.has(gear.id));
    result.push(...locked);
    result.push(...unlocked.slice(0, Math.max(0, maximumPerSignature - locked.length)));
  }
  return result;
}

function buildGroups(input: GearOptimizationInput): GearOption[][] {
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
    // Equivalent synced gear is common across a wide item-level range. Collapse
    // it before materia expansion and ring pairing. Rings retain two IDs per
    // signature because a legal pair must use two different item IDs.
    gears = deduplicateEquivalentGears(gears, slot === 12 ? 2 : 1, lockedGearIds, input.materiaStats);
    const options = gears.flatMap(gear =>
      pruneDominatedOptions(gearOptions(gear, input.materiaStats), input.speedStat));
    if (slot !== 12) {
      groups.push(pruneDominatedOptions(deduplicateOptions(options), input.speedStat));
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
    groups.push(pruneDominatedOptions(deduplicateOptions(pairs), input.speedStat));
  }
  return groups;
}

function combineGroups(left: GearOption[], right: GearOption[]): GearOption[] {
  const unique = new Map<string, GearOption>();
  for (const leftOption of left) {
    for (const rightOption of right) {
      const stats = addStats(leftOption.stats, rightOption.stats);
      const signature = statSignature(stats);
      if (!unique.has(signature)) {
        unique.set(signature, {
          stats,
          choices: leftOption.choices.concat(rightOption.choices),
        });
      }
    }
  }
  return Array.from(unique.values());
}

function contractEquivalentGroups(groups: GearOption[][]): GearOption[][] {
  let nextId = 0;
  const contracted = groups.map(options => ({ id: nextId++, options }));
  const rejectedPairs = new Set<string>();
  for (let contraction = 0; contraction < maximumGroupContractions; contraction++) {
    const pairs: Array<{ left: number, right: number, product: number }> = [];
    for (let left = 0; left < contracted.length; left++) {
      for (let right = left + 1; right < contracted.length; right++) {
        const pairKey = `${contracted[left].id}:${contracted[right].id}`;
        const product = contracted[left].options.length * contracted[right].options.length;
        if (!rejectedPairs.has(pairKey) && product <= maximumContractionProduct) {
          pairs.push({ left, right, product });
        }
      }
    }
    pairs.sort((left, right) => left.product - right.product);

    let merged = false;
    for (const pair of pairs) {
      const leftGroup = contracted[pair.left];
      const rightGroup = contracted[pair.right];
      const options = combineGroups(leftGroup.options, rightGroup.options);
      if (options.length > maximumContractedOptions || options.length * 5 > pair.product * 4) {
        rejectedPairs.add(`${leftGroup.id}:${rightGroup.id}`);
        continue;
      }
      contracted.splice(pair.right, 1);
      contracted.splice(pair.left, 1);
      contracted.push({ id: nextId++, options });
      merged = true;
      break;
    }
    if (!merged) break;
  }
  return contracted.map(group => group.options);
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

function speedAfterFood(speed: number, input: GearOptimizationInput): number {
  const maximum = input.food?.stats[input.speedStat];
  if (maximum === undefined) return speed;
  const rate = input.food?.statRates[input.speedStat];
  return speed + (rate === undefined ? maximum : Math.min(maximum, floor(speed * rate / 100)));
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

export function optimizeGearset(input: GearOptimizationInput,
  onProgress?: (progress: OptimizerProgress) => void): GearOptimizationResult {
  if (!Number.isInteger(input.targetSpeed) || input.targetSpeed < 0) {
    throw new Error('目标技速/咏速必须是非负整数。');
  }
  const groups = contractEquivalentGroups(buildGroups(input))
    .sort((left, right) => left.length - right.length);
  const minimumRemainingSpeed = Array.from({ length: groups.length + 1 }, () => 0);
  const maximumRemainingSpeed = Array.from({ length: groups.length + 1 }, () => 0);
  for (let index = groups.length - 1; index >= 0; index--) {
    const speeds = groups[index].map(option => option.stats[input.speedStat] ?? 0);
    minimumRemainingSpeed[index] = minimumRemainingSpeed[index + 1] + Math.min(...speeds);
    maximumRemainingSpeed[index] = maximumRemainingSpeed[index + 1] + Math.max(...speeds);
  }
  let exploredStates = 0;
  let states = new Map<string, SearchState>();
  states.set(statSignature(input.fixedStats), { stats: input.fixedStats, choices: [] });

  // Keep the largest group last and score it as a stream. Materializing the
  // final Cartesian product is unnecessary and can exceed V8's Map capacity.
  for (let groupIndex = 0; groupIndex < groups.length - 1; groupIndex++) {
    const next = new Map<string, SearchState>();
    for (const state of states.values()) {
      for (const option of groups[groupIndex]) {
        exploredStates++;
        const stats = addStats(state.stats, option.stats);
        const rawSpeed = stats[input.speedStat] ?? 0;
        const minimumFinalSpeed = speedAfterFood(rawSpeed + minimumRemainingSpeed[groupIndex + 1], input);
        const maximumFinalSpeed = speedAfterFood(rawSpeed + maximumRemainingSpeed[groupIndex + 1], input);
        if (input.targetSpeed < minimumFinalSpeed || input.targetSpeed > maximumFinalSpeed) continue;
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
  let finalCandidates = 0;
  const finalGroup = groups[groups.length - 1];
  for (const state of states.values()) {
    for (const option of finalGroup) {
      exploredStates++;
      const combinedStats = addStats(state.stats, option.stats);
      const stats = applyFood(combinedStats, input.food);
      if ((stats[input.speedStat] ?? 0) !== input.targetSpeed) continue;
      const damage = calculateExpectedDamage(stats, input.damage);
      if (damage > bestDamage) {
        bestDamage = damage;
        bestStats = stats;
        bestState = {
          stats: combinedStats,
          choices: [],
          previous: state,
          selected: option.choices,
        };
      }
      finalCandidates++;
    }
  }
  onProgress?.({ completedGroups: groups.length, totalGroups: groups.length, states: finalCandidates });
  if (bestState === undefined || bestStats === undefined) {
    throw new Error(`没有找到最终${input.speedStat === 'SKS' ? '技速' : '咏速'}为 ${input.targetSpeed} 的完整配装。`);
  }
  return {
    damage: bestDamage,
    stats: bestStats,
    gears: reconstruct(bestState),
    exploredStates,
  };
}
