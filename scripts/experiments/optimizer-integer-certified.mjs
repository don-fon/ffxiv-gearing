// Experimental integer objective with explicit rounding-error recovery.
// Browser regressions and full-case benchmarks remain required for adoption.
import { build } from './model.mjs';
const INF = 1e30;

export function appendRow(data, entries, lower = -INF, upper = INF) {
  const coefficients = new Map(entries.filter(([, value]) => value !== 0));
  const starts = [0], indices = [], values = [];
  for (let j = 0; j < data.numCols; j++) {
    for (let k = data.matrix.starts[j]; k < data.matrix.starts[j + 1]; k++) {
      indices.push(data.matrix.indices[k]);values.push(data.matrix.values[k]);
    }
    if (coefficients.has(j)) { indices.push(data.numRows);values.push(coefficients.get(j)); }
    starts.push(indices.length);
  }
  return { ...data, numRows: data.numRows + 1,
    rowLower: [...data.rowLower, lower], rowUpper: [...data.rowUpper, upper],
    matrix: { ...data.matrix, numRows: data.numRows + 1, starts, indices, values } };
}

export function buildIntegerObjective(input) {
  const prepared = build(input, { useMinimumCut: false, oneHotScoreTiers: true });
  if (!prepared) return;
  const exactCost = prepared.data.colCost;
  const rounded = exactCost.map(Math.round);
  // Exactly one tier in each factor group contributes to the objective.
  // Each rounded coefficient differs by at most 0.5. The margin also covers
  // the much smaller floating evaluation/log decomposition differences.
  const error = prepared.scoreGroups.length * 0.5 + 0.01;
  const ceiling = score => Math.ceil(-Math.log(score / prepared.base) * prepared.scale + error);
  let data = { ...prepared.data, colCost: rounded };
  const entries = rounded.flatMap((value, j) => value ? [[j, value]] : []);
  const minimum = Number.isFinite(input.globalMinimumDamage) && input.globalMinimumDamage > 0
    ? input.globalMinimumDamage : 0;
  if (minimum) data = appendRow(data, entries, -INF, ceiling(minimum));
  return { ...prepared, data, error, exactCost, ceiling, costEntries: entries, minimum };
}

// In this formulation even continuous cap deltas and CRT tier selectors are
// integer at a valid discrete solution. Check the rounded vector against EVERY
// integer matrix row exactly instead of trusting only reconstructed gear stats.
function checkedSolution(data, solution) {
  const integers = Array.from(solution, value => {
    const rounded = Math.round(value);
    if (!Number.isFinite(value) || Math.abs(value - rounded) > 1e-5) throw Error('Nonintegral model solution');
    return rounded;
  });
  const sums = Array(data.numRows).fill(0);
  for (let j = 0; j < data.numCols; j++) {
    if (integers[j] < data.colLower[j] || integers[j] > data.colUpper[j]) throw Error('Column bound violation');
    for (let k = data.matrix.starts[j]; k < data.matrix.starts[j + 1]; k++) {
      const coefficient = data.matrix.values[k];
      if (!Number.isSafeInteger(coefficient)) throw Error('Noninteger constraint coefficient');
      sums[data.matrix.indices[k]] += coefficient * integers[j];
    }
  }
  for (let i = 0; i < sums.length; i++) {
    if (!Number.isSafeInteger(sums[i]) || sums[i] < data.rowLower[i] || sums[i] > data.rowUpper[i])
      throw Error('Exact integer row violation: ' + i);
  }
  return integers;
}

export function solveIntegerObjective(highs, prepared, { timeLimit = 280,
  onCandidate = () => {}, onProgress = () => {} } = {}) {
  if (!prepared) return { result: undefined, passes: 0, nodes: 0, recoveredOrdering: 0, optimality: 'solver-claim-only' };
  let data = prepared.data, best, passes = 0, nodes = 0, recoveredOrdering = 0;
  const start = performance.now();
  let lastProgress = start;
  const score = result => result.score ?? result.damage;
  const bound = () => Math.max(prepared.minimum, best ? score(best) : 0);
  while (true) {
    const remaining = timeLimit - (performance.now() - start) / 1000;
    if (remaining <= 0) throw Error('Integer objective recovery incomplete');
    const model = highs.createModel(data);
    let solution, objective;
    try {
      model.options.set({ output_flag: false, time_limit: remaining, mip_rel_gap: 0, mip_abs_gap: 0,
        mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9, dual_feasibility_tolerance: 1e-9 });
      model.run({ [highs.constants.callbackType.mipInterrupt](event) {
        if (performance.now() - lastProgress > 5000) {
          lastProgress = performance.now();
          onProgress({ passes, nodes: nodes + Number(event.data.mip_node_count ?? 0) });
        }
      } });
      nodes += Number(model.info.get('mip_node_count') ?? 0);
      const status = model.getModelStatus();
      if (status === highs.constants.modelStatus.infeasible) break;
      if (status !== highs.constants.modelStatus.optimal) throw Error('Integer objective solve incomplete: ' + status);
      solution = checkedSolution(data, model.getSolution().colValue);
      objective = solution.reduce((sum, value, j) => sum + value * data.colCost[j], 0);
      if (!Number.isSafeInteger(objective) || Math.abs(model.getObjectiveValue() - objective) > 1e-3)
        throw Error('Rounded objective mismatch');
      const dual = Number(model.info.get('mip_dual_bound'));
      if (!Number.isFinite(dual) || Math.abs(dual - objective) > 1e-3) throw Error('Unclosed integer objective gap');
      passes++;
    } finally { model.dispose(); }
    if (bound() && objective > prepared.ceiling(bound())) break;
    const actual = prepared.reconstruct(solution);
    const exact = solution.reduce((sum, value, j) => sum + value * prepared.exactCost[j], 0);
    if (Math.abs(exact + Math.log(score(actual) / prepared.base) * prepared.scale) > 0.001)
      throw Error('True score factor mismatch');
    if (score(actual) >= prepared.minimum && (!best || score(actual) > score(best))) {
      if (best) recoveredOrdering++;
      best = actual;onCandidate(actual);
    }
    for (const group of prepared.scoreGroups) {
      const active = group.filter(j => solution[j] === 1);
      if (active.length !== 1) throw Error('Invalid score factor selection');
    }
    // Exclude this SCORE tuple, not one arbitrary gear/materia representation.
    // Every solution with the same factor tiers has the same true score.
    // With one-hot factor groups, requiring one alternative tier is
    // equivalent to bounding the sum of selected tiers by groups.length-1.
    // The lower-bound form avoids a reproducible HiGHS presolve failure
    // while excluding exactly the same score tuple for every input.
    const alternatives = prepared.scoreGroups.flatMap(group => group.filter(j => solution[j] !== 1));
    if (!alternatives.length) break;
    data = appendRow(data, alternatives.map(j => [j, 1]), 1, INF);
    // Any truly better solution must fall within the rounding-error envelope.
    // Searching this envelope recovers the original score ordering exactly up
    // to the explicitly checked floating evaluation margin above.
    if (bound()) data = appendRow(data, prepared.costEntries, -INF, prepared.ceiling(bound()));
  }
  if (best) best.exploredStates = nodes;
  return { result: best, passes, nodes, recoveredOrdering, roundingError: prepared.error, optimality: 'solver-claim-only' };
}
