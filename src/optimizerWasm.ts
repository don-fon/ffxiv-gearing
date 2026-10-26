import type {
  AttributeTreeNode, GearOption, GearOptimizationInput, OptimizerSearchBackend,
  OptimizerSearchTask, OptimizerStat, OptimizerStats, SearchState,
} from './optimizer';

interface SearchExports extends WebAssembly.Exports {
  __heap_base: WebAssembly.Global;
  search_abi: () => number;
  search_cache_bytes: () => number;
  search_frame_bytes: () => number;
  configure_search: (pointer: number) => void;
  start_search: (pointers: number, count: number, threshold: number) => void;
  step_search: (limit: number) => number;
  search_damage: () => number;
  search_visited: () => number;
  search_evaluated: () => number;
  search_coverage: () => number;
  search_selected: (index: number) => number;
  search_error: () => number;
  pareto_node_bytes: () => number;
  pareto_frontier: (values: number, indices: number, temporary: number, nodes: number,
    result: number, count: number, capacity: number) => number;
}

/** ABI 3: node = 16 f64, point = 9 f64, context = 48 f64. Addresses are wasm32 bytes.
 * Vectors: attack-main, INT, CRT, DET, DHT, TEN, PDMG, MDMG, TEN-present.
 * Node tail: secondary-total max, CRT min, left, right, points, length, count.
 * Context tail (44–46): final CRT lower/upper limits and enabled flag.
 * Pointer caches are reset for each fixed-food input; linear memory is reused.
 */
export async function createWasmSearchBackend(bytes: BufferSource,
  minimumCombinations = 0): Promise<OptimizerSearchBackend> {
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 32768 });
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: { memory, log: Math.log, exp: Math.exp },
  });
  const core = instance.exports as SearchExports;
  if (core.search_abi() !== 3) throw new Error('Unsupported optimizer WASM ABI.');
  const heapBase = Number(core.__heap_base.value);
  let nextAddress = heapBase;
  let currentInput: GearOptimizationInput | undefined;
  let attackStat: OptimizerStat = 'STR';
  let treePointers = new WeakMap<AttributeTreeNode<GearOption>, number>();
  const points = new Map<number, GearOption>();
  const allocate = (size: number): number => {
    const pointer = Math.ceil(nextAddress / 8) * 8;
    nextAddress = pointer + size;
    if (nextAddress > 0x7FFFFFFF) throw new Error('Optimizer WASM memory limit exceeded.');
    const missing = nextAddress - memory.buffer.byteLength;
    if (missing > 0) memory.grow(Math.ceil(missing / 65536));
    return pointer;
  };
  const vector = (stats: OptimizerStats): number[] => [
    stats[attackStat] ?? 0, stats.INT ?? 0, stats.CRT ?? 0, stats.DET ?? 0,
    stats.DHT ?? 0, stats.TEN ?? 0, stats.PDMG ?? 0, stats.MDMG ?? 0,
    Number(stats.TEN !== undefined),
  ];
  const packTree = (tree: AttributeTreeNode<GearOption>): number => {
    const cached = treePointers.get(tree);
    if (cached !== undefined) return cached;
    const pointer = allocate(16 * 8);
    treePointers.set(tree, pointer);
    let left = 0;
    let right = 0;
    let pointAddress = 0;
    if (tree.items === undefined) {
      left = packTree(tree.left!);
      right = packTree(tree.right!);
    } else {
      pointAddress = allocate(tree.items.length * 9 * 8);
      for (const [ index, item ] of tree.items.entries()) {
        const address = pointAddress + index * 9 * 8;
        new Float64Array(memory.buffer, address, 9).set(vector(item.stats));
        points.set(address, item);
      }
    }
    new Float64Array(memory.buffer, pointer, 16).set([
      ...vector(tree.maxima), tree.maximumSecondaryTotal, tree.minimumCritical,
      left, right, pointAddress, tree.items?.length ?? 0, tree.count,
    ]);
    return pointer;
  };
  const configure = (task: OptimizerSearchTask) => {
    currentInput = task.input;
    attackStat = currentInput.damage.mainStat === 'VIT' ? 'STR' : currentInput.damage.mainStat;
    nextAddress = heapBase;
    treePointers = new WeakMap();
    points.clear();
    const { damage, fixedStats, food } = currentInput;
    const pointer = allocate(48 * 8);
    const cache = allocate(core.search_cache_bytes());
    const frames = allocate(core.search_frame_bytes());
    const additions = damage.job === 'BLU' ? damage.bluMdmgAdditions : [];
    const lookup = allocate(additions.length * 8);
    if (additions.length > 0) new Float64Array(memory.buffer, lookup, additions.length).set(additions);
    const secondary = ['CRT', 'DET', 'DHT', 'TEN'] as const;
    const lower = secondary.map(stat => fixedStats[stat] ?? 0);
    const budgetEnabled = damage.mainStat === 'VIT' && lower[0] >= damage.level.sub &&
      lower[1] >= damage.level.main && lower[2] >= damage.level.sub && lower[3] >= damage.level.sub &&
      !currentInput.gears.some(gear => secondary.some(stat => (gear.stats[stat] ?? 0) < 0)) &&
      !secondary.some(stat => food?.stats[stat] !== undefined && food.statRates[stat] === undefined);
    const stats: OptimizerStat[] = [attackStat, 'INT', 'CRT', 'DET', 'DHT', 'TEN', 'PDMG', 'MDMG'];
    const context = new Float64Array(memory.buffer, pointer, 48);
    context.set([
      damage.level.main, damage.level.sub, damage.level.div, damage.level.det, damage.level.detTrunc,
      damage.statModifiers[attackStat]!, damage.mainStat === 'VIT' ? damage.level.apTank : damage.level.ap,
      damage.partyBonus ?? 1.05, damage.traitDamageMultiplier,
      Number(damage.mainStat === 'INT' || damage.mainStat === 'MND'), Number(damage.job === 'BLU'),
      damage.baseStats.INT ?? 0, lookup, additions.length,
      currentInput.objective?.type === 'minimumTenacity' ? currentInput.objective.minimumTenacityMitigation : 0,
      Number(budgetEnabled), Number(food?.stats.TEN !== undefined), cache, frames, 0,
      ...stats.map(stat => food?.stats[stat] ?? 0),
      ...stats.map(stat => food?.statRates[stat] === undefined
        ? food?.stats[stat] === undefined ? 0 : -1 : food.statRates[stat]! / 100),
      ...lower, ...secondary.map(stat => task.reference[stat] ?? 0),
      currentInput.criticalPreference === 'high' ? currentInput.criticalRange?.midpoint ?? -Infinity : -Infinity,
      currentInput.criticalPreference === 'low' ? currentInput.criticalRange?.midpoint ?? Infinity : Infinity,
      Number(currentInput.criticalRange !== undefined),
    ]);
    core.configure_search(pointer);
  };
  const backend: OptimizerSearchBackend = (task, report) => {
    const combinations = task.options.reduce((count, tree) => count * tree.count, task.prefix.count);
    if (combinations < minimumCombinations || task.options.length >= 16) return undefined;
    if (currentInput !== task.input) configure(task);
    const trees = [task.prefix, ...task.options];
    const roots = trees.map(tree => packTree(tree));
    const rootAddress = allocate(roots.length * 4);
    new Uint32Array(memory.buffer, rootAddress, roots.length).set(roots);
    core.start_search(rootAddress, roots.length, task.minimumDamage);
    let lastReport = Date.now();
    let complete = false;
    while (!(complete = core.step_search(50_000) !== 0)) {
      if (task.branchLimit !== undefined && core.search_visited() >= task.branchLimit) break;
      if (Date.now() - lastReport >= 1000) {
        lastReport = Date.now();
        report({ fraction: core.search_coverage(), visitedBranches: core.search_visited(),
          states: core.search_evaluated() });
      }
    }
    if (core.search_error() !== 0) throw new Error(`Optimizer WASM search failed (${core.search_error()}).`);
    const selected = roots.map((root, index) => points.get(core.search_selected(index)));
    return {
      prefix: selected[0] as SearchState | undefined,
      options: selected[0] === undefined ? undefined : selected.slice(1) as GearOption[],
      damage: core.search_damage(), visitedBranches: core.search_visited(), states: core.search_evaluated(), complete,
    };
  };
  const dimensions: OptimizerStat[] = ['STR', 'DEX', 'INT', 'MND', 'CRT', 'DET', 'DHT', 'TEN', 'PDMG', 'MDMG'];
  backend.pareto = options => {
    if (options.length < 64) return undefined;
    // Preprocessing occurs before final search, so scratch storage can reuse the arena.
    currentInput = undefined;
    nextAddress = heapBase;
    treePointers = new WeakMap();
    points.clear();
    const values = allocate(options.length * dimensions.length * 8);
    const indices = allocate(options.length * 4);
    const temporary = allocate(options.length * 4);
    const capacity = 2 * Math.ceil(options.length / 16) + 3;
    const nodes = allocate(capacity * core.pareto_node_bytes());
    const output = allocate(options.length * 4);
    const data = new Float64Array(memory.buffer, values, options.length * dimensions.length);
    for (const [ index, option ] of options.entries()) {
      for (let dimension = 0; dimension < dimensions.length; dimension++) {
        data[index * dimensions.length + dimension] = option.stats[dimensions[dimension]] ?? 0;
      }
    }
    const count = core.pareto_frontier(values, indices, temporary, nodes, output, options.length, capacity);
    if (count < 0) throw new Error(`Optimizer WASM dominance search failed (${count}).`);
    return Array.from(new Uint32Array(memory.buffer, output, count), index => options[index]);
  };
  backend.memoryBytes = () => memory.buffer.byteLength;
  return backend;
}
