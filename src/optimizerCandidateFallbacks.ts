import type { OptimizerGear, OptimizerMateriaStat } from './optimizer';

function isPieFree(gear: OptimizerGear): boolean {
  return (gear.stats.PIE ?? 0) === 0;
}

type GearPredicate = (gear: OptimizerGear) => boolean;

function usableCount(gears: OptimizerGear[], required: number, usable: GearPredicate): number {
  const ids = new Set<number>();
  for (const gear of gears) {
    if (!usable(gear)) continue;
    if (!gear.unique) return required;
    ids.add(gear.id);
  }
  return Math.min(required, ids.size);
}

/**
 * Add lower-item-level alternatives when the regular candidate pool cannot
 * fill a slot. Rings require two distinct unique IDs, or one repeatable ID.
 * Lower levels are opened one complete tier at a time.
 */
export function selectRequiredSlotFallbacks(preferredCandidates: OptimizerGear[],
  lowerLevelCandidates: OptimizerGear[], slots: number[],
  usable: GearPredicate = () => true): OptimizerGear[] {
  const result: OptimizerGear[] = [];
  for (const slot of slots) {
    const required = slot === 12 ? 2 : 1;
    const preferredInSlot = preferredCandidates.filter(gear => gear.slot === slot);
    let available = usableCount(preferredInSlot, required, usable);
    if (available >= required) continue;

    const lowerInSlot = lowerLevelCandidates.filter(gear => gear.slot === slot && usable(gear));
    const levels = Array.from(new Set(lowerInSlot.map(gear => gear.level)))
      .sort((left, right) => right - left);
    const selected = Array.from(preferredInSlot);
    for (const level of levels) {
      const sameLevel = lowerInSlot.filter(gear => gear.level === level);
      result.push(...sameLevel);
      selected.push(...sameLevel);
      available = usableCount(selected, required, usable);
      if (available >= required) break;
    }
  }
  return result;
}

/**
 * Add lower-item-level PIE-free alternatives only where the regular candidate
 * pool cannot fill the slot without PIE. Lower levels are opened one complete
 * item-level tier at a time so equal-level stat variants remain eligible.
 */
export function selectPieFreeFallbacks(preferredCandidates: OptimizerGear[],
  lowerLevelCandidates: OptimizerGear[],
  slots: number[]): OptimizerGear[] {
  return selectRequiredSlotFallbacks(preferredCandidates, lowerLevelCandidates, slots, isPieFree);
}

/** Maximum usable secondary stats, respecting each meld's value and stat caps. */
export function maximumSecondaryStatTotal(gear: OptimizerGear, stats: OptimizerMateriaStat[]): number {
  const base = stats.reduce((sum, stat) => sum + (gear.stats[stat] ?? 0), 0);
  const values = gear.synced ? [] : gear.materiaSlots.map(slot => slot.value);
  const budget = values.reduce((sum, value) => sum + value, 0);
  const remaining = stats.map(stat =>
    Math.min(budget, Math.max(0, (gear.caps[stat] ?? Infinity) - (gear.stats[stat] ?? 0))));
  const memo = new Map<string, number>();
  function allocate(index: number, capacities: number[]): number {
    if (index === values.length) return 0;
    // Stat names do not affect the total; canonicalize equivalent allocations.
    const sorted = capacities.slice().sort((left, right) => right - left);
    const key = `${index}:${sorted.join(',')}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let best = 0;
    for (let stat = 0; stat < sorted.length; stat++) {
      if (sorted[stat] === 0 || (stat > 0 && sorted[stat] === sorted[stat - 1])) continue;
      const gain = Math.min(values[index], sorted[stat]);
      const next = sorted.slice();
      next[stat] -= gain;
      best = Math.max(best, gain + allocate(index + 1, next));
    }
    memo.set(key, best);
    return best;
  }
  return base + allocate(0, remaining);
}

/** Compare every lower tier to the original pool, independent of data order. */
export function selectSecondaryStatFallbacks(preferredCandidates: OptimizerGear[],
  lowerLevelCandidates: OptimizerGear[], stats: OptimizerMateriaStat[]): OptimizerGear[] {
  const totals = new Map<number, number>();
  for (const gear of preferredCandidates) {
    totals.set(gear.slot, Math.max(totals.get(gear.slot) ?? -Infinity,
      maximumSecondaryStatTotal(gear, stats)));
  }
  const selectedIds = new Set(preferredCandidates.map(gear => gear.id));
  return lowerLevelCandidates.filter(gear => !selectedIds.has(gear.id) &&
    totals.has(gear.slot) && maximumSecondaryStatTotal(gear, stats) > totals.get(gear.slot)!);
}
