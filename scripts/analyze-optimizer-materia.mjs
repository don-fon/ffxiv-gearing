import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
// Read-only experiment. Transforms run in memory and never modify production code.
function load(source,deps={}){const exports={};const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInThisContext('(function(exports,module,require){'+compiled+'\n})')(exports,{exports},name=>deps[name]);return exports;}
const mode=process.argv[2]||'baseline';
if (!['baseline', 'early-speed'].includes(mode)) throw new Error('Use baseline or early-speed.');let source=fs.readFileSync(root+'src/optimizer.ts','utf8');
if(mode==='early-speed'){
 source=source.replace('materiaStats: GearOptimizationInput[\'materiaStats\']): GearOption[] {', "materiaStats: GearOptimizationInput['materiaStats'], speedStat?: 'SKS' | 'SPS', speedCeiling = Infinity): GearOption[] {\n  if (speedStat !== undefined && (gear.stats[speedStat] ?? 0) > speedCeiling) return [];");
 source=source.replace('const choice = option.choices[0];', 'if (speedStat !== undefined && (meldedStats[speedStat] ?? 0) > speedCeiling) continue;\n        const choice = option.choices[0];');
 source=source.replace('  const lockedGearIds = new Set(input.lockedGearIds);',`  let speedCeiling = Infinity;
  if (!input.gears.some(gear => (gear.stats[input.speedStat] ?? 0) < 0)) {
    const fixed = input.fixedStats[input.speedStat] ?? 0;
    let low = fixed - 1, high = fixed + Math.ceil(input.damage.level.div * 1000 / 130) + 100;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (gcdHundredths(speedAfterFood(middle, input), input) >= targetGcdHundredths(input)) low = middle;
      else high = middle;
    }
    speedCeiling = low - fixed;
  }
  const lockedGearIds = new Set(input.lockedGearIds);`);
 source=source.replaceAll('gearOptions(gear, input.materiaStats)', 'gearOptions(gear, input.materiaStats, input.speedStat, speedCeiling)');
}
source=source.replace('function buildGroups(input:', 'function rawBuildGroups(input:');
source=source.replace('function prepareSearchGroups(input:', 'function rawPrepareSearchGroups(input:');
source+='\nconst probeTiming = { gearOptionsMs:0, buildGroupsMs:0, prepareGroupsMs:0, optionCount:0, calls:0 };\n'+
 `function buildGroups(...args: Parameters<typeof rawBuildGroups>) { const t=performance.now(); const out=rawBuildGroups(...args); probeTiming.buildGroupsMs+=performance.now()-t; return out; }\n`+
 `function prepareSearchGroups(...args: Parameters<typeof rawPrepareSearchGroups>) { const t=performance.now(); const out=rawPrepareSearchGroups(...args); probeTiming.prepareGroupsMs+=performance.now()-t; return out; }\n`;
source=source.replace('function gearOptions(gear:', 'function rawGearOptions(gear:');
source+=`\nfunction gearOptions(...args: Parameters<typeof rawGearOptions>) { const t=performance.now(); const out=rawGearOptions(...args); probeTiming.gearOptionsMs+=performance.now()-t; probeTiming.optionCount+=out.length; probeTiming.calls++; return out; }\nexport { probeTiming };`;
const solver=load(source,{'./statFormulas':load(fs.readFileSync(root+'src/statFormulas.ts','utf8'))});
const adapter=load(fs.readFileSync(root+'src/optimizerWasm.ts','utf8'),{'./optimizer':solver});
const input=JSON.parse(fs.readFileSync(root+'test/fixtures/warrior-375-input.json'));
const expected=JSON.parse(fs.readFileSync(root+'test/fixtures/warrior-375-result.json'));
const unlocked=process.argv.includes('--unlocked');
input.food=input.foods.find(f=>f.id===49240);input.foods=undefined;input.targetSpeedContribution=0;input.globalMinimumDamage=8.068407103464912;
if(!unlocked){input.lockedGears=expected.gears.filter(g=>[13,5,8].includes(g.slot)).map(g=>({id:g.id,slot:g.slot,melds:g.melds}));input.lockedGearIds=input.lockedGears.map(g=>g.id);}
(async()=>{const backend=await adapter.createWasmSearchBackend(fs.readFileSync(root+'src/optimizerSearch.wasm'));const started=performance.now();
const result=process.argv.includes('--plan')?solver.planGearOptimization(input,backend):solver.optimizeGearset(input,undefined,backend);
console.log(JSON.stringify({mode,unlocked,planning:process.argv.includes('--plan'),milliseconds:performance.now()-started,profile:solver.probeTiming,damage:result.damage??result.heuristicResult.damage,stats:result.stats??result.heuristicResult.stats}));
})().catch(e=>{console.error(e);process.exitCode=1;});
