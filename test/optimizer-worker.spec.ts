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

for (const preference of ['none', 'high', 'low', 'tradeoff']) {
for (const blocked of [false, true]) {
  test(`production worker ${preference}: ${blocked ? 'reports an error when WASM download fails' : 'loads WASM and returns a legal result'}`, async ({ page, context }) => {
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
        const diagnostics: Array<{ engine: string, stage: string, initializationError?: string, version: string }> = [];
        return await new Promise<{ type: string, message?: string, engine: string, diagnostics: typeof diagnostics, result: { damage: number, score?: number, stats: unknown } }>((resolve, reject) => {
          worker.onerror = event => reject(new Error(event.message));
          worker.onmessage = event => {
            if (event.data.type === 'diagnostics') diagnostics.push(event.data.diagnostics);
            if (event.data.type === 'error') resolve({ ...event.data, diagnostics });
            if (event.data.type === 'result') resolve({ ...event.data, diagnostics });
          };
          worker.postMessage({ type: 'optimize', input: lockedInput });
        });
      } finally { worker.terminate(); }
    }, { ...input, criticalPreference: preference === 'tradeoff' ? 'none' : preference,
      objective: preference === 'tradeoff' ? { type: 'tenacityTradeoff', mitigationPointsPerDamagePercent: 0.5 } : input.objective });
    if (blocked) {
      expect(response.type).toBe('error');
      expect(response.message).toContain('自动配装引擎下载失败');
      expect(response.result).toBeUndefined();
      expect(response.diagnostics).toHaveLength(0);
      expect(consoleMessages.some(message => message.includes('分片完成'))).toBe(false);
      return;
    }
    expect(response.engine).toBe('wasm-warm');
    expect(response.result.damage).toBeCloseTo(expected.damage, 10);
    expect(response.result.stats).toEqual(expected.stats);
    if (preference === 'tradeoff') {
      const mitigation = Math.trunc(200 * (expected.stats.TEN - input.damage.level.sub) / input.damage.level.div + 1e-7) / 1000;
      expect(response.result.score).toBeCloseTo(expected.damage * (1 + mitigation / 0.5), 10);
    }
    expect(response.diagnostics[0].engine).toBe('WASM');
    expect(response.diagnostics[0].version).toBe('2026-10-26-console-v1');
    expect(response.diagnostics.at(-1)?.stage).toBe('分片完成');
    expect(consoleMessages.some(message => message.includes('Worker 启动'))).toBe(true);
    expect(consoleMessages.some(message => message.includes('分片完成'))).toBe(true);
  });
}
}


test('panel displays WASM failures and a later retry completes successfully', async ({ page, context }) => {
  let mode = 'download';
  await context.route('**/*.wasm', async route => {
    if (mode === 'download') await route.fulfill({ status: 404, body: '' });
    else if (mode === 'initialize') await route.fulfill({ status: 200,
      contentType: 'application/wasm', body: 'invalid wasm' });
    else await route.continue();
  });
  await page.addInitScript(lockedInput => {
    const RealWorker = Worker;
    window.Worker = class extends RealWorker {
      postMessage(message: { input?: unknown }) {
        super.postMessage({ ...message, input: lockedInput });
      }
    };
  }, input);
  await page.goto('./');
  await page.getByRole('link', { name: '战士', exact: true }).click();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  const start = page.getByRole('button', { name: '开始计算', exact: true });
  await start.click();
  await expect(page.locator('.gear-optimization_error[role=alert]')).toContainText('引擎下载失败');
  await expect(start).toBeEnabled();
  await expect(page.locator('.gear-optimization_result')).toHaveCount(0);
  mode = 'initialize';
  await start.click();
  await expect(page.locator('.gear-optimization_error[role=alert]')).toContainText('引擎无法启动');
  await expect(start).toBeEnabled();
  mode = 'ok';
  await start.click();
  await expect(page.locator('.gear-optimization_error[role=alert]')).toHaveCount(0);
  await expect(page.locator('.gear-optimization_damage')).toContainText(expected.damage.toFixed(5));
  await expect(page.getByRole('button', { name: '重新计算', exact: true })).toBeEnabled();

});

test('panel leaves running state if worker construction is blocked', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('link', { name: '战士', exact: true }).click();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await page.evaluate(() => {
    window.Worker = class { constructor() { throw new Error('blocked by policy'); } } as unknown as typeof Worker;
  });
  const start = page.getByRole('button', { name: '开始计算', exact: true });
  await start.click();
  await expect(page.locator('.gear-optimization_error[role=alert]')).toContainText('自动配装无法启动');
  await expect(start).toBeEnabled();
});
