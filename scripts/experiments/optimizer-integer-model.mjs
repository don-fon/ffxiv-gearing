// Experimental integer formulation: select gear once and allocate materia by grade.
// Not enabled in the website. Run through benchmark-optimizer.mjs --integer-model.
// Known false-Optimal browser regression: diagnostic use only, not accepted for adoption.
import { milpGroups, milpFood, milpEvaluate, milpGcd, materializeOptimizationCandidate } from './optimizer.mjs';
const SCALE = 1048576; const INF = 1e30;
export function build(input, { useMinimumCut = true, oneHotScoreTiers = false } = {}) {
    const groups = milpGroups(input).flatMap(g => Array.from({ length: g.count }, () => ({ ...g, count: 1 }))); const cost = []; const upper = []; const kinds = []; const columns = []; const rowLower = []; const rowUpper = [];
    function variable(value = 0, limit = 1, kind = 1) { const j = cost.length; cost.push(value); upper.push(limit); kinds.push(kind); columns.push([]); if (cost.length > 50000)
        throw Error('integer model too large'); return j; }
    function row(entries, lo = -INF, hi = INF) { const i = rowLower.length; rowLower.push(lo); rowUpper.push(hi); for (const [j, v] of entries)
        if (v !== 0)
            columns[j].push([i, v]); }
    const relevant = [...new Set([input.damage.mainStat === 'VIT' ? 'STR' : input.damage.mainStat, 'INT', 'CRT', 'DET', 'DHT', 'TEN', input.damage.mainStat === 'INT' || input.damage.mainStat === 'MND' ? 'MDMG' : 'PDMG', input.speedStat])];
    for (const stat of relevant) {
        if (!Number.isSafeInteger(input.fixedStats[stat] ?? 0))
            throw Error('fractional fixed stats');
        for (const g of groups)
            for (const o of g.options)
                if (!Number.isSafeInteger(o.stats[stat] ?? 0))
                    throw Error('fractional option stats');
    }
    const ranges = new Map(); const reference = { ...input.fixedStats };
    for (const stat of relevant) {
        let low = input.fixedStats[stat] ?? 0; let high = low;
        const minima = [];
        for (const g of groups) {
            const values = g.options.map(o => o.stats[stat] ?? 0);
            const a = Math.min(...values); const b = Math.max(...values);
            minima.push(a);
            low += a * g.count;
            high += b * g.count;
        }
        if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || high - low > 50000)
            throw Error('integer stat range too large');
        ranges.set(stat, { low, high, minima });
        reference[stat] = low;
    }
    const forcedTen = input.fixedStats.TEN !== undefined || input.food?.stats.TEN !== undefined || groups.some(g => g.options.every(o => o.stats.TEN !== undefined));
    const possibleTen = forcedTen || groups.some(g => g.options.some(o => o.stats.TEN !== undefined));
    if (!forcedTen)
        delete reference.TEN;
    const score = raw => milpEvaluate(milpFood(raw, input.food), input).damage;
    const base = score(reference);
    if (!(base > 0 && Number.isFinite(base)))
        throw Error('nonpositive factor reference');
    const scoreGroups = [];
    const statColumns = new Map(); const alternatives = []; const presence = [];
    let maximumPresence = 0;
    for (const stat of relevant)
        statColumns.set(stat, []);
    for (let g = 0; g < groups.length; g++) {
        const group = groups[g]; const ids = [...new Set(group.options.map(o => o.choices[0].id))]; const list = [];
        for (const id of ids) {
            const gear = input.gears.find(item => item.id === id); const locked = group.options.length === 1 && group.options[0].choices[0].meldsLocked;
            const baseline = locked ? group.options[0].stats : gear.stats; const y = variable(); const alt = { gear, y, locked: locked ? group.options[0].choices[0] : undefined, gems: [] };
            list.push(alt);
            const slots = locked || gear.synced ? [] : gear.materiaSlots; const grades = new Map();
            for (const [i, m] of slots.entries()) {
                const key = m.grade + ':' + m.value;
                if (!grades.has(key))
                    grades.set(key, { ...m, slots: [] });
                grades.get(key).slots.push(i);
            }
            for (const grade of grades.values()) {
                const vars = input.materiaStats.map(stat => ({ stat, j: variable(0, grade.slots.length), ...grade }));
                alt.gems.push(...vars);
                row([...vars.map(v => [v.j, 1]), [y, -grade.slots.length]], 0, 0);
            }
            if (baseline.TEN !== undefined) {
                presence.push([y, 1]);
                maximumPresence++;
            }
            for (const gem of alt.gems)
                if (gem.stat === 'TEN') {
                    presence.push([gem.j, 1]);
                    maximumPresence += gem.slots.length;
                }
            for (const stat of relevant) {
                const list = statColumns.get(stat); const base = baseline[stat] ?? 0;
                list.push([y, base - ranges.get(stat).minima[g]]);
                const gems = alt.gems.filter(m => m.stat === stat); const total = slots.reduce((v, m) => v + m.value, 0); const cap = Math.max(0, (gear.caps[stat] ?? Infinity) - base);
                if (!gems.length || cap === 0)
                    continue;
                if (cap >= total) {
                    for (const m of gems)
                        list.push([m.j, m.value]);
                }
                else {
                    const delta = variable(0, cap, 0); const over = variable();
                    list.push([delta, 1]);
                    row([[over, 1], [y, -1]], -INF, 0);
                    row([[delta, 1], ...gems.map(m => [m.j, -m.value])], -INF, 0);
                    row([[delta, 1], [y, -cap]], -INF, 0);
                    row([[delta, 1], ...gems.map(m => [m.j, -m.value]), [over, total - cap]], 0, INF);
                    row([[delta, 1], [y, -cap], [over, -cap]], -cap, INF);
                }
            }
        }
        alternatives.push(list);
        row(list.map(a => [a.y, 1]), 1, 1);
    }
    const unique = new Map();
    for (const list of alternatives)
        for (const alt of list)
            if (alt.gear.unique) {
                const entries = unique.get(alt.gear.id) ?? [];
                entries.push([alt.y, 1]);
                unique.set(alt.gear.id, entries);
            }
    for (const entries of unique.values())
        row(entries, -INF, 1);
    // IDs are identifiers, not numerical magnitudes. Use small ranks for this
    // symmetry constraint. This improves conditioning but is not a sufficient
    // fix for the known full MNK 605 / GCD 1.93 false-Optimal browser regression.
    for (let g = 1; g < groups.length; g++) {
        if (groups[g].options !== groups[g - 1].options) continue;
        const ranks = new Map(alternatives[g].map(a => a.gear.id)
            .sort((a, b) => a - b).map((id, index) => [id, index]));
        row([...alternatives[g - 1].map(a => [a.y, ranks.get(a.gear.id)]),
            ...alternatives[g].map(a => [a.y, -ranks.get(a.gear.id)])], -INF, 0);
    }
    function coefficients(stat) { return statColumns.get(stat); }
    function constrain(stat, choices) { const r = ranges.get(stat); const values = coefficients(stat); row([...values, ...choices.map(t => [t.j, -(t.lo - r.low)])], 0, INF); row([...values, ...choices.map(t => [t.j, -(t.hi - r.low)])], -INF, 0); }
    function lookup(stat, fn) {
        const r = ranges.get(stat); const tiers = [];
        let first; let previous;
        for (let x = r.low; x <= r.high + 1; x++) {
            const value = x <= r.high ? fn(x) : undefined;
            if (value !== previous) {
                if (previous !== undefined)
                    tiers.push({ lo: first, hi: x - 1, value: previous });
                first = x;
                previous = value;
            }
        }
        if (!tiers.length)
            return false;
        const choices = tiers.map(t => ({ ...t, j: variable(-Math.log(t.value) * SCALE, 1, stat === 'CRT' && !oneHotScoreTiers ? 0 : 1) }));
        if (stat !== input.speedStat) scoreGroups.push(choices.map(t => t.j));
        row(choices.map(t => [t.j, 1]), 1, 1);
        if (stat === 'CRT' && !oneHotScoreTiers)
            for (let bit = 0; 2 ** bit < choices.length; bit++) {
                const selector = variable();
                row([...choices.flatMap((t, i) => (i >> bit) & 1 ? [[t.j, 1]] : []), [selector, -1]], 0, 0);
            }
        constrain(stat, choices);
        return true;
    }
    let tenPresence;
    if (possibleTen && !forcedTen) {
        tenPresence = variable();
        row([...presence, [tenPresence, -1]], 0, INF);
        row([...presence, [tenPresence, -Math.max(1, maximumPresence)]], -INF, 0);
    }
    const attack = input.damage.mainStat === 'VIT' ? 'STR' : input.damage.mainStat; const weapon = input.damage.mainStat === 'INT' || input.damage.mainStat === 'MND' ? 'MDMG' : 'PDMG';
    const coupled = input.damage.job === 'BLU' && ranges.get(weapon).high !== ranges.get(weapon).low;
    if (coupled) {
        const a = ranges.get('INT'); const w = ranges.get(weapon);
        if ((a.high - a.low + 1) * (w.high - w.low + 1) > 40000)
            throw Error('coupled lookup too large');
        const choices = [];
        for (let x = a.low; x <= a.high; x++)
            for (let y = w.low; y <= w.high; y++) {
                const value = score({ ...reference, INT: x, [weapon]: y }) / base;
                if (!(value > 0))
                    throw Error('nonpositive coupled factor');
                choices.push({ j: variable(-Math.log(value) * SCALE), x, y });
            }
        scoreGroups.push(choices.map(t => t.j));
        row(choices.map(t => [t.j, 1]), 1, 1);
        row([...coefficients('INT'), ...choices.map(t => [t.j, -(t.x - a.low)])], 0, 0);
        row([...coefficients(weapon), ...choices.map(t => [t.j, -(t.y - w.low)])], 0, 0);
    }
    const factors = [attack, 'CRT', 'DET', 'DHT', weapon].filter((s, i, a) => a.indexOf(s) === i && (!coupled || s !== 'INT' && s !== weapon));
    for (const stat of factors) {
        if (!lookup(stat, x => { const raw = { ...reference, [stat]: x }; if (stat === 'CRT' && input.criticalRange !== undefined) {
            const crt = milpFood(raw, input.food).CRT; const threshold = input.criticalRange.threshold ?? input.criticalRange.midpoint;
            if (input.criticalPreference === 'high' && crt < threshold || input.criticalPreference === 'low' && crt > threshold)
                return undefined;
        } const value = score(raw) / base; if (!(value > 0))
            throw Error('nonpositive factor'); return value; }))
            return undefined;
    }
    const minimum = input.objective?.type === 'minimumTenacity' ? input.objective.minimumTenacityMitigation : undefined;
    function tenValue(x, present) { const raw = { ...reference }; if (present)
        raw.TEN = x;
    else
        delete raw.TEN; const evaluated = milpEvaluate(milpFood(raw, input.food), input); if (minimum !== undefined && evaluated.tenacityMitigation + 1e-12 < minimum)
        return undefined; const value = evaluated.damage / base; if (!(value > 0))
        throw Error('nonpositive tenacity factor'); return value; }
    if (forcedTen) {
        if (!lookup('TEN', x => tenValue(x, true)))
            return undefined;
    }
    else if (!possibleTen) {
        if (tenValue(0, false) === undefined)
            return undefined;
    }
    else {
        const r = ranges.get('TEN'); const choices = [];
        for (let present = 0; present < 2; present++) {
            let first; let previous;
            for (let x = r.low; x <= r.high + 1; x++) {
                const value = x <= r.high ? tenValue(x, Boolean(present)) : undefined;
                if (value !== previous) {
                    if (previous !== undefined)
                        choices.push({ lo: first, hi: x - 1, present, j: variable(-Math.log(previous) * SCALE) });
                    first = x;
                    previous = value;
                }
            }
        }
        if (!choices.length)
            return undefined;
        scoreGroups.push(choices.map(t => t.j));
        row(choices.map(t => [t.j, 1]), 1, 1);
        constrain('TEN', choices);
        row([[tenPresence, 1], ...choices.map(t => [t.j, -t.present])], 0, 0);
    }
    if (!lookup(input.speedStat, x => { if (input.targetSpeedContribution !== undefined &&
            x !== (input.fixedStats[input.speedStat] ?? 0) + input.targetSpeedContribution) return undefined;
        const raw = { ...reference, [input.speedStat]: x }; const stats = milpFood(raw, input.food); return milpGcd(stats[input.speedStat] ?? 0, input) === Math.round(input.targetGcd * 100) ? 1 : undefined; }))
        return undefined;
    if (useMinimumCut && Number.isFinite(input.globalMinimumDamage) && input.globalMinimumDamage > 0)
        row(cost.map((v, j) => [j, -v]), Math.log(input.globalMinimumDamage / base) * SCALE - 1e-3, INF);
    const starts = [0]; const minor = []; const values = [];
    for (const list of columns) {
        for (const [i, v] of list) {
            minor.push(i);
            values.push(v);
        }
        starts.push(minor.length);
    }
    const data = { numCols: cost.length, numRows: rowLower.length, colCost: cost, colLower: cost.map(() => 0), colUpper: upper, rowLower, rowUpper, integrality: kinds, matrix: { format: 'csc', numRows: rowLower.length, numCols: cost.length, starts, indices: minor, values } };
    const reconstruct = solution => {
        const gears = [];
        for (const list of alternatives) {
            let count = 0;
            for (const alt of list) {
                const value = solution[alt.y];
                if (Math.abs(value - Math.round(value)) > 1e-5)
                    throw Error('fractional gear');
                if (value < .5)
                    continue;
                count++;
                if (alt.locked) {
                    gears.push(alt.locked);
                    continue;
                }
                const gear = alt.gear; const melds = [];
                const counts = alt.gems.map(g => ({ ...g, n: Math.round(solution[g.j]) }));
                for (const [i, slot] of (gear.synced ? [] : gear.materiaSlots).entries()) {
                    const gem = counts.find(g => g.grade === slot.grade && g.value === slot.value && g.n > 0);
                    if (!gem)
                        throw Error('invalid materia counts');
                    gem.n--;
                    melds.push({ stat: gem.stat, grade: slot.grade, value: slot.value, slot: i });
                }
                gears.push({ id: gear.id, name: gear.name, level: gear.level, slot: gear.slot, unique: gear.unique, synced: gear.synced, melds });
            }
            if (count !== 1)
                throw Error('wrong gear count');
        }
        const raw = { ...input.fixedStats };
        for (const choice of gears) {
            const gear = input.gears.find(item => item.id === choice.id && item.slot === choice.slot);
            if (!gear || gear.synced && choice.melds.length)
                throw Error('invalid source gear');
            const part = { ...gear.stats };
            for (const meld of choice.melds)
                part[meld.stat] = (part[meld.stat] ?? 0) + Math.min(meld.value, Math.max(0, (gear.caps[meld.stat] ?? Infinity) - (part[meld.stat] ?? 0)));
            for (const [stat, value] of Object.entries(part))
                raw[stat] = (raw[stat] ?? 0) + value;
        }
        const state = { stats: raw, choices: [], selected: gears, previous: { stats: input.fixedStats, choices: [] } };
        return materializeOptimizationCandidate(input, { prefix: state, options: [], damage: score(raw), states: 0, visitedBranches: 0, complete: false });
    };
    return { data, reconstruct, base, scale: SCALE, groups, scoreGroups };
}
