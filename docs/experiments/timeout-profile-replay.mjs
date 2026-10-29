import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import inspector from 'node:inspector';
const dir=path.resolve(process.argv[2])+'/';
fs.mkdirSync(dir,{recursive:true});
const index=Number(process.argv[3]||0),duration=Number(process.argv[4]||120);
const frozen=gunzipSync(fs.readFileSync(new URL('../benchmarks/timeout-profile-tasks.jsonl.gz',import.meta.url))).toString().trim().split('\n');
const task=JSON.parse(frozen[index]);
if(task.input.damage.job==='BLU')throw new Error('This replay does not pack the BLU lookup table.');
fs.writeFileSync(dir+`task-${index}.json`,JSON.stringify(task));
async function prepare(file){
 const memory=new WebAssembly.Memory({initial:128,maximum:32768});
 const {instance}=await WebAssembly.instantiate(fs.readFileSync(file),{env:{memory,log:Math.log,exp:Math.exp}});const core=instance.exports;
 let heap=Number(core.__heap_base.value);
 const allocate=bytes=>{const p=Math.ceil(heap/8)*8;heap=p+bytes;if(heap>memory.buffer.byteLength)memory.grow(Math.ceil((heap-memory.buffer.byteLength)/65536));return p;};
 const context=task.context.map(Number);context[17]=allocate(core.search_cache_bytes());context[18]=allocate(core.search_frame_bytes());context[12]=0;
 const ctx=allocate(64*8);new Float64Array(memory.buffer,ctx,64).set(context);
 const pack=tree=>{const ptr=allocate(26*8),n=[...tree.n];
  if(tree.children){n[11]=pack(tree.children[0]);n[12]=pack(tree.children[1]);}
  if(tree.vectors){n[13]=allocate(tree.vectors.length*80);for(let i=0;i<tree.vectors.length;i++)new Float64Array(memory.buffer,n[13]+i*80,10).set(tree.vectors[i]);}
  new Float64Array(memory.buffer,ptr,26).set(n);return ptr;};
 const roots=task.roots.map(pack),root=allocate(roots.length*4);new Uint32Array(memory.buffer,root,roots.length).set(roots);
 core.configure_search(ctx);core.start_search(root,roots.length,task.minimumDamage,1);
 return {core,memory,roots};
}
// Ensure the instrumentation preserves the actual query's deterministic path.
const control=[];
for(const file of [fileURLToPath(new URL('../../src/optimizerSearch.wasm',import.meta.url)),dir+'kernel.wasm']){
 const {core}=await prepare(file);let complete=0;for(let i=0;i<100&&!complete;i++)complete=core.step_search(50000);
 control.push({file,visited:core.search_visited(),evaluated:core.search_evaluated(),best:core.search_damage(),complete});
}
if(['visited','evaluated','best','complete'].some(k=>control[0][k]!==control[1][k]))throw new Error('Diagnostic kernel changed the search path: '+JSON.stringify(control));
fs.writeFileSync(dir+`control-${index}.json`,JSON.stringify(control,null,2));
const {core,memory,roots}=await prepare(dir+'kernel.wasm');
const session=new inspector.Session();session.connect();const send=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(err,res)=>err?reject(err):resolve(res)));
await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:1000});await send('Profiler.start');
const snapshots=[],subtrees=[];const start=performance.now();let last=0,complete=false;
function snapshot(){return {elapsedSeconds:(performance.now()-start)/1000,state:Array.from({length:14},(_,i)=>core.audit_state(i)),counters:Array.from(new Float64Array(memory.buffer,core.audit_counts(),64)),bands:Array.from({length:core.audit_state(8)},(_,i)=>Array.from(new Float64Array(memory.buffer,core.audit_bands()+i*12*8,12)))};}
function flatten(ptr){const n=new Float64Array(memory.buffer,ptr,26);if(n[14])return Array.from({length:n[14]},(_,i)=>Array.from(new Float64Array(memory.buffer,n[13]+i*80,10)));return [...flatten(n[11]),...flatten(n[12])];}
function sampleSubtree(s){
 for(let depth=0;depth<Math.min(s.state[10],16);depth++)if(core.audit_frame_bound(depth)>s.state[0]){
  const groups=roots.map((_,i)=>flatten(core.audit_frame_root(depth,i)));
  subtrees.push({elapsedSeconds:s.elapsedSeconds,depth,groups,context:task.context,reference:task.reference,damage:task.input.damage,food:task.input.food,objective:task.input.objective,speedBounds:task.speedBounds,incumbent:s.state[0],interval:s.state.slice(3,5),nativeUpper:core.audit_frame_bound(depth),weights:Array.from({length:8},(_,i)=>core.audit_weight(i)),constant:s.state[13]});break;
 }
}
while(performance.now()-start<duration*1000){
 complete=core.step_search(50000)!==0;
 if(performance.now()-start-last>=10000||complete){last=performance.now()-start;const s=snapshot();snapshots.push(s);if(subtrees.length<3)sampleSubtree(s);console.log(JSON.stringify({index,job:task.input.damage.job,food:task.input.food.id,elapsed:s.elapsedSeconds,visited:s.state[1],evaluated:s.state[2],best:s.state[0],band:s.state.slice(3,5),completedBands:s.state[9],totalBands:s.state[8]}));}
 if(complete)break;
 await new Promise(setImmediate);
}
const final=snapshot();snapshots.push(final);const {profile}=await send('Profiler.stop');session.disconnect();
fs.writeFileSync(dir+`cpu-${index}.cpuprofile`,JSON.stringify(profile));fs.writeFileSync(dir+`subtrees-${index}.json`,JSON.stringify(subtrees));
fs.writeFileSync(dir+`profile-${index}.json`,JSON.stringify({job:task.input.damage.job,food:task.input.food.id,targetGcd:task.input.targetGcd,objective:task.input.objective,minimumDamage:task.minimumDamage,rootSizes:task.roots.map(r=>r.n[15]),complete,snapshots,final},null,2));
