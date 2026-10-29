from pathlib import Path
import subprocess,os,sys
r=Path(__file__).resolve().parents[2];p=Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True);s=(r/'src/optimizerSearch.c').read_text();s=s.replace('static double *context;','static double audit_c[64],audit_planes[256][12];\nstatic double *context;')
s=s.replace('static double factor(int dimension,double raw){','static double factor(int dimension,double raw){\n audit_c[13]++;').replace('if(cacheable&&factors[dimension*CACHE+(int)raw]!=0)return factors[dimension*CACHE+(int)raw];','if(cacheable&&factors[dimension*CACHE+(int)raw]!=0){audit_c[14]++;return factors[dimension*CACHE+(int)raw];}')
s=s.replace('static double budget_bound(const double *v,double critical_minimum,double budget,double independent){','__attribute__((noinline)) static double budget_bound(const double *v,double critical_minimum,double budget,double independent){\n audit_c[8]++;')
s=s.replace('static double plane_bound(const address *roots,double *maximum_critical,double *minimum_critical){','__attribute__((noinline)) static double plane_bound(const address *roots,double *maximum_critical,double *minimum_critical){\n audit_c[4]++;')
s=s.replace('static double damage(const double *v,int has_tenacity){','__attribute__((noinline)) static double damage(const double *v,int has_tenacity){\n audit_c[6]++;')
s=s.replace('static double plane_support_kind(address pointer,int kind){','static double plane_support_kind(address pointer,int kind){\n audit_c[16]++;').replace('if(n[cache+1]==plane_generation)return n[cache];','if(n[cache+1]==plane_generation){audit_c[17]++;return n[cache];}').replace('for(int p=0;p<(int)n[NODE_LENGTH];p++){','for(int p=0;p<(int)n[NODE_LENGTH];p++){\n audit_c[18]++;')
s=s.replace('static double upper(const address *roots){','static double upper(const address *roots){\n audit_c[0]++;audit_planes[plane_finished][0]++;')
s=s.replace('if(plane_enabled&&context[46]&&(effective(plane_high,2,0)+1e-7<context[44]||effective(plane_low,2,1)>context[45]))return -__builtin_inf();','if(plane_enabled&&context[46]&&(effective(plane_high,2,0)+1e-7<context[44]||effective(plane_low,2,1)>context[45])){audit_c[3]++;return -__builtin_inf();}')
s=s.replace(' if(context[57]){\n  double low=0,high=0,total=0;',' if(context[57]){\n  audit_c[1]++;\n  double low=0,high=0,total=0;')
s=s.replace('if(low>context[59]||high<context[58])return -__builtin_inf();','if(low>context[59]||high<context[58]){audit_c[2]++;audit_planes[plane_finished][5]++;return -__builtin_inf();}')
s=s.replace('if(linear<=plane_best_log)return -__builtin_inf();','if(linear<=plane_best_log){audit_c[5]++;audit_planes[plane_finished][2]++;return -__builtin_inf();}')
s=s.replace('if(context[14]>0&&mitigation(v,has_tenacity)+1e-12<context[14])return -__builtin_inf();','if(context[14]>0&&mitigation(v,has_tenacity)+1e-12<context[14]){audit_c[7]++;audit_planes[plane_finished][4]++;return -__builtin_inf();}')
s=s.replace(' value=budget_bound(v,critical_minimum,budget,value);\n return plane_enabled&&value>best?minimum(value,wasm_exp(linear)):value;', ''' audit_c[11]+=value<=best;
 double before=value;value=budget_bound(v,critical_minimum,budget,value);
 if(value<before)audit_c[9]++;
 if(before>best&&value<=best){audit_c[10]++;audit_planes[plane_finished][3]++;}
 double result=plane_enabled&&value>best?minimum(value,wasm_exp(linear)):value;
 if(result>best)audit_c[12]++;
 return result;''')
s=s.replace(' root_count=count;best=threshold;', ' for(int i=0;i<64;i++)audit_c[i]=0;for(int i=0;i<256;i++)for(int j=0;j<12;j++)audit_planes[i][j]=0;\n root_count=count;best=threshold;')
s=s.replace('if(frame.bound<=best){covered+=frame.work;continue;}','if(frame.bound<=best){audit_c[24]++;covered+=frame.work;continue;}').replace('  visited++;','  visited++;audit_planes[plane_finished][1]++;')
s=s.replace('  if(leaf){','  if(leaf){audit_c[19]++;audit_planes[plane_finished][6]++;')
s=s.replace('best=value;plane_best_log=wasm_log(best);','audit_c[20]++;audit_planes[plane_finished][7]++;audit_planes[plane_finished][11]=value;best=value;plane_best_log=wasm_log(best);')
s=s.replace('  if(top+2>FRAMES)', '  audit_c[32+split]++;audit_c[primary_uncertainty>0?25:26]++;\n  if(top+2>FRAMES)')
s=s.replace('frames[0].work=1;frames[0].bound=upper(frames[0].roots);top=1;', 'frames[0].work=1;frames[0].bound=upper(frames[0].roots);audit_planes[plane_finished][8]=frames[0].bound;audit_planes[plane_finished][9]=best;top=1;')
s=s.replace('if(*minimum_critical>plane_high||*maximum_critical<plane_low)return -__builtin_inf();','if(*minimum_critical>plane_high||*maximum_critical<plane_low){audit_c[21]++;return -__builtin_inf();}')
s=s.replace('if(context[57]&&(speed<context[58]||speed>context[59]||speed_gcd(speed)!=context[63]))continue;','if(context[57]&&(speed<context[58]||speed>context[59]||speed_gcd(speed)!=context[63])){audit_c[22]++;continue;}')
s=s.replace('if(plane_enabled&&(v[2]<plane_low||v[2]>plane_high))continue;','if(plane_enabled&&(v[2]<plane_low||v[2]>plane_high)){audit_c[23]++;continue;}')
s+='''
__attribute__((visibility("default"))) address audit_counts(void){return (address)audit_c;}
__attribute__((visibility("default"))) address audit_bands(void){return (address)audit_planes;}
__attribute__((visibility("default"))) double audit_state(int i){
 double v[]={best,visited,evaluated,plane_low,plane_high,plane_first,plane_last,plane_width,plane_count,plane_finished,top,root_count,minimum_tenacity_raw,plane_constant};return i>=0&&i<14?v[i]:0;
}
__attribute__((visibility("default"))) address audit_frame_root(int depth,int group){return depth>=0&&depth<top&&group>=0&&group<root_count?frames[top-1-depth].roots[group]:0;}
__attribute__((visibility("default"))) double audit_frame_bound(int depth){return depth>=0&&depth<top?frames[top-1-depth].bound:0;}
__attribute__((visibility("default"))) double audit_weight(int i){return plane_weights[i];}
'''
(p/'kernel.c').write_text(s)
exports=['search_abi','search_cache_bytes','search_frame_bytes','configure_search','start_search','step_search','search_damage','search_visited','search_evaluated','search_coverage','search_selected','search_error','pareto_node_bytes','pareto_frontier','__heap_base','audit_counts','audit_bands','audit_state','audit_frame_root','audit_frame_bound','audit_weight']
cmd=[os.environ.get('WASM_CC','clang-19'),'--target=wasm32','-O3','-ffp-contract=off','-fno-builtin','-nostdlib','-mbulk-memory','-msimd128','-fuse-ld='+os.environ.get('WASM_LD','lld'),'-Wl,--no-entry','-Wl,--import-memory','-Wl,-z,stack-size=1048576','-Wl,--initial-memory=8388608','-Wl,--max-memory=2147483648']+['-Wl,--export='+e for e in exports]+[str(p/'kernel.c'),'-o',str(p/'kernel.wasm')]
subprocess.run(cmd,check=True)
