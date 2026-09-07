import type { OptimizerGear } from './optimizer';

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
