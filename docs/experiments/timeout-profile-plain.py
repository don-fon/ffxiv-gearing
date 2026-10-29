from pathlib import Path
import subprocess,hashlib,json,os,sys
r=Path(__file__).resolve().parents[2];p=Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True)
exports=['search_abi','search_cache_bytes','search_frame_bytes','configure_search','start_search','step_search','search_damage','search_visited','search_evaluated','search_coverage','search_selected','search_error','pareto_node_bytes','pareto_frontier','__heap_base']
cmd=[os.environ.get('WASM_CC','clang-19'),'--target=wasm32','-O3','-ffp-contract=off','-fno-builtin','-nostdlib','-mbulk-memory','-msimd128','-fuse-ld='+os.environ.get('WASM_LD','lld'),'-Wl,--no-entry','-Wl,--import-memory','-Wl,-z,stack-size=1048576','-Wl,--initial-memory=8388608','-Wl,--max-memory=2147483648']+['-Wl,--export='+e for e in exports]+[str(r/'src/optimizerSearch.c'),'-o',str(p/'plain-named.wasm')]
subprocess.run(cmd,check=True)
def sections(data):
 pos=8;out=[]
 while pos<len(data):
  kind=data[pos];pos+=1;size=0;shift=0
  while True:
   b=data[pos];pos+=1;size|=(b&127)<<shift;shift+=7
   if b<128:break
  if kind:out.append((kind,data[pos:pos+size]))
  pos+=size
 return out
original=(r/'src/optimizerSearch.wasm').read_bytes();named=(p/'plain-named.wasm').read_bytes();a=sections(original);b=sections(named)
assert a==b,'Noncustom WASM sections differ from production!'
(p/'plain-code-verification.json').write_text(json.dumps({'noncustomSectionsIdentical':True,'codeSectionIdentical':True,'productionSha256':hashlib.sha256(original).hexdigest(),'namedSha256':hashlib.sha256(named).hexdigest(),'difference':'custom name/producers sections only'},indent=2)+'\n')
