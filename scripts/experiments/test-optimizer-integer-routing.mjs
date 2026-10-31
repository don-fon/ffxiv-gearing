import assert from 'node:assert/strict';
import fs from 'node:fs';
import { usesIntegerForJointResources } from './optimizer-integer-routing.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('../../test/fixtures/warrior-displayed-375-input.json', import.meta.url)));
const input = { ...fixture, food: undefined, targetGcd: 2.5,
  objective: { type: 'minimumTenacity', minimumTenacityMitigation: 0.1 } };
assert.equal(usesIntegerForJointResources(input), false, 'TEN requirement alone keeps native');
const mixed = { ...input, targetGcd: 2.48 };
assert.equal(usesIntegerForJointResources(mixed), true, 'extra speed and TEN use integer model');
assert.equal(usesIntegerForJointResources({ ...mixed, objective: { type: 'minimumTenacity', minimumTenacityMitigation: 0 } }), false);
assert.equal(usesIntegerForJointResources({ ...mixed, objective: { type: 'tenacityTradeoff', mitigationPointsPerDamagePercent: 10 } }), false, 'soft reward is not a second hard constraint');
assert.equal(usesIntegerForJointResources({ ...mixed, food: { stats: { SKS: 36 }, statRates: {} } }), false, 'food alone reaches2.48');
assert.equal(usesIntegerForJointResources({ ...mixed, food: { stats: { SKS: 100 }, statRates: { SKS: 10 } } }), false, 'percentage food uses its floor and cap');
assert.equal(usesIntegerForJointResources({ ...mixed, fixedStats: { ...mixed.fixedStats, TEN: 1264 } }), false, 'fixed TEN alone provides20% mitigation');
assert.equal(usesIntegerForJointResources({ ...mixed, damage: { ...mixed.damage, job: 'WHM' } }), true, 'job name is not a routing criterion');
console.log('8 hard-resource routing regressions passed');
