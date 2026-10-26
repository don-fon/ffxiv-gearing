import { optimizeGearset, planGearOptimization } from './optimizer';
import type { GearOptimizationInput, OptimizerSearchBackend } from './optimizer';
import { createWasmSearchBackend } from './optimizerWasm';

/* eslint-disable no-restricted-globals */

type Engine = 'javascript' | 'wasm' | 'wasm-warm';

type WorkerRequest =
  { type: 'plan', input: GearOptimizationInput, engine?: Engine, workers?: number, shards?: number } |
  { type: 'optimize', input: GearOptimizationInput, engine?: Engine };

let wasmBackend: Promise<OptimizerSearchBackend> | undefined;
function loadWasmBackend(): Promise<OptimizerSearchBackend> {
  wasmBackend ??= (async () => {
    const response = await fetch(new URL('./optimizerSearch.wasm', import.meta.url));
    if (!response.ok) throw new Error(`Unable to load optimizer WASM (${response.status}).`);
    const bytes = await response.arrayBuffer();
    console.log('[自动配装] WASM 下载完成', { url: response.url, bytes: bytes.byteLength });
    return createWasmSearchBackend(bytes);
  })();
  return wasmBackend;
}

const diagnosticsVersion = '2026-10-26-console-v1';

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const started = Date.now();
  const { input } = event.data;
  const scope = {
    task: event.data.type, job: input.damage?.job, syncLevel: input.syncLevel,
    foodId: input.food?.id, speed: input.targetSpeedContribution, shard: input.candidateShard,
  };
  let engine = 'JavaScript';
  let initializationMs = 0;
  let fallbackReason: string | undefined;
  let activePhase = 'initializing';
  let lastLog = started;
  const counts = { wasmSearchCalls: 0, wasmSearchMs: 0, wasmVisitedBranches: 0,
    wasmEvaluatedCombinations: 0, wasmParetoCalls: 0, wasmParetoMs: 0,
    wasmParetoInputOptions: 0, wasmParetoOutputOptions: 0, jsTreeFallbacks: 0 };
  let backend: OptimizerSearchBackend | undefined;
  const diagnostics = (stage: string) => ({
    version: diagnosticsVersion, ...scope, stage, engine, activePhase,
    elapsedMs: Date.now() - started, initializationMs, fallbackReason,
    otherMs: activePhase === 'done' ? Math.max(0, Date.now() - started - initializationMs -
      counts.wasmSearchMs - counts.wasmParetoMs) : undefined,
    ...counts, wasmUsed: counts.wasmSearchCalls > 0 || counts.wasmParetoCalls > 0, wasmMemoryMiB: backend?.memoryBytes === undefined ? undefined :
      Math.round(backend.memoryBytes() / 1048576 * 10) / 10,
  });
  const emit = (stage: string, detail?: unknown) => {
    const snapshot = diagnostics(stage);
    console.log('[自动配装]', stage, snapshot, detail ?? '');
    self.postMessage({ type: 'diagnostics', diagnostics: snapshot });
    lastLog = Date.now();
  };
  const heartbeat = (detail?: unknown) => {
    if (Date.now() - lastLog >= 5000) emit('计算中', detail);
  };
  console.log('[自动配装] Worker 启动', { version: diagnosticsVersion, ...scope,
    requestedEngine: event.data.engine ?? 'auto', candidates: input.gears?.length,
    foods: input.foods?.length ?? Number(input.food !== undefined), targetGcd: input.targetGcd,
    criticalPreference: input.criticalPreference ?? 'none' });
  try {
    if (event.data.engine !== 'javascript') {
      const initializationStarted = Date.now();
      try { backend = await loadWasmBackend(); } catch (error) {
        fallbackReason = error instanceof Error ? error.message : String(error);
        console.warn('[自动配装] WASM 初始化失败', { ...scope, reason: fallbackReason,
          action: event.data.engine === undefined ? '回退到 JavaScript' : '终止显式 WASM 测试' });
        // Explicit benchmarks must fail visibly instead of silently changing engines.
        if (event.data.engine !== undefined) throw error;
      } finally { initializationMs = Date.now() - initializationStarted; }
    }
    if (backend !== undefined) {
      engine = 'WASM';
      const native = backend;
      const tracked: OptimizerSearchBackend = (task, report) => {
        activePhase = 'WASM 精确搜索';
        counts.wasmSearchCalls++;
        const before = Date.now();
        const result = native(task, update => { heartbeat(update);report(update); });
        counts.wasmSearchMs += Date.now() - before;
        if (result === undefined) {
          counts.wasmSearchCalls--;
          counts.jsTreeFallbacks++;
          activePhase = 'JavaScript 精确搜索';
        } else {
          counts.wasmVisitedBranches += result.visitedBranches;
          counts.wasmEvaluatedCombinations += result.states;
        }
        return result;
      };
      Object.assign(tracked, native);
      tracked.pareto = options => {
        activePhase = '候选去重';
        heartbeat({ inputOptions: options.length });
        const before = Date.now();
        const result = native.pareto?.(options);
        if (result !== undefined) {
          counts.wasmParetoMs += Date.now() - before;
          counts.wasmParetoCalls++;
          counts.wasmParetoInputOptions += options.length;
          counts.wasmParetoOutputOptions += result.length;
        }
        heartbeat({ inputOptions: options.length, outputOptions: result?.length });
        return result;
      };
      backend = tracked;
      backend.warmStartMinimumWork = event.data.engine !== 'wasm' ? 10_000_000_000 : undefined;
    }
    activePhase = event.data.type === 'plan' ? '规划候选与分片' : '准备候选与镶嵌';
    emit('引擎就绪');
    if (event.data.type === 'plan') {
      if (backend !== undefined) backend.candidateShardCount = event.data.shards ?? event.data.workers ?? 1;
      const plan = planGearOptimization(input, backend);
      activePhase = 'done';
      emit('规划完成', { partitions: plan.partitions.length,
        criticalRange: plan.criticalRange, heuristicDamage: plan.heuristicResult?.damage });
      self.postMessage({ type: 'plan', plan });
      return;
    }
    const result = optimizeGearset(input, progress => {
      heartbeat(progress);
      self.postMessage({ type: 'progress', progress });
    }, backend);
    activePhase = 'done';
    emit('分片完成', { damage: result.damage, exploredStates: result.exploredStates, empty: result.empty });
    self.postMessage({ type: 'result', result,
      engine: backend === undefined ? 'javascript' : event.data.engine ?? 'wasm-warm' });
  } catch (error) {
    activePhase = 'failed';
    const message = error instanceof Error ? error.message : String(error);
    console.error('[自动配装] 计算失败', diagnostics('error'), message);
    self.postMessage({ type: 'error', message });
  }
};

export {};
