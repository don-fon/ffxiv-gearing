import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.getByRole('link', { name: '骑士', exact: true }).click();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
});

test('outside clicks and other dropdowns preserve optimizer inputs', async ({ page }) => {
  await page.getByRole('spinbutton', { name: '目标 GCD' }).fill('2.42');
  await page.getByRole('spinbutton', { name: '最低坚韧减伤' }).fill('12.3');
  await page.locator('body').click({ position: { x: 1400, y: 1100 } });
  await expect(page.locator('.gear-optimization')).toBeHidden();
  await page.getByRole('button', { name: '魔晶石', exact: true }).click();
  await expect(page.locator('.materia-overall')).toBeVisible();
  await page.locator('body').click({ position: { x: 1400, y: 1100 } });
  await expect(page.locator('.materia-overall')).toBeHidden();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '目标 GCD' })).toHaveValue('2.42');
  await expect(page.getByRole('spinbutton', { name: '最低坚韧减伤' })).toHaveValue('12.3');
  await page.getByRole('button', { name: '自动配装', exact: true }).press('Escape');
  await expect(page.locator('.gear-optimization')).toBeHidden();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '目标 GCD' })).toHaveValue('2.42');
});

test('running workers survive hiding, and results received while hidden remain available', async ({ page }) => {
  // Control worker completion to test panel lifecycle without an expensive full search.
  await page.evaluate(() => {
    class ControlledWorker {
      onmessage?: (event: { data: unknown }) => void;
      terminated = false;
      result = { damage: 1, stats: {}, gears: [], exploredStates: 42, tenacityMitigation: 0 };
      postMessage(message: { type: string }) {
        if (message.type === 'plan') {
          queueMicrotask(() => this.onmessage?.({ data: {
            type: 'plan', plan: {
              partitions: [{ contribution: 0 }], heuristicResult: this.result,
            },
          } }));
        } else {
          window.addEventListener('optimizer-test-progress', () => {
            if (!this.terminated) this.onmessage?.({ data: { type: 'progress', progress: {
              completedGroups: 2, totalGroups: 4, states: 42, visitedBranches: 100_000,
            } } });
          });
          window.addEventListener('optimizer-test-finish', () => {
            if (!this.terminated) this.onmessage?.({ data: { type: 'result', result: this.result } });
          }, { once: true });
        }
      }
      terminate() { this.terminated = true; }
    }
    window.Worker = ControlledWorker as unknown as typeof Worker;
  });
  await page.getByRole('button', { name: '开始计算', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '目标 GCD' })).toBeDisabled();
  // Wait until the planner created the optimize worker.
  await expect(page.locator('.gear-optimization_status')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('optimizer-test-progress')));
  await expect(page.locator('.gear-optimization_status')).toContainText('100000 个属性分支、42 个完整组合');
  await page.locator('body').click({ position: { x: 1400, y: 1100 } });
  await expect(page.locator('.gear-optimization')).toBeHidden();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '目标 GCD' })).toBeDisabled();
  await page.locator('body').click({ position: { x: 1400, y: 1100 } });
  await page.evaluate(() => window.dispatchEvent(new Event('optimizer-test-finish')));
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.locator('.gear-optimization_result')).toContainText('共检查 42 个组合状态');
  await page.locator('body').click({ position: { x: 1400, y: 1100 } });
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.locator('.gear-optimization_result')).toContainText('最优 1.00000');
});

test('switching jobs starts a fresh optimizer panel', async ({ page }) => {
  await page.getByRole('spinbutton', { name: '目标 GCD' }).fill('2.42');
  await page.getByRole('spinbutton', { name: '最低坚韧减伤' }).fill('12.3');
  await page.locator('.condition_job').click();
  await page.getByRole('link', { name: '战士', exact: true }).click();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '目标 GCD' })).toHaveValue('2.50');
  await expect(page.getByRole('spinbutton', { name: '最低坚韧减伤' })).toHaveValue('0.0');
});
