export interface TenacityLevelModifiers {
  sub: number;
  div: number;
}

const floor = (value: number): number => Math.trunc(value + 1e-7);

export function calculateTenacityMitigation(tenacity: number | undefined,
  { sub, div }: TenacityLevelModifiers): number {
  return floor(200 * ((tenacity ?? sub) - sub) / div) / 1000;
}
