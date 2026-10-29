from pathlib import Path
import subprocess,os,sys
p=Path(sys.argv[1]);s=(p/'kernel.c').read_text();(p/'kernel-profile-v1.c').write_text(s);(p/'kernel-profile-v1.wasm').write_bytes((p/'kernel.wasm').read_bytes())
s=s.replace('static double audit_c[64],audit_planes[256][12];','static double audit_c[64],audit_planes[256][12],audit_sizes[8],audit_product;')
s=s.replace(' plane_width=maximum(64,',' audit_product=work;\n plane_width=maximum(64,')
s=s.replace('visited++;audit_planes[plane_finished][1]++;','visited++;audit_planes[plane_finished][1]++;double remaining=frame.work*audit_product;int bucket=0;double limit=16;while(bucket<7&&remaining>limit*(1+1e-12)){bucket++;limit*=4;}audit_sizes[bucket]++;')
s+='''
__attribute__((visibility("default"))) address audit_histogram(void){return (address)audit_sizes;}
__attribute__((visibility("default"))) void audit_focus_band(int index,double incumbent){
 best=incumbent;plane_best_log=wasm_log(best);plane_finished=index;plane_count=index+1;plane_active=0;top=0;visited=0;evaluated=0;
 for(int i=0;i<64;i++)audit_c[i]=0;for(int i=0;i<8;i++)audit_sizes[i]=0;
 for(int i=0;i<256;i++)for(int j=0;j<12;j++)audit_planes[i][j]=0;
 next_plane();
}
'''
(p/'kernel.c').write_text(s)
s=Path(__file__).with_name('timeout-profile-kernel.py').read_text();start=s.index("exports=[");code=s[start:];code=code.replace("'audit_weight']","'audit_weight','audit_histogram','audit_focus_band']")
exec(code,{'p':p,'subprocess':subprocess,'os':os})
