import * as React from 'react';
import * as mobxReact from 'mobx-react-lite';
import { Button } from './@rmwc/button';
import * as G from '../game';
import { loadGearDataOfLevelRange } from '../stores';
import { createNoSpeedOptimizationInput } from '../optimizerInput';
import type {
  NoSpeedOptimizationResult,
  OptimizerProgress,
  OptimizerStat,
} from '../optimizer';
import type { DropdownPopperProps } from './components/Dropdown';
import { useStore } from './components/contexts';

type Status = 'idle' | 'loading' | 'running' | 'done' | 'error';
type WorkerResponse =
  { type: 'progress', progress: OptimizerProgress } |
  { type: 'result', result: NoSpeedOptimizationResult } |
  { type: 'error', message: string };

export const NoSpeedOptimizationPanel = mobxReact.observer<DropdownPopperProps>(({ toggle }) => {
  const store = useStore();
  const [ lockedSlots, setLockedSlots ] = React.useState<number[]>([]);
  const [ status, setStatus ] = React.useState<Status>('idle');
  const [ progress, setProgress ] = React.useState<OptimizerProgress>();
  const [ result, setResult ] = React.useState<NoSpeedOptimizationResult>();
  const [ baselineDamage, setBaselineDamage ] = React.useState<number>();
  const [ error, setError ] = React.useState('');
  const workerRef = React.useRef<Worker | null>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => () => {
    mountedRef.current = false;
    workerRef.current?.terminate();
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
    workerRef.current?.terminate();
    setStatus('loading');
    setResult(undefined);
    setProgress(undefined);
    setError('');
    setBaselineDamage(store.equippedEffects?.damage);
    store.setOptimizationDataLoading(true);
    try {
      await loadGearDataOfLevelRange(store.syncLevel! - 5, Infinity);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setStatus('error');
      return;
    } finally {
      store.setOptimizationDataLoading(false);
    }
    if (!mountedRef.current) return;

    let input;
    try {
      input = createNoSpeedOptimizationInput(store, lockedSlots);
    } catch (inputError) {
      setError(inputError instanceof Error ? inputError.message : String(inputError));
      setStatus('error');
      return;
    }

    setStatus('running');
    const worker = new Worker(new URL('../optimizer.worker.ts', import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (!mountedRef.current) return;
      if (event.data.type === 'progress') {
        setProgress(event.data.progress);
      } else if (event.data.type === 'result') {
        setResult(event.data.result);
        setStatus('done');
        worker.terminate();
      } else {
        setError(event.data.message);
        setStatus('error');
        worker.terminate();
      }
    };
    worker.onerror = event => {
      setError(event.message || '自动配装计算失败。');
      setStatus('error');
      worker.terminate();
    };
    worker.postMessage(input);
  };

  const busy = status === 'loading' || status === 'running';
  const speedStat = store.schema.stats.includes('SKS') ? '技速' : '咏速';
  return (
    <div className="no-speed-optimization card">
      <div className="no-speed-optimization_intro">
        <p>搜索不含技速/咏速的最高每威力伤害期望配装。</p>
        <p>非同步装备仅使用同步品级及低5品级；高品级装备同步后必须有两项满值副属性。</p>
        <p>魔晶石使用各孔最高值；暴击溢出不超过10%时仍优先暴击，其余孔优化信念、直击或坚韧。</p>
        <p>{`当前${speedStat}基础值会保留，装备、食物和魔晶石不得增加${speedStat}。`}</p>
      </div>

      <div className="no-speed-optimization_section-title">锁定当前装备（可选）</div>
      <div className="no-speed-optimization_locks">
        {lockable.length > 0 ? lockable.map(({ slot, name, gear }) => (
          <label key={slot} className="no-speed-optimization_lock">
            <input
              type="checkbox"
              checked={lockedSlots.includes(slot)}
              disabled={busy}
              onChange={() => toggleLock(slot)}
            />
            <span className="no-speed-optimization_lock-slot">{name}</span>
            <span>{gear.name}</span>
          </label>
        )) : (
          <span className="no-speed-optimization_empty">当前没有可锁定的装备</span>
        )}
      </div>
      <div className="no-speed-optimization_lock-tip">锁定装备 ID，但仍会重新优化其魔晶石。</div>

      {status === 'loading' && <div className="no-speed-optimization_status">正在加载候选装备数据…</div>}
      {status === 'running' && (
        <div className="no-speed-optimization_status">
          {progress === undefined
            ? '正在生成候选方案…'
            : `已处理 ${progress.completedGroups}/${progress.totalGroups} 个部位，保留 ${progress.states} 个属性状态…`}
        </div>
      )}
      {status === 'error' && <div className="no-speed-optimization_error">{error}</div>}

      {result !== undefined && (
        <div className="no-speed-optimization_result">
          <div className="no-speed-optimization_damage">
            <span>当前 {baselineDamage?.toFixed(5) ?? '—'}</span>
            <span>最优 {result.damage.toFixed(5)}</span>
            {baselineDamage !== undefined && (
              <span className={result.damage > baselineDamage ? '-better' : ''}>
                {result.damage >= baselineDamage ? '+' : ''}{(result.damage - baselineDamage).toFixed(5)}
              </span>
            )}
          </div>
          <div className="no-speed-optimization_stats">
            {store.schema.stats.filter(stat => stat !== 'VIT' && stat !== 'SKS' && stat !== 'SPS').map(stat => (
              <span key={stat}>{G.statNames[stat]} {result.stats[stat as OptimizerStat]}</span>
            ))}
          </div>
          <div className="no-speed-optimization_items">
            {result.gears.map((gear, index) => (
              <div key={`${gear.slot}-${gear.id}-${index}`}>
                <span>{gear.name}</span>
                <span className="no-speed-optimization_item-level">il{gear.level}</span>
                <span className="no-speed-optimization_item-melds">
                  {gear.synced ? '同步' : gear.melds.map(meld => G.statNames[meld.stat]).join('、') || '无孔'}
                </span>
              </div>
            ))}
          </div>
          <div className="no-speed-optimization_explored">共检查 {result.exploredStates} 个组合状态。</div>
        </div>
      )}

      <div className="no-speed-optimization_actions">
        <Button disabled={busy || store.syncLevel === undefined} onClick={start}>
          {result === undefined ? '开始计算' : '重新计算'}
        </Button>
        {result !== undefined && (
          <Button
            onClick={() => {
              store.applyNoSpeedOptimization(result);
              toggle();
            }}
          >应用方案</Button>
        )}
      </div>
      {store.syncLevel === undefined && (
        <div className="no-speed-optimization_error">请先选择明确的品级同步值。</div>
      )}
    </div>
  );
});
