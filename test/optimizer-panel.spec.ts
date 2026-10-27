import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.getByRole('link', { name: '骑士', exact: true }).click();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
});

test('outside clicks and other dropdowns preserve optimizer inputs', async ({ page }) => {
  await page.getByLabel('暴击属性策略', { exact: true }).selectOption('high');
  await page.getByRole('spinbutton', { name: '目标 GCD' }).fill('2.42');
  await page.getByRole('spinbutton', { name: '最低坚韧减伤' }).fill('12.3');
  await page.locator('body').click({ position: { x: 1400, y: 1100 } });
  await expect(page.locator('.gear-optimization')).toBeHidden();
  await page.getByRole('button', { name: '魔晶石', exact: true }).click();
  await expect(page.locator('.materia-overall')).toBeVisible();
  await page.locator('body').click({ position: { x: 1400, y: 1100 } });
  await expect(page.locator('.materia-overall')).toBeHidden();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.getByLabel('暴击属性策略', { exact: true })).toHaveValue('high');
  await expect(page.getByRole('spinbutton', { name: '目标 GCD' })).toHaveValue('2.42');
  await expect(page.getByRole('spinbutton', { name: '最低坚韧减伤' })).toHaveValue('12.3');
  await page.getByRole('button', { name: '自动配装', exact: true }).press('Escape');
  await expect(page.locator('.gear-optimization')).toBeHidden();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.getByLabel('暴击属性策略', { exact: true })).toHaveValue('high');
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
              completedGroups: 2, totalGroups: 4, states: 42, visitedBranches: 100_000, searchProgress: 0.5,
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
  await expect(page.locator('.gear-optimization_status')).toContainText('整体进度约 50.0%');
  await expect(page.getByRole('progressbar', { name: '自动配装估算进度' })).toHaveAttribute('value', '0.5');
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
  await page.getByLabel('暴击属性策略', { exact: true }).selectOption('low');
  await page.getByRole('spinbutton', { name: '目标 GCD' }).fill('2.42');
  await page.getByRole('spinbutton', { name: '最低坚韧减伤' }).fill('12.3');
  await page.locator('.condition_job').click();
  await page.getByRole('link', { name: '战士', exact: true }).click();
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await expect(page.getByLabel('暴击属性策略', { exact: true })).toHaveValue('none');
  await expect(page.getByRole('spinbutton', { name: '目标 GCD' })).toHaveValue('2.50');
  await expect(page.getByRole('spinbutton', { name: '最低坚韧减伤' })).toHaveValue('0.0');
});

test('overall progress weights partitions and retains completed work', async ({ page }) => {
  await page.getByLabel('Worker 数量', { exact: true }).selectOption('2');
  await page.evaluate(() => {
    class WeightedWorker {
      onmessage?: (event: { data: unknown }) => void;
      terminated = false;
      result = { damage: 1, stats: {}, gears: [], exploredStates: 1, tenacityMitigation: 0 };
      postMessage(message: { type: string, input: { targetSpeedContribution: number } }) {
        if (message.type === 'plan') {
          queueMicrotask(() => this.onmessage?.({ data: { type: 'plan', plan: {
            heuristicResult: this.result,
            partitions: [{ contribution: 0, estimatedWork: 1 }, { contribution: 1, estimatedWork: 3 }],
          } } }));
          return;
        }
        const contribution = message.input.targetSpeedContribution;
        window.addEventListener('weighted-progress', event => {
          const detail = (event as CustomEvent<{ contribution: number, fraction: number }>).detail;
          if (!this.terminated && detail.contribution === contribution) {
            this.onmessage?.({ data: { type: 'progress', progress: {
              completedGroups: 1, totalGroups: 2, states: 5, visitedBranches: 100,
              searchProgress: detail.fraction,
            } } });
          }
        });
        window.addEventListener('weighted-finish', event => {
          if (!this.terminated && (event as CustomEvent<number>).detail === contribution) {
            this.onmessage?.({ data: { type: 'result', result: this.result } });
          }
        });
        document.body.dataset.weightedWorkers = String(Number(document.body.dataset.weightedWorkers ?? 0) + 1);
      }
      terminate() { this.terminated = true; }
    }
    window.Worker = WeightedWorker as unknown as typeof Worker;
  });
  await page.getByRole('button', { name: '开始计算', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-weighted-workers', '2');
  const progress = page.getByRole('progressbar', { name: '自动配装估算进度' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('weighted-progress', {
    detail: { contribution: 0, fraction: 0.5 },
  })));
  await expect(progress).toHaveAttribute('value', '0.125');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('weighted-progress', {
    detail: { contribution: 1, fraction: 0.5 },
  })));
  await expect(progress).toHaveAttribute('value', '0.5');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('weighted-finish', { detail: 0 })));
  await expect(progress).toHaveAttribute('value', '0.625');
  await expect(page.locator('.gear-optimization_status')).toContainText('已完成 1/2 个分片');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('weighted-progress', {
    detail: { contribution: 1, fraction: 0.1 },
  })));
  await expect(progress).toHaveAttribute('value', '0.625');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('weighted-finish', { detail: 1 })));
  await expect(page.locator('.gear-optimization_result')).toBeVisible();
});

test('critical preference and the shared range reach every search worker', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await page.getByLabel('暴击属性策略', { exact: true }).selectOption('low');
  await page.evaluate(() => {
    class CriticalWorker {
      onmessage?: (event: { data: unknown }) => void;
      postMessage(message: { type: string, input: { criticalPreference?: string, criticalRange?: unknown } }) {
        const range = { minimum: 1000, maximum: 2001, midpoint: 1500.5, threshold: 1250.25 };
        const result = { damage: 1, stats: { CRT: 1200 }, gears: [], exploredStates: 1,
          tenacityMitigation: 0, criticalRange: range };
        if (message.input.criticalPreference !== 'low') throw new Error('Missing critical preference');
        queueMicrotask(() => this.onmessage?.({ data: { type: 'diagnostics',
          diagnostics: { engine: 'WASM', stage: '引擎就绪', version: 'test' } } }));
        if (message.type === 'plan') queueMicrotask(() => this.onmessage?.({ data: {
          type: 'plan', plan: { partitions: [{ contribution: 0 }], heuristicResult: result, criticalRange: range },
        } }));
        else {
          if (JSON.stringify(message.input.criticalRange) !== JSON.stringify(range)) throw new Error('Missing shared critical range');
          queueMicrotask(() => this.onmessage?.({ data: { type: 'result', result } }));
        }
      }
      terminate() {}
    }
    window.Worker = CriticalWorker as unknown as typeof Worker;
  });
  await page.getByRole('button', { name: '开始计算', exact: true }).click();
  await expect(page.locator('.gear-optimization_critical-range')).toContainText('1000–2001');
  await expect(page.locator('.gear-optimization_critical-range')).toContainText('≤ 1250');
  expect(messages.some(message => message.includes('[自动配装] 规划 Worker'))).toBe(true);
  expect(messages.some(message => message.includes('[自动配装] 搜索 Worker'))).toBe(true);
  await page.getByLabel('暴击属性策略', { exact: true }).selectOption('high');
  await expect(page.locator('.gear-optimization_result')).toHaveCount(0);
});

for (const selected of [false, true]) {
test(`350–375 candidates match the display ${selected ? 'with a manually selected 500 item' : 'without cached 500 gear'}`, async ({ page }) => {
  await page.evaluate(() => {
    window.Worker = class {
      postMessage(message: { type: string, input: unknown }) {
        if (message.type === 'plan') (window as unknown as { strictRangeInput: unknown }).strictRangeInput = message.input;
      }
      terminate() {}
    } as unknown as typeof Worker;
  });
  await page.locator('.condition_job').click();
  await page.getByRole('link', { name: '战士', exact: true }).click();
  const levels = page.locator('.condition_level-input input');
  // Load high gear before narrowing; cached data must never bypass the filter.
  await levels.nth(0).fill('350');
  await levels.nth(0).press('Enter');
  await levels.nth(1).fill('795');
  await levels.nth(1).press('Enter');
  await expect(levels.nth(1)).toHaveValue('795');
  const armor = page.locator('tr.gears_item[data-id="29278"]');
  await expect(armor).toBeVisible();
  if (selected) {
    await expect(async () => {
      if (!(await armor.getAttribute('class'))?.includes('-selected')) await armor.locator('.gears_name').click();
      await expect(armor).toHaveClass(/-selected/, { timeout: 300 });
    }).toPass({ timeout: 3000 });
  }
  await levels.nth(1).fill('375');
  await levels.nth(1).press('Enter');
  await page.getByRole('button', { name: '品级同步', exact: true }).click();
  await page.getByText('70级', { exact: true }).click();
  await page.locator('.level-sync_level').getByText('375', { exact: true }).click();
  const visibleIds = await page.locator('tr.gears_item[data-id]').evaluateAll(rows =>
    rows.map(row => Math.abs(Number(row.getAttribute('data-id')))));
  await page.getByRole('button', { name: '自动配装', exact: true }).click();
  await page.getByLabel('目标 GCD', { exact: true }).fill('2.50');
  await expect(page.locator('.gear-optimization_intro')).toContainText('候选装备与当前列表显示范围一致');
  await page.getByRole('button', { name: '开始计算', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as unknown as { strictRangeInput: unknown }).strictRangeInput));
  const input = await page.evaluate(() => (window as unknown as {
    strictRangeInput: { gears: Array<{ id: number, level: number, name: string }>, lockedGearIds: number[] };
  }).strictRangeInput);
  expect(input.gears.length).toBeGreaterThan(0);
  expect(input.gears.every(gear => visibleIds.includes(gear.id))).toBe(true);
  expect(input.gears.every(gear => gear.level >= 350 && gear.level <= 375 || selected && gear.id === 29278)).toBe(true);
  expect(input.gears.some(gear => gear.id === 29278)).toBe(selected);
  if (!selected) expect(input.gears.some(gear => gear.level === 500)).toBe(false);
  expect(input.gears.some(gear => gear.level === 350 && gear.name.includes('常风'))).toBe(true);
  expect(input.gears.some(gear => gear.name === '白虎大斧')).toBe(true);
  expect(input.lockedGearIds).not.toContain(29278);
});
}
