"""Soundness regressions and independent bounded oracle comparisons."""
from pathlib import Path
from fractions import Fraction
import copy
import json
import runpy
import time

HERE = Path(__file__).parent
ROOT = HERE.parents[1]
P = runpy.run_path(str(HERE / 'optimizer-proof-producer.py'))
V = runpy.run_path(str(HERE / 'optimizer-proof-checker.py'))
O = runpy.run_path(str(HERE / 'optimizer-raw-oracle.py'))


def rejected(source, proof):
    try:
        V['verify'](source, proof)
    except Exception:
        return
    raise AssertionError('Tampered/incomplete proof was accepted')


def expected(source):
    rows, _ = O['enumerate_raw'](source)
    minimum = Fraction(str(source.get('objective', {}).get('minimumTenacityMitigation', 0)))
    rows = [r for r in rows if r[0] == round(source['targetGcd'] * 100) and (source.get('objective', {}).get('type') != 'minimumTenacity' or r[1] >= minimum)]
    preference = source.get('criticalPreference', 'none')
    if rows and preference != 'none':
        low = min(r[3] for r in rows);high = max(r[3] for r in rows)
        threshold = low + (high - low) * Fraction(3 if preference == 'high' else 1, 4)
        rows = [r for r in rows if (r[3] >= threshold if preference == 'high' else r[3] <= threshold)]
    return max((r[2] for r in rows), default=None)


start = time.monotonic();corpus = O['generate'](ROOT, 512, 20261030)
proofs = [];total_nodes = 0
for case in corpus['cases']:
    source = case['input'];truth = expected(source)
    proof = P['generate'](source, seconds=10)
    assert proof['complete'], (case['id'], proof.get('reason'))
    checked = V['verify'](source, proof, seconds=10)
    assert (checked['status'] == 'certified-infeasible') == (truth is None), (case['id'], checked, truth)
    if truth is not None:
        assert Fraction(checked['exactScore']) == truth, (case['id'], checked['exactScore'], truth)
    proofs.append((source, proof, checked));total_nodes += checked['nodes']

source, proof, checked = next(item for item in proofs if item[2]['status'] == 'certified-optimal' and any(type(root) is list for phase in item[1]['phases'] for root in phase['roots']))
mutations = []
q = copy.deepcopy(proof);q['complete'] = False;mutations.append(q)
q = copy.deepcopy(proof);q['inputHash'] = '0' * 64;mutations.append(q)
q = copy.deepcopy(proof);q['order'] = q['order'][:-1];mutations.append(q)
q = copy.deepcopy(proof);q['phases'] = q['phases'][:-1];mutations.append(q)
q = copy.deepcopy(proof);q['phases'][-1]['roots'] = [];mutations.append(q)
q = copy.deepcopy(proof);q['phases'][-1]['value'] = '999999999';mutations.append(q)
q = copy.deepcopy(proof);q['phases'][-1]['witness']['selection'] = [];mutations.append(q)
q = copy.deepcopy(proof);q['phases'][-1]['roots'][0] = 'I';mutations.append(q)
q = copy.deepcopy(proof);q['phases'][-1]['roots'][0] = 'L';mutations.append(q)
q = copy.deepcopy(proof);q['phases'][-1]['roots'][0] = ['S', []];mutations.append(q)
for altered in mutations:
    rejected(source, altered)
changed_input = copy.deepcopy(source);changed_input['fixedStats']['CRT'] += 1;rejected(changed_input, proof)
# A forged bound cannot declare a larger value without an attainable witness.
q = copy.deepcopy(proof);q['phases'][-1]['value'] = str(Fraction(checked['exactScore']) * 2);q['phases'][-1]['roots'] = ['B'] * len(q['phases'][-1]['roots']);rejected(source, q)
# Proofs are rebound to actual raw inputs, never to native/MILP narrowed hints.
q = copy.deepcopy(source);q['globalMinimumDamage'] = 1e12;q['targetSpeedContribution'] = 999999;q['criticalRange'] = {'minimum':0,'maximum':0,'midpoint':0,'threshold':0}
strict = V['verify'](q, P['generate'](q, seconds=10));assert strict['exactScore'] == checked['exactScore']
# Incomplete and zero-budget proof attempts must fail closed.
rejected(source, P['generate'](source, seconds=0))
rejected(source, P['generate'](source, max_nodes=0))
rejected(source, proof | {'version':'foreign-proof-v99'})
# Arbitrary BLU additions need not be monotone: max-over-interval remains safe.
blu = copy.deepcopy(next(c['input'] for c in corpus['cases'] if c['input']['damage']['job'] == 'BLU' and expected(c['input']) is not None))
blu['damage']['bluMdmgAdditions'] = [100 if i % 3 == 0 else 0 for i in range(3000)]
strict = V['verify'](blu, P['generate'](blu, seconds=10));assert Fraction(strict['exactScore']) == expected(blu)
# Exact-ID symmetry must retain two distinct interchangeable unique rings.
equal_rings = copy.deepcopy(corpus['cases'][1]['input'])
equal_rings['criticalPreference'] = 'none';equal_rings.pop('criticalRange', None)
equal_rings['lockedGearIds'] = [];equal_rings['lockedGears'] = []
ring = copy.deepcopy(next(g for g in equal_rings['gears'] if g['slot'] == 12));ring['unique'] = True
rings = []
for identifier in range(120, 128):
    rings.append({**copy.deepcopy(ring), 'id': identifier})
equal_rings['gears'] = [g for g in equal_rings['gears'] if g['slot'] != 12] + rings
all_rows, _ = O['enumerate_raw'](equal_rings);equal_rings['targetGcd'] = all_rows[0][0] / 100
for locked in [False, True]:
    if locked:
        equal_rings['lockedGearIds'] = [127];equal_rings['lockedGears'] = [{'id':127,'slot':-12}]
    q = P['generate'](equal_rings, seconds=10);answer = V['verify'](equal_rings, q)
    assert Fraction(answer['exactScore']) == expected(equal_rings)
    ids = [g['id'] for g in answer['result']['gears'] if g['slot'] == 12];assert len(set(ids)) == 2
    if locked:assert 127 in ids
q = copy.deepcopy(proof);q['complete'] = True;q['phases'] = [];rejected(source, q)
changed = copy.deepcopy(source);main = 'STR' if changed['damage']['mainStat'] == 'VIT' else changed['damage']['mainStat'];changed['fixedStats'][main] += 100
q = copy.deepcopy(proof);q['inputHash'] = P['K'].input_hash(changed);rejected(changed, q)
# JSON null is the serialized unbounded-cap convention used by full fixtures.
null_caps = copy.deepcopy(source)
for gear in null_caps['gears']:
    gear['caps']['DLY'] = None;gear['caps'][null_caps['materiaStats'][0]] = None
sanitized = copy.deepcopy(null_caps)
for gear in sanitized['gears']:
    gear['caps'] = {key:value for key,value in gear['caps'].items() if value is not None}
answer = V['verify'](null_caps, P['generate'](null_caps, seconds=10))
assert Fraction(answer['exactScore']) == expected(sanitized)
# A fake numeric score on a proposal supplies no bound; a verified witness does.
proposal = copy.deepcopy(checked['result']);proposal['score'] = 1e300;proposal['damage'] = 1e300
answer = V['verify'](source, P['generate'](source, proposal, seconds=10));assert answer['exactScore'] == checked['exactScore']
# An attainable but suboptimal claim must also fail independent bound checking.
from itertools import product
for case in corpus['cases']:
    if case['input']['criticalPreference'] != 'none' or expected(case['input']) is None:
        continue
    problem = P['K'].Problem(case['input']);truth = expected(case['input']);inferior = None
    for food in range(len(problem.foods)):
        for indices in product(*(range(len(domain)) for domain in problem.domains)):
            witness = {'food':food,'selection':list(indices)};value = problem.evaluate_witness(witness,'score')
            if value is not None and value < truth:
                inferior = (witness,value);break
        if inferior:break
    if inferior:
        optimal = P['generate'](case['input'],seconds=10);forged = copy.deepcopy(optimal)
        forged['phases'][-1]['witness'] = inferior[0];forged['phases'][-1]['value'] = str(inferior[1]);forged['phases'][-1]['roots'] = ['B']*len(problem.foods)
        rejected(case['input'],forged)
        proposal = problem.public_result(inferior[0]);answer = V['verify'](case['input'],P['generate'](case['input'],proposal,seconds=10))
        assert Fraction(answer['exactScore']) == truth
        break
else:raise AssertionError('No suboptimal attainable test witness found')
overflow = copy.deepcopy(source);main = 'STR' if overflow['damage']['mainStat'] == 'VIT' else overflow['damage']['mainStat'];overflow['fixedStats'][main] = 2**53-1
rejected(overflow, P['generate'](overflow, seconds=10))
print(json.dumps({'passed':True,'independentOracleCases':len(proofs),'verifiedNodes':total_nodes,'schemaTamperingCases':len(mutations),'targetedRegressions':['inputBinding','attainableBounds','untrustedHints','budgets','version','nonmonotoneBLU','uniqueIDSymmetry','lockedSymmetry','nullCaps','untrustedCandidateScores','unsafeAggregateStats'],'nonmonotoneBlu':True,'seconds':time.monotonic()-start}))
