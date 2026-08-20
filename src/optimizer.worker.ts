import { optimizeGearset } from './optimizer';
import type { GearOptimizationInput } from './optimizer';

/* eslint-disable no-restricted-globals */

self.onmessage = (event: MessageEvent<GearOptimizationInput>) => {
  try {
    const result = optimizeGearset(event.data, progress => {
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
