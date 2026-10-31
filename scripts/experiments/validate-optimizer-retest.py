"""Validate archived complete optimizer outputs independently of JS/WASM code.

Usage: python scripts/experiments/validate-optimizer-retest.py ARCHIVE.json.gz
Does not prove optimality: that comparison is recorded separately per run.
"""
import collections
import gzip
import json
import math
import sys
from pathlib import Path


def game_floor(value):
    return math.trunc(value + 1e-7)


def validate_result(result, input_data, mode):
    stats = dict(input_data['fixedStats'])
    candidates = {(gear['id'], gear['slot']): gear for gear in input_data['gears']}
    counts = collections.Counter()
    unique = set()
    for gear in result['gears']:
        source = candidates[(gear['id'], gear['slot'])]
        assert gear['id'] not in input_data.get('excludedGearIds', [])
        assert gear['synced'] == source['synced']
        assert gear['level'] == source['level']
        assert gear['unique'] == source['unique']
        if source['unique']:
            assert gear['id'] not in unique
            unique.add(gear['id'])
        counts[gear['slot']] += 1
        melds = gear['melds']
        assert len(melds) <= len(source['materiaSlots'])
        assert not (source['synced'] and melds)
        used = set()
        part = dict(source['stats'])
        for meld in melds:
            slot = meld['slot']
            assert isinstance(slot, int) and 0 <= slot < len(source['materiaSlots'])
            assert slot not in used
            used.add(slot)
            assert meld['stat'] in input_data['materiaStats']
            assert meld['grade'] == source['materiaSlots'][slot]['grade']
            assert meld['value'] == source['materiaSlots'][slot]['value']
            stat = meld['stat']
            current = part.get(stat, 0)
            part[stat] = current + min(meld['value'], max(0, source['caps'][stat] - current))
        for stat, value in part.items():
            stats[stat] = stats.get(stat, 0) + value
    required = collections.Counter(input_data['slots'])
    if 12 in required:
        required[12] += 1
    assert counts == required
    # This matrix deliberately contains no locked items. Fail rather than silently
    # claim coverage of locking semantics if a future archive adds them.
    assert not input_data.get('lockedGearIds') and not input_data.get('lockedGears')
    food = result.get('food')
    if food:
        allowed = ([input_data['food']] if input_data.get('food') else input_data.get('foods', []))
        original = next(candidate for candidate in allowed if candidate['id'] == food['id'])
        assert original['stats'] == food['stats']
        assert original.get('statRates', {}) == food.get('statRates', {})
        for stat, maximum in food['stats'].items():
            rate = food.get('statRates', {}).get(stat)
            stats[stat] = stats.get(stat, 0) + (maximum if rate is None else min(maximum, game_floor(stats.get(stat, 0) * rate / 100)))
    assert stats == result['stats']
    context = input_data['damage']
    level = context['level']
    sub, main, div = level['sub'], level['main'], level['div']
    speed = stats[input_data['speedStat']]
    modifier = context['statModifiers'].get('gcd', 100) if context['jobLevel'] >= 80 else 100
    gcd = game_floor(game_floor((1000 - game_floor(130 * (speed - sub) / div)) * 2500 / 1000) * modifier / 1000) / 100
    assert gcd == input_data['targetGcd']
    mitigation = game_floor(200 * (stats.get('TEN', sub) - sub) / div) / 1000
    assert abs(mitigation - result['tenacityMitigation']) < 1e-12
    objective = input_data.get('objective', {})
    if objective.get('type') == 'minimumTenacity':
        assert mitigation + 1e-12 >= objective['minimumTenacityMitigation']
    if mode != 'none':
        critical = result['criticalRange']
        threshold = critical['minimum'] + (critical['maximum'] - critical['minimum']) * (0.75 if mode == 'high' else 0.25)
        assert abs(critical['threshold'] - threshold) < 1e-10
        assert stats['CRT'] >= threshold if mode == 'high' else stats['CRT'] <= threshold
    attack_stat = 'STR' if context['mainStat'] == 'VIT' else context['mainStat']
    blu = 200 if context['job'] == 'BLU' else 0
    critical_chance = game_floor(200 * (stats.get('CRT', 0) - sub) / div + 50 + blu) / 1000
    critical_damage = game_floor(200 * (stats.get('CRT', 0) - sub) / div + 1400) / 1000
    determination = game_floor((140 * (stats.get('DET', 0) - main) / level['det'] + 1000) / level['detTrunc']) * level['detTrunc'] / 1000
    direct_chance = game_floor(550 * (stats.get('DHT', 0) - sub) / div + blu) / 1000
    tenacity = game_floor(112 * (stats.get('TEN', sub) - sub) / div + 1000) / 1000
    weapon_stat = 'MDMG' if context['mainStat'] in ['INT', 'MND'] else 'PDMG'
    weapon = game_floor(main * context['statModifiers'][attack_stat] / 1000) + stats.get(weapon_stat, 0)
    if context['job'] == 'BLU':
        index = stats.get('INT', 0) - context['baseStats']['INT']
        weapon += context['bluMdmgAdditions'][index] if 0 <= index < len(context['bluMdmgAdditions']) else 0
    attack = game_floor((level['apTank'] if context['mainStat'] == 'VIT' else level['ap']) * (game_floor(stats[attack_stat] * context.get('partyBonus', 1.05)) - main) / main + 100) / 100
    damage = 0.01 * weapon * attack * determination * tenacity * context['traitDamageMultiplier'] * ((critical_damage - 1) * critical_chance + 1) * (0.25 * direct_chance + 1)
    assert abs(damage - result['damage']) < 1e-10
    if objective.get('type') == 'tenacityTradeoff':
        score = damage * (1 + max(0, mitigation) / objective['mitigationPointsPerDamagePercent'])
        assert abs(score - result['score']) < 1e-10
    return {'meldSlotsGradesValues': True, 'candidateAndFoodMembership': True, 'reconstructedStats': True, 'recalculatedDamage': damage, 'gcd': gcd, 'mitigation': mitigation, 'criticalPreference': mode}


def validate_archive(data):
    checked = {}
    for row in data['summary']['runs']:
        if row['status'] != 'completed':
            continue
        raw = data['rawRuns'][row['id']][0]
        assert raw['completed'] == raw['partitions']
        assert row['sameObjective']
        checked[row['id']] = validate_result(raw['result'], data['inputs'][row['inputSha256']], row['validation']['criticalThresholdCheck'])
    return checked


if __name__ == '__main__':
    archive = json.loads(gzip.decompress(Path(sys.argv[1]).read_bytes()))
    checked = validate_archive(archive)
    print(json.dumps({'checkedCompleteRuns': len(checked), 'passed': True}))
