import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const input = JSON.parse(fs.readFileSync(new URL('./fixtures/warrior-375-input.json', import.meta.url), 'utf8'));
const expected = JSON.parse(fs.readFileSync(new URL('./fixtures/warrior-375-result.json', import.meta.url), 'utf8'));
// A fully locked legal result exercises real asset loading and worker messaging
// without making interaction tests repeat the multi-minute benchmark.
input.gears = input.gears.filter((gear: { id: number }) =>
  expected.gears.some((choice: { id: number }) => choice.id === gear.id));
input.lockedGears = expected.gears.map((gear: { id: number, slot: number, melds: unknown[] }) =>
  ({ id: gear.id, slot: gear.slot, melds: gear.melds }));
input.lockedGearIds = input.lockedGears.map((gear: { id: number }) => gear.id);
input.foods = [expected.food];

for (const preference of ['none', 'high', 'low']) {
for (const blocked of [false, true]) {
  test(`production worker ${preference}: ${blocked ? 'falls back when WASM download fails' : 'loads WASM and returns a legal result'}`, async ({ page, context }) => {
    const consoleMessages: string[] = [];
    page.on('console', message => consoleMessages.push(message.text()));
    if (blocked) await context.route('**/*.wasm', route => route.abort());
    await page.addInitScript(() => {
      const scope = window as unknown as { RealOptimizerWorker: typeof Worker, optimizerWorkerUrl: string };
      scope.RealOptimizerWorker = Worker;
      window.Worker = class {
        constructor(url: string) { scope.optimizerWorkerUrl = String(url); }
        postMessage() {}
        terminate() {}
      } as unknown as typeof Worker;
    });
    await page.goto('./');
    await page.getByRole('link', { name: '战士', exact: true }).click();
    await page.getByRole('button', { name: '自动配装', exact: true }).click();
    await page.getByRole('button', { name: '开始计算', exact: true }).click();
    const response = await page.evaluate(async lockedInput => {
      const scope = window as unknown as { RealOptimizerWorker: typeof Worker, optimizerWorkerUrl: string };
      const worker = new scope.RealOptimizerWorker(scope.optimizerWorkerUrl);
      try {
        const diagnostics: Array<{ engine: string, stage: string, fallbackReason?: string, version: string }> = [];
        return await new Promise<{ type: string, engine: string, diagnostics: typeof diagnostics, result: { damage: number, stats: unknown } }>((resolve, reject) => {
          worker.onerror = event => reject(new Error(event.message));
          worker.onmessage = event => {
            if (event.data.type === 'diagnostics') diagnostics.push(event.data.diagnostics);
            if (event.data.type === 'error') reject(new Error(event.data.message));
            if (event.data.type === 'result') resolve({ ...event.data, diagnostics });
          };
          worker.postMessage({ type: 'optimize', input: lockedInput });
        });
      } finally { worker.terminate(); }
    }, { ...input, criticalPreference: preference });
    expect(response.engine).toBe(blocked ? 'javascript' : 'wasm-warm');
    expect(response.result.damage).toBeCloseTo(expected.damage, 10);
    expect(response.result.stats).toEqual(expected.stats);
    expect(response.diagnostics[0].engine).toBe(blocked ? 'JavaScript' : 'WASM');
    expect(response.diagnostics[0].version).toBe('2026-10-26-console-v1');
    expect(response.diagnostics.at(-1)?.stage).toBe('分片完成');
    if (blocked) expect(response.diagnostics[0].fallbackReason).toBeTruthy();
    expect(consoleMessages.some(message => message.includes('[自动配装] Worker 启动'))).toBe(true);
    expect(consoleMessages.some(message => message.includes('分片完成'))).toBe(true);
    if (blocked) expect(consoleMessages.some(message => message.includes('WASM 初始化失败'))).toBe(true);
  });
}
}
