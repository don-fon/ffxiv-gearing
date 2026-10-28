const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const root=path.resolve(__dirname,'../..');const auditDir=process.argv[2];if(!auditDir)throw new Error('Pass the scratch audit directory.');const {createRequire}=require('node:module');const req=createRequire(path.join(root,'test/optimizerWasm.test.cjs'));
const source=fs.readFileSync(path.join(root,'test/optimizerWasm.test.cjs'),'utf8').split('function compare(')[0];
const body=`
(async()=>{
 const dir=${JSON.stringify(auditDir)};const rows=JSON.parse(fs.readFileSync(dir+'/lp-results.json','utf8'));const traces=fs.readFileSync(dir+'/trace-data.jsonl','utf8').trim().split('\\n').map(JSON.parse);let core;
 const original=WebAssembly.instantiate;WebAssembly.instantiate=async(...args)=>{const r=await original(...args);core=r.instance.exports;return r;};
 for(const trace of traces){
  const names=['STR','INT','CRT','DET','DHT','TEN','PDMG','MDMG'];const stats=p=>{const out=Object.fromEntries(names.map((s,i)=>[s,p[i]]));if(!p[8])delete out.TEN;out.SKS=p[9];return out;};
  const input={fixedStats:stats(trace.groups[0][0]),gears:[],materiaStats:['CRT','DET','DHT','SKS','TEN'],speedStat:'SKS',targetGcd:trace.damage.job==='WAR'?2.48:2.45,damage:trace.damage,food:trace.food,objective:trace.objective};
  const backend=await adapter.createWasmSearchBackend(fs.readFileSync(dir+'/native-audit.wasm'),0,0);
  const trees=trace.groups.map(group=>solver.testAttributeTree(group.map(p=>({stats:stats(p),choices:[]})),64,'SKS'));
  backend({input,prefix:trees[0],options:trees.slice(1),reference:trace.reference,minimumDamage:trace.minimumDamage,speedBounds:trace.speedBounds,branchLimit:1},()=>{});
  for(const row of rows.filter(r=>r.job===trace.damage.job)){
   const actual=core.audit_root_bound(...row.interval);row.nativeCurrentUpper=actual;row.reproducedUpperAbsoluteError=Math.abs(actual-row.currentUpper);console.log(row.job,row.interval,actual,row.currentUpper,row.reproducedUpperAbsoluteError);if(row.reproducedUpperAbsoluteError>1e-8)throw new Error('Upper mismatch');
  }
 }
 fs.writeFileSync(dir+'/lp-results.json',JSON.stringify(rows,null,2)+'\\n');
})().catch(e=>{console.error(e);process.exitCode=1;});`;
vm.runInNewContext(source+body,{require:req,console,process,WebAssembly,Buffer});
