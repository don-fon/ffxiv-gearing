/* eslint-disable no-restricted-globals */
import loadHighs from '/__optimizer_integer/highs.mjs';
import { build } from '/__optimizer_integer/model.mjs';
import { buildIntegerObjective, solveIntegerObjective } from '/__optimizer_integer/certified.mjs';
let runtime;
self.onmessage = async ({ data: request }) => {
    const start = performance.now(); const input = request.input;
    let model;
    try {
        const highs = await (runtime ??= loadHighs());
        const recovery = request.modelOptions?.integerRecovery;
        const prepared = recovery ? buildIntegerObjective(input) : build(input, request.modelOptions);
        const empty = { empty: true, damage: 0, stats: {}, gears: [], tenacityMitigation: 0, exploredStates: 0 };
        if (!prepared) {
            self.postMessage({ type: 'diagnostics', diagnostics: { stage: '分片完成', engine: recovery ? 'HiGHS integer objective' : 'HiGHS WASM', foodId: input.food?.id, status: 'empty-lookup-domain', elapsedMs: performance.now() - start } });
            self.postMessage({ type: 'result', optimality: 'solver-claim-only', result: empty });
            return;
        }
        if (recovery) {
            let last = performance.now();
            self.postMessage({ type: 'diagnostics', diagnostics: { engine: 'HiGHS integer objective', wasmMemoryMiB: Math.round(highs.memoryBytes / 1048576 * 10) / 10, stage: '整数模型就绪', foodId: input.food?.id, columns: prepared.data.numCols, rows: prepared.data.numRows, elapsedMs: performance.now() - start } });
            const solved = solveIntegerObjective(highs, prepared, {
                onCandidate(result) { self.postMessage({ type: 'candidate', result }); },
                onProgress(progress) { if (performance.now() - last > 5000) {
                    last = performance.now();self.postMessage({ type: 'progress', progress: { completedGroups: 0, totalGroups: 1, states: progress.nodes } });
                } },
            });
            self.postMessage({ type: 'diagnostics', diagnostics: { engine: 'HiGHS integer objective', wasmMemoryMiB: Math.round(highs.memoryBytes / 1048576 * 10) / 10, stage: '分片完成', foodId: input.food?.id,
                passes: solved.passes, recoveredOrdering: solved.recoveredOrdering, roundingError: solved.roundingError, mipNodes: solved.nodes, mipMs: performance.now() - start } });
            self.postMessage({ type: 'result', optimality: 'solver-claim-only', result: solved.result ?? empty });
            return;
        }
        model = highs.createModel(prepared.data);
        model.options.set({ output_flag: false, time_limit: 280, mip_rel_gap: 0, mip_abs_gap: 0, mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9, dual_feasibility_tolerance: 1e-9 });
        let last = performance.now();
        self.postMessage({ type: 'diagnostics', diagnostics: { engine: 'HiGHS WASM', stage: '整数模型就绪', wasmMemoryMiB: Math.round(highs.memoryBytes / 1048576 * 10) / 10, foodId: input.food?.id, columns: prepared.data.numCols, rows: prepared.data.numRows, elapsedMs: performance.now() - start } });
        model.run({ [highs.constants.callbackType.mipInterrupt](e) { if (performance.now() - last > 5000) {
                last = performance.now();
                self.postMessage({ type: 'progress', progress: { completedGroups: 0, totalGroups: 1, states: Number(e.data.mip_node_count ?? 0) } });
            } }, [highs.constants.callbackType.mipImprovingSolution](e) { self.postMessage({ type: 'candidate', result: prepared.reconstruct(e.data.mip_solution) }); } });
        const status = model.getModelStatus();
        let result;
        if (status === highs.constants.modelStatus.infeasible)
            result = empty;
        else if (status === highs.constants.modelStatus.optimal) {
            result = prepared.reconstruct(model.getSolution().colValue);
            const objective = prepared.base * Math.exp(-model.getObjectiveValue() / prepared.scale);
            if (Math.abs(objective - (result.score ?? result.damage)) > 1e-8 * Math.max(1, objective))
                throw Error('objective mismatch');
        }
        else
            throw Error('MILP incomplete: ' + status);
        const nodes = Number(model.info.get('mip_node_count'));
        result.exploredStates = nodes;
        self.postMessage({ type: 'diagnostics', diagnostics: { engine: 'HiGHS WASM', stage: '分片完成', wasmMemoryMiB: Math.round(highs.memoryBytes / 1048576 * 10) / 10, foodId: input.food?.id, mipNodes: nodes, mipMs: performance.now() - start, damage: result.damage, status } });
        self.postMessage({ type: 'result', optimality: 'solver-claim-only', result });
    }
    catch (e) {
        self.postMessage({ type: 'error', message: String(e) });
    }
    finally {
        model?.dispose();
    }
};
