"""Trusted exact rules for raw-domain optimizer certificates.

No imports from the optimizer, HiGHS, MILP, or the proof producer. The proof
checker trusts only this module's domain construction, arithmetic and bounds.
"""
from fractions import Fraction
from itertools import product
from collections import Counter
import hashlib
import json

F = Fraction
VERSION = 'ffxiv-raw-proof-v1'
MAX_SAFE = 2**53 - 1


class Unsupported(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Unsupported(message)


def integer(value):
    require(type(value) is int and 0 <= value <= MAX_SAFE, 'Expected nonnegative safe integer')
    return value


def rational(value):
    require(type(value) in (int, float, str), 'Expected rational number')
    result = F(str(value))
    require(abs(result.numerator) <= MAX_SAFE * result.denominator, 'Rational magnitude too large')
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def input_hash(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def add(left, right):
    result = dict(left)
    for key, value in right.items():
        result[key] = result.get(key, 0) + value
    return result


def floor(value):
    value = F(value)
    # On this supported domain exact floor agrees with the game's positive
    # integer-floor rules. No tolerance or float operation enters a proof.
    require(value >= 0, 'Negative intermediate is outside the supported floor domain')
    return value.numerator // value.denominator


def with_food(raw, food):
    result = dict(raw)
    if food:
        for stat, maximum in food['stats'].items():
            rate = food.get('statRates', {}).get(stat)
            bonus = maximum if rate is None else min(maximum, floor(F(raw.get(stat, 0)) * rational(rate) / 100))
            result[stat] = raw.get(stat, 0) + bonus
    return result


def effective_tenacity(stats, context):
    return stats.get('TEN', context['level']['sub'])


def mitigation(stats, context):
    level = context['level']
    # Supported inputs have TEN >= sub. An absent TEN uses the base value.
    return F(floor(F(200 * (effective_tenacity(stats, context) - level['sub']), level['div'])), 1000)


def gcd(stats, problem):
    context = problem['damage']
    level = context['level']
    speed = stats.get(problem['speedStat'], 0)
    modifier = context['statModifiers'].get('gcd', 100) if context['jobLevel'] >= 80 else 100
    reduced = 1000 - floor(F(130 * (speed - level['sub']), level['div']))
    return floor(F(floor(F(reduced * 2500, 1000)) * modifier, 1000))


def expected_damage(stats, context, blu_addition=None):
    level = context['level']
    main, sub, div = level['main'], level['sub'], level['div']
    attack = 'STR' if context['mainStat'] == 'VIT' else context['mainStat']
    blu = 200 if context['job'] == 'BLU' else 0
    critical = F(floor(F(200 * (stats.get('CRT', 0) - sub), div) + 50 + blu), 1000)
    critical_damage = F(floor(F(200 * (stats.get('CRT', 0) - sub), div) + 1400), 1000)
    determination = F(floor((F(140 * (stats.get('DET', 0) - main), level['det']) + 1000) / level['detTrunc']) * level['detTrunc'], 1000)
    direct = F(floor(F(550 * (stats.get('DHT', 0) - sub), div) + blu), 1000)
    tenacity = F(floor(F(112 * (effective_tenacity(stats, context) - sub), div) + 1000), 1000)
    weapon = floor(F(main * context['statModifiers'][attack], 1000)) + stats.get('MDMG' if context['mainStat'] in ('INT', 'MND') else 'PDMG', 0)
    if context['job'] == 'BLU':
        if blu_addition is None:
            index = stats.get('INT', 0) - context['baseStats']['INT']
            additions = context['bluMdmgAdditions']
            blu_addition = additions[index] if 0 <= index < len(additions) else 0
        weapon += blu_addition
    ap = level['apTank'] if context['mainStat'] == 'VIT' else level['ap']
    party = floor(F(stats.get(attack, 0)) * rational(context.get('partyBonus', 1.05)))
    main_damage = F(floor(F(ap * (party - main), main) + 100), 100)
    return F(1, 100) * weapon * main_damage * determination * tenacity * rational(context['traitDamageMultiplier']) * (1 + (critical_damage - 1) * critical) * (1 + direct / 4)


def score(stats, problem, blu_addition=None):
    damage = expected_damage(stats, problem['damage'], blu_addition)
    objective = problem.get('objective', {})
    if objective.get('type') == 'tenacityTradeoff':
        damage *= 1 + mitigation(stats, problem['damage']) / rational(objective['mitigationPointsPerDamagePercent'])
    return damage


def materialize_gear(gear, melds):
    raw = dict(gear['stats'])
    if not gear['synced']:
        used = set()
        for meld in melds:
            index = meld['slot']
            require(type(index) is int and 0 <= index < len(gear['materiaSlots']) and index not in used, 'Invalid materia slot')
            used.add(index)
            slot = gear['materiaSlots'][index]
            require(meld['grade'] == slot['grade'] and meld['value'] == slot['value'], 'Materia grade/value mismatch')
            stat = meld['stat']
            require(stat in {'CRT', 'DET', 'DHT', 'TEN', 'PIE', 'SKS', 'SPS'}, 'Unknown locked materia stat')
            cap = gear.get('caps', {}).get(stat)
            raw[stat] = raw.get(stat, 0) + (meld['value'] if cap is None else min(meld['value'], max(0, cap - raw.get(stat, 0))))
    else:
        require(not melds, 'Synced equipment cannot have effective materia')
    return raw


class Problem:
    def __init__(self, value, tick=lambda: None):
        self.input = value
        self.fixed = value['fixedStats']
        self.damage = value['damage']
        self.mode = value.get('criticalPreference', 'none')
        require(self.mode in ('none', 'high', 'low'), 'Unknown CRT preference')
        self.target = rational(value['targetGcd']) * 100
        require(self.target.denominator == 1 and self.target > 0, 'GCD must be positive hundredths')
        # Search hints are not user constraints. In particular an unattested
        # floating incumbent must never exclude a legal global optimum.
        self.cutoff = F(0)
        objective = value.get('objective', {'type': 'damage'})
        require(objective.get('type') in ('damage', 'minimumTenacity', 'tenacityTradeoff'), 'Unknown objective')
        self.minimum = rational(objective['minimumTenacityMitigation']) if objective['type'] == 'minimumTenacity' else None
        if self.minimum is not None:
            require(0 <= self.minimum < 1, 'Invalid mitigation requirement')
        if objective['type'] == 'tenacityTradeoff':
            require(self.damage['mainStat'] == 'VIT' and F(1, 100) <= rational(objective['mitigationPointsPerDamagePercent']) <= 100, 'Invalid mitigation tradeoff')
        require(value['speedStat'] in ('SKS', 'SPS'), 'Unknown speed stat')
        require(len(set(value['slots'])) == len(value['slots']) and len(value['slots']) <= 20, 'Duplicate/unsupported slots')
        require(value.get('materiaStats') and len(set(value['materiaStats'])) == len(value['materiaStats']), 'Empty/duplicate materia stat list')
        require(set(value['materiaStats']).issubset({'CRT', 'DET', 'DHT', 'TEN', 'PIE', 'SKS', 'SPS'}), 'Unknown materia stat')
        require(all(integer(slot) > 0 for slot in value['slots']), 'Invalid requested slot')
        for key, number in self.fixed.items():
            require(isinstance(key, str), 'Invalid stat key')
            integer(number)
        for key in ('main', 'sub', 'div', 'det', 'detTrunc', 'ap', 'apTank'):
            require(integer(self.damage['level'][key]) > 0, 'Invalid level constants')
        require(integer(self.damage['jobLevel']) > 0, 'Invalid job level')
        require(rational(self.damage.get('partyBonus', 1.05)) > 0 and rational(self.damage['traitDamageMultiplier']) > 0, 'Nonpositive multiplier')
        attack_stat = 'STR' if self.damage['mainStat'] == 'VIT' else self.damage['mainStat']
        for number in [self.damage['statModifiers'][attack_stat], self.damage['statModifiers'].get('gcd', 100)]:
            require(integer(number) > 0, 'Invalid stat modifier')
        self.foods = [value['food']] if value.get('food') is not None else value.get('foods') or [None]
        for food in self.foods:
            if food is not None:
                for number in food['stats'].values():
                    integer(number)
                for number in food.get('statRates', {}).values():
                    require(rational(number) >= 0, 'Negative food rate')
        if self.damage['job'] == 'BLU':
            for number in self.damage['bluMdmgAdditions']:
                integer(number)
        self.gears = {}
        for gear in value['gears']:
            key = (integer(gear['id']), integer(gear['slot']))
            require(key not in self.gears, 'Duplicate gear ID/slot')
            for number in gear['stats'].values():
                integer(number)
            for number in gear.get('caps', {}).values():
                if number is not None:
                    integer(number)
            for slot in gear['materiaSlots']:
                integer(slot['grade']); integer(slot['value'])
            self.gears[key] = gear
        require(all(type(gear['unique']) is bool and type(gear['synced']) is bool for gear in value['gears']), 'Gear flags must be boolean')
        self.required_counts = Counter(integer(identifier) for identifier in value.get('lockedGearIds', []))
        self.required_ids = set(self.required_counts)
        excluded = set(value.get('excludedGearIds', []))
        locks = value.get('lockedGears')
        if locks is None:
            locks = []
            ring = 0
            for identifier in value.get('lockedGearIds', []):
                matches = [gear for gear in value['gears'] if gear['id'] == identifier]
                require(len(matches) == 1, 'Missing/ambiguous legacy lock')
                slot = matches[0]['slot']
                locks.append({'id': identifier, 'slot': -12 if slot == 12 and ring else slot})
                if slot == 12:
                    ring += 1
        require(len(set(lock['slot'] for lock in locks)) == len(locks), 'Duplicate explicit locked slot')
        require(all(abs(lock['slot']) in value['slots'] and (lock['slot'] > 0 or lock['slot'] == -12) for lock in locks), 'Invalid locked slot')
        self.domains = []
        self.slots = []
        for slot in value['slots']:
            for occurrence in range(2 if slot == 12 else 1):
                signed = -12 if occurrence else slot
                lock = next((item for item in locks if item['slot'] == signed), None)
                self.slots.append(signed)
                domain = []
                candidates = [gear for gear in value['gears'] if gear['slot'] == slot and gear['id'] not in excluded]
                locked_here = self.required_ids.intersection(gear['id'] for gear in candidates) if slot != 12 else set()
                if locked_here:
                    candidates = [gear for gear in candidates if gear['id'] in locked_here]
                if lock:
                    candidates = [gear for gear in candidates if gear['id'] == lock['id']]
                for gear in candidates:
                    fixed = lock is not None and 'melds' in lock
                    if fixed:
                        recipes = [[{**meld, 'slot': meld.get('slot', i)} for i, meld in enumerate(lock['melds'])]]
                    else:
                        slots = [] if gear['synced'] else gear['materiaSlots']
                        recipes = ([{'stat': stat, 'grade': slot['grade'], 'value': slot['value'], 'slot': i} for i, (stat, slot) in enumerate(zip(stats, slots))] for stats in product(value['materiaStats'], repeat=len(slots)))
                    seen = set()
                    for recipe in recipes:
                        tick()
                        require(fixed or all(meld['stat'] in value['materiaStats'] for meld in recipe), 'Invalid unlocked materia')
                        stats = materialize_gear(gear, recipe)
                        # Equal full stats for the same ID are indistinguishable
                        # to every constraint and score. Keep a legal witness.
                        signature = canonical(stats)
                        if signature not in seen:
                            seen.add(signature)
                            domain.append({'id': gear['id'], 'unique': gear['unique'], 'stats': stats, 'melds': recipe, 'gear': gear})
                self.domains.append(domain)
        # Exact ID symmetry, not statistical dominance: IDs are interchangeable
        # only when they expose the same FULL stat menus in the same domains.
        # Keep m distinct representatives for unique IDs used in m domains;
        # a feasible selection can use at most m of them. Required IDs never
        # merge. The checker rebuilds these classes from original raw options.
        menus = {}
        flags = {}
        for domain_index, domain in enumerate(self.domains):
            for option in domain:
                identifier = option['id']
                menus.setdefault(identifier, {}).setdefault(domain_index, set()).add(canonical(option['stats']))
                flags.setdefault(identifier, set()).add(option['unique'])
        require(all(len(values) == 1 for values in flags.values()), 'Inconsistent unique flag for an ID')
        classes = {}
        for identifier, by_domain in menus.items():
            unique = next(iter(flags[identifier]))
            signature = (identifier,) if identifier in self.required_ids else (unique, tuple((i, tuple(sorted(values))) for i, values in sorted(by_domain.items())))
            classes.setdefault(signature, []).append(identifier)
        keep = set()
        for identifiers in classes.values():
            first = identifiers[0]
            count = len(menus[first]) if next(iter(flags[first])) else 1
            keep.update(sorted(identifiers)[:count])
        self.raw_option_count = sum(len(domain) for domain in self.domains)
        self.domains = [[option for option in domain if option['id'] in keep] for domain in self.domains]
        self.stats = sorted(set(self.fixed).union(*(set(o['stats']) for domain in self.domains for o in domain)))
        self.minima = [{stat: min((o['stats'].get(stat, 0) for o in domain), default=0) for stat in self.stats} for domain in self.domains]
        self.maxima = [{stat: max((o['stats'].get(stat, 0) for o in domain), default=0) for stat in self.stats} for domain in self.domains]
        self.always = [set.intersection(*(set(o['stats']) for o in domain)) if domain else set() for domain in self.domains]
        self.ids = [{o['id'] for o in domain} for domain in self.domains]
        # Verify the monotonic-domain assumptions once over a safe outer box.
        lows, highs, guaranteed = self.raw_box({}, [], list(range(len(self.domains))))
        require(all(0 <= value <= MAX_SAFE for value in highs.values()), 'Aggregate attributes exceed safe integer domain')
        for food in self.foods:
            lo, hi = self.food_box(lows, highs, guaranteed, food)
            require(all(0 <= value <= MAX_SAFE for value in hi.values()), 'Food attributes exceed safe integer domain')
            level = self.damage['level']
            for stat, base in [('CRT', level['sub']), ('DHT', level['sub']), ('DET', level['main']), (value['speedStat'], level['sub']), ('TEN', level['sub'])]:
                require(lo.get(stat, base) >= base, 'Stats below supported base: ' + stat)
            expected_damage(lo, self.damage, self.blu_max(lo, hi))
            gcd(hi, value)

    def raw_box(self, raw, selected, remaining):
        lo = add(self.fixed, raw); hi = dict(lo)
        guaranteed = set(lo)
        for index in remaining:
            domain = self.domains[index]
            for stat in self.stats:
                lo[stat] = lo.get(stat, 0) + self.minima[index][stat]
                hi[stat] = hi.get(stat, 0) + self.maxima[index][stat]
            if domain:
                guaranteed.update(self.always[index])
        return lo, hi, guaranteed

    def food_box(self, low, high, guaranteed, food):
        lo = with_food(low, food); hi = with_food(high, food)
        guaranteed = guaranteed.union((food or {}).get('stats', {}))
        if 'TEN' not in guaranteed:
            sub = self.damage['level']['sub']
            # Presence is semantically distinct from numeric zero. An absent
            # TEN uses sub; retaining it expands, never shrinks, this box.
            possible = 'TEN' in self.fixed or any('TEN' in o['stats'] for domain in self.domains for o in domain) or 'TEN' in (food or {}).get('stats', {})
            if possible:
                lo['TEN'] = min(lo.get('TEN', 0), sub); hi['TEN'] = max(hi.get('TEN', 0), sub)
            else:
                lo['TEN'] = hi['TEN'] = sub
        return lo, hi

    def blu_max(self, low, high):
        if self.damage['job'] != 'BLU':
            return None
        additions = self.damage['bluMdmgAdditions'];base = self.damage['baseStats']['INT']
        a, b = low.get('INT', 0) - base, high.get('INT', 0) - base
        return max([0] + (additions[max(0, a):min(len(additions), b + 1)] if b >= 0 and a < len(additions) else []))

    def box(self, raw, selected, remaining, food, threshold=None):
        low, high, guaranteed = self.raw_box(raw, selected, remaining)
        low, high = self.food_box(low, high, guaranteed, food)
        if threshold is not None:
            if self.mode == 'low':
                high['CRT'] = min(high.get('CRT', 0), threshold.numerator // threshold.denominator)
            elif self.mode == 'high':
                low['CRT'] = max(low.get('CRT', 0), -((-threshold.numerator) // threshold.denominator))
        return low, high

    def impossible(self, raw, selected, remaining, food, threshold=None):
        if any(not self.domains[i] for i in remaining):
            return True
        unique = [o['id'] for o in selected if o['unique']]
        if len(unique) != len(set(unique)):
            return True
        chosen = Counter(o['id'] for o in selected)
        if any(chosen[identifier] + sum(identifier in self.ids[i] for i in remaining) < count for identifier, count in self.required_counts.items()):
            return True
        low, high = self.box(raw, selected, remaining, food, threshold)
        if any(low.get(stat, 0) > high.get(stat, 0) for stat in self.stats):
            return True
        if gcd(high, self.input) > self.target or gcd(low, self.input) < self.target:
            return True
        if self.minimum is not None and mitigation(high, self.damage) < self.minimum:
            return True
        return False

    def bound(self, raw, selected, remaining, food, mode, threshold=None):
        low, high = self.box(raw, selected, remaining, food, threshold)
        if mode == 'minCRT':
            return F(low.get('CRT', 0))
        if mode == 'maxCRT':
            return F(high.get('CRT', 0))
        return score(high, self.input, self.blu_max(low, high))

    def evaluate_witness(self, witness, mode, threshold=None):
        require(isinstance(witness, dict) and set(witness) == {'food', 'selection'}, 'Invalid witness shape')
        require(type(witness['food']) is int and 0 <= witness['food'] < len(self.foods), 'Invalid food witness')
        require(len(witness['selection']) == len(self.domains), 'Incomplete witness')
        selected = []
        raw = {}
        for domain, index in zip(self.domains, witness['selection']):
            require(type(index) is int and 0 <= index < len(domain), 'Invalid option witness')
            option = domain[index];selected.append(option);raw = add(raw, option['stats'])
        food = self.foods[witness['food']]
        if self.impossible(raw, selected, [], food, threshold):
            return None
        stats = with_food(add(self.fixed, raw), food)
        if gcd(stats, self.input) != self.target:
            return None
        if self.minimum is not None and mitigation(stats, self.damage) < self.minimum:
            return None
        if any(Counter(o['id'] for o in selected)[identifier] < count for identifier, count in self.required_counts.items()):
            return None
        if mode == 'score':
            if threshold is not None and (stats['CRT'] > threshold if self.mode == 'low' else stats['CRT'] < threshold):
                return None
            value = score(stats, self.input)
        else:
            value = F(stats.get('CRT', 0))
        return value

    def public_result(self, witness):
        selected = [domain[index] for domain, index in zip(self.domains, witness['selection'])]
        raw = dict(self.fixed)
        for option in selected:
            raw = add(raw, option['stats'])
        stats = with_food(raw, self.foods[witness['food']])
        damage = expected_damage(stats, self.damage)
        value = score(stats, self.input)
        result = {'damage': float(damage), 'score': float(value), 'exactScore': str(value), 'exactDamage': str(damage),
                  'tenacityMitigation': float(mitigation(stats, self.damage)), 'stats': stats,
                  'gears': [{**{k: o['gear'][k] for k in ('id', 'slot', 'name', 'level', 'unique', 'synced')}, 'melds': o['melds']} for o in selected]}
        if self.foods[witness['food']] is not None:
            result['food'] = self.foods[witness['food']]
        return result

    def proposed_witness(self, candidate):
        if not candidate or candidate.get('empty'):
            return None
        try:
            food = candidate.get('food')
            food_index = self.foods.index(food)
            choices = candidate['gears']
            require(len(choices) == len(self.domains), 'Incomplete proposal')
            states = []
            for selection in choices:
                gear = self.gears[(selection['id'], selection['slot'])]
                states.append((selection['id'], materialize_gear(gear, selection['melds'])))
            def match(i, used, indices):
                if i == len(self.domains):
                    counts = Counter(self.domains[d][indices[d]]['id'] for d in range(i))
                    return {'food': food_index, 'selection': indices} if all(counts[k] >= n for k, n in self.required_counts.items()) else None
                for j, (identifier, stats) in enumerate(states):
                    if j in used:
                        continue
                    for k, option in enumerate(self.domains[i]):
                        if option['stats'] == stats and (not option['unique'] or all(self.domains[d][indices[d]]['id'] != option['id'] for d in range(i))):
                            result = match(i + 1, used | {j}, indices + [k])
                            if result:
                                return result
                return None
            return match(0, set(), [])
        except (KeyError, ValueError, Unsupported):
            return None
