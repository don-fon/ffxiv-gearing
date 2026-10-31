"""Independent bounded exhaustive oracle: no production pruning/scoring code.
Enumerates original gear/materia assignments; uses rational score arithmetic.
"""
from fractions import Fraction as F
from itertools import product
from pathlib import Path
import argparse,copy,json,random,time


def food_stats(raw,food):
 s=dict(raw)
 for k,v in (food or {}).get('stats',{}).items():
  rate=food.get('statRates',{}).get(k)
  s[k]=s.get(k,0)+(v if rate is None else min(v,s.get(k,0)*rate//100))
 return s


def evaluate(s,x):
 c=x['damage'];l=c['level'];sub=l['sub'];main=l['main'];div=l['div'];attack='STR' if c['mainStat']=='VIT' else c['mainStat'];blu=200 if c['job']=='BLU' else 0
 speed=s.get(x['speedStat'],0);gcd=(1000-(130*(speed-sub)//div))*2500//1000
 gcd=gcd*(c['statModifiers'].get('gcd',100) if c['jobLevel']>=80 else 100)//1000
 mitigation=F(200*(s.get('TEN',sub)-sub)//div,1000)
 critical=F(200*(s.get('CRT',0)-sub)//div+50+blu,1000)
 critical_damage=F(200*(s.get('CRT',0)-sub)//div+1400,1000)
 determination=F((F(140*(s.get('DET',0)-main),l['det'])+1000)//l['detTrunc']*l['detTrunc'],1000)
 direct=F(550*(s.get('DHT',0)-sub)//div+blu,1000)
 tenacity=F(112*(s.get('TEN',sub)-sub)//div+1000,1000)
 weapon=main*c['statModifiers'][attack]//1000+s.get('MDMG' if c['mainStat'] in ['INT','MND'] else 'PDMG',0)
 if c['job']=='BLU':
  i=s.get('INT',0)-c['baseStats']['INT'];add=c['bluMdmgAdditions'];weapon+=add[i] if 0<=i<len(add) else 0
 party=int(s[attack]*F(str(c.get('partyBonus',1.05))))
 ap=l['apTank'] if c['mainStat']=='VIT' else l['ap'];attack_factor=F((F(ap*(party-main),main)+100)//1,100)
 damage=F(1,100)*weapon*attack_factor*determination*tenacity*F(str(c['traitDamageMultiplier']))*(1+(critical_damage-1)*critical)*(1+F(1,4)*direct)
 objective=x.get('objective',{});score=damage
 if objective.get('type')=='tenacityTradeoff':score*=1+max(0,mitigation)/F(str(objective['mitigationPointsPerDamagePercent']))
 return gcd,mitigation,score


def choices(x):
 excluded=set(x.get('excludedGearIds',[]));locks=x.get('lockedGears');legacy=set(x.get('lockedGearIds',[]));domains=[]
 for slot in x['slots']:
  for occurrence in range(2 if slot==12 else 1):
   lock=next((l for l in (locks or []) if l['slot']==(-12 if occurrence else slot)),None)
   allowed=[g for g in x['gears'] if g['slot']==slot and g['id'] not in excluded]
   if lock:allowed=[g for g in allowed if g['id']==lock['id']]
   elif slot!=12 and legacy:allowed=[g for g in allowed if g['id'] in legacy] or allowed
   entries=[]
   for g in allowed:
    assignments=[lock['melds']] if lock and 'melds' in lock else ([[]] if g['synced'] else product(x['materiaStats'],repeat=len(g['materiaSlots'])))
    for assignment in assignments:
     s=dict(g['stats'])
     if not g['synced']:
      for i,m in enumerate(assignment):
       stat=m['stat'] if isinstance(m,dict) else m;v=m['value'] if isinstance(m,dict) else g['materiaSlots'][i]['value'];s[stat]=s.get(stat,0)+min(v,max(0,g['caps'].get(stat,10**9)-s.get(stat,0)))
     entries.append((g,s))
   domains.append(entries)
 return domains


def enumerate_raw(x):
 foods=[x['food']] if x.get('food') else x.get('foods') or [None];rows=[];visits=0
 for chosen in product(*choices(x)):
  ids=[g['id'] for g,_ in chosen if g['unique']]
  if len(ids)!=len(set(ids)):continue
  raw=dict(x['fixedStats'])
  for _,s in chosen:
   for k,v in s.items():raw[k]=raw.get(k,0)+v
  if 'targetSpeedContribution' in x and raw.get(x['speedStat'],0)-x['fixedStats'].get(x['speedStat'],0)!=x['targetSpeedContribution']:continue
  for food in foods:
   s=food_stats(raw,food);gcd,mitigation,score=evaluate(s,x);visits+=1
   rows.append((gcd,mitigation,score,s.get('CRT',0)))
 return rows,visits


def generate(root,count,seed):
 rng=random.Random(seed);names=['warrior-displayed-375-input.json','pictomancer-375-phantom-input.json','monk-605-phantom-input.json','pictomancer-375-phantom-input.json'];cases=[];visits=0
 for i in range(count):
  original=json.loads((root/'test/fixtures'/names[i%4]).read_text());c=copy.deepcopy(original['damage']);tank=i%4==0;magic=i%4 in [1,3];main='INT' if magic else 'STR';speed='SPS' if magic else 'SKS';sub=c['level']['sub']
  if i%4==3:
   c['job']='BLU';c['statModifiers']={**c['statModifiers'],'INT':115};c['bluMdmgAdditions']=[12+j//100 for j in range(3000)];c['baseStats']['INT']=1000
  fixed={main:1200,'CRT':sub,'DET':c['level']['main'],'DHT':sub,speed:sub,'MDMG' if magic else 'PDMG':100}
  if tank:fixed['TEN']=sub
  stats=['CRT','DET','DHT',speed]+(['TEN'] if tank else []);meldstats=rng.sample(stats,2);gears=[]
  for slot in [3,4,12]:
   for j in range(2):
    s={main:rng.randrange(10,35),'CRT':rng.randrange(0,91),'DET':rng.randrange(0,91),'DHT':rng.randrange(0,91),speed:rng.choice([0,20,40,60])}
    if tank:s['TEN']=rng.choice([0,30,60])
    if i%4==3:s['MDMG']=j
    synced=(i+slot+j)%7==0;slots=[] if synced or slot==12 else [{'grade':6,'value':16}]
    if i%19==0 and slot==3 and j==0 and not synced:slots.append({'grade':5,'value':12})
    gears.append({'id':slot*10+j,'name':f'oracle{i}-{slot}-{j}','slot':slot,'unique':slot!=12 or j==0,'level':350,'synced':synced,'stats':s,'caps':{k:s.get(k,0)+rng.choice([0,5,16,40]) for k in stats},'materiaSlots':slots})
  x={'fixedStats':fixed,'gears':gears,'slots':[3,4,12],'lockedGearIds':[],'lockedGears':[],'excludedGearIds':[],'materiaStats':meldstats,'speedStat':speed,'targetGcd':2.5,'criticalPreference':['none','high','low'][i%3],'damage':c,'objective':{'type':'damage'}}
  foods=[{'id':1,'name':'oracle capped','stats':{'CRT':20,'DET':15,speed:10},'statRates':{'CRT':10,'DET':10,speed:10}},{'id':2,'name':'oracle flat','stats':{'DHT':20,'CRT':13},'statRates':{}}]
  if i%3==1:x['food']=foods[0]
  elif i%3==2:x['foods']=foods
  if tank:x['objective']={'type':'tenacityTradeoff','mitigationPointsPerDamagePercent':[.1,1,10][i%3]} if i%8==0 else {'type':'minimumTenacity','minimumTenacityMitigation':rng.choice([0,.02,.04,.08])}
  if i%11==0:
   g=gears[0];x['lockedGearIds']=[g['id']];x['lockedGears']=[{'id':g['id'],'slot':3,'melds':[]}]
  if i%13==0:
   g=gears[-1];x['lockedGearIds'].append(g['id']);x['lockedGears'].append({'id':g['id'],'slot':-12,'melds':[]})
  if i%7==0:x['excludedGearIds']=[gears[3]['id']]
  rows,n=enumerate_raw(x);visits+=n
  gcds=sorted(set(r[0] for r in rows));x['targetGcd']=(rng.choice(gcds) if gcds else 250)/100
  if i%17==0:x['targetGcd']=1.5
  minimum=F(str(x['objective'].get('minimumTenacityMitigation',0)))
  feasible=[r for r in rows if r[0]==round(x['targetGcd']*100) and (x['objective']['type']!='minimumTenacity' or r[1]>=minimum)]
  if feasible and x['criticalPreference']!='none':
   low=min(r[3] for r in feasible);high=max(r[3] for r in feasible);threshold=F(low)+(high-low)*F(3 if x['criticalPreference']=='high' else 1,4)
   x['criticalRange']={'minimum':low,'maximum':high,'midpoint':(low+high)/2,'threshold':float(threshold)}
   feasible=[r for r in feasible if (r[3]>=threshold if x['criticalPreference']=='high' else r[3]<=threshold)]
  best=max((r[2] for r in feasible),default=None)
  if best is not None and i%23==0:x['globalMinimumDamage']=float(best)+1e-5;best=None
  elif best is not None and i%5==0:x['globalMinimumDamage']=float(best)*.999
  cases.append({'id':i,'input':x,'expectedScore':float(best) if best is not None else None,'exactScore':str(best) if best is not None else None,'assignments':n})
 return {'seed':seed,'count':count,'assignments':visits,'cases':cases}


def verify_returned_plans(corpus, results):
 checked=0
 for case,results in zip(corpus['cases'],results):
  assert case['id']==results['id'];x=case['input']
  for algorithm in ['native','integer']:
   result=results.get(algorithm);expected=case['exactScore']
   if expected is None:
    assert result is None,(case['id'],algorithm,'expected infeasible');continue
   assert result is not None,(case['id'],algorithm,'missing solution')
   raw=dict(x['fixedStats']);seen_unique=set();counts={};chosen=result['gears'];sources={(g['id'],g['slot']):g for g in x['gears']}
   for selection in chosen:
    gear=sources[(selection['id'],selection['slot'])];assert gear['id'] not in x.get('excludedGearIds',[])
    if gear['unique']:assert gear['id'] not in seen_unique;seen_unique.add(gear['id'])
    counts[gear['slot']]=counts.get(gear['slot'],0)+1
    assert not(gear['synced'] and selection['melds']);part=dict(gear['stats']);used=set()
    for meld in selection['melds']:
     index=meld['slot'];assert index not in used;used.add(index);slot=gear['materiaSlots'][index]
     assert meld['grade']==slot['grade'] and meld['value']==slot['value'];assert meld['stat'] in x['materiaStats']
     stat=meld['stat'];part[stat]=part.get(stat,0)+min(meld['value'],max(0,gear['caps'].get(stat,10**9)-part.get(stat,0)))
    for stat,value in part.items():raw[stat]=raw.get(stat,0)+value
   assert counts=={slot:2 if slot==12 else 1 for slot in x['slots']}
   assert all(any(g['id']==identifier for g in chosen) for identifier in x.get('lockedGearIds',[]))
   available=list(chosen)
   for lock in x.get('lockedGears',[]):
    match=next((g for g in available if g['id']==lock['id'] and g['slot']==abs(lock['slot']) and ('melds' not in lock or g['melds']==lock['melds'])),None)
    assert match is not None;(available.remove(match))
   food=result.get('food');allowed=[x['food']] if x.get('food') else x.get('foods') or [None]
   assert food in allowed
   stats=food_stats(raw,food);assert stats==result['stats']
   gcd,mitigation,score=evaluate(stats,x);assert gcd==round(x['targetGcd']*100)
   if x['objective']['type']=='minimumTenacity':assert mitigation>=F(str(x['objective']['minimumTenacityMitigation']))
   if x.get('criticalRange'):
    threshold=F(str(x['criticalRange']['threshold']));assert stats['CRT']>=threshold if x['criticalPreference']=='high' else stats['CRT']<=threshold
   assert score==F(expected),(case['id'],algorithm,'exact rational objective mismatch',str(score),expected)
   checked+=1
 return {'passed':True,'exactReturnedPlansVerified':checked,'cases':len(corpus['cases'])}


if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);parser.add_argument('--count',type=int,default=512);parser.add_argument('--seed',type=int,default=20261030);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--corpus',type=Path);parser.add_argument('--verify',type=Path);args=parser.parse_args();start=time.monotonic()
 if args.verify:
  data=verify_returned_plans(json.loads(args.corpus.read_text()),json.loads(args.verify.read_text()))
 else:data=generate(args.root,args.count,args.seed)
 data['seconds']=time.monotonic()-start;args.output.write_text(json.dumps(data,ensure_ascii=False));print(json.dumps({k:v for k,v in data.items() if k!='cases'}))
