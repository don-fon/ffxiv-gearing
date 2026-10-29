import json,pathlib,math,itertools,sys,gzip
import numpy as np
from scipy.optimize import linprog
from scipy.sparse import csr_matrix
p=pathlib.Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True)
r=pathlib.Path(__file__).resolve().parents[2]
frozen=[json.loads(line) for line in gzip.decompress((r/'docs/benchmarks/timeout-profile-tasks.jsonl.gz').read_bytes()).splitlines()]
pack=json.loads(gzip.decompress((r/'docs/benchmarks/timeout-profile-subtrees.json.gz').read_bytes()))
reference=json.loads((r/'docs/benchmarks/timeout-profile.json').read_text())
snapshots=json.loads(gzip.decompress((r/'docs/benchmarks/timeout-profile-counters.json.gz').read_bytes()))
def flatten(t):return t.get('vectors') or [v for c in t['children'] for v in flatten(c)]
def solve(groups,t,T):
 sizes=[len(g) for g in groups];a=np.asarray([v for g in groups for v in g]);w=np.asarray(t['weights']);profits=a[:,:8]@w;c=t['context'];lo,hi=t['interval'];speed=t['speedBounds']
 A=np.stack([-a[:,5],-a[:,2],a[:,2],-a[:,9],a[:,9]]);b=np.asarray([-T,-lo,hi,-speed['minimum'],speed['maximum']]);eq=csr_matrix((np.ones(len(a)),(np.repeat(np.arange(len(groups)),sizes),np.arange(len(a)))),shape=(len(groups),len(a)))
 result=linprog(-profits,A_ub=csr_matrix(A),b_ub=b,A_eq=eq,b_eq=np.ones(len(groups)),bounds=(0,None),method='highs')
 rec={'status':int(result.status),'points':len(a),'combinations':math.prod(sizes)}
 if result.success:
  m=np.maximum(0,-result.ineqlin.marginals);q=np.array([m[0],m[1]-m[2],m[3]-m[4]]);rec.update(certificate(groups,t,T,q));rec['prices']=q.tolist();rec['lpLogUpper']=t['constant']-result.fun
 return rec

def certificate(groups,t,T,q):
 lo,hi=t['interval'];speed=t['speedBounds'];targets=[T,lo if q[1]>=0 else hi,speed['minimum'] if q[2]>=0 else speed['maximum']];constant=t['constant']-float(q@targets);value=constant;scale=1+abs(t['constant'])+abs(float(q@targets));w=np.asarray(t['weights'])
 for group in groups:
  a=np.asarray(group);profits=a[:,:8]@w+a[:,[5,2,9]]@q;value+=float(profits.max());scale+=float((np.abs(a[:,:8])@np.abs(w)+np.abs(a[:,[5,2,9]])@np.abs(q)).max())
 return {'upperCertificate':math.exp(value+1e-9*scale),'logCertificate':value+1e-9*scale}

def exact(groups,t):
 total=math.prod(map(len,groups))
 if total>2_000_000:return {'enumerated':False}
 c=list(map(float,t['context']));w=np.asarray(t['weights']);lo,hi=t['interval'];best=-math.inf;linear=-math.inf;feasible=0;floor=lambda x:math.trunc(x+1e-7)
 def eff(x,stat):return x+(c[20+stat] if c[28+stat]<0 else min(c[20+stat],floor(x*c[28+stat])))
 for options in itertools.product(*groups):
  v=np.sum(options,axis=0)
  if not(lo<=v[2]<=hi and c[58]<=v[9]<=c[59]):continue
  ten=eff(v[5],5) if v[8] else c[1];mit=floor(200*(ten-c[1])/c[2])/1000
  if mit+1e-12<c[14]:continue
  speed=v[9]+(c[60] if c[61]<0 else min(c[60],floor(v[9]*c[61])))
  gcd=floor(floor((1000-floor(130*(speed-c[1])/c[2]))*2500/1000)*c[62]/1000)
  if gcd!=c[63]:continue
  feasible+=1;linear=max(linear,t['constant']+float(w@v[:8]));main=floor(c[6]*(floor(eff(v[0],0)*c[7])-c[0])/c[0]+100)/100
  crt=1+(floor(200*(eff(v[2],2)-c[1])/c[2]+1400)/1000-1)*floor(200*(eff(v[2],2)-c[1])/c[2]+50)/1000
  det=floor((140*(eff(v[3],3)-c[0])/c[3]+1000)/c[4])*c[4]/1000
  dh=1+.25*floor(550*(eff(v[4],4)-c[1])/c[2])/1000
  tf=floor(112*(ten-c[1])/c[2]+1000)/1000
  weapon=floor(c[0]*c[5]/1000)+eff(v[7] if c[9] else v[6],7 if c[9] else 6)
  damage=.01*weapon*main*det*tf*c[8]*crt*dh;best=max(best,damage)
 return {'enumerated':True,'combinations':total,'feasible':feasible,'exactMaximumDamage':best if feasible else None,'integerLinearUpper':math.exp(linear) if feasible else None}
rows=[]
for i in [0,1]:
 task=frozen[i];profile=snapshots[i];T=profile['final']['state'][12];root=[flatten(t) for t in task['roots']]
 for t in pack[i]['subtrees']:
  row={k:t[k] for k in ['elapsedSeconds','interval','incumbent','nativeUpper']};row['job']=task['input']['damage']['job'];row['food']=task['input']['food']['id'];row['subtreeSizes']=list(map(len,t['groups']));row['conditionalLP']=solve(t['groups'],t,T);row['exact']=exact(t['groups'],t)
  rootlp=solve(root,t,T);row['rootLP']={k:v for k,v in rootlp.items() if k not in ['prices']}
  if rootlp['status']==0:row['rootPriceAppliedToSubtree']=certificate(t['groups'],t,T,np.asarray(rootlp['prices']))
  rows.append(row);print(row,flush=True);(p/'lp-analysis.json').write_text(json.dumps(rows,indent=2)+'\n')
