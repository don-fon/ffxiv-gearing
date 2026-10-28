import os
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='1'
import json,pathlib,math,sys,numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_matrix,csr_matrix
p=pathlib.Path(sys.argv[1]);rows=[]
fl=lambda x:math.trunc(x+1e-7)
for line in (p/'trace-data.jsonl').read_text().splitlines():
 x=json.loads(line);groups=[np.array(g,dtype=float) for g in x['groups']];points=np.vstack(groups);n=len(points);sizes=list(map(len,groups));starts=np.cumsum([0]+sizes);v=np.sum([g.max(axis=0) for g in groups],axis=0);mn=np.sum([g.min(axis=0) for g in groups],axis=0)
 ctx=x['damage'];lev=ctx['level'];main=lev['main'];sub=lev['sub'];div=lev['div'];det=lev['det'];dt=lev['detTrunc'];ap=lev['apTank'];party=ctx.get('partyBonus',1.05);mod=ctx['statModifiers']['STR'];trait=ctx['traitDamageMultiplier'];names=['STR','INT','CRT','DET','DHT','TEN','PDMG','MDMG'];ref=np.array([x['reference'].get(k,0) for k in names]);food=x['food'];caps=np.array([food['stats'].get(k,0) for k in names]);rates=np.array([food['statRates'].get(k,0)/100 if k in food['statRates'] else (-1 if k in food['stats'] else 0) for k in names])
 def eff(z,j,integer=False):return z+(caps[j] if rates[j]<0 else min(caps[j],fl(z*rates[j]) if integer else z*rates[j]))
 def derivative(z,j):return 1+rates[j] if rates[j]>=0 and z*rates[j]<caps[j] else 1
 def critical(z):t=.2*(z-sub)/div;return 1+(t+.4)*(t+.05)
 def factors(a):
  z=[eff(a[j],j,True) for j in range(8)];return [fl(ap*(fl(z[0]*party)-main)/main+100)/100,1+(fl(200*(z[2]-sub)/div+1400)/1000-1)*fl(200*(z[2]-sub)/div+50)/1000,fl((140*(z[3]-main)/det+1000)/dt)*dt/1000,1+.25*fl(550*(z[4]-sub)/div)/1000,fl(112*(z[5]-sub)/div+1000)/1000,fl(main*mod/1000)+z[6]]
 def damage(a):return .01*trait*math.prod(factors(a))
 target=sub+div/200*(math.ceil(x['objective']['minimumTenacityMitigation']*1000-1e-9)-1e-7);l,h=0.,1e6
 for _ in range(60):
  m=(l+h)/2
  if eff(m,5)>=target:h=m
  else:l=m
 mint=max(0,l-1e-6);slo=x['speedBounds']['minimum'];shi=x['speedBounds']['maximum'];budget=min(sum(max(sum(z[2:6]) for z in g) for g in groups),sum(max(sum(z[2:6])+z[9] for z in g) for g in groups)-slo)
 slopes=np.array([0,.14/det,.1375/div,.112/div]);bases=[sub,main,sub,sub];bw=np.zeros(4);bc=0
 for j in range(1,4):
  rr=ref[j+2];z=1+slopes[j]*(eff(rr,j+2)-bases[j]);bw[j]=slopes[j]*derivative(rr,j+2)/z;bc+=math.log(z)-bw[j]*rr
 def box_bound(lo,hi):
  a=v[:8].copy();a[2]=min(a[2],hi);cm=max(mn[2],lo)
  if cm>a[2] or fl(200*(eff(a[5],5,True)-sub)/div)/1000+1e-12<x['objective']['minimumTenacityMitigation']:return -math.inf
  independent=damage(a);deficit=sum(a[2:6])-budget
  if deficit<=0:return independent
  cl=eff(cm,2,True);ch=eff(a[2],2);slope=.2/div*(.2*(cl+ch-2*sub)/div+.45);rr=ref[2];rf=critical(cl)-slope*cl+slope*eff(rr,2)
  if rf<=0:return independent
  w=bw.copy();w[0]=slope*derivative(rr,2)/rf;value=bc+math.log(rf)-w[0]*rr+float(w@a[2:6]);lower=groups[0][0][2:6].copy();lower[3]=max(lower[3],mint)
  for j in np.argsort(w,kind='stable'):
   reduction=min(deficit,max(0,a[j+2]-lower[j]));value-=reduction*w[j];deficit-=reduction
   if deficit<=0:break
  f=factors(a);return min(independent,independent/(f[1]*f[2]*f[3]*f[4])*math.exp(value)*(1+1e-12))
 eq=coo_matrix((np.ones(n),(np.repeat(np.arange(len(groups)),sizes),np.arange(n))),shape=(len(groups),n)).tocsr()
 first=mn[2];last=v[2];width=max(64,math.ceil((last-first+1)/256));count=max(1,math.ceil((last-first)/width));ri=int((ref[2]-first)//width);indices=sorted({max(0,min(count-1,ri+k)) for k in [-2,-1,0,1,2,3]})
 for index in indices:
  lo=first+index*width;hi=min(last,first+(index+1)*width);w=np.zeros(10);constant=math.log(.01*trait)+1e-10
  def pf(j,a,b,rr):
   global constant
   value=a+b*(eff(rr,j)+1e-7);weight=b*derivative(rr,j)/value;w[j]=weight;constant+=math.log(value)-weight*rr
  cl=eff(lo,2,True);ch=eff(hi,2)+1e-7;slope=.2/div*(.2*(cl+ch-2*sub)/div+.45+2e-10);t=.2*(cl-sub)/div;cf=1+(t+.4+1e-10)*(t+.05+1e-10)
  pf(2,cf-slope*cl,slope,min(hi,max(lo,ref[2])));pf(3,1-.14/det*main+1e-10*dt,.14/det,ref[3]);pf(4,1-.1375/div*sub+2.5e-11,.1375/div,ref[4]);pf(5,1-.112/div*sub+1e-10,.112/div,ref[5]);secondary_constant=constant
  pf(0,1-ap/100+ap/main*1e-9+1e-9,ap*party/(100*main),ref[0]);pf(6,fl(main*mod/1000),1,ref[6]);full_constant=constant
  raw_old=[];options=[]
  for kind in ['full','secondary']:
   weights=w.copy();const=full_constant
   if kind=='secondary':weights[0]=weights[6]=0;fs=factors(v[:8]);const=secondary_constant+math.log(fs[0])+math.log(fs[5])
   profit=points@weights;uncon=const+sum(max(profit[a:b]) for a,b in zip(starts[:-1],starts[1:]));raw_old.append(math.exp(uncon));entry={'kind':kind,'unconstrainedPlane':math.exp(uncon),'constraints':{}}
   for mode in ['crt','crt_ten','crt_speed','joint']:
    aa=[points[:,2],-points[:,2]];bb=[hi,-lo]
    if mode in ['crt_ten','joint']:aa.append(-points[:,5]);bb.append(-mint)
    if mode in ['crt_speed','joint']:aa.extend([points[:,9],-points[:,9]]);bb.extend([shi,-slo])
    a=np.vstack(aa);b=np.array(bb);sol=linprog(-profit,A_ub=csr_matrix(a),b_ub=b,A_eq=eq,b_eq=np.ones(len(groups)),bounds=(0,None),method='highs',options={'dual_feasibility_tolerance':1e-8,'primal_feasibility_tolerance':1e-8})
    if sol.status==2:entry['constraints'][mode]={'infeasible':True};continue
    if not sol.success:raise RuntimeError(sol.message)
    prices=np.maximum(0,-sol.ineqlin.marginals);adjusted=profit-prices@a;terms=[max(adjusted[l:h]) for l,h in zip(starts[:-1],starts[1:])];cert=const+float(prices@b)+sum(terms);cert+=1e-9*(1+abs(const)+abs(float(prices@b))+sum(map(abs,terms)))
    entry['constraints'][mode]={'upperCertificate':math.exp(cert),'lpUpper':math.exp(const-sol.fun),'prices':prices.tolist(),'dualGap':cert-(const-sol.fun)}
   options.append(entry)
  old=min(box_bound(lo,hi),*raw_old);joint=min((o['constraints']['joint'].get('upperCertificate',-math.inf) for o in options));row={'job':ctx['job'],'food':food['id'],'points':n,'interval':[lo,hi],'incumbent':x['minimumDamage'],'currentUpper':old,'jointUpper':min(old,joint),'details':options};rows.append(row)
  print(ctx['job'],index,round(lo),round(hi),'old',round(old,8),'joint',round(min(old,joint),8),'seed',round(x['minimumDamage'],8),flush=True)
(p/'lp-results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
