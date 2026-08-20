import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import { Button } from './@rmwc/button';
import * as G from '../game';
import { loadGearDataOfLevelRange } from '../stores';
import { createGearOptimizationInput } from '../optimizerInput';
import type {
  GearOptimizationInput,
  GearOptimizationResult,
  GearOptimizationPlan,
  OptimizerProgress,
  OptimizerStat,
} from '../optimizer';
import type { DropdownPopperProps } from './components/Dropdown';
import { useStore } from './components/contexts';

type Status = 'idle' | 'loading' | 'running' | 'done' | 'error';
type WorkerResponse =
  { type: 'plan', plan: GearOptimizationPlan } |
  { type: 'progress', progress: OptimizerProgress } |
  { type: 'result', result: GearOptimizationResult } |
  { type: 'error', message: string };

export const GearOptimizationPanel = mobxReact.observer<DropdownPopperProps>(({ toggle }) => {
  const store = useStore();
  const speedStat: 'SKS' | 'SPS' = store.schema.stats.includes('SKS') ? 'SKS' : 'SPS';
  const speedName = G.statNames[speedStat];
  const isTank = store.schema.stats.includes('TEN');
  const initialGcd = store.equippedEffects?.gcd ?? 2.5;
  const [ lockedSlots, setLockedSlots ] = React.useState<number[]>([]);
  const [ targetGcd, setTargetGcd ] = React.useState(initialGcd.toFixed(2));
  const [ status, setStatus ] = React.useState<Status>('idle');
  const [ progress, setProgress ] = React.useState<OptimizerProgress>();
  const [ result, setResult ] = React.useState<GearOptimizationResult>();
  const [ baselineDamage, setBaselineDamage ] = React.useState<number>();
  const [ minimumTenacityMitigation, setMinimumTenacityMitigation ] = React.useState('0.0');
  const [ error, setError ] = React.useState('');
  const workersRef = React.useRef<Worker[]>([]);
  const mountedRef = React.useRef(true);

  React.useEffect(() => () => {
    mountedRef.current = false;
    workersRef.current.forEach(worker => worker.terminate());
  }, []);

  const lockable = store.schema.slots.flatMap(slot => {
    if (slot.slot <= 0 && slot.slot !== -12) return [];
    const gear = store.equippedGears.get(slot.slot.toString());
    if (gear === undefined || gear.isFood) return [];
    return [{ slot: slot.slot, name: `${slot.name}${slot.slot === -12 ? '（右）' : ''}`, gear }];
  });

  const toggleLock = (slot: number) => {
    setLockedSlots(slots => slots.includes(slot) ? slots.filter(value => value !== slot) : slots.concat(slot));
    setStatus('idle');
    setResult(undefined);
  };

  const start = async () => {
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
    if (isTank &&
        (!Number.isFinite(parsedMinimumTenacityMitigation) ||
          parsedMinimumTenacityMitigation < 0 || parsedMinimumTenacityMitigation >= 100)) {
      setError('请输入大于等于 0 且小于 100 的最低坚韧减伤百分比。');
      setStatus('error');
      return;
    }
    workersRef.current.forEach(worker => worker.terminate());
    workersRef.current = [];
    setStatus('loading');
    setResult(undefined);
    setProgress(undefined);
    setError('');
    setBaselineDamage(store.equippedEffects?.damage);
    store.setOptimizationDataLoading(true);
    try {
      const minimumLevel = store.minLevel > 0
        ? Math.min(store.minLevel, store.syncLevel! - 5)
        : store.syncLevel! - 5;
      await loadGearDataOfLevelRange(minimumLevel, Infinity);
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
      input = createGearOptimizationInput(store, lockedSlots, parsedTargetGcd);
      input = isTank
        ? {
          ...input,
          objective: {
            type: 'minimumTenacity',
            minimumTenacityMitigation: parsedMinimumTenacityMitigation / 100,
          },
        }
        : { ...input, objective: { type: 'damage' } };
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
      if (event.data.type === 'error') {
        fail(event.data.message);
        return;
      }
      if (event.data.type !== 'plan') return;
      planner.terminate();
      const { partitions, heuristicResult } = event.data.plan;
      if (partitions.length === 0) {
        fail(`没有找到最终 GCD 为 ${parsedTargetGcd.toFixed(2)} 秒的完整配装。`);
        return;
      }

      const workerCount = Math.min(
        partitions.length, Math.max(1, navigator.hardwareConcurrency ?? 4), 4);
      const workers = Array.from({ length: workerCount }, () =>
        new Worker(new URL('../optimizer.worker.ts', import.meta.url)));
      workersRef.current = workers;
      const activeProgress = new Map<Worker, OptimizerProgress>();
      let nextIndex = 0;
      let completed = 0;
      let exploredStates = 0;
      let bestResult: GearOptimizationResult = heuristicResult;
      const updateProgress = () => setProgress({
        completedGroups: completed,
        totalGroups: partitions.length,
        states: Array.from(activeProgress.values()).reduce((total, value) => total + value.states, 0),
      });
      const assign = (worker: Worker) => {
        if (nextIndex >= partitions.length) {
          worker.terminate();
          return;
        }
        const targetSpeedContribution = partitions[nextIndex++].contribution;
        activeProgress.delete(worker);
        worker.postMessage({
          type: 'optimize',
          input: { ...input, targetSpeedContribution, globalMinimumDamage: bestResult.damage },
        });
      };
      for (const worker of workers) {
        worker.onerror = workerError => fail(workerError.message || '自动配装计算失败。');
        worker.onmessage = (workerEvent: MessageEvent<WorkerResponse>) => {
          if (!mountedRef.current) return;
          if (workerEvent.data.type === 'error') {
            fail(workerEvent.data.message);
          } else if (workerEvent.data.type === 'progress') {
            activeProgress.set(worker, workerEvent.data.progress);
            updateProgress();
          } else if (workerEvent.data.type === 'result') {
            completed++;
            exploredStates += workerEvent.data.result.exploredStates;
            if (workerEvent.data.result.damage > bestResult.damage) {
              bestResult = workerEvent.data.result;
            }
            activeProgress.delete(worker);
            updateProgress();
            if (completed === partitions.length) {
              workers.forEach(item => item.terminate());
              workersRef.current = [];
              setResult({ ...bestResult, exploredStates });
              setStatus('done');
            } else {
              assign(worker);
            }
          }
        };
        assign(worker);
      }
    };
    planner.postMessage({ type: 'plan', input });
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
  const tankObjectiveValid = !isTank || minimumTenacityMitigationValid;
  return (
    <div className="gear-optimization card">
      <div className="gear-optimization_intro">
        <p>{`在指定最终 GCD 下，搜索最高每威力伤害期望配装（使用${speedName}计算）。`}</p>
        <p>非同步装备优先使用同步品级及低5品级；治疗职业缺少足够无信仰装备时，会按筛选范围向下放宽品级。</p>
        <p>{`魔晶石使用各孔最高值，并精确枚举暴击、信念、直击、坚韧和${speedName}。`}</p>
        <p>装备、魔晶石和当前食物生效后计算出的 GCD 必须精确等于目标值。</p>
        <p>特殊武器的属性需要提前手动输入，食物需要提前手动选择；求解器会沿用当前配置。</p>
      </div>

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
          }}
        />
      </div>
      {isTank && (
        <div className="gear-optimization_constraint-row">
          <span>坚韧减伤不低于</span>
          <input
            aria-label="最低坚韧减伤"
            className="gear-optimization_minimum-tenacity-mitigation"
            type="number"
            min="0"
            max="99.9"
            step="0.1"
            value={minimumTenacityMitigation}
            disabled={busy}
            onChange={event => {
              setMinimumTenacityMitigation(event.target.value);
              setStatus('idle');
              setResult(undefined);
            }}
          />
          <span>%</span>
        </div>
      )}

      <div className="gear-optimization_section-title">锁定当前装备（可选）</div>
      <div className="gear-optimization_locks">
        {lockable.length > 0 ? lockable.map(({ slot, name, gear }) => (
          <label key={slot} className="gear-optimization_lock">
            <input
              type="checkbox"
              checked={lockedSlots.includes(slot)}
              disabled={busy}
              onChange={() => toggleLock(slot)}
            />
            <span className="gear-optimization_lock-slot">{name}</span>
            <span>{gear.name}</span>
          </label>
        )) : (
          <span className="gear-optimization_empty">当前没有可锁定的装备</span>
        )}
      </div>
      <div className="gear-optimization_lock-tip">锁定装备 ID，但仍会重新优化其魔晶石。</div>

      {status === 'loading' && <div className="gear-optimization_status">正在加载候选装备数据…</div>}
      {status === 'running' && (
        <div className="gear-optimization_status">
          {progress === undefined
            ? '正在分析可达速度值…'
            : `已完成 ${progress.completedGroups}/${progress.totalGroups} 个可达速度值，当前保留 ${progress.states} 个属性状态…`}
        </div>
      )}
      {status === 'error' && <div className="gear-optimization_error">{error}</div>}

      {result !== undefined && (
        <div className="gear-optimization_result">
          <div className="gear-optimization_damage">
            <span>当前 {baselineDamage?.toFixed(5) ?? '—'}</span>
            <span>最优 {result.damage.toFixed(5)}</span>
            {baselineDamage !== undefined && (
              <span className={result.damage > baselineDamage ? '-better' : ''}>
                {result.damage >= baselineDamage ? '+' : ''}{(result.damage - baselineDamage).toFixed(5)}
              </span>
            )}
            {isTank && (
              <span>坚韧减伤 {(result.tenacityMitigation * 100).toFixed(1)}%</span>
            )}
          </div>
          <div className="gear-optimization_stats">
            {store.schema.stats.filter(stat => stat !== 'VIT').map(stat => (
              <span key={stat}>{G.statNames[stat]} {result.stats[stat as OptimizerStat]}</span>
            ))}
          </div>
          <div className="gear-optimization_items">
            {result.gears.map((gear, index) => (
              <div key={`${gear.slot}-${gear.id}-${index}`}>
                <span>{gear.name}</span>
                <span className="gear-optimization_item-level">il{gear.level}</span>
                <span className="gear-optimization_item-melds">
                  {gear.synced ? '同步' : gear.melds.map(meld => G.statNames[meld.stat]).join('、') || '无孔'}
                </span>
              </div>
            ))}
          </div>
          <div className="gear-optimization_explored">共检查 {result.exploredStates} 个组合状态。</div>
        </div>
      )}

      <div className="gear-optimization_actions">
        <Button
          disabled={busy || store.syncLevel === undefined || !targetGcdValid || !tankObjectiveValid}
          onClick={start}
        >
          {result === undefined ? '开始计算' : '重新计算'}
        </Button>
        {result !== undefined && (
          <Button
            onClick={() => {
              store.applyGearOptimization(result);
              toggle();
            }}
          >应用方案</Button>
        )}
      </div>
      {store.syncLevel === undefined && (
        <div className="gear-optimization_error">请先选择明确的品级同步值。</div>
      )}
    </div>
  );
});
