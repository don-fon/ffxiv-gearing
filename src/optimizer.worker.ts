import { optimizeNoSpeedGearset } from './optimizer';
import type { NoSpeedOptimizationInput } from './optimizer';

/* eslint-disable no-restricted-globals */

self.onmessage = (event: MessageEvent<NoSpeedOptimizationInput>) => {
  try {
    const result = optimizeNoSpeedGearset(event.data, progress => {
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
