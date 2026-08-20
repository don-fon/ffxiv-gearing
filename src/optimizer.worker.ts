import { optimizeGearset, planGearOptimization } from './optimizer';
import type { GearOptimizationInput } from './optimizer';

/* eslint-disable no-restricted-globals */

type WorkerRequest =
  { type: 'plan', input: GearOptimizationInput } |
  { type: 'optimize', input: GearOptimizationInput };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'plan') {
      const plan = planGearOptimization(event.data.input);
      self.postMessage({ type: 'plan', plan });
      return;
    }
    const result = optimizeGearset(event.data.input, progress => {
      self.postMessage({ type: 'progress', progress });
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
