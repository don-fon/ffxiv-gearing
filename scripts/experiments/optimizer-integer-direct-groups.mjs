// Range-only candidate adapter for the no-expansion ablation. The extrema are
// not selectable gear plans: the integer model allocates the actual materia.
export function directGroups(input, helpers) {
  const lockedIds = new Set(input.lockedGearIds);
  const excluded = new Set(input.excludedGearIds ?? []);
  let legacyRing = 0;
  const locks = input.lockedGears ?? input.lockedGearIds.map(id => {
    const slot = input.gears.find(gear => gear.id === id)?.slot ?? 0;
    return { id, slot: slot === 12 && legacyRing++ > 0 ? -12 : slot };
  });
  if (input.lockedGearIds.some(id => excluded.has(id))) throw new Error('Locked gear is excluded.');
  const groups = [];
  for (const slot of input.slots) {
    let gears = input.gears.filter(gear => gear.slot === slot && !excluded.has(gear.id));
    const selected = gears.filter(gear => lockedIds.has(gear.id));
    if (slot !== 12 && selected.length) {
      if (selected.length !== 1) throw new Error('Multiple locked gears in one slot.');
      gears = selected;
    }
    gears = helpers.deduplicateEquivalentGears(gears, slot === 12 ? 2 : 1, lockedIds, input.materiaStats);
    if (!gears.length) throw new Error('Empty candidate slot.');
    const fixed = slot === 12 ? undefined : locks.find(lock => Math.abs(lock.slot) === slot && lock.melds !== undefined);
    const fixedOptions = lock => {
      const gear = gears.find(item => item.id === lock.id);
      if (!gear) throw new Error('Locked gear is not a candidate.');
      return [helpers.lockedGearOption(gear, lock.melds)];
    };
    if (fixed) { groups.push(fixedOptions(fixed));continue; }
    const options = gears.flatMap(gear => {
      const choice = { id: gear.id, name: gear.name, level: gear.level, slot: gear.slot,
        unique: gear.unique, synced: gear.synced, melds: [] };
      const maximum = { ...gear.stats };
      const amount = gear.synced ? 0 : gear.materiaSlots.reduce((sum, materia) => sum + materia.value, 0);
      for (const stat of input.materiaStats) {
        const value = gear.stats[stat] ?? 0;
        maximum[stat] = Math.min(value + amount, Math.max(value, gear.caps[stat] ?? Infinity));
      }
      return [{ stats: { ...gear.stats }, choices: [choice] }, { stats: maximum, choices: [choice] }];
    });
    if (slot !== 12) { groups.push(options);continue; }
    const ringLocks = locks.filter(lock => Math.abs(lock.slot) === 12);
    const first = ringLocks.find(lock => lock.slot === 12) ?? (input.lockedGears === undefined ? ringLocks[0] : undefined);
    const second = ringLocks.find(lock => lock.slot === -12) ?? (input.lockedGears === undefined ? ringLocks[1] : undefined);
    const select = lock => lock === undefined ? options : lock.melds !== undefined ? fixedOptions(lock)
      : options.filter(option => option.choices[0].id === lock.id);
    groups.push(select(first), select(second));
  }
  const counts = new Map();
  for (const options of groups) counts.set(options, (counts.get(options) ?? 0) + 1);
  return Array.from(counts, ([options, count]) => ({ options, count }));
}
