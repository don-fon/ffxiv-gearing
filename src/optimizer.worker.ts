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
    return createWasmSearchBackend(await response.arrayBuffer());
  })();
  return wasmBackend;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    let backend: OptimizerSearchBackend | undefined;
    if (event.data.engine !== 'javascript') {
      try { backend = await loadWasmBackend(); } catch (error) {
        // Explicit benchmark modes must fail visibly. Normal use can fall back
        // when WASM is unavailable, unsupported, or blocked by the network.
        if (event.data.engine !== undefined) throw error;
      }
    }
    if (backend !== undefined) {
      backend.warmStartMinimumWork = event.data.engine !== 'wasm' ? 10_000_000_000 : undefined;
    }
    if (event.data.type === 'plan') {
      if (backend !== undefined) backend.candidateShardCount = event.data.shards ?? event.data.workers ?? 1;
      const plan = planGearOptimization(event.data.input, backend);
      self.postMessage({ type: 'plan', plan });
      return;
    }
    const result = optimizeGearset(event.data.input, progress => {
      self.postMessage({ type: 'progress', progress });
    }, backend);
    self.postMessage({ type: 'result', result, engine: backend === undefined ? 'javascript' : event.data.engine ?? 'wasm-warm' });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
