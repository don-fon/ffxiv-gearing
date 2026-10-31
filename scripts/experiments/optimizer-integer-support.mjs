import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// The experiment shares all candidate and score rules with the production source.
// Keep ring choices separate so the integer model can enforce their multiplicity.
export function compileOptimizerSupport(root, { preprocess = 'baseline' } = {}) {
  if (!['baseline', 'no-pareto', 'direct'].includes(preprocess)) throw new Error('Unknown integer preprocessing.');
  let source = fs.readFileSync(path.join(root, 'src/optimizer.ts'), 'utf8');
  const declaration = 'function buildGroups(input: GearOptimizationInput, backend?: OptimizerSearchBackend): GearOption[][] {';
  const pairLoop = '    for (let i = 0; i < leftOptions.length; i++) {';
  if (!source.includes(declaration) || !source.includes(pairLoop)) {
    throw new Error('Optimizer source changed; review the experimental candidate adapter.');
  }
  source = source.replace(declaration, declaration.replace('):', ', pairRings = true):'))
    .replace(pairLoop, '    if (!pairRings) { groups.push(leftOptions, rightOptions);continue; }\n' + pairLoop);
  if (preprocess === 'no-pareto') {
    const marker = '  const bySpeed = new Map<number, GearOption[]>();';
    if (!source.includes(marker)) throw new Error('Review Pareto ablation adapter.');
    source = source.replace(marker, '  if (true) return options;\n' + marker);
  }
  source += `
export const milpFood = applyFood;
export const milpEvaluate = evaluateStats;
export const milpGcd = gcdHundredths;
export function milpGroups(input) {
  const counts = new Map();
  for (const options of buildGroups(input, criticalBackend(input), false)) {
    counts.set(options, (counts.get(options) ?? 0) + 1);
  }
  return Array.from(counts, ([options, count]) => ({ options, count }));
}
`;
  if (preprocess === 'direct') {
    const marker = 'export function milpGroups(input) {';
    source = source.slice(0, source.lastIndexOf(marker)) + `
import { directGroups } from './direct-groups.mjs';
export function milpGroups(input) {
  return directGroups(input, { deduplicateEquivalentGears, lockedGearOption });
}
`;
  }
  source += `
export function milpMinimalPlan(input, backend) {
  validateOptimizationInput(input);
  const resolved = resolveCriticalPreference(input, backend);
  return {
    partitions: fixedFoodInputs(resolved).map(part => ({ foodId: part.food?.id,
      estimatedWork: 1, heuristicDamage: 0 })),
    criticalRange: resolved.criticalRange,
    heuristicResult: { empty: true, damage: 0, stats: {}, gears: [],
      tenacityMitigation: 0, exploredStates: 0, criticalRange: resolved.criticalRange },
  };
}
`;
  const compile = text => ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return {
    optimizer: compile(source).replaceAll('\'./statFormulas\'', '\'./statFormulas.mjs\''),
    statFormulas: compile(fs.readFileSync(path.join(root, 'src/statFormulas.ts'), 'utf8')),
  };
}
