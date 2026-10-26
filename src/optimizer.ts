import { calculateTenacityMitigation } from './statFormulas';

export { calculateTenacityMitigation } from './statFormulas';

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

export type OptimizerMeldStat = OptimizerMateriaStat | 'PIE';

export interface OptimizerLockedGear {
  id: number;
  slot: number;
  melds?: OptimizerMeld[];
}

export type CriticalPreference = 'none' | 'high' | 'low';

export interface OptimizerCriticalRange {
  minimum: number;
  maximum: number;
  midpoint: number;
}

export interface GearOptimizationInput {
  criticalPreference?: CriticalPreference;
  criticalRange?: OptimizerCriticalRange;
  candidateShard?: { index: number; count: number };
  syncLevel?: number;
  fixedStats: OptimizerStats;
  gears: OptimizerGear[];
  slots: number[];
  lockedGearIds: number[];
  lockedGears?: OptimizerLockedGear[];
  excludedGearIds?: number[];
  materiaStats: OptimizerMateriaStat[];
  speedStat: 'SKS' | 'SPS';
  targetGcd: number;
  targetSpeedContribution?: number;
  globalMinimumDamage?: number;
  objective?: GearOptimizationObjective;
  food?: OptimizerFood;
  foods?: OptimizerFood[];
  damage: OptimizerDamageContext;
}

export type GearOptimizationObjective =
  { type: 'damage' } |
  { type: 'minimumTenacity', minimumTenacityMitigation: number };

export interface OptimizerSpeedPartition {
  candidateShard?: { index: number; count: number };
  foodId?: number;
  contribution: number;
  heuristicDamage: number;
  estimatedWork: number;
}

export interface GearOptimizationPlan {
  criticalRange?: OptimizerCriticalRange;
  partitions: OptimizerSpeedPartition[];
  heuristicResult: GearOptimizationResult;
}

export interface OptimizerMeld {
  stat: OptimizerMeldStat;
  grade: number;
  value: number;
  slot?: number;
}

export interface OptimizerGearChoice {
  id: number;
  name: string;
  level: number;
  slot: number;
  unique: boolean;
  synced: boolean;
  melds: OptimizerMeld[];
  meldsLocked?: boolean;
}

export interface GearOptimizationResult {
  criticalRange?: OptimizerCriticalRange;
  empty?: boolean;
  damage: number;
  tenacityMitigation: number;
  stats: OptimizerStats;
  gears: OptimizerGearChoice[];
  food?: OptimizerFood;
  exploredStates: number;
}

export interface OptimizerProgress {
  completedGroups: number;
  totalGroups: number;
  states: number;
  visitedBranches?: number;
  searchProgress?: number;
}

export interface GearOption {
  stats: OptimizerStats;
  choices: OptimizerGearChoice[];
}

interface OptimizationEvaluation {
  damage: number;
  tenacityMitigation: number;
}

export interface SearchState extends GearOption {
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

export interface AttributeTreeNode<T extends GearOption> {
  maxima: OptimizerStats;
  count: number;
  minimumCritical: number;
  maximumSecondaryTotal: number;
  items?: T[];
  left?: AttributeTreeNode<T>;
  right?: AttributeTreeNode<T>;
}

export interface OptimizerSearchTask {
  input: GearOptimizationInput;
  prefix: AttributeTreeNode<SearchState>;
  options: AttributeTreeNode<GearOption>[];
  reference: OptimizerStats;
  minimumDamage: number;
  branchLimit?: number;
}

export interface OptimizerSearchUpdate {
  fraction: number;
  visitedBranches: number;
  states: number;
}

export interface OptimizerSearchResult {
  prefix?: SearchState;
  options?: GearOption[];
  damage: number;
  visitedBranches: number;
  states: number;
  complete: boolean;
}

export type OptimizerSearchBackend = ((task: OptimizerSearchTask,
  report: (progress: OptimizerSearchUpdate) => void) => OptimizerSearchResult | undefined) & {
    pareto?: <T extends GearOption>(options: T[]) => T[] | undefined;
    warmStartMinimumWork?: number;
    candidateShardCount?: number;
    memoryBytes?: () => number;
  };

interface SpeedSearchPlan {
  fixedSpeed: number;
  targetContributions: number[];
  allowedOptionSpeeds: Map<number, number[]>[];
  optionsBySpeed: Map<number, GearOption[]>[];
  completionMaxima: Map<number, OptimizerStats>[];
}

class NoFeasibleOptimizationSolution extends Error {}

const damageStats: OptimizerStat[] = [
  'STR', 'DEX', 'INT', 'MND', 'CRT', 'DET', 'DHT', 'TEN', 'SKS', 'SPS', 'PDMG', 'MDMG',
];
const scoredStats = damageStats.filter(stat => stat !== 'SKS' && stat !== 'SPS');
const maximumContractionProduct = 250_000;
const maximumContractedOptions = 100_000;
const maximumStateExpansion = 1_000_000;
const maximumGroupContractions = 7;
const dominanceLeafSize = 32;
const finalOptionLeafSize = 1;
const finalStateLeafSize = 16;

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
  stat: OptimizerMeldStat, value: number): OptimizerStats {
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

  for (const [ materiaIndex, materia ] of gear.materiaSlots.entries()) {
    const next = new Map<string, GearOption>();
    for (const option of options) {
      for (const stat of materiaStats) {
        const meldedStats = addMeld(option.stats, gear.caps, stat, materia.value);
        const choice = option.choices[0];
        const melded: GearOption = {
          stats: meldedStats,
          choices: [{
            ...choice,
            melds: choice.melds.concat({
              stat,
              grade: materia.grade,
              value: materia.value,
              slot: materiaIndex,
            }),
          }],
        };
        next.set(statSignature(meldedStats), melded);
      }
    }
    options = Array.from(next.values());
  }
  return options;
}

function lockedGearOption(gear: OptimizerGear, melds: OptimizerMeld[]): GearOption {
  let stats = gear.stats;
  if (!gear.synced) {
    for (const meld of melds) {
      stats = addMeld(stats, gear.caps, meld.stat, meld.value);
    }
  }
  return {
    stats,
    choices: [{
      id: gear.id,
      name: gear.name,
      level: gear.level,
      slot: gear.slot,
      unique: gear.unique,
      synced: gear.synced,
      melds,
      meldsLocked: true,
    }],
  };
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

function paretoFrontier<T extends GearOption>(options: T[], backend?: OptimizerSearchBackend): T[] {
  const native = backend?.pareto?.(options);
  if (native !== undefined) return native;
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

function pruneDominatedOptions<T extends GearOption>(options: T[], speedStat: 'SKS' | 'SPS',
  backend?: OptimizerSearchBackend): T[] {
  const bySpeed = new Map<number, GearOption[]>();
  for (const option of options) {
    const speed = option.stats[speedStat] ?? 0;
    const sameSpeed = bySpeed.get(speed) ?? [];
    sameSpeed.push(option);
    bySpeed.set(speed, sameSpeed);
  }

  const result: T[] = [];
  for (const sameSpeed of bySpeed.values()) {
    for (const option of paretoFrontier(sameSpeed as T[], backend)) result.push(option);
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
    for (const gear of locked) result.push(gear);
    for (const gear of unlocked.slice(0, Math.max(0, maximumPerSignature - locked.length))) {
      result.push(gear);
    }
  }
  return result;
}

function hasRemovableSpeedMeld(option: GearOption, input: GearOptimizationInput): boolean {
  if (input.targetSpeedContribution === undefined ||
      !input.materiaStats.some(stat => stat !== input.speedStat)) return false;
  const rawSpeed = (input.fixedStats[input.speedStat] ?? 0) + input.targetSpeedContribution;
  // Replacing this meld with a damage materia is dominating only when the
  // resulting speed, including the changed food bonus, stays in the GCD tier.
  return option.choices.some(choice => !choice.meldsLocked && choice.melds.some(meld =>
    meld.stat === input.speedStat &&
    gcdHundredths(speedAfterFood(rawSpeed - meld.value, input), input) === targetGcdHundredths(input)));
}

function filterRemovableSpeedMeldOptions(groups: GearOption[][],
  input: GearOptimizationInput): GearOption[][] {
  if (input.targetSpeedContribution === undefined) return groups;
  // Replacing excess speed with a non-CRT damage stat preserves either CRT half.
  // With only CRT/speed materia, a low-CRT solution may require the speed meld.
  if (hasCriticalPreference(input) && !input.materiaStats.some(stat =>
    stat !== input.speedStat && stat !== 'CRT')) return groups;
  const filtered = groups.map(group => group.filter(option => !hasRemovableSpeedMeld(option, input)));
  if (filtered.some(group => group.length === 0)) throw new NoFeasibleOptimizationSolution();
  return filtered;
}

function buildGroups(input: GearOptimizationInput, backend?: OptimizerSearchBackend): GearOption[][] {
  const lockedGearIds = new Set(input.lockedGearIds);
  let legacyRingIndex = 0;
  const lockedGears: OptimizerLockedGear[] = input.lockedGears ?? input.lockedGearIds.map(id => {
    const gearSlot = input.gears.find(gear => gear.id === id)?.slot ?? 0;
    return {
      id,
      slot: gearSlot === 12 && legacyRingIndex++ > 0 ? -12 : gearSlot,
    };
  });
  const excludedGearIds = new Set(input.excludedGearIds ?? []);
  const excludedLockedGearId = input.lockedGearIds.find(id => excludedGearIds.has(id));
  if (excludedLockedGearId !== undefined) {
    throw new Error(`装备 ${excludedLockedGearId} 不能同时锁定和排除。`);
  }
  const bySlot = new Map<number, OptimizerGear[]>();
  for (const gear of input.gears) {
    if (excludedGearIds.has(gear.id)) continue;
    const gears = bySlot.get(gear.slot) ?? [];
    gears.push(gear);
    bySlot.set(gear.slot, gears);
  }

  const groups: GearOption[][] = [];
  for (const slot of input.slots) {
    let gears = bySlot.get(slot) ?? [];
    const lockedSlotGears = gears.filter(gear => lockedGearIds.has(gear.id));
    if (slot !== 12 && lockedSlotGears.length > 0) {
      if (lockedSlotGears.length > 1) {
        throw new Error(`部位 ${slot} 同时锁定了多件装备。`);
      }
      gears = lockedSlotGears;
    }
    if (gears.length === 0) {
      throw new Error(`部位 ${slot} 没有满足条件的装备。`);
    }
    // Equivalent synced gear is common across a wide item-level range. Collapse
    // it before materia expansion and ring pairing. Rings retain two IDs per
    // signature so unique rings can still form a legal pair.
    gears = deduplicateEquivalentGears(gears, slot === 12 ? 2 : 1, lockedGearIds, input.materiaStats);
    if (slot !== 12) {
      const locked = lockedGears.find(selection => Math.abs(selection.slot) === slot &&
        selection.melds !== undefined);
      if (locked !== undefined) {
        const gear = gears.find(candidate => candidate.id === locked.id);
        if (gear === undefined) throw new Error(`无法锁定装备 ${locked.id} 的魔晶石。`);
        groups.push([lockedGearOption(gear, locked.melds!)]);
        continue;
      }
      const options = gears.flatMap(gear =>
        pruneDominatedOptions(gearOptions(gear, input.materiaStats), input.speedStat, backend));
      groups.push(pruneDominatedOptions(deduplicateOptions(options), input.speedStat, backend));
      continue;
    }

    // Rings form one group. A non-unique ring may pair with itself, including
    // with different melds on its two copies. Unique rings still require two IDs.
    const options = gears.flatMap(gear =>
      pruneDominatedOptions(gearOptions(gear, input.materiaStats), input.speedStat, backend));
    const ringLocks = lockedGears.filter(selection => Math.abs(selection.slot) === 12);
    const pairs: GearOption[] = [];
    const ringOptions = (lock: OptimizerLockedGear | undefined): GearOption[] => {
      if (lock === undefined) return options;
      const gear = gears.find(candidate => candidate.id === lock.id);
      if (gear === undefined) throw new Error(`无法锁定戒指 ${lock.id}。`);
      return lock.melds === undefined
        ? options.filter(option => option.choices[0].id === lock.id)
        : [lockedGearOption(gear, lock.melds)];
    };
    const leftLock = ringLocks.find(lock => lock.slot === 12) ??
      (input.lockedGears === undefined ? ringLocks[0] : undefined);
    const rightLock = ringLocks.find(lock => lock.slot === -12) ??
      (input.lockedGears === undefined ? ringLocks[1] : undefined);
    const leftOptions = ringOptions(leftLock);
    const rightOptions = ringOptions(rightLock);
    for (let i = 0; i < leftOptions.length; i++) {
      const firstRight = ringLocks.length === 0 ? i : 0;
      for (let j = firstRight; j < rightOptions.length; j++) {
        const left = leftOptions[i].choices[0];
        const right = rightOptions[j].choices[0];
        if (left.id === right.id && left.unique) continue;
        pairs.push({
          stats: addStats(leftOptions[i].stats, rightOptions[j].stats),
          choices: leftOptions[i].choices.concat(rightOptions[j].choices),
        });
      }
    }
    if (pairs.length === 0) {
      throw new Error('没有两枚满足条件且不违反唯一品限制的戒指。');
    }
    groups.push(pruneDominatedOptions(deduplicateOptions(pairs), input.speedStat, backend));
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

function contractEquivalentGroups(groups: GearOption[][], speedStat: 'SKS' | 'SPS',
  backend?: OptimizerSearchBackend): GearOption[][] {
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
        combineGroups(leftGroup.options, rightGroup.options), speedStat, backend);
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
    const minimumSpeeds = filtered.map(group => group.reduce((minimum, option) =>
      Math.min(minimum, option.stats[input.speedStat] ?? 0), Infinity));
    const maximumSpeeds = filtered.map(group => group.reduce((maximum, option) =>
      Math.max(maximum, option.stats[input.speedStat] ?? 0), -Infinity));
    const totalMinimum = minimumSpeeds.reduce((total, speed) => total + speed, 0);
    const totalMaximum = maximumSpeeds.reduce((total, speed) => total + speed, 0);
    filtered = filtered.map((group, index) => {
      const next = group.filter(option => {
        const speed = option.stats[input.speedStat] ?? 0;
        const minimumFinal = fixedSpeed + speed + totalMinimum - minimumSpeeds[index];
        const maximumFinal = fixedSpeed + speed + totalMaximum - maximumSpeeds[index];
        return speedRangeCanReachTargetGcd(minimumFinal, maximumFinal, input);
      });
      if (next.length === 0) {
        throw new NoFeasibleOptimizationSolution();
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
    let maximum = -Infinity;
    for (const option of options) {
      if (option.stats[stat] !== undefined) maximum = Math.max(maximum, option.stats[stat]!);
    }
    if (maximum !== -Infinity) maxima[stat] = maximum;
  }
  return maxima;
}

function buildAttributeTree<T extends GearOption>(options: T[],
  leafSize = finalOptionLeafSize): AttributeTreeNode<T> {
  const node: AttributeTreeNode<T> = {
    maxima: maximumOptionStats(options),
    count: options.length,
    minimumCritical: options.reduce((minimum, option) => Math.min(minimum, option.stats.CRT ?? 0), Infinity),
    maximumSecondaryTotal: options.reduce((maximum, option) => Math.max(maximum,
      (option.stats.CRT ?? 0) + (option.stats.DET ?? 0) + (option.stats.DHT ?? 0) +
      (option.stats.TEN ?? 0)), 0),
  };
  if (options.length <= leafSize) {
    node.items = options;
    return node;
  }
  let splitStat = scoredStats[0];
  let maximumDistinct = 0;
  // Keep weapon/main-stat alternatives near the top so bounds cannot borrow
  // their damage from a different secondary-stat allocation deep in the tree.
  const primary = (['PDMG', 'MDMG', 'STR', 'DEX', 'INT', 'MND'] as const).find(stat =>
    options.some(option => (option.stats[stat] ?? 0) !== (options[0].stats[stat] ?? 0)));
  for (const stat of primary === undefined ? scoredStats : [primary]) {
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
  node.left = buildAttributeTree(options.slice(0, middle), leafSize);
  node.right = buildAttributeTree(options.slice(middle), leafSize);
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

function gcdHundredths(speed: number, input: GearOptimizationInput): number {
  const { sub, div } = input.damage.level;
  const jobModifier = input.damage.jobLevel >= 80
    ? input.damage.statModifiers.gcd ?? 100
    : 100;
  return floor(floor((1000 - floor(130 * (speed - sub) / div)) * 2500 / 1000) *
    jobModifier / 1000);
}

function targetGcdHundredths(input: GearOptimizationInput): number {
  return Math.round(input.targetGcd * 100);
}

function speedRangeCanReachTargetGcd(minimumSpeed: number, maximumSpeed: number,
  input: GearOptimizationInput): boolean {
  const target = targetGcdHundredths(input);
  const fastest = gcdHundredths(speedAfterFood(maximumSpeed, input), input);
  const slowest = gcdHundredths(speedAfterFood(minimumSpeed, input), input);
  return target >= fastest && target <= slowest;
}

function buildSpeedSearchPlan(groups: GearOption[][],
  input: GearOptimizationInput): SpeedSearchPlan {
  const fixedSpeed = input.fixedStats[input.speedStat] ?? 0;
  const optionsBySpeed = groups.map(group => {
    const buckets = new Map<number, GearOption[]>();
    for (const option of group) {
      const speed = option.stats[input.speedStat] ?? 0;
      const bucket = buckets.get(speed) ?? [];
      bucket.push(option);
      buckets.set(speed, bucket);
    }
    return buckets;
  });
  const groupSpeeds = optionsBySpeed.map(buckets => Array.from(buckets.keys()));
  const minimumRemaining = Array.from({ length: groups.length + 1 }, () => 0);
  const maximumRemaining = Array.from({ length: groups.length + 1 }, () => 0);
  for (let index = groups.length - 1; index >= 0; index--) {
    minimumRemaining[index] = minimumRemaining[index + 1] + Math.min(...groupSpeeds[index]);
    maximumRemaining[index] = maximumRemaining[index + 1] + Math.max(...groupSpeeds[index]);
  }

  let minimumTargetContribution = Infinity;
  let maximumTargetContribution = -Infinity;
  const minimumTotalSpeed = fixedSpeed + minimumRemaining[0];
  const maximumTotalSpeed = fixedSpeed + maximumRemaining[0];
  const targetGcd = targetGcdHundredths(input);
  for (let speed = minimumTotalSpeed; speed <= maximumTotalSpeed; speed++) {
    if (gcdHundredths(speedAfterFood(speed, input), input) === targetGcd) {
      minimumTargetContribution = Math.min(minimumTargetContribution, speed - fixedSpeed);
      maximumTargetContribution = Math.max(maximumTargetContribution, speed - fixedSpeed);
    }
  }
  if (!Number.isFinite(minimumTargetContribution)) {
    throw new NoFeasibleOptimizationSolution();
  }

  // First enumerate only distinct cumulative speed contributions. The reverse
  // pass then keeps prefixes that have an exact route into the target GCD tier.
  const reachablePrefixes: Set<number>[] = [new Set([0])];
  for (let index = 0; index < groups.length; index++) {
    const next = new Set<number>();
    for (const prefix of reachablePrefixes[index]) {
      for (const speed of groupSpeeds[index]) {
        const cumulative = prefix + speed;
        if (cumulative + minimumRemaining[index + 1] > maximumTargetContribution ||
            cumulative + maximumRemaining[index + 1] < minimumTargetContribution) continue;
        next.add(cumulative);
      }
    }
    reachablePrefixes.push(next);
  }

  const targetContributions: number[] = [];
  const viablePrefixes = Array.from({ length: groups.length + 1 }, () => new Set<number>());
  for (const contribution of reachablePrefixes[groups.length]) {
    const finalSpeed = speedAfterFood(fixedSpeed + contribution, input);
    if (gcdHundredths(finalSpeed, input) === targetGcd) targetContributions.push(contribution);
    if (gcdHundredths(finalSpeed, input) === targetGcd &&
        (input.targetSpeedContribution === undefined ||
          contribution === input.targetSpeedContribution)) {
      viablePrefixes[groups.length].add(contribution);
    }
  }
  const allowedOptionSpeeds = Array.from(
    { length: groups.length }, () => new Map<number, number[]>());
  for (let index = groups.length - 1; index >= 0; index--) {
    for (const prefix of reachablePrefixes[index]) {
      const allowed = groupSpeeds[index].filter(speed =>
        viablePrefixes[index + 1].has(prefix + speed));
      if (allowed.length > 0) {
        viablePrefixes[index].add(prefix);
        allowedOptionSpeeds[index].set(prefix, allowed);
      }
    }
  }
  if (!viablePrefixes[0].has(0)) {
    throw new NoFeasibleOptimizationSolution();
  }

  const completionMaxima = Array.from(
    { length: groups.length + 1 }, () => new Map<number, OptimizerStats>());
  for (const prefix of viablePrefixes[groups.length]) {
    completionMaxima[groups.length].set(prefix, {});
  }
  for (let index = groups.length - 1; index >= 0; index--) {
    const bucketMaxima = new Map(Array.from(optionsBySpeed[index], ([ speed, options ]) =>
      [speed, maximumOptionStats(options)] as const));
    for (const [ prefix, allowedSpeeds ] of allowedOptionSpeeds[index]) {
      const maxima: OptimizerStats = {};
      for (const speed of allowedSpeeds) {
        const tail = completionMaxima[index + 1].get(prefix + speed)!;
        const route = addStats(bucketMaxima.get(speed)!, tail);
        for (const stat of damageStats) {
          if (route[stat] !== undefined) {
            maxima[stat] = Math.max(maxima[stat] ?? -Infinity, route[stat]!);
          }
        }
      }
      completionMaxima[index].set(prefix, maxima);
    }
  }
  targetContributions.sort((left, right) => left - right);
  return { fixedSpeed, targetContributions, allowedOptionSpeeds, optionsBySpeed, completionMaxima };
}

function filterToViableSpeedOptions(groups: GearOption[][],
  input: GearOptimizationInput): GearOption[][] {
  const plan = buildSpeedSearchPlan(groups, input);
  return groups.map((group, index) => {
    const viableSpeeds = new Set<number>();
    for (const speeds of plan.allowedOptionSpeeds[index].values()) {
      for (const speed of speeds) viableSpeeds.add(speed);
    }
    return group.filter(option => viableSpeeds.has(option.stats[input.speedStat] ?? 0));
  });
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

function minimumTenacityMitigation(input: GearOptimizationInput): number | undefined {
  return input.objective?.type === 'minimumTenacity'
    ? input.objective.minimumTenacityMitigation
    : undefined;
}

function meetsObjective(evaluation: OptimizationEvaluation, input: GearOptimizationInput): boolean {
  const minimum = minimumTenacityMitigation(input);
  return minimum === undefined || evaluation.tenacityMitigation + 1e-12 >= minimum;
}

function evaluateStats(stats: OptimizerStats, input: GearOptimizationInput): OptimizationEvaluation {
  const damage = calculateExpectedDamage(stats, input.damage);
  const tenacityMitigation = calculateTenacityMitigation(stats.TEN, input.damage.level);
  return { damage, tenacityMitigation };
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

function calculateCombinedTenacityMitigation(left: OptimizerStats, right: OptimizerStats,
  input: GearOptimizationInput): number {
  return calculateTenacityMitigation(
    combinedStatValue(left, right, 'TEN', input.food), input.damage.level);
}

function createCombinedDamageCalculator(input: GearOptimizationInput):
  (left: OptimizerStats, right: OptimizerStats) => number {
  const context = input.damage;
  if (context.job === 'BLU') {
    return (left, right) => calculateCombinedExpectedDamage(left, right, input);
  }
  const { main, sub, div, det, detTrunc } = context.level;
  const attackMainStat = context.mainStat === 'VIT' ? 'STR' : context.mainStat;
  const weaponStat = context.mainStat === 'MND' || context.mainStat === 'INT' ? 'MDMG' : 'PDMG';
  const mainFactors: number[] = [];
  const criticalFactors: number[] = [];
  const determinationFactors: number[] = [];
  const directHitFactors: number[] = [];
  const tenacityFactors: number[] = [];
  const weaponFactors: number[] = [];
  const adjustedValue = (raw: number, stat: OptimizerStat): number => {
    const maximum = input.food?.stats[stat];
    if (maximum === undefined) return raw;
    const rate = input.food?.statRates[stat];
    return raw + (rate === undefined ? maximum : Math.min(maximum, floor(raw * rate / 100)));
  };
  const rawValue = (left: OptimizerStats, right: OptimizerStats, stat: OptimizerStat): number =>
    (left[stat] ?? 0) + (right[stat] ?? 0);
  const cached = (values: number[], raw: number, calculate: (adjusted: number) => number,
    stat: OptimizerStat): number => {
    let value = values[raw];
    if (value === undefined) {
      value = calculate(adjustedValue(raw, stat));
      values[raw] = value;
    }
    return value;
  };
  return (left, right) => {
    const mainDamage = cached(mainFactors, rawValue(left, right, attackMainStat), value =>
      floor((context.mainStat === 'VIT' ? context.level.apTank : context.level.ap) *
        (floor(value * (context.partyBonus ?? 1.05)) - main) / main + 100) / 100,
    attackMainStat);
    const critical = cached(criticalFactors, rawValue(left, right, 'CRT'), value => {
      const chance = floor(200 * (value - sub) / div + 50) / 1000;
      const damage = floor(200 * (value - sub) / div + 1400) / 1000;
      return (damage - 1) * chance + 1;
    }, 'CRT');
    const determination = cached(determinationFactors, rawValue(left, right, 'DET'), value =>
      floor((140 * (value - main) / det + 1000) / detTrunc) * detTrunc / 1000, 'DET');
    const directHit = cached(directHitFactors, rawValue(left, right, 'DHT'), value =>
      0.25 * floor(550 * (value - sub) / div) / 1000 + 1, 'DHT');
    const rawTenacity = left.TEN === undefined && right.TEN === undefined
      ? undefined
      : rawValue(left, right, 'TEN');
    const tenacity = rawTenacity === undefined ? 1 : cached(tenacityFactors, rawTenacity, value =>
      floor(112 * (value - sub) / div + 1000) / 1000, 'TEN');
    const weaponDamage = cached(weaponFactors, rawValue(left, right, weaponStat), value =>
      floor(main * context.statModifiers[attackMainStat]! / 1000) + value, weaponStat);
    return 0.01 * weaponDamage * mainDamage * determination * tenacity *
      context.traitDamageMultiplier * critical * directHit;
  };
}

function combinedDamageValue(left: OptimizerStats, right: OptimizerStats,
  input: GearOptimizationInput,
  calculateDamage?: (left: OptimizerStats, right: OptimizerStats) => number): number {
  return calculateDamage === undefined
    ? calculateCombinedExpectedDamage(left, right, input)
    : calculateDamage(left, right);
}

function feasibleDamageBound(left: OptimizerStats, right: OptimizerStats,
  input: GearOptimizationInput,
  calculateDamage?: (left: OptimizerStats, right: OptimizerStats) => number): number {
  if (input.criticalRange !== undefined && input.criticalPreference === 'high' &&
      (combinedStatValue(left, right, 'CRT', input.food) ?? 0) < input.criticalRange.midpoint) return -Infinity;
  const damage = combinedDamageValue(left, right, input, calculateDamage);
  const minimum = minimumTenacityMitigation(input);
  if (minimum === undefined || minimum <= 0) return damage;
  return calculateCombinedTenacityMitigation(left, right, input) + 1e-12 >= minimum
    ? damage
    : -Infinity;
}

function evaluateCombinedStats(left: OptimizerStats, right: OptimizerStats,
  input: GearOptimizationInput,
  calculateDamage?: (left: OptimizerStats, right: OptimizerStats) => number): OptimizationEvaluation {
  const damage = combinedDamageValue(left, right, input, calculateDamage);
  const tenacityMitigation = calculateCombinedTenacityMitigation(left, right, input);
  return { damage, tenacityMitigation };
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

function findGreedySolution(input: GearOptimizationInput,
  speedPlan: SpeedSearchPlan): SearchState {
  let state: SearchState = { stats: input.fixedStats, choices: [] };
  let prefixSpeed = 0;
  for (let groupIndex = 0; groupIndex < speedPlan.optionsBySpeed.length; groupIndex++) {
    let bestNext: SearchState | undefined;
    let bestNextPrefix = 0;
    let bestBound = -Infinity;
    const allowedSpeeds = speedPlan.allowedOptionSpeeds[groupIndex].get(prefixSpeed) ?? [];
    for (const speed of allowedSpeeds) {
      const nextPrefix = prefixSpeed + speed;
      const remaining = speedPlan.completionMaxima[groupIndex + 1].get(nextPrefix)!;
      for (const option of speedPlan.optionsBySpeed[groupIndex].get(speed)!) {
        const stats = addStats(state.stats, option.stats);
        const bound = feasibleDamageBound(stats, remaining, input);
        if (bound > bestBound) {
          bestBound = bound;
          bestNextPrefix = nextPrefix;
          bestNext = {
            stats,
            choices: [],
            previous: state,
            selected: option.choices,
          };
        }
      }
    }
    if (bestNext === undefined) {
      throw new NoFeasibleOptimizationSolution(
        `没有找到最终 GCD 为 ${input.targetGcd.toFixed(2)} 秒的完整配装。`);
    }
    state = bestNext;
    prefixSpeed = bestNextPrefix;
  }
  return state;
}

/** Improve a legal lower bound with bounded two-group searches. The final
 * exhaustive search still proves optimality; incomplete warm-up tasks never do.
 * Restrict this heuristic to partitions with a single valid speed in each group.
 */
function improveGreedySolution(input: GearOptimizationInput, plan: SpeedSearchPlan,
  initial: SearchState, backend?: OptimizerSearchBackend): SearchState {
  if (backend?.warmStartMinimumWork === undefined ||
      estimatePartitionWork(plan) < backend.warmStartMinimumWork) return initial;
  const groups: GearOption[][] = [];
  for (const [index, routes] of plan.allowedOptionSpeeds.entries()) {
    const speeds = new Set(Array.from(routes.values()).flat());
    if (speeds.size !== 1) return initial;
    groups.push(plan.optionsBySpeed[index].get(speeds.values().next().value!)!);
  }
  const selected: GearOption[] = Array.from({ length: groups.length });
  let cursor = initial;
  for (let index = groups.length - 1; index >= 0; index--) {
    const option = groups[index].find(candidate => candidate.choices === cursor.selected);
    if (option === undefined) return initial;
    selected[index] = option;
    cursor = cursor.previous!;
  }
  const trees = groups.map(options => buildAttributeTree(options.slice()));
  const calculator = createCombinedDamageCalculator(input);
  let evaluation = evaluateStats(applyFood(initial.stats, input.food), input);
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let left = 0; left < groups.length; left++) {
      for (let right = left + 1; right < groups.length; right++) {
        let others = input.fixedStats;
        for (let index = 0; index < groups.length; index++) {
          if (index !== left && index !== right) others = addStats(others, selected[index].stats);
        }
        const prefix = buildAttributeTree<SearchState>([{ stats: others, choices: [] }], finalStateLeafSize);
        const candidate = backend({ input, prefix, options: [trees[left], trees[right]],
          reference: initial.stats, minimumDamage: evaluation.damage, branchLimit: 500_000 }, () => {});
        if (candidate?.prefix === undefined) continue;
        const options = candidate.options!;
        const optionStats = addStats(options[0].stats, options[1].stats);
        const next = evaluateCombinedStats(others, optionStats, input, calculator);
        if (meetsCombinedObjective(next, others, optionStats, input) && next.damage > evaluation.damage) {
          evaluation = next;
          selected[left] = options[0];
          selected[right] = options[1];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  let state: SearchState = { stats: input.fixedStats, choices: [] };
  for (const option of selected) {
    state = { stats: addStats(state.stats, option.stats), choices: [],
      previous: state, selected: option.choices };
  }
  return state;
}

function hasCriticalPreference(input: GearOptimizationInput): boolean {
  return input.criticalPreference === 'high' || input.criticalPreference === 'low';
}

function criticalAfterFood(raw: number, input: GearOptimizationInput): number {
  const maximum = input.food?.stats.CRT;
  const rate = input.food?.statRates.CRT;
  return raw + (maximum === undefined ? 0 : rate === undefined ? maximum : Math.min(maximum, floor(raw * rate / 100)));
}

function meetsCombinedObjective(evaluation: OptimizationEvaluation, left: OptimizerStats,
  right: OptimizerStats, input: GearOptimizationInput): boolean {
  if (!meetsObjective(evaluation, input)) return false;
  if (input.criticalRange === undefined) return true;
  const critical = combinedStatValue(left, right, 'CRT', input.food) ?? 0;
  return input.criticalPreference === 'high' ? critical >= input.criticalRange.midpoint :
    input.criticalPreference !== 'low' || critical <= input.criticalRange.midpoint;
}

/** Protect both endpoints while measuring the range. An upper CRT limit needs
 * exact-CRT buckets; a resolved lower limit preserves ordinary dominance. */
function criticalBackend(input: GearOptimizationInput,
  backend?: OptimizerSearchBackend): OptimizerSearchBackend | undefined {
  if (!hasCriticalPreference(input) ||
      input.criticalPreference === 'high' && input.criticalRange !== undefined) return backend;
  const protectedBackend: OptimizerSearchBackend = (task, report) => backend?.(task, report);
  Object.assign(protectedBackend, backend);
  protectedBackend.pareto = options => {
    const buckets = new Map<number, typeof options>();
    for (const option of options) {
      const critical = option.stats.CRT ?? 0;
      const bucket = buckets.get(critical) ?? [];
      bucket.push(option);
      buckets.set(critical, bucket);
    }
    return Array.from(buckets.values()).flatMap(bucket => paretoFrontier(bucket, backend));
  };
  return protectedBackend;
}

interface CriticalEndpoints {
  minimum: SearchState;
  maximum: SearchState;
}

/** Dynamic programming over speed and useful tenacity. Track CRT endpoints,
 * not the Cartesian product of damage stats. Keep witnesses for legal seeds. */
function criticalEndpoints(input: GearOptimizationInput,
  groups: GearOption[][]): Map<number, CriticalEndpoints> {
  const speedPlan = buildSpeedSearchPlan(groups, input);
  const requiredMitigation = minimumTenacityMitigation(input);
  let tenacityCap = requiredMitigation === undefined ? 0 : Infinity;
  if (requiredMitigation !== undefined && !groups.some(group =>
    group.some(option => (option.stats.TEN ?? 0) < 0))) {
    let low = 0;
    let high = (input.fixedStats.TEN ?? 0) + groups.reduce((sum, group) => sum +
      group.reduce((maximum, option) => Math.max(maximum, option.stats.TEN ?? 0), 0), 0);
    const mitigation = (raw: number) => calculateTenacityMitigation(
      applyFood({ TEN: raw }, input.food).TEN, input.damage.level);
    if (mitigation(high) + 1e-12 >= requiredMitigation) {
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (mitigation(middle) + 1e-12 >= requiredMitigation) high = middle;
        else low = middle + 1;
      }
      tenacityCap = low;
    }
  }
  const tenacityKey = (stats: OptimizerStats, cap = tenacityCap) => requiredMitigation === undefined
    ? '0' : `${Number(stats.TEN !== undefined)}:${Math.min(stats.TEN ?? 0, cap)}`;
  const insert = <T extends GearOption>(map: Map<string, { minimum: T; maximum: T }>, key: string, point: T) => {
    const pair = map.get(key);
    if (pair === undefined) map.set(key, { minimum: point, maximum: point });
    else {
      if ((point.stats.CRT ?? 0) < (pair.minimum.stats.CRT ?? 0)) pair.minimum = point;
      if ((point.stats.CRT ?? 0) > (pair.maximum.stats.CRT ?? 0)) pair.maximum = point;
    }
  };
  const initial: SearchState = { stats: input.fixedStats, choices: [] };
  let states = new Map<number, Map<string, CriticalEndpoints>>([
    [0, new Map([[tenacityKey(initial.stats), { minimum: initial, maximum: initial }]])],
  ]);
  for (let index = 0; index < groups.length; index++) {
    const bySpeed = new Map<number, GearOption[]>();
    const optionCap = Math.max(0, tenacityCap - (input.fixedStats.TEN ?? 0));
    for (const [speed, options] of speedPlan.optionsBySpeed[index]) {
      const projected = new Map<string, { minimum: GearOption; maximum: GearOption }>();
      for (const option of options) insert(projected, tenacityKey(option.stats, optionCap), option);
      bySpeed.set(speed, Array.from(new Set(Array.from(projected.values())
        .flatMap(pair => [pair.minimum, pair.maximum]))));
    }
    const next = new Map<number, Map<string, CriticalEndpoints>>();
    for (const [prefix, points] of states) {
      for (const speed of speedPlan.allowedOptionSpeeds[index].get(prefix) ?? []) {
        const cumulative = prefix + speed;
        const bucket = next.get(cumulative) ?? new Map<string, CriticalEndpoints>();
        next.set(cumulative, bucket);
        for (const pair of points.values()) {
          for (const state of pair.minimum === pair.maximum ? [pair.minimum] : [pair.minimum, pair.maximum]) {
            for (const option of bySpeed.get(speed)!) {
              const stats = addStats(state.stats, option.stats);
              insert(bucket, tenacityKey(stats), { stats, choices: [], previous: state, selected: option.choices });
            }
          }
        }
      }
    }
    // More tenacity with no worse endpoint dominates for feasibility. Preserve
    // the presence flag: absent TEN has different semantics from explicit zero.
    if (requiredMitigation !== undefined) {
      for (const bucket of next.values()) {
        const best = new Map<string, { minimum: number; maximum: number }>();
        const ordered = Array.from(bucket).sort(([left], [right]) =>
          Number(right.split(':')[1]) - Number(left.split(':')[1]));
        for (const [key, pair] of ordered) {
          const presence = key.split(':')[0];
          const previous = best.get(presence) ?? { minimum: Infinity, maximum: -Infinity };
          const minimum = pair.minimum.stats.CRT ?? 0;
          const maximum = pair.maximum.stats.CRT ?? 0;
          if (minimum >= previous.minimum && maximum <= previous.maximum) bucket.delete(key);
          else best.set(presence, { minimum: Math.min(previous.minimum, minimum),
            maximum: Math.max(previous.maximum, maximum) });
        }
      }
    }
    states = next;
  }
  const result = new Map<number, CriticalEndpoints>();
  for (const [contribution, bucket] of states) {
    let pair: CriticalEndpoints | undefined;
    for (const points of bucket.values()) {
      for (const point of [points.minimum, points.maximum]) {
        if (!meetsObjective(evaluateStats(applyFood(point.stats, input.food), input), input)) continue;
        if (pair === undefined) pair = { minimum: point, maximum: point };
        else {
          if ((point.stats.CRT ?? 0) < (pair.minimum.stats.CRT ?? 0)) pair.minimum = point;
          if ((point.stats.CRT ?? 0) > (pair.maximum.stats.CRT ?? 0)) pair.maximum = point;
        }
      }
    }
    if (pair !== undefined) result.set(contribution, pair);
  }
  return result;
}

function criticalSeed(endpoints: Map<number, CriticalEndpoints>, input: GearOptimizationInput): SearchState {
  let best: SearchState | undefined;
  let bestDamage = -Infinity;
  for (const [contribution, pair] of endpoints) {
    if (input.targetSpeedContribution !== undefined && contribution !== input.targetSpeedContribution) continue;
    for (const state of [pair.minimum, pair.maximum]) {
      const evaluation = evaluateCombinedStats(state.stats, {}, input);
      if (meetsCombinedObjective(evaluation, state.stats, {}, input) && evaluation.damage > bestDamage) {
        bestDamage = evaluation.damage;
        best = state;
      }
    }
  }
  if (best === undefined) throw new NoFeasibleOptimizationSolution();
  return best;
}

function resolveCriticalPreference(input: GearOptimizationInput,
  backend?: OptimizerSearchBackend): GearOptimizationInput {
  if (!hasCriticalPreference(input) || input.criticalRange !== undefined) return input;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const fixedInput of fixedFoodInputs(input)) {
    try {
      const groups = buildGroups(fixedInput, criticalBackend(fixedInput, backend));
      for (const pair of criticalEndpoints(fixedInput, groups).values()) {
        minimum = Math.min(minimum, criticalAfterFood(pair.minimum.stats.CRT ?? 0, fixedInput));
        maximum = Math.max(maximum, criticalAfterFood(pair.maximum.stats.CRT ?? 0, fixedInput));
      }
    } catch (error) {
      if (!(error instanceof NoFeasibleOptimizationSolution)) throw error;
    }
  }
  if (!Number.isFinite(minimum)) throw noFeasibleOptimizationError(input);
  return { ...input, criticalRange: { minimum, maximum, midpoint: (minimum + maximum) / 2 } };
}

function validateOptimizationInput(input: GearOptimizationInput): void {
  if (input.criticalPreference !== undefined && !['none', 'high', 'low'].includes(input.criticalPreference)) {
    throw new Error('暴击偏好无效。');
  }
  if (input.criticalRange !== undefined) {
    const { minimum, maximum, midpoint } = input.criticalRange;
    if (![minimum, maximum, midpoint].every(Number.isFinite) || minimum > maximum ||
        midpoint !== (minimum + maximum) / 2) throw new Error('暴击范围无效。');
  }
  if (input.candidateShard !== undefined && (!Number.isInteger(input.candidateShard.count) ||
      !Number.isInteger(input.candidateShard.index) || input.candidateShard.count < 1 ||
      input.candidateShard.count > 64 || input.candidateShard.index < 0 ||
      input.candidateShard.index >= input.candidateShard.count)) {
    throw new Error('Invalid optimizer candidate shard.');
  }
  if (!Number.isFinite(input.targetGcd) || input.targetGcd <= 0 ||
      Math.abs(input.targetGcd * 100 - Math.round(input.targetGcd * 100)) > 1e-7) {
    throw new Error('目标 GCD 必须是大于 0 且最多包含两位小数的秒数。');
  }
  if (input.targetSpeedContribution !== undefined &&
      !Number.isInteger(input.targetSpeedContribution)) {
    throw new Error('速度搜索分片参数无效。');
  }
  if (input.objective?.type === 'minimumTenacity' &&
      (!Number.isFinite(input.objective.minimumTenacityMitigation) ||
        input.objective.minimumTenacityMitigation < 0 ||
        input.objective.minimumTenacityMitigation >= 1)) {
    throw new Error('最低坚韧减伤必须是大于等于 0 且小于 100 的百分比。');
  }
}

function prepareSearchGroups(input: GearOptimizationInput, backend?: OptimizerSearchBackend): GearOption[][] {
  let groups = filterRemovableSpeedMeldOptions(buildGroups(input, backend), input);
  groups = filterInfeasibleSpeedOptions(groups, input);
  groups = filterToViableSpeedOptions(groups, input);
  return filterInfeasibleSpeedOptions(
    contractEquivalentGroups(groups, input.speedStat, backend), input)
    .sort((left, right) => left.length - right.length);
}

export function findTargetSpeedContributions(input: GearOptimizationInput): number[] {
  validateOptimizationInput(input);
  const planningInput = { ...input };
  delete planningInput.targetSpeedContribution;
  const groups = prepareSearchGroups(planningInput);
  return buildSpeedSearchPlan(groups, planningInput).targetContributions;
}

function estimatePartitionWork(plan: SpeedSearchPlan): number {
  let prefixes = new Map<number, number>([[0, 1]]);
  for (let index = 0; index < plan.optionsBySpeed.length; index++) {
    const next = new Map<number, number>();
    for (const [prefix, count] of prefixes) {
      for (const speed of plan.allowedOptionSpeeds[index].get(prefix) ?? []) {
        const cumulative = prefix + speed;
        const optionCount = plan.optionsBySpeed[index].get(speed)!.length;
        const routes = Math.min(Number.MAX_SAFE_INTEGER, count * optionCount);
        next.set(cumulative, Math.min(Number.MAX_SAFE_INTEGER,
          (next.get(cumulative) ?? 0) + routes));
      }
    }
    prefixes = next;
  }
  return Array.from(prefixes.values()).reduce((total, count) =>
    Math.min(Number.MAX_SAFE_INTEGER, total + count), 0);
}

function planFixedFoodGearOptimization(input: GearOptimizationInput,
  backend?: OptimizerSearchBackend): GearOptimizationPlan {
  validateOptimizationInput(input);
  const planningInput = { ...input };
  delete planningInput.targetSpeedContribution;
  delete planningInput.globalMinimumDamage;
  const groups = prepareSearchGroups(planningInput, backend);
  const contributions = buildSpeedSearchPlan(groups, planningInput).targetContributions;
  const criticalSeeds = hasCriticalPreference(input) ? criticalEndpoints(planningInput, groups) : undefined;
  let heuristicResult: GearOptimizationResult | undefined;
  const partitions: OptimizerSpeedPartition[] = [];
  for (const contribution of contributions) {
    const partitionInput = { ...planningInput, targetSpeedContribution: contribution };
    let speedPlan: SpeedSearchPlan;
    let state: SearchState;
    try {
      const partitionGroups = filterRemovableSpeedMeldOptions(groups, partitionInput);
      speedPlan = buildSpeedSearchPlan(partitionGroups, partitionInput);
      state = improveGreedySolution(partitionInput, speedPlan,
        criticalSeeds === undefined ? findGreedySolution(partitionInput, speedPlan) :
          criticalSeed(criticalSeeds, partitionInput), backend);
    } catch (error) {
      if (error instanceof NoFeasibleOptimizationSolution) continue;
      throw error;
    }
    const stats = applyFood(state.stats, input.food);
    const evaluation = evaluateStats(stats, input);
    if (heuristicResult === undefined || evaluation.damage > heuristicResult.damage) {
      heuristicResult = {
        ...evaluation,
        stats,
        gears: reconstruct(state),
        food: input.food,
        criticalRange: input.criticalRange,
        exploredStates: 0,
      };
    }
    partitions.push({
      foodId: input.food?.id,
      contribution,
      heuristicDamage: evaluation.damage,
      estimatedWork: estimatePartitionWork(speedPlan),
    });
  }
  if (heuristicResult === undefined) {
    throw new NoFeasibleOptimizationSolution();
  }
  const promisingContributions = new Set(Array.from(partitions)
    .sort((left, right) => right.heuristicDamage - left.heuristicDamage)
    .slice(0, 4)
    .map(partition => partition.contribution));
  partitions.sort((left, right) => {
    const leftPromising = promisingContributions.has(left.contribution);
    const rightPromising = promisingContributions.has(right.contribution);
    if (leftPromising && rightPromising) return right.heuristicDamage - left.heuristicDamage;
    if (leftPromising) return -1;
    if (rightPromising) return 1;
    return right.estimatedWork - left.estimatedWork;
  });
  return { partitions, heuristicResult };
}

/** A conservative log-tangent bound also respects the shared secondary-stat budget.
 * CRT's convex multiplier is first bounded by its secant over the node's interval.
 * The remaining factors (including capped food) have concave logarithms. Their
 * tangents reduce the bound to a four-variable fractional knapsack problem.
 */
function createSecondaryBudgetBound(input: GearOptimizationInput, reference: OptimizerStats) {
  const { sub, main, div, det, detTrunc } = input.damage.level;
  const stats = ['CRT', 'DET', 'DHT', 'TEN'] as const;
  const lower = stats.map(stat => input.fixedStats[stat] ?? 0);
  const neutralTenacity = input.damage.job !== 'BLU' && input.damage.mainStat !== 'VIT' &&
    input.fixedStats.TEN === undefined && input.food?.stats.TEN === undefined &&
    !input.materiaStats.includes('TEN') &&
    !input.lockedGears?.some(gear => gear.melds?.some(meld => meld.stat === 'TEN')) &&
    !input.gears.some(gear => gear.stats.TEN !== undefined);
  if (neutralTenacity) lower[3] = sub;
  if ((input.damage.mainStat !== 'VIT' && !neutralTenacity) || lower[0] < sub || lower[1] < main ||
      lower[2] < sub || lower[3] < sub ||
      input.gears.some(gear => stats.some(stat => (gear.stats[stat] ?? 0) < 0)) ||
      stats.some(stat => input.food?.stats[stat] !== undefined &&
        input.food.statRates[stat] === undefined)) return undefined;
  const foodCaps = stats.map(stat => input.food?.stats[stat] ?? 0);
  const foodRates = stats.map(stat => (input.food?.statRates[stat] ?? 0) / 100);
  const refs = stats.map(stat => stat === 'TEN' && neutralTenacity ? sub : reference[stat] ?? 0);
  const foodUpper = (value: number, index: number) =>
    value + Math.min(foodCaps[index], value * foodRates[index]);
  const slopes = [0, 0.14 / det, 0.1375 / div, 0.112 / div];
  const bases = [sub, main, sub, sub];
  const weights = stats.map((stat, index) => index === 0 ? 0 :
    slopes[index] * (refs[index] * foodRates[index] < foodCaps[index] ? 1 + foodRates[index] : 1) /
    (1 + slopes[index] * (foodUpper(refs[index], index) - bases[index])));
  const constant = stats.reduce((sum, stat, index) => index === 0 ? sum : sum +
    Math.log(1 + slopes[index] * (foodUpper(refs[index], index) - bases[index])) -
    weights[index] * refs[index], 0);
  const criticalFactor = (value: number) => {
    const scaled = 0.2 * (value - sub) / div;
    return 1 + (scaled + 0.4) * (scaled + 0.05);
  };
  return (maxima: OptimizerStats, minimumCritical: number, budget: number,
    independentBound: number): number => {
    const upper = stats.map(stat => stat === 'TEN' && neutralTenacity ? sub : maxima[stat] ?? 0);
    let deficit = upper.reduce((sum, value) => sum + value, 0) - budget - (neutralTenacity ? sub : 0);
    if (deficit <= 0 || !Number.isFinite(independentBound)) return independentBound;
    const criticalLower = minimumCritical + Math.min(foodCaps[0], floor(minimumCritical * foodRates[0]));
    const criticalUpper = foodUpper(upper[0], 0);
    // The secant slope of this quadratic is exact even for a zero-width interval.
    const criticalSlope = 0.2 / div * (0.2 * (criticalLower + criticalUpper - 2 * sub) / div + 0.45);
    const criticalIntercept = criticalFactor(criticalLower) - criticalSlope * criticalLower;
    const criticalRef = criticalIntercept + criticalSlope * foodUpper(refs[0], 0);
    if (criticalRef <= 0 || !Number.isFinite(criticalRef)) return independentBound;
    const currentWeights = weights.slice();
    currentWeights[0] = criticalSlope *
      (refs[0] * foodRates[0] < foodCaps[0] ? 1 + foodRates[0] : 1) / criticalRef;
    let logBound = constant + Math.log(criticalRef) - currentWeights[0] * refs[0];
    for (let index = 0; index < stats.length; index++) logBound += currentWeights[index] * upper[index];
    const order = [0, 1, 2, 3].sort((left, right) => currentWeights[left] - currentWeights[right]);
    for (const index of order) {
      const reduction = Math.min(deficit, Math.max(0, upper[index] - lower[index]));
      logBound -= reduction * currentWeights[index];
      deficit -= reduction;
      if (deficit <= 0) break;
    }
    const effective = upper.map((value, index) => value + Math.min(foodCaps[index],
      floor(value * foodRates[index])));
    const criticalChance = floor(200 * (effective[0] - sub) / div + 50) / 1000;
    const criticalDamage = floor(200 * (effective[0] - sub) / div + 1400) / 1000;
    const independentFactors = (1 + criticalChance * (criticalDamage - 1)) *
      (floor((140 * (effective[1] - main) / det + 1000) / detTrunc) * detTrunc / 1000) *
      (1 + 0.25 * floor(550 * (effective[2] - sub) / div) / 1000) *
      (floor(112 * (effective[3] - sub) / div + 1000) / 1000);
    // Leave room for floating-point rounding in the relaxation.
    return Math.min(independentBound, independentBound / independentFactors * Math.exp(logBound) * (1 + 1e-12));
  };
}

function optimizeFixedFoodGearset(input: GearOptimizationInput,
  onProgress?: (progress: OptimizerProgress) => void,
  searchBackend?: OptimizerSearchBackend): GearOptimizationResult {
  validateOptimizationInput(input);
  const groups = prepareSearchGroups(input, searchBackend);
  if (input.candidateShard !== undefined) {
    // Split a fixed candidate group BEFORE incumbent-dependent state pruning.
    // Hashing later prefix states would be unsafe if different workers have
    // different incumbent bounds or switch to tree search at different stages.
    const { index, count } = input.candidateShard;
    const last = groups.length - 1;
    groups[last] = groups[last].filter(option => {
      let hash = 2166136261;
      const signature = statSignature(option.stats);
      for (let position = 0; position < signature.length; position++) {
        hash = Math.imul(hash ^ signature.charCodeAt(position), 16777619) >>> 0;
      }
      return hash % count === index;
    });
    if (groups[last].length === 0) throw new NoFeasibleOptimizationSolution();
  }
  const speedPlan = buildSpeedSearchPlan(groups, input);
  const combinedDamage = createCombinedDamageCalculator(input);
  let bestState: SearchState | undefined = improveGreedySolution(input, speedPlan,
    hasCriticalPreference(input) ? criticalSeed(criticalEndpoints(input, groups), input) :
      findGreedySolution(input, speedPlan), searchBackend);
  let bestStats: OptimizerStats | undefined = applyFood(bestState.stats, input.food);
  let bestEvaluation = evaluateStats(bestStats, input);
  let pruningDamage = Math.max(bestEvaluation.damage, input.globalMinimumDamage ?? -Infinity);
  let exploredStates = 0;
  let states: SearchState[] = [{ stats: input.fixedStats, choices: [] }];

  // Keep the largest group for the final tree search. GCD tiers with several
  // reachable exact speeds are split into independent worker tasks by the UI.
  let finalGroupIndex = groups.length - 1;
  for (let groupIndex = 0; groupIndex < groups.length - 1; groupIndex++) {
    const statesByPrefix = new Map<number, SearchState[]>();
    for (const state of states) {
      const prefixSpeed = (state.stats[input.speedStat] ?? 0) - speedPlan.fixedSpeed;
      const samePrefix = statesByPrefix.get(prefixSpeed) ?? [];
      samePrefix.push(state);
      statesByPrefix.set(prefixSpeed, samePrefix);
    }
    const routesByNextPrefix = new Map<number, Array<{
      states: SearchState[],
      options: GearOption[],
    }>>();
    for (const [ prefixSpeed, prefixStates ] of statesByPrefix) {
      const allowedSpeeds = speedPlan.allowedOptionSpeeds[groupIndex].get(prefixSpeed) ?? [];
      for (const speed of allowedSpeeds) {
        const nextPrefix = prefixSpeed + speed;
        const routes = routesByNextPrefix.get(nextPrefix) ?? [];
        routes.push({
          states: prefixStates,
          options: speedPlan.optionsBySpeed[groupIndex].get(speed)!,
        });
        routesByNextPrefix.set(nextPrefix, routes);
      }
    }
    const expansionSize = Array.from(routesByNextPrefix.values()).reduce((total, routes) =>
      total + routes.reduce((count, route) => count + route.states.length * route.options.length, 0), 0);
    if (expansionSize > maximumStateExpansion) {
      // Search the remaining groups through their trees instead of materializing
      // a Cartesian product that can exceed JavaScript Map's capacity.
      finalGroupIndex = groupIndex;
      break;
    }
    const frontier: SearchState[] = [];
    // Dominance is only comparable at identical speed. Finish one cumulative
    // speed bucket at a time so candidates from other speeds do not stay live.
    for (const [ nextPrefix, routes ] of routesByNextPrefix) {
      const next = new Map<string, SearchState>();
      const remaining = speedPlan.completionMaxima[groupIndex + 1].get(nextPrefix)!;
      for (const route of routes) {
        for (const state of route.states) {
          for (const option of route.options) {
            exploredStates++;
            const stats = addStats(state.stats, option.stats);
            const bound = feasibleDamageBound(stats, remaining, input, combinedDamage);
            if (bound <= pruningDamage) continue;
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
      }
      for (const state of paretoFrontier(Array.from(next.values()), searchBackend)) frontier.push(state);
    }
    states = frontier;
    onProgress?.({ completedGroups: groupIndex + 1, totalGroups: groups.length, states: states.length });
  }

  let finalCandidates = 0;

  const statesBySpeed = new Map<number, SearchState[]>();
  for (const state of states) {
    const speed = state.stats[input.speedStat] ?? 0;
    const sameSpeed = statesBySpeed.get(speed) ?? [];
    sameSpeed.push(state);
    statesBySpeed.set(speed, sameSpeed);
  }
  const stateTrees = Array.from(statesBySpeed, ([ speed, sameSpeed ]) => ({
    speed,
    tree: buildAttributeTree(sameSpeed, finalStateLeafSize),
  }));

  const secondaryBudgetBound = createSecondaryBudgetBound(input, bestState.stats);
  const upperDamage = (stateNode: AttributeTreeNode<SearchState>, maxima: OptimizerStats,
    optionNodes: AttributeTreeNode<GearOption>[]): number => {
    if (input.criticalRange !== undefined && input.criticalPreference === 'low' &&
        criticalAfterFood(stateNode.minimumCritical + optionNodes.reduce((sum, node) =>
          sum + node.minimumCritical, 0), input) > input.criticalRange.midpoint) return -Infinity;
    const independent = feasibleDamageBound(stateNode.maxima, maxima, input, combinedDamage);
    if (secondaryBudgetBound === undefined || independent <= pruningDamage) return independent;
    return secondaryBudgetBound(addStats(stateNode.maxima, maxima),
      stateNode.minimumCritical + optionNodes.reduce((sum, node) => sum + node.minimumCritical, 0),
      stateNode.maximumSecondaryTotal + optionNodes.reduce((sum, node) => sum + node.maximumSecondaryTotal, 0),
      independent);
  };
  const replaceMaxima = (maxima: OptimizerStats, previous: OptimizerStats,
    next: OptimizerStats): OptimizerStats => {
    const result: OptimizerStats = {};
    for (const stat of scoredStats) {
      if (maxima[stat] !== undefined || next[stat] !== undefined) {
        result[stat] = (maxima[stat] ?? 0) - (previous[stat] ?? 0) + (next[stat] ?? 0);
      }
    }
    return result;
  };
  // Count feasible suffix combinations by speed without enumerating them. This
  // weights coverage of the final search space, not its unpredictable wall time.
  const suffixWork = groups.map(() => new Map<number, number>());
  const completionWork = (groupIndex: number, prefixSpeed: number): number => {
    if (groupIndex === groups.length) return 1;
    const cached = suffixWork[groupIndex].get(prefixSpeed);
    if (cached !== undefined) return cached;
    let work = 0;
    for (const speed of speedPlan.allowedOptionSpeeds[groupIndex].get(prefixSpeed) ?? []) {
      work += speedPlan.optionsBySpeed[groupIndex].get(speed)!.length *
        completionWork(groupIndex + 1, prefixSpeed + speed);
    }
    suffixWork[groupIndex].set(prefixSpeed, work);
    return work;
  };
  const totalWork = stateTrees.reduce((total, { speed, tree }) => total + tree.count *
    completionWork(finalGroupIndex, speed - speedPlan.fixedSpeed), 0);
  let completedWork = 0;
  let visitedBranches = 0;
  let lastProgressTime = Date.now();
  const reportSearchProgress = (finished = false, currentWork = completedWork) => onProgress?.({
    completedGroups: finished ? groups.length : finalGroupIndex,
    totalGroups: groups.length,
    states: finalCandidates,
    visitedBranches,
    searchProgress: finished ? 1 : Math.min(0.999999, totalWork > 0 ? currentWork / totalWork : 0),
  });
  reportSearchProgress();
  const searchFinalOptions = (stateNode: AttributeTreeNode<SearchState>,
    optionNodes: AttributeTreeNode<GearOption>[], maxima: OptimizerStats, work: number,
    bound = upperDamage(stateNode, maxima, optionNodes)): void => {
    if (bound <= pruningDamage) {
      completedWork += work;
      return;
    }
    visitedBranches++;
    if (visitedBranches % 10_000 === 0 && Date.now() - lastProgressTime >= 1000) {
      lastProgressTime = Date.now();
      reportSearchProgress();
    }
    if (stateNode.items !== undefined && optionNodes.every(node => node.items !== undefined)) {
      // Option trees have one item per leaf; prefix-state leaves can have several.
      const optionStats = optionNodes.reduce((stats, node) => addStats(stats, node.items![0].stats), {});
      for (const state of stateNode.items) {
        exploredStates++;
        const evaluation = evaluateCombinedStats(state.stats, optionStats, input, combinedDamage);
        if (meetsCombinedObjective(evaluation, state.stats, optionStats, input) && evaluation.damage > bestEvaluation.damage) {
          const combinedStats = addStats(state.stats, optionStats);
          bestEvaluation = evaluation;
          pruningDamage = Math.max(pruningDamage, evaluation.damage);
          bestStats = applyFood(combinedStats, input.food);
          bestState = {
            stats: combinedStats,
            choices: [],
            previous: state,
            selected: optionNodes.flatMap(node => node.items![0].choices),
          };
        }
        finalCandidates++;
      }
      completedWork += work;
      return;
    }
    let splitIndex = -1;
    let splitCount = stateNode.items === undefined ? stateNode.count : 0;
    for (const [ index, node ] of optionNodes.entries()) {
      if (node.items === undefined && node.count > splitCount) {
        splitIndex = index;
        splitCount = node.count;
      }
    }
    const splitNode = splitIndex === -1 ? stateNode : optionNodes[splitIndex];
    const leftState = splitIndex === -1 ? stateNode.left! : stateNode;
    const rightState = splitIndex === -1 ? stateNode.right! : stateNode;
    const leftOptions = optionNodes.slice();
    const rightOptions = optionNodes.slice();
    if (splitIndex !== -1) {
      leftOptions[splitIndex] = splitNode.left!;
      rightOptions[splitIndex] = splitNode.right!;
    }
    const leftMaxima = splitIndex === -1 ? maxima :
      replaceMaxima(maxima, splitNode.maxima, splitNode.left!.maxima);
    const rightMaxima = splitIndex === -1 ? maxima :
      replaceMaxima(maxima, splitNode.maxima, splitNode.right!.maxima);
    const leftWork = work * splitNode.left!.count /
      (splitNode.left!.count + splitNode.right!.count);
    const rightWork = work - leftWork;
    const leftBound = upperDamage(leftState, leftMaxima, leftOptions);
    const rightBound = upperDamage(rightState, rightMaxima, rightOptions);
    if (leftBound >= rightBound) {
      searchFinalOptions(leftState, leftOptions, leftMaxima, leftWork, leftBound);
      searchFinalOptions(rightState, rightOptions, rightMaxima, rightWork, rightBound);
    } else {
      searchFinalOptions(rightState, rightOptions, rightMaxima, rightWork, rightBound);
      searchFinalOptions(leftState, leftOptions, leftMaxima, leftWork, leftBound);
    }
  };

  const finalTrees = groups.map(() => new Map<number, AttributeTreeNode<GearOption>>());
  // Depth-local buffers preserve addition order without retaining temporary
  // objects for every reachable exact-speed route. Calls below are synchronous.
  const routeMaxima = groups.map(() => ({} as OptimizerStats));
  const routeBounds = groups.map(() => ({} as OptimizerStats));
  const routeStats = scoredStats.filter(stat => input.fixedStats[stat] !== undefined ||
    groups.some(group => group.some(option => option.stats[stat] !== undefined)));
  const sumInto = (output: OptimizerStats, left: OptimizerStats, right: OptimizerStats) => {
    for (const stat of routeStats) {
      const a = left[stat];
      const b = right[stat];
      if (a === undefined && b === undefined) delete output[stat];
      else output[stat] = (a ?? 0) + (b ?? 0);
    }
    return output;
  };
  const suffixLimits = groups.map(() => new Map<number, { budget: number; critical: number }>());
  const bucketLimits = secondaryBudgetBound === undefined ? [] : speedPlan.optionsBySpeed.map(buckets => new Map(Array.from(buckets,
    ([speed, options]) => [speed, {
      budget: options.reduce((maximum, option) => Math.max(maximum,
        (option.stats.CRT ?? 0) + (option.stats.DET ?? 0) +
        (option.stats.DHT ?? 0) + (option.stats.TEN ?? 0)), -Infinity),
      critical: options.reduce((minimum, option) => Math.min(minimum, option.stats.CRT ?? 0), Infinity),
    }])));
  const remainingLimits = (index: number, prefix: number): { budget: number; critical: number } => {
    if (index === groups.length) return { budget: 0, critical: 0 };
    const cached = suffixLimits[index].get(prefix);
    if (cached !== undefined) return cached;
    let budget = -Infinity;
    let critical = Infinity;
    for (const speed of speedPlan.allowedOptionSpeeds[index].get(prefix) ?? []) {
      const bucket = bucketLimits[index].get(speed)!;
      const tail = remainingLimits(index + 1, prefix + speed);
      budget = Math.max(budget, bucket.budget + tail.budget);
      critical = Math.min(critical, bucket.critical + tail.critical);
    }
    const limits = { budget, critical };
    suffixLimits[index].set(prefix, limits);
    return limits;
  };
  const budgetMaxima = groups.map(() => ({} as OptimizerStats));
  const visitFinalSpeeds = (stateTree: AttributeTreeNode<SearchState>, groupIndex: number,
    prefixSpeed: number, nodes: AttributeTreeNode<GearOption>[], maxima: OptimizerStats,
    work: number, prefixBudget = 0, prefixCritical = 0): void => {
    if (groupIndex === groups.length) {
      const previousBranches = visitedBranches;
      const previousCandidates = finalCandidates;
      const nativeResult = searchBackend?.({ input, prefix: stateTree, options: nodes,
        reference: bestState!.stats, minimumDamage: pruningDamage }, update => {
        visitedBranches = previousBranches + update.visitedBranches;
        finalCandidates = previousCandidates + update.states;
        reportSearchProgress(false, completedWork + work * update.fraction);
      });
      if (nativeResult === undefined) {
        searchFinalOptions(stateTree, nodes, maxima, work);
      } else {
        if (!nativeResult.complete) throw new Error('Incomplete WASM search cannot establish an exact result.');
        visitedBranches = previousBranches + nativeResult.visitedBranches;
        finalCandidates = previousCandidates + nativeResult.states;
        exploredStates += nativeResult.states;
        if (nativeResult.prefix !== undefined) {
          const selected = nativeResult.options!;
          const optionStats = selected.reduce((stats, option) => addStats(stats, option.stats), {});
          const evaluation = evaluateCombinedStats(nativeResult.prefix.stats, optionStats, input, combinedDamage);
          if (Math.abs(evaluation.damage - nativeResult.damage) > 1e-10 * Math.max(1, evaluation.damage) ||
              !meetsCombinedObjective(evaluation, nativeResult.prefix.stats, optionStats, input)) throw new Error('WASM 求解结果未通过伤害或约束校验。');
          if (evaluation.damage > bestEvaluation.damage) {
            const combinedStats = addStats(nativeResult.prefix.stats, optionStats);
            bestEvaluation = evaluation;
            pruningDamage = Math.max(pruningDamage, evaluation.damage);
            bestStats = applyFood(combinedStats, input.food);
            bestState = { stats: combinedStats, choices: [], previous: nativeResult.prefix,
              selected: selected.flatMap(option => option.choices) };
          }
        }
        completedWork += work;
      }
      return;
    }
    const remaining = speedPlan.completionMaxima[groupIndex].get(prefixSpeed);
    if (remaining === undefined) { completedWork += work; return; }
    const upperStats = sumInto(routeBounds[groupIndex], maxima, remaining);
    const independent = feasibleDamageBound(stateTree.maxima, upperStats, input, combinedDamage);
    let bound = independent;
    if (bound > pruningDamage && secondaryBudgetBound !== undefined) {
      const limits = remainingLimits(groupIndex, prefixSpeed);
      bound = secondaryBudgetBound(sumInto(budgetMaxima[groupIndex], stateTree.maxima, upperStats),
        stateTree.minimumCritical + prefixCritical + limits.critical,
        stateTree.maximumSecondaryTotal + prefixBudget + limits.budget, independent);
    }
    if (bound <= pruningDamage) { completedWork += work; return; }
    const allowedSpeeds = speedPlan.allowedOptionSpeeds[groupIndex].get(prefixSpeed) ?? [];
    const parentWork = completionWork(groupIndex, prefixSpeed);
    for (const speed of allowedSpeeds) {
      let tree = finalTrees[groupIndex].get(speed);
      if (tree === undefined) {
        tree = buildAttributeTree(speedPlan.optionsBySpeed[groupIndex].get(speed)!);
        finalTrees[groupIndex].set(speed, tree);
      }
      nodes.push(tree);
      visitFinalSpeeds(stateTree, groupIndex + 1, prefixSpeed + speed,
        nodes, sumInto(routeMaxima[groupIndex], maxima, tree.maxima), work *
          speedPlan.optionsBySpeed[groupIndex].get(speed)!.length *
          completionWork(groupIndex + 1, prefixSpeed + speed) / parentWork,
        prefixBudget + tree.maximumSecondaryTotal, prefixCritical + tree.minimumCritical);
      nodes.pop();
    }
  };
  for (const { speed, tree } of stateTrees) {
    const prefixSpeed = speed - speedPlan.fixedSpeed;
    visitFinalSpeeds(tree, finalGroupIndex, prefixSpeed, [], {}, tree.count *
      completionWork(finalGroupIndex, prefixSpeed));
  }
  reportSearchProgress(true);
  if (bestState === undefined || bestStats === undefined) {
    throw new NoFeasibleOptimizationSolution();
  }
  return {
    ...bestEvaluation,
    stats: bestStats,
    gears: reconstruct(bestState),
    food: input.food,
    criticalRange: input.criticalRange,
    exploredStates,
  };
}

function noFeasibleOptimizationError(input: GearOptimizationInput): Error {
  if (input.objective?.type === 'minimumTenacity') {
    return new Error(`没有找到坚韧减伤不低于 ` +
      `${(input.objective.minimumTenacityMitigation * 100).toFixed(1)}%` +
      ` 且最终 GCD 为 ${input.targetGcd.toFixed(2)} 秒的完整配装。`);
  }
  return new Error(`没有找到最终 GCD 为 ${input.targetGcd.toFixed(2)} 秒的完整配装。`);
}

function fixedFoodInputs(input: GearOptimizationInput): GearOptimizationInput[] {
  if (input.foods === undefined) return [input];
  if (input.foods.length === 0) return [{ ...input, foods: undefined }];
  return input.foods.map(food => ({ ...input, food, foods: undefined }));
}

export function planGearOptimization(request: GearOptimizationInput,
  nativeBackend?: OptimizerSearchBackend): GearOptimizationPlan {
  validateOptimizationInput(request);
  const input = resolveCriticalPreference(request, nativeBackend);
  const backend = criticalBackend(input, nativeBackend);
  const plans: GearOptimizationPlan[] = [];
  for (const fixedInput of fixedFoodInputs(input)) {
    try {
      plans.push(planFixedFoodGearOptimization(fixedInput, backend));
    } catch (error) {
      if (!(error instanceof NoFeasibleOptimizationSolution)) throw error;
    }
  }
  if (plans.length === 0) throw noFeasibleOptimizationError(input);
  const partitions = plans.flatMap(plan => plan.partitions)
    .sort((left, right) => right.heuristicDamage - left.heuristicDamage ||
      right.estimatedWork - left.estimatedWork);
  const heuristicResult = plans.map(plan => plan.heuristicResult)
    .reduce((best, candidate) => candidate.damage > best.damage ? candidate : best);
  const shardCount = Math.max(1, Math.min(64, Math.trunc(backend?.candidateShardCount ?? 1)));
  const tasks = partitions.flatMap(partition => shardCount === 1 || partition.estimatedWork < 10_000_000_000
    ? [partition]
    : Array.from({ length: shardCount }, (_, index) => ({ ...partition,
      candidateShard: { index, count: shardCount }, estimatedWork: partition.estimatedWork / shardCount })));
  return { partitions: tasks, heuristicResult, criticalRange: input.criticalRange };
}

export function optimizeGearset(request: GearOptimizationInput,
  onProgress?: (progress: OptimizerProgress) => void,
  nativeBackend?: OptimizerSearchBackend): GearOptimizationResult {
  validateOptimizationInput(request);
  const input = resolveCriticalPreference(request, nativeBackend);
  const searchBackend = criticalBackend(input, nativeBackend);
  let best: GearOptimizationResult | undefined;
  let exploredStates = 0;
  for (const fixedInput of fixedFoodInputs(input)) {
    try {
      const result = optimizeFixedFoodGearset({
        ...fixedInput,
        globalMinimumDamage: Math.max(
          fixedInput.globalMinimumDamage ?? -Infinity, best?.damage ?? -Infinity),
      }, onProgress, searchBackend);
      exploredStates += result.exploredStates;
      if (best === undefined || result.damage > best.damage) best = result;
    } catch (error) {
      if (!(error instanceof NoFeasibleOptimizationSolution)) throw error;
    }
  }
  if (best === undefined) {
    if (input.candidateShard !== undefined) return { empty: true, damage: -Infinity,
      tenacityMitigation: 0, stats: {}, gears: [], exploredStates };
    throw noFeasibleOptimizationError(input);
  }
  return { ...best, exploredStates };
}
