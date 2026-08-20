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
  unique: boolean;
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
  unique: boolean;
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

interface DominanceTreeNode {
  maxima: number[];
  count: number;
  points?: number[][];
  left?: DominanceTreeNode;
  right?: DominanceTreeNode;
}

interface AttributeTreeNode<T extends GearOption> {
  maxima: OptimizerStats;
  count: number;
  items?: T[];
  left?: AttributeTreeNode<T>;
  right?: AttributeTreeNode<T>;
}

const damageStats: OptimizerStat[] = [
  'STR', 'DEX', 'INT', 'MND', 'CRT', 'DET', 'DHT', 'TEN', 'SKS', 'SPS', 'PDMG', 'MDMG',
];
const scoredStats = damageStats.filter(stat => stat !== 'SKS' && stat !== 'SPS');
const maximumContractionProduct = 50_000;
const maximumContractedOptions = 50_000;
const maximumGroupContractions = 5;
const dominanceLeafSize = 32;
const finalOptionLeafSize = 1;

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
      unique: gear.unique,
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

function coordinates(option: GearOption, stats: OptimizerStat[]): number[] {
  return stats.map(stat => option.stats[stat] ?? 0);
}

function dominanceTreeLeaf(points: number[][]): DominanceTreeNode {
  return {
    maxima: points[0].map((_, dimension) =>
      Math.max(...points.map(point => point[dimension]))),
    count: points.length,
    points,
  };
}

function splitDominanceTreeLeaf(node: DominanceTreeNode): void {
  const points = node.points!;
  let splitDimension = 0;
  let maximumSpread = -Infinity;
  for (let dimension = 0; dimension < node.maxima.length; dimension++) {
    const minimum = Math.min(...points.map(point => point[dimension]));
    const spread = node.maxima[dimension] - minimum;
    if (spread > maximumSpread) {
      maximumSpread = spread;
      splitDimension = dimension;
    }
  }
  points.sort((left, right) => right[splitDimension] - left[splitDimension]);
  const middle = Math.ceil(points.length / 2);
  node.left = dominanceTreeLeaf(points.slice(0, middle));
  node.right = dominanceTreeLeaf(points.slice(middle));
  delete node.points;
}

function dominanceTreeIncrease(node: DominanceTreeNode, point: number[]): number {
  return point.reduce((increase, value, dimension) =>
    increase + Math.max(0, value - node.maxima[dimension]), 0);
}

function insertDominancePoint(node: DominanceTreeNode, point: number[]): void {
  node.count++;
  for (let dimension = 0; dimension < point.length; dimension++) {
    node.maxima[dimension] = Math.max(node.maxima[dimension], point[dimension]);
  }
  if (node.points !== undefined) {
    node.points.push(point);
    if (node.points.length > dominanceLeafSize) splitDominanceTreeLeaf(node);
    return;
  }
  const leftIncrease = dominanceTreeIncrease(node.left!, point);
  const rightIncrease = dominanceTreeIncrease(node.right!, point);
  const child = leftIncrease < rightIncrease ||
    (leftIncrease === rightIncrease && node.left!.count <= node.right!.count)
    ? node.left!
    : node.right!;
  insertDominancePoint(child, point);
}

function hasDominatingPoint(node: DominanceTreeNode, target: number[]): boolean {
  if (node.maxima.some((maximum, dimension) => maximum < target[dimension])) return false;
  if (node.points !== undefined) {
    return node.points.some(point =>
      point.every((value, dimension) => value >= target[dimension]));
  }
  const leftScore = node.left!.maxima.reduce((total, value) => total + value, 0);
  const rightScore = node.right!.maxima.reduce((total, value) => total + value, 0);
  const first = leftScore >= rightScore ? node.left! : node.right!;
  const second = first === node.left ? node.right! : node.left!;
  return hasDominatingPoint(first, target) || hasDominatingPoint(second, target);
}

function paretoFrontier<T extends GearOption>(options: T[]): T[] {
  if (options.length <= 1) return options;
  const dimensions = scoredStats.filter(stat => {
    const first = options[0].stats[stat] ?? 0;
    return options.some(option => (option.stats[stat] ?? 0) !== first);
  });
  if (dimensions.length === 0) return [options[0]];
  const distinctCounts = new Map(dimensions.map(stat =>
    [ stat, new Set(options.map(option => option.stats[stat] ?? 0)).size ]));
  dimensions.sort((left, right) => distinctCounts.get(right)! - distinctCounts.get(left)!);
  options.sort((left, right) => {
    for (const stat of dimensions) {
      const difference = (right.stats[stat] ?? 0) - (left.stats[stat] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  if (dimensions.length === 1) return [options[0]];

  const result: T[] = [];
  let tree: DominanceTreeNode | undefined;
  for (const option of options) {
    const point = coordinates(option, dimensions.slice(1));
    if (tree !== undefined && hasDominatingPoint(tree, point)) continue;
    result.push(option);
    if (tree === undefined) tree = dominanceTreeLeaf([point]);
    else insertDominancePoint(tree, point);
  }
  return result;
}

function pruneDominatedOptions<T extends GearOption>(options: T[], speedStat: 'SKS' | 'SPS'): T[] {
  const bySpeed = new Map<number, GearOption[]>();
  for (const option of options) {
    const speed = option.stats[speedStat] ?? 0;
    const sameSpeed = bySpeed.get(speed) ?? [];
    sameSpeed.push(option);
    bySpeed.set(speed, sameSpeed);
  }

  const result: T[] = [];
  for (const sameSpeed of bySpeed.values()) {
    result.push(...paretoFrontier(sameSpeed as T[]));
  }
  return result;
}

function equivalentGearSignature(gear: OptimizerGear,
  materiaStats: GearOptimizationInput['materiaStats']): string {
  const uniqueness = gear.unique ? 'unique' : 'repeatable';
  if (gear.synced) return `synced|${uniqueness}|${statSignature(gear.stats)}`;
  const caps = materiaStats.map(stat => gear.caps[stat] ?? '').join(',');
  const materiaSlots = gear.materiaSlots.map(slot => `${slot.grade}:${slot.value}`).join(',');
  return `${uniqueness}|${statSignature(gear.stats)}|${caps}|${materiaSlots}`;
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

function matchesLockedRings(left: OptimizerGearChoice, right: OptimizerGearChoice,
  lockedRingIds: number[]): boolean {
  if (lockedRingIds.length === 0) return true;
  if (lockedRingIds.length === 1) {
    return left.id === lockedRingIds[0] || right.id === lockedRingIds[0];
  }
  return (left.id === lockedRingIds[0] && right.id === lockedRingIds[1]) ||
    (left.id === lockedRingIds[1] && right.id === lockedRingIds[0]);
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
    // signature so unique rings can still form a legal pair.
    gears = deduplicateEquivalentGears(gears, slot === 12 ? 2 : 1, lockedGearIds, input.materiaStats);
    const options = gears.flatMap(gear =>
      pruneDominatedOptions(gearOptions(gear, input.materiaStats), input.speedStat));
    if (slot !== 12) {
      groups.push(pruneDominatedOptions(deduplicateOptions(options), input.speedStat));
      continue;
    }

    // Rings form one group. A non-unique ring may pair with itself, including
    // with different melds on its two copies. Unique rings still require two IDs.
    const lockedRingIds = input.lockedGearIds.filter(id =>
      lockedGears.some(gear => gear.id === id));
    const pairs: GearOption[] = [];
    for (let i = 0; i < options.length; i++) {
      for (let j = i; j < options.length; j++) {
        const left = options[i].choices[0];
        const right = options[j].choices[0];
        if (left.id === right.id && left.unique) continue;
        if (!matchesLockedRings(left, right, lockedRingIds)) continue;
        pairs.push({
          stats: addStats(options[i].stats, options[j].stats),
          choices: options[i].choices.concat(options[j].choices),
        });
      }
    }
    if (pairs.length === 0) {
      throw new Error('没有两枚满足条件且不违反唯一品限制的戒指。');
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

function contractEquivalentGroups(groups: GearOption[][], speedStat: 'SKS' | 'SPS'): GearOption[][] {
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
      const options = pruneDominatedOptions(
        combineGroups(leftGroup.options, rightGroup.options), speedStat);
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

function filterInfeasibleSpeedOptions(groups: GearOption[][],
  input: GearOptimizationInput): GearOption[][] {
  const fixedSpeed = input.fixedStats[input.speedStat] ?? 0;
  let filtered = groups;
  let changed = true;
  while (changed) {
    changed = false;
    const minimumSpeeds = filtered.map(group =>
      Math.min(...group.map(option => option.stats[input.speedStat] ?? 0)));
    const maximumSpeeds = filtered.map(group =>
      Math.max(...group.map(option => option.stats[input.speedStat] ?? 0)));
    const totalMinimum = minimumSpeeds.reduce((total, speed) => total + speed, 0);
    const totalMaximum = maximumSpeeds.reduce((total, speed) => total + speed, 0);
    filtered = filtered.map((group, index) => {
      const next = group.filter(option => {
        const speed = option.stats[input.speedStat] ?? 0;
        const minimumFinal = speedAfterFood(
          fixedSpeed + speed + totalMinimum - minimumSpeeds[index], input);
        const maximumFinal = speedAfterFood(
          fixedSpeed + speed + totalMaximum - maximumSpeeds[index], input);
        return input.targetSpeed >= minimumFinal && input.targetSpeed <= maximumFinal;
      });
      if (next.length === 0) {
        throw new Error(`没有找到最终${input.speedStat === 'SKS' ? '技速' : '咏速'}为 ${input.targetSpeed} 的完整配装。`);
      }
      if (next.length !== group.length) changed = true;
      return next;
    });
  }
  return filtered;
}

function maximumOptionStats(options: GearOption[]): OptimizerStats {
  const maxima: OptimizerStats = {};
  for (const stat of damageStats) {
    if (options.some(option => option.stats[stat] !== undefined)) {
      maxima[stat] = Math.max(...options.map(option => option.stats[stat] ?? 0));
    }
  }
  return maxima;
}

function buildAttributeTree<T extends GearOption>(options: T[]): AttributeTreeNode<T> {
  const node: AttributeTreeNode<T> = {
    maxima: maximumOptionStats(options),
    count: options.length,
  };
  if (options.length <= finalOptionLeafSize) {
    node.items = options;
    return node;
  }
  let splitStat = scoredStats[0];
  let maximumDistinct = 0;
  for (const stat of scoredStats) {
    const distinct = new Set(options.map(option => option.stats[stat] ?? 0)).size;
    if (distinct > maximumDistinct) {
      maximumDistinct = distinct;
      splitStat = stat;
    }
  }
  if (maximumDistinct <= 1) {
    node.count = 1;
    node.items = [options[0]];
    return node;
  }
  options.sort((left, right) =>
    (right.stats[splitStat] ?? 0) - (left.stats[splitStat] ?? 0));
  const middle = Math.ceil(options.length / 2);
  node.left = buildAttributeTree(options.slice(0, middle));
  node.right = buildAttributeTree(options.slice(middle));
  return node;
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
  const attackMainStat = context.mainStat === 'VIT' ? 'STR' : context.mainStat;
  return calculateExpectedDamageComponents(
    stats[attackMainStat] ?? 0,
    stats.INT ?? 0,
    stats.CRT ?? 0,
    stats.DET ?? 0,
    stats.DHT ?? 0,
    stats.TEN,
    stats.PDMG,
    stats.MDMG,
    context);
}

function calculateExpectedDamageComponents(attackMainValue: number, intelligence: number,
  CRT: number, DET: number, DHT: number, TEN: number | undefined,
  PDMG: number | undefined, MDMG: number | undefined,
  context: OptimizerDamageContext): number {
  const { main, sub, div, det, detTrunc } = context.level;
  const attackMainStat = context.mainStat === 'VIT' ? 'STR' : context.mainStat;
  const bluAetherialMimicry = context.job === 'BLU' ? 200 : 0;
  const crtChance = floor(200 * (CRT - sub) / div + 50 + bluAetherialMimicry) / 1000;
  const crtDamage = floor(200 * (CRT - sub) / div + 1400) / 1000;
  const detDamage = floor((140 * (DET - main) / det + 1000) / detTrunc) * detTrunc / 1000;
  const dhtChance = floor(550 * (DHT - sub) / div + bluAetherialMimicry) / 1000;
  const tenDamage = floor(112 * ((TEN ?? sub) - sub) / div + 1000) / 1000;
  const weaponDamage = floor(main * context.statModifiers[attackMainStat]! / 1000) +
    ((context.mainStat === 'MND' || context.mainStat === 'INT' ? MDMG : PDMG) ?? 0) +
    (context.job === 'BLU'
      ? context.bluMdmgAdditions[intelligence - context.baseStats.INT!] ?? 0
      : 0);
  const mainDamage = floor((context.mainStat === 'VIT' ? context.level.apTank : context.level.ap) *
    (floor(attackMainValue * (context.partyBonus ?? 1.05)) - main) / main + 100) / 100;
  return 0.01 * weaponDamage * mainDamage * detDamage * tenDamage * context.traitDamageMultiplier *
    ((crtDamage - 1) * crtChance + 1) * (0.25 * dhtChance + 1);
}

function combinedStatValue(left: OptimizerStats, right: OptimizerStats,
  stat: OptimizerStat, food?: OptimizerFood): number | undefined {
  const leftValue = left[stat];
  const rightValue = right[stat];
  const maximum = food?.stats[stat];
  if (leftValue === undefined && rightValue === undefined && maximum === undefined) return undefined;
  let value = (leftValue ?? 0) + (rightValue ?? 0);
  if (maximum !== undefined) {
    const rate = food?.statRates[stat];
    value += rate === undefined ? maximum : Math.min(maximum, floor(value * rate / 100));
  }
  return value;
}

function calculateCombinedExpectedDamage(left: OptimizerStats, right: OptimizerStats,
  input: GearOptimizationInput): number {
  const attackMainStat = input.damage.mainStat === 'VIT' ? 'STR' : input.damage.mainStat;
  return calculateExpectedDamageComponents(
    combinedStatValue(left, right, attackMainStat, input.food) ?? 0,
    combinedStatValue(left, right, 'INT', input.food) ?? 0,
    combinedStatValue(left, right, 'CRT', input.food) ?? 0,
    combinedStatValue(left, right, 'DET', input.food) ?? 0,
    combinedStatValue(left, right, 'DHT', input.food) ?? 0,
    combinedStatValue(left, right, 'TEN', input.food),
    combinedStatValue(left, right, 'PDMG', input.food),
    combinedStatValue(left, right, 'MDMG', input.food),
    input.damage);
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
  let groups = filterInfeasibleSpeedOptions(buildGroups(input), input);
  groups = filterInfeasibleSpeedOptions(
    contractEquivalentGroups(groups, input.speedStat), input)
    .sort((left, right) => left.length - right.length);
  const minimumRemainingSpeed = Array.from({ length: groups.length + 1 }, () => 0);
  const maximumRemainingSpeed = Array.from({ length: groups.length + 1 }, () => 0);
  for (let index = groups.length - 1; index >= 0; index--) {
    const speeds = groups[index].map(option => option.stats[input.speedStat] ?? 0);
    minimumRemainingSpeed[index] = minimumRemainingSpeed[index + 1] + Math.min(...speeds);
    maximumRemainingSpeed[index] = maximumRemainingSpeed[index + 1] + Math.max(...speeds);
  }
  let exploredStates = 0;
  let states: SearchState[] = [{ stats: input.fixedStats, choices: [] }];

  // Keep the largest group last and score it as a stream. Materializing the
  // final Cartesian product is unnecessary and can exceed V8's Map capacity.
  for (let groupIndex = 0; groupIndex < groups.length - 1; groupIndex++) {
    const next = new Map<string, SearchState>();
    for (const state of states) {
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
    const candidates = Array.from(next.values());
    next.clear();
    states = pruneDominatedOptions(candidates, input.speedStat);
    onProgress?.({ completedGroups: groupIndex + 1, totalGroups: groups.length, states: states.length });
  }

  let bestState: SearchState | undefined;
  let bestStats: OptimizerStats | undefined;
  let bestDamage = -Infinity;
  let finalCandidates = 0;
  const finalGroup = groups[groups.length - 1];
  const finalOptionsBySpeed = new Map<number, GearOption[]>();
  for (const option of finalGroup) {
    const speed = option.stats[input.speedStat] ?? 0;
    const sameSpeed = finalOptionsBySpeed.get(speed) ?? [];
    sameSpeed.push(option);
    finalOptionsBySpeed.set(speed, sameSpeed);
  }
  const finalTrees = Array.from(finalOptionsBySpeed, ([ speed, options ]) => ({
    speed,
    tree: buildAttributeTree(options),
  }));

  const statesBySpeed = new Map<number, SearchState[]>();
  for (const state of states) {
    const speed = state.stats[input.speedStat] ?? 0;
    const sameSpeed = statesBySpeed.get(speed) ?? [];
    sameSpeed.push(state);
    statesBySpeed.set(speed, sameSpeed);
  }
  const stateTrees = Array.from(statesBySpeed, ([ speed, sameSpeed ]) => ({
    speed,
    tree: buildAttributeTree(sameSpeed),
  }));

  const upperDamage = (stateNode: AttributeTreeNode<SearchState>,
    optionNode: AttributeTreeNode<GearOption>): number =>
    calculateCombinedExpectedDamage(stateNode.maxima, optionNode.maxima, input);
  const searchFinalOptions = (stateNode: AttributeTreeNode<SearchState>,
    optionNode: AttributeTreeNode<GearOption>,
    bound = upperDamage(stateNode, optionNode)): void => {
    if (bound <= bestDamage) return;
    if (stateNode.items !== undefined && optionNode.items !== undefined) {
      for (const state of stateNode.items) {
        for (const option of optionNode.items) {
          exploredStates++;
          const damage = calculateCombinedExpectedDamage(state.stats, option.stats, input);
          if (damage > bestDamage) {
            const combinedStats = addStats(state.stats, option.stats);
            const stats = applyFood(combinedStats, input.food);
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
      return;
    }
    const splitStates = stateNode.items === undefined &&
      (optionNode.items !== undefined || stateNode.count >= optionNode.count);
    const leftState = splitStates ? stateNode.left! : stateNode;
    const rightState = splitStates ? stateNode.right! : stateNode;
    const leftOption = splitStates ? optionNode : optionNode.left!;
    const rightOption = splitStates ? optionNode : optionNode.right!;
    const leftBound = upperDamage(leftState, leftOption);
    const rightBound = upperDamage(rightState, rightOption);
    if (leftBound >= rightBound) {
      searchFinalOptions(leftState, leftOption, leftBound);
      searchFinalOptions(rightState, rightOption, rightBound);
    } else {
      searchFinalOptions(rightState, rightOption, rightBound);
      searchFinalOptions(leftState, leftOption, leftBound);
    }
  };

  const finalSearches: Array<{
    stateTree: AttributeTreeNode<SearchState>,
    optionTree: AttributeTreeNode<GearOption>,
    bound: number,
  }> = [];
  for (const { speed: stateSpeed, tree: stateTree } of stateTrees) {
    for (const { speed: optionSpeed, tree: optionTree } of finalTrees) {
      if (speedAfterFood(stateSpeed + optionSpeed, input) !== input.targetSpeed) continue;
      finalSearches.push({
        stateTree,
        optionTree,
        bound: upperDamage(stateTree, optionTree),
      });
    }
  }
  finalSearches.sort((left, right) => right.bound - left.bound);
  for (const { stateTree, optionTree, bound } of finalSearches) {
    searchFinalOptions(stateTree, optionTree, bound);
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
