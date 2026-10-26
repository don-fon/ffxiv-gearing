# 高/低暴击模式的冗余剪枝修正（2026-10-26）

合法解数量减少，不保证分支定界搜索更快：低暴击上限会使原先由高暴击方案支配的低暴击方案仍有保留价值，半区最优伤害也可能降低，使伤害上界更难剪枝。不过，此前实现确实还有两处不必要的开销，本次修正不改变偏好规则或最优性。

## 两项独立改动

1. `a49f921`：允许高/低暴击模式排除冗余速度魔晶石方案。前提是将该速度石替换成一种允许的非暴击、非速度魔晶石后，仍满足最终目标 GCD。替换不会改变暴击，也不会降低伤害或坚韧，因此不会丢失半区最优解。只有暴击/速度魔晶石可选时继续保留速度方案；锁定的镶嵌不受影响。
2. `8f9a140`：范围计算完成后的高暴击搜索恢复跨暴击数值的属性支配剪枝。同速度下，如果一个方案各伤害属性都不低、暴击更高，那么它仍满足暴击下限，可安全替代被支配方案。计算最小/最大端点时仍保护所有暴击组；低暴击有上限，仍按相同暴击分组筛选。

第一项使本例速度分片从 0/6 两档缩减为 0 一档，任务数从 32 降至 16；第二项进一步减少高暴击中保留的中间状态。没有改变装备候选、GCD 要求、暴击中点、合法镶嵌或最终评分公式，也没有使用近似搜索。

## 同条件完整浏览器实测

输入是 [当前显示范围的 87 件装备](../test/fixtures/warrior-displayed-375-input.json)：战士、350–375、同步 375、GCD 2.50、最低坚韧 0%、无锁定、全部食物。同一云容器、Chromium 154.0.8037.57、4 Worker，所有计时串行执行且使用新浏览器上下文。计时包含规划、暴击端点计算、WASM 加载与全部分片精确完成。

| 配置 | 高暴击 | 低暴击 |
| --- | --- | --- |
| 本次修正前，已包含树序和原生关联上界 | 32.085 秒 | 38.017 秒 |
| 仅冗余速度镶嵌剪枝 | 14.190 秒 | 13.844 / 13.627 秒 |
| 再恢复高暴击跨 CRT 支配剪枝 | 7.258 / 7.024 秒 | 无额外改动 |

按较慢复测值保守计算：

- 速度剪枝单项：高暴击耗时降低 55.8%，低暴击降低 63.6%。
- 高暴击支配剪枝：在速度单项基础上再降低 48.9%。
- 高暴击两项合计降低 77.4%；低暴击单项降低 63.6%。两种模式均超过组合提速至少 50% 的要求，每项都有可测增量价值。
- 默认“无所谓”本轮复核为 6.383 秒，最优伤害和属性与原参考相同。该路径没有增加新的暴击处理。

这里没有将高、低、无偏好的不同可行域相互作为性能基线；每个改进比例都比较同一种偏好。低暴击仍比高暴击慢，不能据此断言实现错误，也不能保证其他输入具有同样的加速比例。

高、低暴击范围均为 546–1399，中点 972.5。高暴击结果 CRT 1363、伤害 `7.966430616454143`；低暴击 CRT 967、伤害 `7.8869947495708805`。每次复测的完整属性、伤害和暴击端点都与修正前已完成的精确参考解相同。

原始记录：

- 修正前：[高暴击](benchmarks/displayed-search-high.json)、[低暴击](benchmarks/displayed-search-low.json)。
- 单项：[仅速度剪枝高暴击](benchmarks/critical-pruning-speed-only-high.json)、[低暴击第一次](benchmarks/critical-pruning-speed-only-low-1.json)、[低暴击复测](benchmarks/critical-pruning-speed-only-low-2.json)。
- 两项：[高暴击第一次](benchmarks/critical-pruning-combined-high-1.json)、[高暴击复测](benchmarks/critical-pruning-combined-high-2.json)。
- [默认模式复核](benchmarks/critical-pruning-default-check.json)。

## 验证与复现

71 项优化器测试通过，其中独立穷举 64 组输入，验证 JS/WASM 的端点和半区最优伤害；新增回归确认有非暴击替换石时能排除冗余速度档，并确认只有暴击/速度可选时保留低暴击所需方案。13 项生产浏览器测试、lint 和生产构建通过。原生 C/WASM 未修改。

```sh
npm run test:optimizer
npm run lint
npm run build
node scripts/benchmark-optimizer.mjs --skip-build --chromium /usr/bin/chromium --engine auto --workers 4 --critical high --input test/fixtures/warrior-displayed-375-input.json
node scripts/benchmark-optimizer.mjs --skip-build --chromium /usr/bin/chromium --engine auto --workers 4 --critical low --input test/fixtures/warrior-displayed-375-input.json
```

单项消融可分别在 `fbdcc96`、`a49f921`、`8f9a140` 的源码快照构建后运行相同命令；不要并行计时，以免 CPU 竞争影响结论。
