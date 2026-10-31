/* eslint-disable no-restricted-globals */
import { milpMinimalPlan } from '/__optimizer_integer/planner-optimizer.mjs';
import { createWasmSearchBackend } from '/__optimizer_integer/native.mjs';

// Keep the user-visible critical range calculation. Integer workers themselves
// find feasible gear, so no old greedy damage seed, pair warm-up or speed plan.
self.onmessage = async ({ data: request }) => {
  const started = performance.now();
  try {
    let backend;
    const input = request.input;
    if (input.criticalPreference !== 'none' && input.criticalPreference !== undefined && !input.criticalRange) {
      const response = await fetch('/__optimizer_integer/native.wasm');
      if (!response.ok) throw new Error('Cannot load critical-range backend.');
      backend = await createWasmSearchBackend(await response.arrayBuffer());
    }
    const plan = milpMinimalPlan(input, backend);
    self.postMessage({ type: 'diagnostics', diagnostics: { stage: '规划完成',
      engine: 'minimal integer planner', elapsedMs: performance.now() - started,
      criticalRange: plan.criticalRange, warmup: false } });
    self.postMessage({ type: 'plan', plan });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error) });
  }
};
