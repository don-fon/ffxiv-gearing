// A shared problem-shape rule, independent of job names and equipment IDs.
// Both hard requirements must consume gear attributes beyond fixed stats+food.
export function usesIntegerForJointResources(input) {
  if (input.objective?.type !== 'minimumTenacity' || input.objective.minimumTenacityMitigation <= 0) return false;
  const floor = value => Math.trunc(value + 1e-7);
  const level = input.damage.level;
  const afterFood = (stat, fallback) => {
    const raw = input.fixedStats[stat];
    const maximum = input.food?.stats[stat];
    if (maximum === undefined) return raw ?? fallback;
    const value = raw ?? 0;
    const rate = input.food?.statRates[stat];
    return value + (rate === undefined ? maximum : Math.min(maximum, floor(value * rate / 100)));
  };
  const mitigation = floor(200 * (afterFood('TEN', level.sub) - level.sub) / level.div) / 1000;
  if (mitigation + 1e-12 >= input.objective.minimumTenacityMitigation) return false;
  const speed = afterFood(input.speedStat, 0);
  const modifier = input.damage.jobLevel >= 80 ? input.damage.statModifiers.gcd ?? 100 : 100;
  const gcd = floor(floor((1000 - floor(130 * (speed - level.sub) / level.div)) * 2500 / 1000) * modifier / 1000);
  return gcd > Math.round(input.targetGcd * 100);
}
