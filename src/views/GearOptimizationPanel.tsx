import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import { Button } from './@rmwc/button';
import * as G from '../game';
import { gearData, gearDataOrdered, loadGearDataOfLevelRange, resolveGearColor } from '../stores';
import {
  createGearOptimizationInput,
  optimizerGearCategoryOf,
  optimizerGearCategoryOptions,
} from '../optimizerInput';
import type { OptimizerGearCategory } from '../optimizerInput';
import type {
  CriticalPreference,
  GearOptimizationInput,
  GearOptimizationResult,
  GearOptimizationPlan,
  OptimizerProgress,
  OptimizerStat,
} from '../optimizer';
import type { DropdownPopperProps } from './components/Dropdown';
import { useStore } from './components/contexts';
import { Icon } from './components/Icon';

type Status = 'idle' | 'loading' | 'running' | 'done' | 'error';
type WorkerResponse =
  { type: 'diagnostics', diagnostics: Record<string, unknown> } |
  { type: 'plan', plan: GearOptimizationPlan } |
  { type: 'progress', progress: OptimizerProgress } |
  { type: 'result', result: GearOptimizationResult } |
  { type: 'error', message: string };

const exclusionKey = (ids: number[], categories: OptimizerGearCategory[]) => [
  ids.slice().sort((left, right) => left - right).join(','),
  categories.slice().sort().join(','),
].join('|');
const specialWeaponCategories = new Set<OptimizerGearCategory>([
  'zodiacWeapon', 'animaWeapon', 'eurekaWeapon', 'resistanceWeapon',
  'mandervilleWeapon', 'phantomWeapon',
]);
const specialGearCategories = new Set<OptimizerGearCategory>([
  'eurekaGear', 'bozjaGear', 'crescentIsleGear', 'artifactGear', 'wolfMarkGear',
  'deepDungeonGear', 'wondrousTailsGear',
]);

export const GearOptimizationPanel = mobxReact.observer<DropdownPopperProps>(({ toggle }) => {
  const store = useStore();
  const speedStat: 'SKS' | 'SPS' = store.schema.stats.includes('SKS') ? 'SKS' : 'SPS';
  const speedName = G.statNames[speedStat];
  const isTank = store.schema.stats.includes('TEN');
  const initialGcd = store.equippedEffects?.gcd ?? 2.5;
  const [ lockedSlots, setLockedSlots ] = React.useState<number[]>([]);
  const [ lockedMateriaSlots, setLockedMateriaSlots ] = React.useState<number[]>([]);
  const [ excludedGearIds, setExcludedGearIds ] = React.useState<number[]>([]);
  const [ excludedGearCategories, setExcludedGearCategories ] =
    React.useState<OptimizerGearCategory[]>([]);
  const [ previewedGearCategory, setPreviewedGearCategory ] =
    React.useState<OptimizerGearCategory>();
  const [ exclusionsExpanded, setExclusionsExpanded ] = React.useState(false);
  const [ targetGcd, setTargetGcd ] = React.useState(initialGcd.toFixed(2));
  const [ status, setStatus ] = React.useState<Status>('idle');
  const [ progress, setProgress ] = React.useState<OptimizerProgress>();
  const [ result, setResult ] = React.useState<GearOptimizationResult>();
  const [ resultExcludedGearKey, setResultExcludedGearKey ] = React.useState<string>();
  const [ baselineDamage, setBaselineDamage ] = React.useState<number>();
  const [ criticalPreference, setCriticalPreference ] = React.useState<CriticalPreference>('none');
  const [ minimumTenacityMitigation, setMinimumTenacityMitigation ] = React.useState('0.0');
  const [ tradeTenacity, setTradeTenacity ] = React.useState(false);
  const [ mitigationExchange, setMitigationExchange ] = React.useState('10');
  const [ selectedWorkerCount, setSelectedWorkerCount ] = React.useState(() => Math.min(
    Math.max(1, typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4), 4));
  const [ error, setError ] = React.useState('');
  const workersRef = React.useRef<Worker[]>([]);
  const mountedRef = React.useRef(true);

  const incompleteCustomWeapons = store.schema.slots
    .filter(slot => slot.uiGroup === 'weapon')
    .flatMap(slot => {
      const customWeapons = gearDataOrdered.get().filter(item =>
        item.slot === slot.slot && item.level >= store.minLevel && item.level <= store.maxLevel &&
        G.jobCategories[item.jobCategory][store.job!] &&
        (!item.obsolete || !store.setting.hideObsoleteGears) && (item as G.Gear).customizable);
      if (customWeapons.length === 0 || customWeapons.some(item => {
        const gear = store.gears.get(item.id.toString());
        return gear !== undefined && !gear.isFood && (gear.customStats?.size ?? 0) > 0;
      })) return [];
      return customWeapons.map(item => item.name);
    });
  const hasCompleteGearset = store.schema.slots
    .filter(slot => slot.slot > 0 || slot.slot === -12)
    .every(slot => store.equippedGears.get(slot.slot.toString()) !== undefined);

  React.useEffect(() => () => {
    mountedRef.current = false;
    workersRef.current.forEach(worker => worker.terminate());
  }, []);

  const lockable = store.schema.slots.flatMap(slot => {
    if (slot.slot <= 0 && slot.slot !== -12 && slot.slot !== -1) return [];
    const gear = store.equippedGears.get(slot.slot.toString());
    if (gear === undefined) return [];
    return [{ slot: slot.slot, name: `${slot.name}${slot.slot === -12 ? '（右）' : ''}`, gear }];
  });
  const lockedGearIds = new Set<number>(lockable.flatMap(({ slot, gear }) =>
    lockedSlots.includes(slot) && !gear.isFood ? [Math.abs(gear.id)] : []));
  const orderedGearData = gearDataOrdered.get();
  const categorySlotKey = store.schema.slots
    .filter(slot => slot.slot > 0 && slot.levelWeight !== 0)
    .map(slot => Math.abs(slot.slot))
    .join(',');
  const availableGearCategories = React.useMemo(() => {
    const slots = new Set(categorySlotKey.split(',').filter(Boolean).map(Number));
    const gearsByCategory = new Map<OptimizerGearCategory, G.Gear[]>();
    for (const item of orderedGearData) {
      if (item.slot <= 0 || !slots.has(item.slot) ||
          item.level < store.minLevel || item.level > store.maxLevel ||
          !G.jobCategories[item.jobCategory][store.job!]) continue;
      const gear = item as G.Gear;
      if (gear.equipLevel > store.schema.jobLevel ||
          (gear.obsolete && store.setting.hideObsoleteGears)) continue;
      const category = optimizerGearCategoryOf(gear);
      if (category !== undefined) {
        const gears = gearsByCategory.get(category) ?? [];
        gears.push(gear);
        gearsByCategory.set(category, gears);
      }
    }
    return optimizerGearCategoryOptions.flatMap(option => {
      const gears = gearsByCategory.get(option.id) ?? [];
      return gears.length === 0 ? [] : [{ ...option, count: gears.length, gears }];
    });
  }, [
    categorySlotKey,
    orderedGearData,
    store.job,
    store.maxLevel,
    store.minLevel,
    store.schema.jobLevel,
    store.setting.hideObsoleteGears,
  ]);
  const availableGearCategoryIds = new Set(availableGearCategories.map(category => category.id));
  const activeExcludedGearCategories = excludedGearCategories.filter(category =>
    availableGearCategoryIds.has(category));

  const toggleLock = (slot: number) => {
    if (!lockedSlots.includes(slot)) {
      const gear = store.equippedGears.get(slot.toString());
      if (gear !== undefined && !gear.isFood) {
        setExcludedGearIds(ids => ids.filter(id => id !== Math.abs(gear.id)));
      }
    }
    if (lockedSlots.includes(slot)) {
      setLockedMateriaSlots(slots => slots.filter(value => value !== slot));
    }
    setLockedSlots(slots => slots.includes(slot) ? slots.filter(value => value !== slot) : slots.concat(slot));
    setStatus('idle');
    setResult(undefined);
    setResultExcludedGearKey(undefined);
  };

  const toggleLockedMateria = (slot: number) => {
    if (!lockedSlots.includes(slot)) return;
    setLockedMateriaSlots(slots =>
      slots.includes(slot) ? slots.filter(value => value !== slot) : slots.concat(slot));
    setStatus('idle');
    setResult(undefined);
    setResultExcludedGearKey(undefined);
  };

  const toggleExcludedGear = (gearId: number) => {
    const id = Math.abs(gearId);
    if (lockedGearIds.has(id)) return;
    setExcludedGearIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : ids.concat(id));
    setStatus('idle');
    setError('');
  };

  const toggleExcludedGearCategory = (category: OptimizerGearCategory) => {
    setExcludedGearCategories(categories => categories.includes(category)
      ? categories.filter(value => value !== category)
      : categories.concat(category));
    setStatus('idle');
    setError('');
  };

  const start = async () => {
    const runStarted = Date.now();
    const calculationExcludedGearIds = excludedGearIds.slice();
    const calculationExcludedGearCategories = activeExcludedGearCategories.slice();
    const calculationExcludedGearKey = exclusionKey(
      calculationExcludedGearIds,
      calculationExcludedGearCategories,
    );
    const parsedTargetGcd = targetGcd.trim() === '' ? NaN : Number(targetGcd);
    const parsedMinimumTenacityMitigation = minimumTenacityMitigation.trim() === ''
      ? NaN
      : Number(minimumTenacityMitigation);
    if (!Number.isFinite(parsedTargetGcd) || parsedTargetGcd <= 0 ||
        Math.abs(parsedTargetGcd * 100 - Math.round(parsedTargetGcd * 100)) > 1e-7) {
      setError('请输入大于 0 且最多包含两位小数的目标 GCD。');
      setStatus('error');
      return;
    }
    if (isTank && !tradeTenacity &&
        (!Number.isFinite(parsedMinimumTenacityMitigation) ||
          parsedMinimumTenacityMitigation < 0 || parsedMinimumTenacityMitigation >= 100)) {
      setError('请输入大于等于 0 且小于 100 的最低坚韧减伤百分比。');
      setStatus('error');
      return;
    }
    if (isTank && tradeTenacity && !exchangeValid) {
      setError('请输入 0.01–100 之间的减伤兑换比例。');
      setStatus('error');
      return;
    }
    workersRef.current.forEach(worker => worker.terminate());
    workersRef.current = [];
    setStatus('loading');
    setResult(undefined);
    setResultExcludedGearKey(undefined);
    setProgress(undefined);
    setError('');
    setBaselineDamage(hasCompleteGearset ? store.equippedEffects?.damage : undefined);
    console.log('[自动配装] 开始加载装备数据', { page: window.location.pathname,
      hardwareConcurrency: navigator.hardwareConcurrency, workers: selectedWorkerCount });
    store.setOptimizationDataLoading(true);
    try {
      await loadGearDataOfLevelRange(store.minLevel, store.maxLevel);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setStatus('error');
      return;
    } finally {
      store.setOptimizationDataLoading(false);
    }
    if (!mountedRef.current) return;

    let input: GearOptimizationInput;
    try {
      input = createGearOptimizationInput(
        store,
        lockedSlots,
        parsedTargetGcd,
        calculationExcludedGearIds,
        lockedMateriaSlots,
        calculationExcludedGearCategories,
      );
      input = isTank
        ? {
          ...input,
          objective: tradeTenacity ? {
            type: 'tenacityTradeoff', mitigationPointsPerDamagePercent: Number(mitigationExchange),
          } : {
            type: 'minimumTenacity', minimumTenacityMitigation: parsedMinimumTenacityMitigation / 100,
          },
        }
        : { ...input, objective: { type: 'damage' } };
      input.criticalPreference = criticalPreference;
      const outside = input.gears.filter(gear => gear.level < store.minLevel || gear.level > store.maxLevel);
      console.log('[自动配装] 输入概况', { job: store.job, filter: [store.minLevel, store.maxLevel], rangePolicy: 'displayed',
        syncLevel: store.syncLevel, targetGcd: parsedTargetGcd, workers: selectedWorkerCount,
        candidates: input.gears.length, foods: input.foods?.length ?? 0,
        outsideFilter: outside.length, syncedOutsideFilter: outside.filter(gear => gear.synced).length,
        selectedOutsideFilter: outside.filter(gear => lockable.some(entry => Math.abs(entry.gear.id) === gear.id)).length,
        exampleSyncedArmor: input.gears.filter(gear => gear.synced && gear.slot === 4).slice(0, 3)
          .map(gear => ({ id: gear.id, name: gear.name, itemLevel: gear.level, effectiveStats: gear.stats })),
        outsideLevels: Array.from(new Set(outside.map(gear => gear.level))).sort((left, right) => left - right),
        materiaSlots: input.gears.reduce((count, gear) => count + gear.materiaSlots.length, 0),
        criticalPreference, minimumTenacityMitigation: parsedMinimumTenacityMitigation });
    } catch (inputError) {
      setError(inputError instanceof Error ? inputError.message : String(inputError));
      setStatus('error');
      return;
    }

    setStatus('running');
    const fail = (message: string) => {
      if (!mountedRef.current) return;
      workersRef.current.forEach(worker => worker.terminate());
      workersRef.current = [];
      setError(message);
      setStatus('error');
    };
    const planner = new Worker(new URL('../optimizer.worker.ts', import.meta.url));
    workersRef.current = [planner];
    planner.onerror = event => fail(event.message || '自动配装计算失败。');
    planner.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (!mountedRef.current) return;
      if (event.data.type === 'diagnostics') {
        console.log('[自动配装] 规划 Worker', event.data.diagnostics);
        return;
      }
      if (event.data.type === 'error') {
        fail(event.data.message);
        return;
      }
      if (event.data.type !== 'plan') return;
      planner.terminate();
      const { partitions, heuristicResult, criticalRange } = event.data.plan;
      if (partitions.length === 0) {
        fail(`没有找到最终 GCD 为 ${parsedTargetGcd.toFixed(2)} 秒的完整配装。`);
        return;
      }

      const workerCount = Math.min(partitions.length, selectedWorkerCount);
      const workers = Array.from({ length: workerCount }, () =>
        new Worker(new URL('../optimizer.worker.ts', import.meta.url)));
      workersRef.current = workers;
      const activeProgress = new Map<Worker, OptimizerProgress>();
      const activePartitionIndexes = new Map<Worker, number>();
      const partitionProgress = partitions.map(() => 0);
      const partitionWeights = partitions.map(partition => Math.max(1, partition.estimatedWork || 1));
      const totalWeight = partitionWeights.reduce((total, weight) => total + weight, 0);
      let nextIndex = 0;
      let completed = 0;
      let exploredStates = 0;
      let bestResult: GearOptimizationResult = heuristicResult;
      const updateProgress = () => {
        const values = Array.from(activeProgress.values());
        const searching = values.some(value => value.visitedBranches !== undefined);
        setProgress({
          completedGroups: completed,
          totalGroups: partitions.length,
          searchProgress: partitionProgress.reduce((total, fraction, index) =>
            total + fraction * partitionWeights[index], 0) / totalWeight,
          states: values.filter(value => !searching || value.visitedBranches !== undefined)
            .reduce((total, value) => total + value.states, 0),
          visitedBranches: searching
            ? values.reduce((total, value) => total + (value.visitedBranches ?? 0), 0)
            : undefined,
        });
      };
      const assign = (worker: Worker) => {
        if (nextIndex >= partitions.length) {
          worker.terminate();
          return;
        }
        const partitionIndex = nextIndex++;
        const partition = partitions[partitionIndex];
        activePartitionIndexes.set(worker, partitionIndex);
        const targetSpeedContribution = partition.contribution;
        const food = partition.foodId === undefined
          ? input.food
          : input.foods?.find(candidate => candidate.id === partition.foodId);
        activeProgress.delete(worker);
        worker.postMessage({
          type: 'optimize',
          input: {
            ...input,
            candidateShard: partition.candidateShard,
            criticalRange,
            food,
            foods: undefined,
            targetSpeedContribution,
            globalMinimumDamage: bestResult.score ?? bestResult.damage,
          },
        });
      };
      for (const worker of workers) {
        worker.onerror = workerError => fail(workerError.message || '自动配装计算失败。');
        worker.onmessage = (workerEvent: MessageEvent<WorkerResponse>) => {
          if (!mountedRef.current) return;
          if (workerEvent.data.type === 'diagnostics') {
            console.log('[自动配装] 搜索 Worker', { partition: activePartitionIndexes.get(worker),
              ...workerEvent.data.diagnostics });
          } else if (workerEvent.data.type === 'error') {
            fail(workerEvent.data.message);
          } else if (workerEvent.data.type === 'progress') {
            activeProgress.set(worker, workerEvent.data.progress);
            const index = activePartitionIndexes.get(worker)!;
            partitionProgress[index] = Math.max(partitionProgress[index],
              Math.min(0.999999, workerEvent.data.progress.searchProgress ?? 0));
            updateProgress();
          } else if (workerEvent.data.type === 'result') {
            partitionProgress[activePartitionIndexes.get(worker)!] = 1;
            completed++;
            exploredStates += workerEvent.data.result.exploredStates;
            if ((workerEvent.data.result.score ?? workerEvent.data.result.damage) > (bestResult.score ?? bestResult.damage)) {
              bestResult = workerEvent.data.result;
            }
            activeProgress.delete(worker);
            updateProgress();
            if (completed === partitions.length) {
              workers.forEach(item => item.terminate());
              workersRef.current = [];
              setResult({ ...bestResult, exploredStates });
              setResultExcludedGearKey(calculationExcludedGearKey);
              console.log('[自动配装] 全部完成', { elapsedMs: Date.now() - runStarted,
                partitions: partitions.length, workers: workerCount, damage: bestResult.damage,
                exploredStates, selectedGear: bestResult.gears.map(gear => ({ id: gear.id,
                  name: gear.name, itemLevel: gear.level, synced: gear.synced })) });
              setStatus('done');
            } else {
              assign(worker);
            }
          }
        };
        assign(worker);
      }
    };
    planner.postMessage({ type: 'plan', input, workers: selectedWorkerCount });
  };

  const busy = status === 'loading' || status === 'running';
  const parsedTargetGcd = targetGcd.trim() === '' ? NaN : Number(targetGcd);
  const targetGcdValid = Number.isFinite(parsedTargetGcd) && parsedTargetGcd > 0 &&
    Math.abs(parsedTargetGcd * 100 - Math.round(parsedTargetGcd * 100)) <= 1e-7;
  const parsedMinimumTenacityMitigation = minimumTenacityMitigation.trim() === ''
    ? NaN
    : Number(minimumTenacityMitigation);
  const minimumTenacityMitigationValid = Number.isFinite(parsedMinimumTenacityMitigation) &&
    parsedMinimumTenacityMitigation >= 0 && parsedMinimumTenacityMitigation < 100;
  const exchangeValid = mitigationExchange.trim() !== '' && Number.isFinite(Number(mitigationExchange)) &&
    Number(mitigationExchange) >= 0.01 && Number(mitigationExchange) <= 100;
  const tankObjectiveValid = !isTank || (tradeTenacity ? exchangeValid : minimumTenacityMitigationValid);
  const excludedGearKey = exclusionKey(excludedGearIds, activeExcludedGearCategories);
  const excludedGearIdSet = new Set(excludedGearIds);
  const resultIsStale = result !== undefined && resultExcludedGearKey !== excludedGearKey;
  const specialWeaponCategoryOptions = availableGearCategories.filter(category =>
    specialWeaponCategories.has(category.id));
  const specialGearCategoryOptions = availableGearCategories.filter(category =>
    specialGearCategories.has(category.id));
  const regularGearCategoryOptions = availableGearCategories.filter(category =>
    !specialWeaponCategories.has(category.id) && !specialGearCategories.has(category.id));
  const previewedGearCategoryOption = availableGearCategories.find(category =>
    category.id === previewedGearCategory);
  const exclusionConditionCount = excludedGearIds.length + activeExcludedGearCategories.length;
  const slotOrder = new Map<number, number>();
  for (const [ index, slot ] of store.schema.slots.entries()) {
    if (slot.slot === -1) continue;
    const normalizedSlot = Math.abs(slot.slot);
    if (!slotOrder.has(normalizedSlot)) slotOrder.set(normalizedSlot, index);
  }
  const orderedResultGears = result?.gears.slice().sort((left, right) =>
    (slotOrder.get(left.slot) ?? Infinity) - (slotOrder.get(right.slot) ?? Infinity));
  const previewedCategoryGears = previewedGearCategoryOption?.gears.slice().sort((left, right) => {
    const slotDifference = (slotOrder.get(left.slot) ?? Infinity) -
      (slotOrder.get(right.slot) ?? Infinity);
    return slotDifference !== 0 ? slotDifference : right.level - left.level || left.id - right.id;
  });
  const categoryButton = (category: typeof availableGearCategories[number]) => {
    const selected = activeExcludedGearCategories.includes(category.id);
    const previewed = previewedGearCategory === category.id;
    return (
      <div
        key={category.id}
        className={`gear-optimization_category-option${selected ? ' -selected' : ''}`}
      >
        <button
          type="button"
          className="gear-optimization_category-toggle"
          aria-pressed={selected}
          disabled={busy}
          onClick={() => toggleExcludedGearCategory(category.id)}
        >
          <span>{category.label}</span>
          <span>{category.count}</span>
        </button>
        <button
          type="button"
          className="gear-optimization_category-preview"
          aria-label={`查看${category.label}包含的装备`}
          aria-expanded={previewed}
          aria-controls="gear-optimization_category-preview"
          title={`查看${category.label}包含的装备`}
          onClick={() => setPreviewedGearCategory(previewed ? undefined : category.id)}
        >?</button>
      </div>
    );
  };
  return (
    <div className="gear-optimization card">
      <div className="gear-optimization_intro">
        <p>{`在指定最终 GCD 下，搜索符合当前优化目标的配装（使用${speedName}计算）。`}</p>
        <p>候选装备与当前列表显示范围一致：品级筛选范围内的装备，加上手动选定的装备。</p>
        {store.syncLevel !== undefined && (
          <p>品级同步只调整候选装备的属性，不会自动加入范围外装备；手动选定不等于锁定。</p>
        )}
        {store.syncLevel !== undefined && (
          <p>范围内的高品级同步装备按同步后的属性计算，魔晶石不生效。</p>
        )}
        <p>{`魔晶石使用各孔最高值，并精确枚举暴击、信念、直击、坚韧和${speedName}。`}</p>
      </div>
      {incompleteCustomWeapons.length > 0 && (
        <div className="gear-optimization_warning" role="alert">
          <strong>请先填写特殊武器属性：</strong>
          当前筛选范围内的{incompleteCustomWeapons.join('、')}尚未填写自定义属性，因此不会参与自动配装。
        </div>
      )}

      <div className="gear-optimization_constraint-row">
        <span>目标 GCD</span>
        <input
          aria-label="目标 GCD"
          type="number"
          min="0.01"
          step="0.01"
          value={targetGcd}
          disabled={busy}
          onChange={event => {
            setTargetGcd(event.target.value);
            setStatus('idle');
            setResult(undefined);
            setResultExcludedGearKey(undefined);
          }}
        />
      </div>
      {isTank && (
        <div className="gear-optimization_tenacity">
          <div className="gear-optimization_constraint-row">
            <span>坚韧策略</span>
            <select aria-label="坚韧策略" value={tradeTenacity ? 'tradeoff' : 'minimum'} disabled={busy}
              onChange={event => {
                setTradeTenacity(event.target.value === 'tradeoff');
                setStatus('idle'); setResult(undefined); setResultExcludedGearKey(undefined);
              }}>
              <option value="minimum">最低减伤</option>
              <option value="tradeoff">减伤折算</option>
            </select>
          </div>
          <div className="gear-optimization_tenacity-value">
            {tradeTenacity ? <>
              <span>每</span>
              <input type="number" aria-label="减伤兑换比例" min="0.01" max="100" step="0.1"
                value={mitigationExchange} disabled={busy}
                onChange={event => {
                  setMitigationExchange(event.target.value);
                  setStatus('idle'); setResult(undefined); setResultExcludedGearKey(undefined);
                }} />
              <span>% 减伤</span>
              <span className="gear-optimization_exchange-equals">＝</span>
              <span>1% 增伤</span>
            </> : <>
              <span>减伤不低于</span>
              <input aria-label="最低坚韧减伤" type="number" min="0" max="99.9" step="0.1"
                value={minimumTenacityMitigation} disabled={busy}
                onChange={event => {
                  setMinimumTenacityMitigation(event.target.value);
                  setStatus('idle'); setResult(undefined); setResultExcludedGearKey(undefined);
                }} />
              <span>%</span>
            </>}
          </div>
        </div>
      )}
      <div className="gear-optimization_constraint-row">
        <span>暴击属性策略</span>
        <select
          aria-label="暴击属性策略"
          className="gear-optimization_critical-preference"
          value={criticalPreference}
          disabled={busy}
          onChange={event => {
            setCriticalPreference(event.target.value as CriticalPreference);
            setStatus('idle');
            setResult(undefined);
            setResultExcludedGearKey(undefined);
          }}
        >
          <option value="none">不限制</option>
          <option value="high">高暴击</option>
          <option value="low">低暴击</option>
        </select>
      </div>
      <div className="gear-optimization_constraint-row">
        <span>Worker 数量</span>
        <select
          aria-label="Worker 数量"
          value={selectedWorkerCount}
          disabled={busy}
          onChange={event => setSelectedWorkerCount(Number(event.target.value))}
        >
          {[ 1, 2, 3, 4 ].map(count => <option key={count} value={count}>{count}</option>)}
        </select>
      </div>
      <div className="gear-optimization_worker-tip">
        更多 Worker 通常计算更快，但会提高内存峰值；内存不足或出现 Out of Memory 时请选择 1–2。
      </div>

      <div className="gear-optimization_section-title">锁定当前装备（可选）</div>
      <div className="gear-optimization_locks">
        {lockable.length > 0 ? lockable.map(({ slot, name, gear }) => {
          const locked = lockedSlots.includes(slot);
          const hasMateria = !gear.isFood && gear.materias.some(materia => materia.stat !== undefined);
          const materiaLocked = lockedMateriaSlots.includes(slot);
          return (
            <div key={slot} className="gear-optimization_lock-entry">
              <label className="gear-optimization_lock">
                <input
                  type="checkbox"
                  checked={locked}
                  disabled={busy}
                  onChange={() => toggleLock(slot)}
                />
                <span className="gear-optimization_lock-slot">{name}</span>
                <span className="gear-optimization_lock-name">{gear.name}</span>
              </label>
              {locked && hasMateria && (
                <button
                  type="button"
                  className={`gear-optimization_lock-materia${materiaLocked ? ' -selected' : ''}`}
                  aria-label={`${materiaLocked ? '取消' : ''}连带锁定${gear.name}的魔晶石`}
                  aria-pressed={materiaLocked}
                  title={materiaLocked ? '已连带锁定魔晶石；点击取消' : '点击连带锁定当前魔晶石'}
                  disabled={busy}
                  onClick={() => toggleLockedMateria(slot)}
                >
                  <Icon name="materia" />
                </button>
              )}
            </div>
          );
        }) : (
          <span className="gear-optimization_empty">当前没有可锁定的装备</span>
        )}
      </div>
      <div className="gear-optimization_lock-tip">
        默认只锁定装备或食物 ID；锁定已镶嵌魔晶石的装备后，点亮右侧图标可同时保留当前魔晶石。
      </div>

      <label className="gear-optimization_section-title gear-optimization_exclusion-toggle">
        <input
          type="checkbox"
          checked={exclusionsExpanded}
          aria-controls="gear-optimization_exclusion-content"
          aria-expanded={exclusionsExpanded}
          onChange={event => {
            setExclusionsExpanded(event.target.checked);
            if (!event.target.checked) setPreviewedGearCategory(undefined);
          }}
        />
        <span>排除装备</span>
        {exclusionConditionCount > 0 && (
          <span className="gear-optimization_exclusion-count">已选 {exclusionConditionCount}</span>
        )}
      </label>
      {exclusionsExpanded && (
        <div id="gear-optimization_exclusion-content">
      {specialWeaponCategoryOptions.length > 0 && (
        <div className="gear-optimization_category-group">
          <div className="gear-optimization_category-label">特殊武器</div>
          <div className="gear-optimization_category-list">
            {specialWeaponCategoryOptions.map(categoryButton)}
          </div>
        </div>
      )}
      {specialGearCategoryOptions.length > 0 && (
        <div className="gear-optimization_category-group">
          <div className="gear-optimization_category-label">特殊获取</div>
          <div className="gear-optimization_category-list">
            {specialGearCategoryOptions.map(categoryButton)}
          </div>
        </div>
      )}
      {regularGearCategoryOptions.length > 0 && (
        <div className="gear-optimization_category-group">
          <div className="gear-optimization_category-label">装备来源</div>
          <div className="gear-optimization_category-list">
            {regularGearCategoryOptions.map(categoryButton)}
          </div>
        </div>
      )}
      {previewedGearCategoryOption !== undefined && previewedCategoryGears !== undefined && (
        <div
          id="gear-optimization_category-preview"
          className="gear-optimization_category-preview-panel"
          role="region"
          aria-label={`${previewedGearCategoryOption.label}包含的装备`}
        >
          <div className="gear-optimization_category-preview-heading">
            <strong>{previewedGearCategoryOption.label}（{previewedCategoryGears.length}）</strong>
            <button
              type="button"
              aria-label="关闭装备清单"
              title="关闭装备清单"
              onClick={() => setPreviewedGearCategory(undefined)}
            >×</button>
          </div>
          <div className="gear-optimization_category-preview-items">
            {previewedCategoryGears.map(gear => {
              const slot = store.schema.slots.find(candidate =>
                Math.abs(candidate.slot) === gear.slot && candidate.slot !== -12);
              const color = resolveGearColor(gear, store.setting.gearColorScheme);
              return (
                <div key={gear.id} className={`gears_color-${color}`}>
                  <span className="gear-optimization_category-preview-slot">
                    {slot?.shortName ?? slot?.name ?? `部位 ${gear.slot}`}
                  </span>
                  <span className="gears_name">{gear.name}</span>
                  <span>il{gear.level}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {excludedGearIds.length > 0 && (
        <div className="gear-optimization_exclusions">
          <div className="gear-optimization_exclusion-list">
            {excludedGearIds.map(id => (
              <button
                key={id}
                type="button"
                disabled={busy}
                title="恢复此装备"
                onClick={() => toggleExcludedGear(id)}
              >
                <span>{gearData.get(id as G.GearId)?.name ?? `装备 ${id}`}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {exclusionConditionCount > 0 && (
        <div className="gear-optimization_clear-exclusions-row">
          <button
            className="gear-optimization_clear-exclusions"
            type="button"
            disabled={busy}
            onClick={() => {
              setExcludedGearIds([]);
              setExcludedGearCategories([]);
              setStatus('idle');
              setError('');
            }}
          >清空排除</button>
        </div>
      )}
      <div className="gear-optimization_lock-tip">
        可在计算前按来源排除，计算后仍可继续排除单件装备；锁定装备不受来源排除影响。
      </div>
        </div>
      )}

      {status === 'loading' && <div className="gear-optimization_status">正在加载候选装备数据…</div>}
      {status === 'running' && (
        <div className="gear-optimization_status">
          {progress?.searchProgress !== undefined && (
            <div title="按已评估或已通过剪枝排除的搜索空间估算，包含全部食物/速度分片；不代表耗时比例，可能跳跃或长时间停留。">
              <div>{`整体进度约 ${(Math.min(0.999, progress.searchProgress) * 100).toFixed(1)}%（已完成 ${progress.completedGroups}/${progress.totalGroups} 个分片）`}</div>
              <progress
                className="gear-optimization_progress"
                aria-label="自动配装估算进度"
                max={1}
                value={progress.searchProgress}
              />
              <div className="gear-optimization_progress-tip">按搜索空间估算，不代表耗时比例。</div>
            </div>
          )}
          {progress === undefined
            ? '正在分析候选食物和可达速度值…'
            : progress.visitedBranches !== undefined
              ? `正在精确搜索：已检查 ${progress.visitedBranches} 个属性分支、${progress.states} 个完整组合…`
            : `已完成 ${progress.completedGroups}/${progress.totalGroups} 个食物/速度分片，当前保留 ${progress.states} 个属性状态…`}
        </div>
      )}
      {status === 'error' && <div className="gear-optimization_error">{error}</div>}

      {result !== undefined && (
        <div className="gear-optimization_result">
          {resultIsStale && (
            <div className="gear-optimization_result-stale">排除条件已更改，请重新计算。</div>
          )}
          <div className="gear-optimization_damage">
            {baselineDamage !== undefined && <span>当前 {baselineDamage.toFixed(5)}</span>}
            <span>{result.score === undefined ? '最优' : '伤害'} {result.damage.toFixed(5)}</span>
            {result.score !== undefined && <span>折算评分 {result.score.toFixed(5)}</span>}
            {baselineDamage !== undefined && (
              <span className={result.damage > baselineDamage ? '-better' : ''}>
                {result.damage >= baselineDamage ? '+' : ''}{(result.damage - baselineDamage).toFixed(5)}
              </span>
            )}
            {isTank && (
              <span>坚韧减伤 {(result.tenacityMitigation * 100).toFixed(1)}%</span>
            )}
          </div>
          {result.criticalRange !== undefined && (
            <div className="gear-optimization_critical-range">
              总暴击范围 {result.criticalRange.minimum}–{result.criticalRange.maximum}；
              {criticalPreference === 'high' ? `本次要求 ≥ ${Math.ceil(result.criticalRange.threshold ?? result.criticalRange.midpoint)}` :
                `本次要求 ≤ ${Math.floor(result.criticalRange.threshold ?? result.criticalRange.midpoint)}`}
            </div>
          )}
          <div className="gear-optimization_stats">
            {store.schema.stats.filter(stat => stat !== 'VIT').map(stat => (
              <span key={stat}>{G.statNames[stat]} {result.stats[stat as OptimizerStat]}</span>
            ))}
          </div>
          <div className="gear-optimization_items">
            {orderedResultGears?.map((gear, index) => {
              const data = gearData.get(gear.id as G.GearId) as G.Gear | undefined;
              const color = data === undefined
                ? 'white'
                : resolveGearColor(data, store.setting.gearColorScheme);
              const excluded = excludedGearIdSet.has(gear.id);
              const exclusionDisabled = busy || lockedGearIds.has(gear.id);
              return (
                <div
                  key={`${gear.slot}-${gear.id}-${index}`}
                  className={`gears_color-${color}${excluded ? ' -excluded' : ''}`}
                >
                  <span className="gears_name">{gear.name}</span>
                  <span className="gear-optimization_item-level">il{gear.level}</span>
                  <span className="gear-optimization_item-melds">
                    {gear.synced ? '同步' : gear.melds.map(meld => G.statNames[meld.stat]).join('、') || '无孔'}
                  </span>
                  <label
                    className={`gear-optimization_item-exclusion${exclusionDisabled ? ' -disabled' : ''}`}
                    title={lockedGearIds.has(gear.id) ? '已锁定的装备不能排除' : undefined}
                  >
                    <input
                      type="checkbox"
                      aria-label={`排除${gear.name}`}
                      checked={excluded}
                      disabled={exclusionDisabled}
                      onChange={() => toggleExcludedGear(gear.id)}
                    />
                    <span>排除</span>
                  </label>
                </div>
              );
            })}
            {result.food !== undefined && (
              <div>
                <span>{result.food.name}</span>
                <span className="gear-optimization_item-level">食物</span>
                <span className="gear-optimization_item-melds">
                  {lockedSlots.includes(-1) ? '已锁定' : '自动选择'}
                </span>
                <span />
              </div>
            )}
          </div>
          <div className="gear-optimization_explored">共检查 {result.exploredStates} 个组合状态。</div>
        </div>
      )}

      <div className="gear-optimization_actions">
        <Button
          disabled={busy || !targetGcdValid || !tankObjectiveValid}
          onClick={start}
        >
          {result === undefined
            ? exclusionConditionCount > 0 ? `计算排除方案（${exclusionConditionCount}）` : '开始计算'
            : resultIsStale ? '按排除条件重新计算' : '重新计算'}
        </Button>
        {result !== undefined && (
          <Button
            disabled={resultIsStale}
            onClick={() => {
              store.applyGearOptimization(result);
              toggle();
            }}
          >应用方案</Button>
        )}
      </div>
    </div>
  );
});
