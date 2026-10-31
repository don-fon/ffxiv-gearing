# HiGHS：未来可选项（暂停接入）

2026-10-30，按用户决定，将 HiGHS 整数模型保留为未来可选项，退出当前求解、验证及基准测试流程。

## 当前决定

- 网页继续使用原生 JavaScript／WASM 求解流程。
- `npm run benchmark:optimizer` 仅测试原生 Worker 流程，不再接受整数模型、条件路由或独立证明参数，不加载 HiGHS，也不追加证明搜索。
- 主项目移除 `highs` 开发依赖及 `test:optimizer-integer` 命令；常规安装、构建和优化器回归测试不依赖该方案。
- 实验源码、正确性反例、证书样例和冻结测量数据保留，作为未来研究资料。暂停接入不代表实验问题已解决，也不代表采用某个职业专用的路由策略。

## 保留它的理由与未解决的问题

整数模型改变了离散选择的表示方式，在此前原生算法超时的一些案例上完成了搜索。16 个主输入的历史测试中，180 秒内原生完成 11 个，整数方案完成 16 个；但中位耗时分别为 26.82 秒和 37.64 秒，不能据此认定全局提速。这些数字只对应当时冻结版本的候选搜索。

当前实现不能仅依赖浮点求解器的 `Optimal` 声明保证最优；历史版本出现过错误判定。后加的原始候选域精确证明可以独立核验，但完整画家 375 和战士 375 案例追加 30 秒仍未证完。它没有成为高效的严格求解方案。

重新考虑接入前，需要同时满足：

1. 明确模型、离散化、预处理和求解终止的正确性依据，解决已知反例；不把有限测试或求解器状态当作严格证明。
2. 将必要的证明／核验成本纳入端到端计时，避免只报告候选搜索时间。
3. 在多职业、技速、坚韧、暴击偏好和锁定条件下重新测试。按此前要求，采用的方案须达到至少 50% 性能提升，并核实各项改动的价值、回退和内存成本。
4. 在能确定优势区间之前，不按职业或少数案例条件启用，不用限时切换规避全局评估。

## 归档入口与证据

- [独立实验入口](../scripts/experiments/benchmark-optimizer-highs.mjs)：由旧基准脚本移入实验目录；未挂接任何 npm 命令。
- [整数目标及舍入恢复](optimizer-integer-objective-recovery.md)、[全局复测](optimizer-integer-global-retest.md)。
- [稳定性与正确性调查](optimizer-stability-and-correctness.md)、[独立证明规则与成本](optimizer-strict-proof.md)。
- `scripts/experiments/optimizer-integer-*`、`optimizer-proof-*`、`optimizer-strict-proof.mjs` 及相关测试保留供研究。
- `docs/benchmarks/` 中的冻结数据与源码快照保持原样；历史命令反映当时入口，不是当前工作流。

未来明确恢复研究时，可在隔离 checkout 中执行 `npm ci`，再显式安装实验依赖 `npm install --no-save --package-lock=false highs@1.15.4`。旧命令的 `node scripts/benchmark-optimizer.mjs --integer-model ...` 应改为 `node scripts/experiments/benchmark-optimizer-highs.mjs --integer-model ...`；旧整数测试可直接调用 `node scripts/experiments/test-optimizer-integer.mjs`。这些是归档复现说明，不是当前验证要求；重新研究仍须核对源代码兼容性。
