import type { GearOptimizationInput, GearOptimizationPlan, GearOptimizationResult, OptimizerProgress } from './optimizer';

export type OptimizerWorkerResponse =
  { type: 'diagnostics'; diagnostics: Record<string, unknown> } |
  { type: 'plan'; plan: GearOptimizationPlan } |
  { type: 'progress'; progress: OptimizerProgress } |
  { type: 'candidate'; result: GearOptimizationResult } |
  { type: 'result'; result: GearOptimizationResult } |
  { type: 'error'; message: string };

interface PoolOptions {
  input: GearOptimizationInput;
  plan: GearOptimizationPlan;
  workerCount: number;
  createWorker: () => Worker;
  engine?: 'wasm' | 'wasm-warm';
  isActive?: () => boolean;
  onProgress?: (progress: OptimizerProgress) => void;
  onBest?: (result: GearOptimizationResult) => void;
  onDiagnostics?: (diagnostics: Record<string, unknown>) => void;
  onDone: (result: GearOptimizationResult, restarts: number) => void;
  onError: (message: string) => void;
  shareCandidates?: boolean;
  maxRestarts?: number;
  fixedMinimumDamage?: number;
}

/** A restart repeats the entire partition with a stronger, feasible bound.
 * Interrupted work never counts as a completed optimality proof. */
export function runOptimizationPool(options: PoolOptions): { workers: Worker[]; cancel: () => void } {
  const { input, plan } = options;
  const workers: Worker[] = [];
  const active = new Map<Worker, number>();
  const progress = new Map<Worker, OptimizerProgress>();
  const bounds = new Map<Worker, number>();
  const started = new Map<Worker, number>();
  const restartCounts = plan.partitions.map(() => 0);
  const fractions = plan.partitions.map(() => 0);
  const weights = plan.partitions.map(partition => Math.max(1, partition.estimatedWork || 1));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let best = plan.heuristicResult;
  let next = 0;
  let completed = 0;
  let explored = 0;
  let closed = false;
  let restarts = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const score = (result: GearOptimizationResult) => result.score ?? result.damage;
  const cancel = () => {
    closed = true;
    clearTimeout(refreshTimer);
    workers.forEach(worker => worker.terminate());
    active.clear();
    progress.clear();
  };
  const fail = (message: string) => { cancel();options.onError(message); };
  const report = () => {
    const values = Array.from(progress.values());
    const searching = values.some(value => value.visitedBranches !== undefined);
    options.onProgress?.({
      completedGroups: completed, totalGroups: plan.partitions.length,
      searchProgress: fractions.reduce((sum, fraction, i) => sum + fraction * weights[i], 0) / totalWeight,
      states: values.filter(value => !searching || value.visitedBranches !== undefined)
        .reduce((sum, value) => sum + value.states, 0),
      visitedBranches: searching ? values.reduce((sum, value) => sum + (value.visitedBranches ?? 0), 0) : undefined,
    });
  };
  const assign = (worker: Worker, partitionIndex: number) => {
    const partition = plan.partitions[partitionIndex];
    const minimumDamage = options.fixedMinimumDamage ?? score(best);
    active.set(worker, partitionIndex);
    bounds.set(worker, minimumDamage);
    started.set(worker, Date.now());
    progress.delete(worker);
    const food = partition.foodId === undefined ? input.food
      : input.foods?.find(candidate => candidate.id === partition.foodId) ??
        (input.food?.id === partition.foodId ? input.food : undefined);
    if (partition.foodId !== undefined && food === undefined) throw new Error('配装分片的食物不存在。');
    worker.postMessage({ type: 'optimize', engine: options.engine,
      input: { ...input, food, foods: undefined,
      candidateShard: partition.candidateShard, criticalRange: plan.criticalRange,
      targetSpeedContribution: partition.contribution, globalMinimumDamage: minimumDamage } });
  };
  const forget = (worker: Worker) => {
    active.delete(worker);bounds.delete(worker);started.delete(worker);progress.delete(worker);
  };
  const refreshBounds = () => {
    clearTimeout(refreshTimer);refreshTimer = undefined;
    if (closed || !(options.isActive?.() ?? true) || options.fixedMinimumDamage !== undefined) return;
    let delay = Infinity;
    for (const [worker, partitionIndex] of Array.from(active)) {
      const bound = bounds.get(worker)!;
      if (restartCounts[partitionIndex] >= (options.maxRestarts ?? 4) ||
          score(best) - bound <= Math.max(Math.abs(bound), 1e-12) * 0.001) continue;
      // Coalesce early improvements and leave short/preparing tasks uninterrupted.
      const remaining = 5000 - (Date.now() - started.get(worker)!);
      if (remaining > 0) { delay = Math.min(delay, remaining);continue; }
      const slot = workers.indexOf(worker);
      forget(worker);worker.terminate();
      const replacement = options.createWorker();workers[slot] = replacement;
      restartCounts[partitionIndex]++;restarts++;
      options.onDiagnostics?.({ worker: slot, partition: partitionIndex, stage: '重启分片',
        previousMinimumDamage: bound, minimumDamage: score(best), restarts: restartCounts[partitionIndex] });
      bind(replacement, slot);assign(replacement, partitionIndex);
    }
    if (Number.isFinite(delay)) refreshTimer = setTimeout(() => {
      try { refreshBounds(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    }, delay);
  };
  const improve = (candidate: GearOptimizationResult) => {
    if (candidate.empty || !Number.isFinite(score(candidate)) || score(candidate) <= score(best)) return;
    best = candidate;options.onBest?.(best);refreshBounds();
  };
  const bind = (worker: Worker, slot: number) => {
    worker.onerror = event => {
      if (!closed && active.has(worker) && (options.isActive?.() ?? true)) fail(event.message || '自动配装计算失败。');
    };
    worker.onmessage = (event: MessageEvent<OptimizerWorkerResponse>) => {
      if (closed || !active.has(worker) || !(options.isActive?.() ?? true)) return;
      const partitionIndex = active.get(worker)!;
      try {
        const message = event.data;
        if (message.type === 'diagnostics') {
          options.onDiagnostics?.({ worker: slot, partition: partitionIndex, ...message.diagnostics });
        } else if (message.type === 'error') {
          fail(message.message);
        } else if (message.type === 'candidate') {
          if (options.shareCandidates !== false && !message.result.empty && Number.isFinite(score(message.result))) {
            bounds.set(worker, Math.max(bounds.get(worker)!, score(message.result)));
            improve(message.result);
          }
        } else if (message.type === 'progress') {
          progress.set(worker, message.progress);
          fractions[partitionIndex] = Math.max(fractions[partitionIndex],
            Math.min(0.999999, message.progress.searchProgress ?? 0));
          report();
        } else if (message.type === 'result') {
          forget(worker);
          fractions[partitionIndex] = 1;completed++;explored += message.result.exploredStates;
          improve(message.result);report();
          if (completed === plan.partitions.length) {
            cancel();options.onDone({ ...best, exploredStates: explored }, restarts);
          } else if (next < plan.partitions.length) {
            assign(worker, next++);
          } else worker.terminate();
        }
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    };
  };
  try {
    if (plan.partitions.length === 0) throw new Error('没有可计算的配装分片。');
    for (let slot = 0; slot < Math.min(plan.partitions.length, Math.max(1, Math.trunc(options.workerCount))); slot++) {
      if (closed) break;
      const worker = options.createWorker();workers.push(worker);bind(worker, slot);assign(worker, next++);
    }
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  return { workers, cancel };
}
