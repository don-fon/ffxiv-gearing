import type { GearOptimizationPlan, GearOptimizationResult, OptimizerProgress } from './optimizer';

let sequence = 0;

/** One console owner per UI run. Worker messages remain available to benchmark tools. */
export function createOptimizerLogger(started: number) {
  const id = ++sequence;
  const snapshots = new Map<string, Record<string, unknown>>();
  const accumulated: Record<string, number> = {};
  const metrics = ['initializationMs', 'wasmSearchMs', 'wasmParetoMs', 'otherMs',
    'wasmVisitedBranches', 'wasmEvaluatedCombinations', 'wasmSearchCalls',
    'wasmParetoInputOptions', 'wasmParetoOutputOptions',
    'fixedSearchCalls', 'fixedSearchMs', 'rangeSearchCalls', 'rangeSearchMs', 'warmSearchCalls', 'warmSearchMs'];
  let lastReport = started;
  let ready = false;
  let restarts = 0;
  let peakMemory = 0;
  let progress: OptimizerProgress | undefined;
  const received = new Map<string, number>();
  const recentRestarts: Record<string, unknown>[] = [];
  let best: GearOptimizationResult | undefined;
  let initialScore: number | undefined;
  let improvements = 0;
  let improvedAt = started;
  let sample = { time: started, branches: 0, combinations: 0 };
  const score = (result: GearOptimizationResult) => result.score ?? result.damage;
  const observeBest = (result: GearOptimizationResult) => {
    if (result.empty || !Number.isFinite(score(result)) || (best && score(result) <= score(best))) return;
    if (best) improvements++;
    else initialScore = score(result);
    best = result;improvedAt = Date.now();
  };
  const value = (snapshot: Record<string, unknown>, key: string) =>
    typeof snapshot[key] === 'number' && Number.isFinite(snapshot[key]) ? snapshot[key] as number : 0;
  const write = (stage: string, detail: Record<string, unknown>, error = false) => {
    const brief = [
      detail.墙钟秒 === undefined ? undefined : `耗时 ${detail.墙钟秒}s`,
      detail.完成分片 === undefined ? undefined : `分片 ${detail.完成分片}`,
      detail.搜索分支 === undefined ? undefined : `分支 ${detail.搜索分支}`,
      detail.完整组合 === undefined ? undefined : `完整组合 ${detail.完整组合}`,
      detail.原因,
    ].filter(value => value !== undefined).join('；');
    const line = `[自动配装 #${id}] ${stage}${brief ? ` · ${brief}` : ''}`;
    // Preserve an expandable snapshot: later restarts must not mutate an older console entry.
    const snapshot = structuredClone(detail);
    if (error) console.error(line, snapshot);else console.log(line, snapshot);
  };
  const summary = (finished = false) => {
    const current = Array.from(snapshots.values());
    const active = current.filter(snapshot => !['done', 'failed'].includes(String(snapshot.activePhase)));
    const sum = (key: string) => (accumulated[key] ?? 0) +
      current.reduce((total, snapshot) => total + value(snapshot, key), 0);
    const seconds = (ms: number) => Math.round(ms / 100) / 10;
    const branches = sum('wasmVisitedBranches');
    const combinations = sum('wasmEvaluatedCombinations');
    const interval = (Date.now() - sample.time) / 1000;
    const rate = interval >= 1 ? { 采样间隔秒: seconds(Date.now() - sample.time),
      分支每秒: Math.round(Math.max(0, branches - sample.branches) / interval),
      完整组合每秒: Math.round(Math.max(0, combinations - sample.combinations) / interval) } : undefined;
    if (interval >= 1) sample = { time: Date.now(), branches, combinations };
    const describe = (snapshot: Record<string, unknown>) => {
      const key = snapshot.task === 'plan' ? 'plan' : `partition:${snapshot.partition}`;
      const query = snapshot.query as { route: string; counts: number[]; minimumScore: number;
        speedBounds?: unknown; branchLimit?: number; fraction?: number; elapsedMs?: number; complete?: boolean } | undefined;
      return { 分片: snapshot.task === 'plan' ? '规划' : snapshot.partition, Worker: snapshot.worker,
        食物: snapshot.foodName ?? snapshot.foodId ?? '未指定', 固定速度贡献: snapshot.speed,
        候选分片: snapshot.shard, 阶段: snapshot.activePhase, 本轮已观测秒: seconds(value(snapshot, 'elapsedMs')),
        距上报秒: seconds(Date.now() - (received.get(key) ?? Date.now())),
        分支: snapshot.wasmVisitedBranches, 完整组合: snapshot.wasmEvaluatedCombinations,
        最近原生查询: query && { 路线: query.route, 各组属性候选数: query.counts,
          速度贡献区间: query.speedBounds, 剪枝评分下限: query.minimumScore, 预热分支限额: query.branchLimit,
          本次查询秒: query.elapsedMs === undefined ? undefined : seconds(query.elapsedMs),
          本次查询覆盖率: query.complete ? '100.0%' : query.fraction === undefined ? undefined : `${(100 * query.fraction).toFixed(1)}%`,
          已完成: query.complete } };
    };
    return {
      墙钟秒: seconds(Date.now() - started),
      完成分片: progress && `${progress.completedGroups}/${progress.totalGroups}`,
      搜索空间进度: progress?.searchProgress === undefined ? undefined :
        `${(progress.searchProgress * 100).toFixed(1)}%（非耗时比例）`,
      活跃阶段: Array.from(new Set(active.map(snapshot => snapshot.activePhase))),
      活跃任务数: active.length,
      WASM已调用: sum('wasmSearchCalls') > 0 || sum('wasmParetoInputOptions') > 0,
      搜索分支: branches, 完整组合: combinations, 近期观测吞吐: rate,
      搜索路线: { 固定速度: { 查询数: sum('fixedSearchCalls'), 累计秒: seconds(sum('fixedSearchMs')) },
        整段GCD: { 查询数: sum('rangeSearchCalls'), 累计秒: seconds(sum('rangeSearchMs')) },
        限额预热: { 查询数: sum('warmSearchCalls'), 累计秒: seconds(sum('warmSearchMs')) } },
      当前最好: best && { 期望威力: best.damage, 排序评分: score(best), 改善次数: improvements,
        较初始提升百分比: initialScore ? Math.round((score(best) / initialScore - 1) * 1e6) / 1e4 : undefined,
        未改善秒: seconds(Date.now() - improvedAt), 状态: finished ? '全部分片已完成' : '可行解；全部分片完成前不代表最优' },
      最慢任务前三: (active.length ? active : current).slice()
        .sort((left, right) => value(right, 'elapsedMs') - value(left, 'elapsedMs')).slice(0, 3).map(describe),
      最近重启: recentRestarts.length ? recentRestarts : undefined,
      Worker累计秒: { 加载引擎: seconds(sum('initializationMs')), 搜索: seconds(sum('wasmSearchMs')),
        原生去重: seconds(sum('wasmParetoMs')), 其他准备及调度: seconds(sum('otherMs')) },
      原生去重输入: sum('wasmParetoInputOptions'), 原生去重保留: sum('wasmParetoOutputOptions'),
      单Worker内存观测峰值MiB: peakMemory, 重启次数: restarts,
    };
  };
  return {
    start: (detail: Record<string, unknown>) => write('开始', detail),
    input: (detail: Record<string, unknown>) => write('候选', detail),
    best: observeBest,
    progress: (update: OptimizerProgress) => { progress = update; },
    diagnostics: (snapshot: Record<string, unknown>) => {
      const key = snapshot.task === 'plan' ? 'plan' : `partition:${snapshot.partition}`;
      if (snapshot.stage === '重启分片') {
        // Retain measured work from the interrupted attempt; do not count its replacement twice.
        const previous = snapshots.get(key);
        if (previous) for (const metric of metrics) {
          accumulated[metric] = (accumulated[metric] ?? 0) + value(previous, metric);
        }
        snapshots.delete(key);
        restarts++;
        recentRestarts.push({ 分片: snapshot.partition, 原评分下限: snapshot.previousMinimumDamage,
          新评分下限: snapshot.minimumDamage, 本轮运行毫秒: snapshot.elapsedMs,
          原因: '更好可行解提高剪枝下限，重算分片', 次数: snapshot.restarts });
        if (recentRestarts.length > 3) recentRestarts.shift();
      } else {
        snapshots.set(key, snapshot);received.set(key, Date.now());
        peakMemory = Math.max(peakMemory, value(snapshot, 'wasmMemoryMiB'));
      }
      if (snapshot.engine === 'WASM' && !ready) {
        ready = true;
        write('WASM 引擎就绪', { 加载毫秒: snapshot.initializationMs,
          统计说明: 'Worker时间为并行累计，不能与墙钟时间相加；重启前未上报的工作不计入累计；WASM内存不含JS内存；吞吐为上报观测值，预热也计入搜索统计' });
      }
      if (Date.now() - lastReport >= 30_000) {
        lastReport = Date.now();
        write('运行中', summary());
      }
    },
    plan: (plan: GearOptimizationPlan, workers: number) => {
      observeBest(plan.heuristicResult);
      const fixedSpeeds = plan.partitions.flatMap(partition => partition.contribution === undefined ? [] : [partition.contribution]);
      write('规划完成', { ...summary(), 分片数: plan.partitions.length, Worker数: workers,
        食物ID: Array.from(new Set(plan.partitions.map(partition => partition.foodId))),
        固定速度分片数: fixedSpeeds.length, 自动速度分片数: plan.partitions.length - fixedSpeeds.length,
        固定速度贡献范围: fixedSpeeds.length ? [fixedSpeeds.reduce((a, b) => Math.min(a, b)),
          fixedSpeeds.reduce((a, b) => Math.max(a, b))] : undefined,
        暴击边界: plan.criticalRange });
    },
    done: (result: GearOptimizationResult, restartCount: number) => {
      restarts = restartCount;observeBest(result);
      write('完成', { ...summary(true), 期望威力: result.damage, 排序评分: result.score ?? result.damage,
        最终方案: { 属性: result.stats, 坚韧减伤百分比: result.tenacityMitigation * 100,
          食物: result.food && { id: result.food.id, 名称: result.food.name },
          装备: result.gears?.map(gear => ({ 部位: gear.slot, id: gear.id, 名称: gear.name, 品级: gear.level,
            同步: gear.synced, 镶嵌: gear.melds })) } });
    },
    fail: (message: string) => write('失败', { ...summary(), 原因: message }, true),
  };
}
