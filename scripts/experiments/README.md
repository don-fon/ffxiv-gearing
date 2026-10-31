# 优化器研究脚本

HiGHS 整数模型及独立证明链路已暂停接入，仅作为未来可选项保留。它们不属于当前求解、验证或基准测试流程，也不在主项目依赖中。

状态、证据、恢复研究的条件和依赖安装说明见 [HiGHS 归档说明](../../docs/optimizer-highs-future-option.md)。历史浏览器实验入口为 `benchmark-optimizer-highs.mjs`；常规原生基准入口仍为 `../benchmark-optimizer.mjs`。

本目录其他原生算法实验不受此决定影响。

梯度细化、切线继承及局部重算也已[归档](../../docs/optimizer-gradient-archive.md)，停止当前推进。补丁和冻结源码／数据保留在 `docs/experiments/` 与 `docs/benchmarks/`，历史复现命令不属于常规工作流。
