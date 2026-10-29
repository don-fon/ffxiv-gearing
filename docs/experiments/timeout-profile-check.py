import json,pathlib,math,collections,gzip
r=pathlib.Path(__file__).resolve().parents[2]
floor=lambda v: math.trunc(v+1e-7)
def validate(r,x,crit):
 s=dict(x['fixedStats']);slots=[];unique=set()
 for g in r['gears']:
  orig=next(t for t in x['gears'] if t['id']==g['id']);assert orig['slot']==g['slot'];slots.append(g['slot'])
  if orig['unique']:assert g['id'] not in unique;unique.add(g['id'])
  part=dict(orig['stats']);assert not(orig['synced'] and g['melds'])
  for m in g['melds']:
   k=m['stat'];part[k]=part.get(k,0)+min(m['value'],max(0,orig['caps'][k]-part.get(k,0)))
  for k,v in part.items():s[k]=s.get(k,0)+v
 expected=collections.Counter(x['slots']);expected[12]+=1
 assert collections.Counter(slots)==expected
 if r.get('food'):
  f=r['food']
  for k,v in f['stats'].items():s[k]=s.get(k,0)+(min(v,floor(s.get(k,0)*f['statRates'][k]/100)) if k in f.get('statRates',{}) else v)
 assert s==r['stats']
 lev=x['damage']['level'];modifier=x['damage']['statModifiers'].get('gcd',100) if x['damage']['jobLevel']>=80 else 100
 gcd=floor(floor((1000-floor(130*(s[x['speedStat']]-lev['sub'])/lev['div']))*2500/1000)*modifier/1000)/100
 assert gcd==x['targetGcd'],(gcd,x['targetGcd'])
 mit=floor(200*(s.get('TEN',lev['sub'])-lev['sub'])/lev['div'])/1000
 assert abs(mit-r['tenacityMitigation'])<1e-12
 objective=x.get('objective',{})
 if objective.get('type')=='minimumTenacity':assert mit+1e-12>=objective['minimumTenacityMitigation']
 if objective.get('type')=='tenacityTradeoff':assert abs(r['score']-r['damage']*(1+max(0,mit)/objective['mitigationPointsPerDamagePercent']))<1e-10
 if r.get('criticalRange'):
  c=r['criticalRange'];th=c.get('threshold',c['midpoint'])
  if crit=='high':assert s['CRT']>=th
  if crit=='low':assert s['CRT']<=th
 return {'gearFoodStatsReconstructed':True,'slotUniqueAndCandidateChecks':True,'gcd':gcd,'mitigation':mit,'criticalThresholdCheck':crit}

data=json.loads((r/'docs/benchmarks/timeout-profile.json').read_text())
for row in json.loads(gzip.decompress((r/'docs/benchmarks/timeout-profile-candidates.json.gz').read_bytes())):
 fixture='gradient-expanded/pld605.json' if row['job']=='PLD' else 'warrior-displayed-375-input.json'
 x=json.loads((r/'test/fixtures'/fixture).read_text());x['targetGcd']=2.45 if row['job']=='PLD' else 2.48
 x['objective']={'type':'minimumTenacity','minimumTenacityMitigation':.1 if row['job']=='PLD' else .15}
 assert not row['optimalityProved'];validate(row['result'],x,'none')
print('12 recorded intermediate candidates satisfy gear, meld, food, GCD and mitigation constraints; no optimality claim.')
