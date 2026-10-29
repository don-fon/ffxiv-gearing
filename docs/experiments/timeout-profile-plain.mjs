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
const measured=JSON.parse(fs.readFileSync(dir+`profile-${index}.json`));
const target=measured.snapshots[4];const {core,memory,roots}=await prepare(dir+'plain-named.wasm');
const session=new inspector.Session();session.connect();const send=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(err,res)=>err?reject(err):resolve(res)));
await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:1000});await send('Profiler.start');const start=performance.now();let last=0,complete=false;
while(core.search_visited()<target.state[1]){complete=core.step_search(50000)!==0;if(performance.now()-start-last>=10000){last=performance.now()-start;console.log(JSON.stringify({index,seconds:last/1000,visited:core.search_visited()}));}if(complete)break;await new Promise(setImmediate);}
const seconds=(performance.now()-start)/1000;const {profile}=await send('Profiler.stop');session.disconnect();
const actual=[core.search_damage(),core.search_visited(),core.search_evaluated()];if(actual.some((v,i)=>v!==target.state[i]))throw new Error('Uninstrumented replay diverged: '+JSON.stringify({actual,expected:target.state.slice(0,3)}));
const vectors=roots.map((_,i)=>{const ptr=core.search_selected(i);return ptr?Array.from(new Float64Array(memory.buffer,ptr,10)):undefined;});
fs.writeFileSync(dir+`plain-cpu-${index}.cpuprofile`,JSON.stringify(profile));fs.writeFileSync(dir+`plain-${index}.json`,JSON.stringify({index,job:task.input.damage.job,food:task.input.food.id,seconds,sameVisitedEvaluatedAndBest:true,referenceInstrumentedSeconds:target.elapsedSeconds,actual,bestVectors:vectors},null,2));
