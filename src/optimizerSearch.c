/* Freestanding WASM kernel. ABI and data layout are defined in optimizerWasm.ts.
 * Keep IEEE-754 operation order: compile without fast-math or FP contraction. */
__attribute__((import_module("env"), import_name("log"))) extern double wasm_log(double);
__attribute__((import_module("env"), import_name("exp"))) extern double wasm_exp(double);
typedef unsigned int address;
#define ROOTS 16
#define FRAMES 1024
#define CACHE 65536
#define NODE_LEFT 11
#define NODE_RIGHT 12
#define NODE_POINTS 13
#define NODE_LENGTH 14
#define NODE_COUNT 15
#define POINT_BYTES 80
static double *context;
static double *factors;
static double budget_weights[4], budget_constant, minimum_tenacity_raw;
static double best, visited, evaluated, covered;
static address selected[ROOTS];
static int root_count, top, failure;
typedef struct { address roots[ROOTS]; double bound, work; } Frame;
static Frame *frames;
static double minimum(double a,double b){return a<b?a:b;}
static double maximum(double a,double b){return a>b?a:b;}
static double floor_game(double value){return __builtin_trunc(value+1e-7);}
static double *node(address pointer){return (double*)pointer;}
static double effective(double raw,int stat,int integer){
 double cap=context[20+stat],rate=context[28+stat];
 return raw+(rate<0?cap:minimum(cap,integer?floor_game(raw*rate):raw*rate));
}
static double factor(int dimension,double raw){
 int cacheable=raw>=0&&raw<CACHE&&__builtin_trunc(raw)==raw;
 if(cacheable&&factors[dimension*CACHE+(int)raw]!=0)return factors[dimension*CACHE+(int)raw];
 double value=0,sub=context[1],div=context[2],main=context[0];
 if(dimension==0)value=floor_game(context[6]*(floor_game(effective(raw,0,1)*context[7])-main)/main+100)/100;
 else if(dimension==1){
  double x=effective(raw,2,1),chance=floor_game(200*(x-sub)/div+50+(context[10]?200:0))/1000;
  value=(floor_game(200*(x-sub)/div+1400)/1000-1)*chance+1;
 }else if(dimension==2)value=floor_game((140*(effective(raw,3,1)-main)/context[3]+1000)/context[4])*context[4]/1000;
 else if(dimension==3)value=0.25*floor_game(550*(effective(raw,4,1)-sub)/div+(context[10]?200:0))/1000+1;
 else if(dimension==4)value=floor_game(112*(effective(raw,5,1)-sub)/div+1000)/1000;
 else value=floor_game(main*context[5]/1000)+effective(raw,context[9]?7:6,1);
 if(cacheable)factors[dimension*CACHE+(int)raw]=value;
 return value;
}
static double mitigation(const double *v,int has_tenacity);
static double damage(const double *v,int has_tenacity){
 double weapon=factor(5,v[context[9]?7:6]);
 if(context[10]){
  double index=effective(v[1],1,1)-context[11];
  if(index>=0&&index<context[13]&&__builtin_trunc(index)==index)weapon+=((double*)(address)context[12])[(int)index];
 }
 int tenacity_present=has_tenacity||(context[10]&&context[16]);
 return 0.01*weapon*factor(0,v[0])*factor(2,v[3])*(tenacity_present?factor(4,v[5]):1)*context[8]*factor(1,v[2])*factor(3,v[4])*(context[19]?(1+context[19]*maximum(0,mitigation(v,has_tenacity))):1);
}
static double mitigation(const double *v,int has_tenacity){
 double tenacity=has_tenacity||context[16]?effective(v[5],5,1):context[1];
 return floor_game(200*(tenacity-context[1])/context[2])/1000;
}
static double critical_factor(double value){double x=0.2*(value-context[1])/context[2];return 1+(x+0.4)*(x+0.05);}
static double budget_bound(const double *v,double critical_minimum,double budget,double independent){
 double deficit=v[2]+v[3]+v[4]+v[5]-budget;
 if(!context[15]||deficit<=0)return independent;
 double lo=effective(critical_minimum,2,1),hi=effective(v[2],2,0);
 double slope=0.2/context[2]*(0.2*(lo+hi-2*context[1])/context[2]+0.45);
 double reference=context[40],reference_factor=critical_factor(lo)-slope*lo+slope*effective(reference,2,0);
 if(reference_factor<=0)return independent;
 double weights[4]={0,budget_weights[1],budget_weights[2],budget_weights[3]};
 weights[0]=slope*(reference*context[30]<context[22]?1+context[30]:1)/reference_factor;
 double log_bound=budget_constant+wasm_log(reference_factor)-weights[0]*reference;
 int order[4]={0,1,2,3};
 for(int i=0;i<4;i++)log_bound+=weights[i]*v[i+2];
 for(int i=1;i<4;i++){
  int value=order[i],j=i;
  while(j>0&&weights[order[j-1]]>weights[value]){order[j]=order[j-1];j--;}
  order[j]=value;
 }
 for(int i=0;i<4&&deficit>0;i++){
  int stat=order[i];double lower=context[36+stat];
  if(stat==3)lower=maximum(lower,minimum_tenacity_raw);
  double reduction=minimum(deficit,maximum(0,v[stat+2]-lower));
  log_bound-=reduction*weights[stat];deficit-=reduction;
 }
 double independent_factors=factor(1,v[2])*factor(2,v[3])*factor(3,v[4])*factor(4,v[5]);
 return minimum(independent,independent/independent_factors*wasm_exp(log_bound)*(1+1e-12));
}
/* On each raw CRT interval, the convex critical factor is below its secant.
 * The logarithms of that affine secant and the other (food-capped) affine
 * factors are concave, so their tangents give a linear upper bound in raw stats.
 * Maximizing this linear form over EACH actual option node preserves attribute
 * correlations; summing independent stat maxima would lose those constraints.
 * A second support form keeps only secondaries, using exact main/weapon maxima
 * to avoid unnecessary floor-relaxation gaps after those stats are fixed.
 * Cache both supports per node/interval. Epsilon terms cover game's truncation.
 */
static double plane_weights[8],plane_constant,plane_low,plane_high,plane_best_log;
static double plane_first,plane_last,plane_width;
static address original_roots[ROOTS];
static int plane_enabled,plane_count,plane_finished,plane_active;
static unsigned int plane_generation;
static double plane_support_kind(address pointer,int kind){
 double *n=node(pointer);int cache=kind?20:16;
 if(n[cache+1]==plane_generation)return n[cache];
 double value=-__builtin_inf();
 if(n[NODE_LENGTH]>0){
  for(int p=0;p<(int)n[NODE_LENGTH];p++){
   double *point=(double*)((address)n[NODE_POINTS]+p*POINT_BYTES),sum=0;
   for(int i=kind?2:0;i<(kind?6:8);i++)sum+=plane_weights[i]*point[i];
   value=maximum(value,sum);
  }
 }else value=maximum(plane_support_kind((address)n[NODE_LEFT],kind),plane_support_kind((address)n[NODE_RIGHT],kind));
 n[cache]=value;n[cache+1]=plane_generation;return value;
}
static double plane_critical(double x){double t=0.2*(x-context[1])/context[2];return 1+(t+0.4+1e-10)*(t+0.05+1e-10);}
static void plane_factor(int dimension,double a,double b,double reference){
 double cap=context[20+dimension],rate=context[28+dimension];
 double post=effective(reference,dimension,0)+1e-7;
 double value=a+b*post;
 double weight=b*(rate>=0&&reference*rate<cap?1+rate:1)/value;
 plane_weights[dimension]=weight;plane_constant+=wasm_log(value)-weight*reference;
}
static double plane_secondary_constant;
static int plane_score_integrated;
static void configure_plane(void){
 for(int i=0;i<8;i++)plane_weights[i]=0;
 plane_constant=wasm_log(0.01*context[8])+1e-10;
 double lo=effective(plane_low,2,1),hi=effective(plane_high,2,0)+1e-7;
 double slope=0.2/context[2]*(0.2*(lo+hi-2*context[1])/context[2]+0.45+2e-10);
 plane_factor(2,plane_critical(lo)-slope*lo,slope,minimum(plane_high,maximum(plane_low,context[50])));
 plane_factor(3,1-0.14/context[3]*context[0]+1e-10*context[4],0.14/context[3],context[51]);
 plane_factor(4,1-0.1375/context[2]*context[1]+2.5e-11,0.1375/context[2],context[52]);
 if(!context[56])plane_factor(5,1-0.112/context[2]*context[1]+1e-10,0.112/context[2],context[53]);
 /* The score's extra mitigation reward is an affine upper relaxation on
  * TEN >= sub. Add its log tangent to the same TEN axis, retaining correlations
  * with the ordinary damage factors instead of taking an independent TEN max. */
 plane_score_integrated=context[19]>0&&context[39]>=context[1];
 if(plane_score_integrated){
  double reference=context[53],slope=0.2*context[19]/context[2];
  double value=1+slope*(effective(reference,5,0)+1e-7-context[1])+context[19]*1e-10;
  double weight=slope*(reference*context[33]<context[25]?1+context[33]:1)/value;
  plane_weights[5]+=weight;plane_constant+=wasm_log(value)-weight*reference;
 }
 plane_secondary_constant=plane_constant;
 double main_slope=context[6]*context[7]/(100*context[0]);
 plane_factor(0,1-context[6]/100+context[6]/context[0]*1e-9+1e-9,main_slope,context[48]);
 int weapon=context[9]?7:6;
 plane_factor(weapon,floor_game(context[0]*context[5]/1000),1,context[48+weapon]);
 plane_generation++;
}
static double plane_main_raw,plane_main_log,plane_weapon_raw,plane_weapon_log;
static double plane_primary_logs(double main,double weapon){
 if(main!=plane_main_raw){plane_main_raw=main;plane_main_log=wasm_log(factor(0,main));}
 if(weapon!=plane_weapon_raw){plane_weapon_raw=weapon;plane_weapon_log=wasm_log(factor(5,weapon));}
 return plane_main_log+plane_weapon_log;
}
static double plane_bound(const address *roots,double *maximum_critical,double *minimum_critical){
 double log_bound=plane_constant,secondary=plane_secondary_constant,main=0,weapon=0;
 *maximum_critical=0;*minimum_critical=0;int weapon_stat=context[9]?7:6;
 for(int i=0;i<root_count;i++){
  double *n=node(roots[i]);*maximum_critical+=n[2];*minimum_critical+=n[10];
  log_bound+=plane_support_kind(roots[i],0);secondary+=plane_support_kind(roots[i],1);
  main+=n[0];weapon+=n[weapon_stat];
 }
 if(*minimum_critical>plane_high||*maximum_critical<plane_low)return -__builtin_inf();
 return minimum(log_bound,secondary+plane_primary_logs(main,weapon));
}
static double speed_gcd(double raw){
 double cap=context[60],rate=context[61];
 double speed=raw+(rate<0?cap:minimum(cap,floor_game(raw*rate)));
 return floor_game(floor_game((1000-floor_game(130*(speed-context[1])/context[2]))*2500/1000)*context[62]/1000);
}
static double upper(const address *roots){
 if(plane_enabled&&context[46]&&(effective(plane_high,2,0)+1e-7<context[44]||effective(plane_low,2,1)>context[45]))return -__builtin_inf();
 double speed_budget=__builtin_inf();
 if(context[57]){
  double low=0,high=0,total=0;
  for(int i=0;i<root_count;i++){double *n=node(roots[i]);low+=n[23];high+=n[22];total+=n[24];}
  if(low>context[59]||high<context[58])return -__builtin_inf();
  speed_budget=total-context[58];
 }
 double linear=__builtin_inf();
 if(plane_enabled){double high,low;linear=plane_bound(roots,&high,&low);
  if(context[19]&&!plane_score_integrated){double v[8]={0};int present=0;for(int i=0;i<root_count;i++){double *n=node(roots[i]);v[5]+=n[5];present|=(int)n[8];}linear+=wasm_log(1+context[19]*maximum(0,mitigation(v,present)));}
  if(linear<=plane_best_log)return -__builtin_inf();}
 double v[8]={0},budget=0,critical_minimum=0;int has_tenacity=0;
 for(int i=0;i<root_count;i++){
  double *n=node(roots[i]);for(int stat=0;stat<8;stat++)v[stat]+=n[stat];
  has_tenacity|=(int)n[8];budget+=n[9];critical_minimum+=n[10];
 }
 if(plane_enabled){
  v[2]=minimum(v[2],plane_high);critical_minimum=maximum(critical_minimum,plane_low);
  if(context[46]){v[2]=minimum(v[2],context[45]);critical_minimum=maximum(critical_minimum,context[44]-context[22]);}
  if(critical_minimum>v[2])return -__builtin_inf();
 }
 if(context[46]&&(effective(v[2],2,1)<context[44]||effective(critical_minimum,2,1)>context[45]))return -__builtin_inf();
 double value=damage(v,has_tenacity);
 if(value<=best)return value;
 if(context[14]>0&&mitigation(v,has_tenacity)+1e-12<context[14])return -__builtin_inf();
 budget=minimum(budget,speed_budget);
 if(context[56]){v[5]=context[1];budget+=context[1];}
 value=budget_bound(v,critical_minimum,budget,value);
 return plane_enabled&&value>best?minimum(value,wasm_exp(linear)):value;
}
__attribute__((visibility("default"))) int search_abi(void){return 7;}
__attribute__((visibility("default"))) int search_cache_bytes(void){return 6*CACHE*8;}
__attribute__((visibility("default"))) int search_frame_bytes(void){return FRAMES*sizeof(Frame);}
__attribute__((visibility("default"))) void configure_search(address pointer){
 context=(double*)pointer;factors=(double*)(address)context[17];frames=(Frame*)(address)context[18];
 for(int dim=0;dim<6;dim++)for(int i=0;i<CACHE;i++)factors[dim*CACHE+i]=0;
 /* A mitigation floor consumes a minimum raw TEN budget. Invert the
  * continuous food upper envelope, so fractional stats and game truncation
  * cannot make this lower bound exclude a feasible point. */
 minimum_tenacity_raw=0;
 if(context[14]>0){
  double target=context[1]+context[2]/200*(__builtin_ceil(context[14]*1000-1e-9)-1e-7);
  double low=0,high=1000000;
  for(int i=0;i<60;i++){double middle=(low+high)*0.5;if(effective(middle,5,0)>=target)high=middle;else low=middle;}
  minimum_tenacity_raw=maximum(0,low-1e-6);
 }
 budget_constant=0;
 if(context[15]){
  double slopes[4]={0,0.14/context[3],0.1375/context[2],0.112/context[2]};
  double bases[4]={context[1],context[0],context[1],context[1]};
  for(int i=1;i<4;i++){
   double reference=context[40+i],value=1+slopes[i]*(effective(reference,i+2,0)-bases[i]);
   budget_weights[i]=slopes[i]*(reference*context[30+i]<context[22+i]?1+context[30+i]:1)/value;
   budget_constant+=wasm_log(value)-budget_weights[i]*reference;
  }
 }
}
/* Adjacent closed intervals share the same computed boundary, including for
 * fractional custom stats. Overlap is harmless; leaving any gap would not be.
 * Optimality is reported only after every interval has been exhausted. */
static int next_plane(void){
 if(plane_active){plane_finished++;plane_active=0;}
 if(plane_finished>=plane_count)return 0;
 covered=0;
 if(plane_enabled){
  int index=plane_finished;
  plane_low=plane_first+index*plane_width;plane_high=minimum(plane_last,plane_first+(index+1)*plane_width);
  configure_plane();
 }
 for(int i=0;i<root_count;i++)frames[0].roots[i]=original_roots[i];
 frames[0].work=1;frames[0].bound=upper(frames[0].roots);top=1;plane_active=1;return 1;
}
__attribute__((visibility("default"))) void start_search(address pointers,int count,double threshold){
 plane_main_raw=-__builtin_inf();plane_weapon_raw=-__builtin_inf();
 root_count=count;best=threshold;visited=0;evaluated=0;covered=0;top=0;failure=0;
 if(count<1||count>ROOTS){failure=1;return;}
 double work=1;plane_first=0;plane_last=0;
 for(int i=0;i<count;i++){
  original_roots[i]=((address*)pointers)[i];selected[i]=0;double *n=node(original_roots[i]);
  work*=n[NODE_COUNT];plane_first+=n[10];plane_last+=n[2];
 }
 plane_enabled=context[15]&&(!context[56]||context[57])&&context[7]>0&&context[8]>0&&work>=context[47]&&count>1;
 // The relaxation needs nonnegative secondary food and a positive reference.
 if(plane_enabled){
  for(int stat=2;stat<=5;stat++)if(context[20+stat]<0||context[28+stat]<0)plane_enabled=0;
  if(factor(0,context[48])<=0||factor(5,context[48+(context[9]?7:6)])<=0)plane_enabled=0;
 }
 plane_width=maximum(64,__builtin_ceil((plane_last-plane_first+1)/256));
 plane_count=plane_enabled?(int)maximum(1,__builtin_ceil((plane_last-plane_first)/plane_width)):1;
 plane_best_log=best>0?wasm_log(best):-__builtin_inf();plane_finished=0;plane_active=0;
 next_plane();
}
__attribute__((visibility("default"))) int step_search(int limit){
 if(failure)return 1;
 for(int processed=0;processed<limit;processed++){
  if(top==0&&!next_plane())break;
  Frame frame;top--;frame.bound=frames[top].bound;frame.work=frames[top].work;
  for(int i=0;i<root_count;i++)frame.roots[i]=frames[top].roots[i];
  if(frame.bound<=best){covered+=frame.work;continue;}
  visited++;
  int split=-1,split_count=0,leaf=1;double primary_uncertainty=-1;
  for(int i=0;i<root_count;i++){
   double *n=node(frame.roots[i]);
   if(n[NODE_LENGTH]==0){
    leaf=0;double uncertainty=plane_enabled?(n[0]-n[18])*plane_weights[0]+(n[6]-n[19])*plane_weights[6]:0;
    if(uncertainty>primary_uncertainty||(uncertainty==primary_uncertainty&&n[NODE_COUNT]>split_count)){
     primary_uncertainty=uncertainty;split=i;split_count=(int)n[NODE_COUNT];
    }
   }
  }
  if(leaf){
   double *prefix=node(frame.roots[0]);
   for(int point=0;point<(int)prefix[NODE_LENGTH];point++){
    double v[8]={0},speed=0;int has_tenacity=0;address choices[ROOTS];
    for(int i=0;i<root_count;i++){
     double *n=node(frame.roots[i]);address ptr=(address)n[NODE_POINTS]+(i==0?point*POINT_BYTES:0);choices[i]=ptr;
     double *p=(double*)ptr;for(int stat=0;stat<8;stat++)v[stat]+=p[stat];has_tenacity|=(int)p[8];speed+=p[9];
    }
    evaluated++;if(context[57]&&(speed<context[58]||speed>context[59]||speed_gcd(speed)!=context[63]))continue;if(plane_enabled&&(v[2]<plane_low||v[2]>plane_high))continue;double value=damage(v,has_tenacity);
    if(value>best&&(!context[46]||(effective(v[2],2,1)>=context[44]&&effective(v[2],2,1)<=context[45]))&&mitigation(v,has_tenacity)+1e-12>=context[14]){
     best=value;plane_best_log=wasm_log(best);for(int i=0;i<root_count;i++)selected[i]=choices[i];
    }
   }
   covered+=frame.work;continue;
  }
  if(top+2>FRAMES){failure=2;top=0;break;}
  double *n=node(frame.roots[split]),*ln=node((address)n[NODE_LEFT]),*rn=node((address)n[NODE_RIGHT]);
  Frame left,right;for(int i=0;i<root_count;i++){left.roots[i]=frame.roots[i];right.roots[i]=frame.roots[i];}
  left.roots[split]=(address)n[NODE_LEFT];right.roots[split]=(address)n[NODE_RIGHT];
  left.work=frame.work*ln[NODE_COUNT]/(ln[NODE_COUNT]+rn[NODE_COUNT]);right.work=frame.work-left.work;
  left.bound=upper(left.roots);right.bound=upper(right.roots);
  Frame *first=left.bound>=right.bound?&right:&left,*second=left.bound>=right.bound?&left:&right;
  frames[top].bound=first->bound;frames[top].work=first->work;
  for(int i=0;i<root_count;i++)frames[top].roots[i]=first->roots[i];top++;
  frames[top].bound=second->bound;frames[top].work=second->work;
  for(int i=0;i<root_count;i++)frames[top].roots[i]=second->roots[i];top++;
 }
 if(failure){top=0;plane_finished=plane_count;return 1;}
 return top==0&&plane_finished>=plane_count;
}
__attribute__((visibility("default"))) double search_damage(void){return best;}
__attribute__((visibility("default"))) double search_visited(void){return visited;}
__attribute__((visibility("default"))) double search_evaluated(void){return evaluated;}
__attribute__((visibility("default"))) double search_coverage(void){return top==0&&plane_finished>=plane_count?1:minimum(0.999999,(plane_finished+covered)/plane_count);}
__attribute__((visibility("default"))) address search_selected(int index){return index>=0&&index<root_count?selected[index]:0;}
__attribute__((visibility("default"))) int search_error(void){return failure;}
/* LLVM may lower fixed-size structure copies to these freestanding routines. */
void *memcpy(void *destination,const void *source,unsigned int count){unsigned char*d=destination;const unsigned char*s=source;for(unsigned int i=0;i<count;i++)d[i]=s[i];return destination;}
void *memset(void *destination,int value,unsigned int count){unsigned char*d=destination;for(unsigned int i=0;i<count;i++)d[i]=(unsigned char)value;return destination;}

/* Exact component-wise dominance frontier for preprocessing. Speed buckets are
 * separated by the caller. Stable lexicographic sorting makes every possible
 * dominator precede its target, so queries can omit the first sorted axis. */
#define SKY_DIMS 10
#define SKY_LEAF 32
typedef struct {
 double maxima[SKY_DIMS];
 int left,right,count,length,points[SKY_LEAF+1];
} SkylineNode;
static double *sky_values;
static SkylineNode *sky_nodes;
static int sky_axes[SKY_DIMS],sky_dimensions,sky_used,sky_capacity;
static int *sky_stack;
static double coordinate(int point,int dimension){return sky_values[point*SKY_DIMS+sky_axes[dimension]];}
static int lex_before(int left,int right){
 for(int d=0;d<sky_dimensions;d++){
  double a=coordinate(left,d),b=coordinate(right,d);
  if(a!=b)return a>b;
 }
 return left<right;
}
static int sky_leaf(const int *points,int length){
 if(sky_used>=sky_capacity)return -1;
 int index=sky_used++;SkylineNode *n=&sky_nodes[index];n->left=-1;n->right=-1;n->count=length;n->length=length;
 for(int d=1;d<sky_dimensions;d++)n->maxima[d]=coordinate(points[0],d);
 for(int i=0;i<length;i++){
  n->points[i]=points[i];
  for(int d=1;d<sky_dimensions;d++)n->maxima[d]=maximum(n->maxima[d],coordinate(points[i],d));
 }
 return index;
}
static int sky_dominates(int index,int target){
 int pending=0;sky_stack[pending++]=index;
 while(pending){
  SkylineNode *n=&sky_nodes[sky_stack[--pending]];int possible=1;
  for(int d=1;d<sky_dimensions;d++)if(n->maxima[d]<coordinate(target,d)){possible=0;break;}
  if(!possible)continue;
  if(n->length>=0){
   for(int i=0;i<n->length;i++){
    int all=1;for(int d=1;d<sky_dimensions;d++)if(coordinate(n->points[i],d)<coordinate(target,d)){all=0;break;}
    if(all)return 1;
   }continue;
  }
  double left=0,right=0;
  for(int d=1;d<sky_dimensions;d++){left+=sky_nodes[n->left].maxima[d];right+=sky_nodes[n->right].maxima[d];}
  sky_stack[pending++]=left>=right?n->right:n->left;
  sky_stack[pending++]=left>=right?n->left:n->right;
 }
 return 0;
}
static void sky_insert(int index,int point){
 SkylineNode *n=&sky_nodes[index];n->count++;
 for(int d=1;d<sky_dimensions;d++)n->maxima[d]=maximum(n->maxima[d],coordinate(point,d));
 if(n->length>=0){
  n->points[n->length++]=point;
  if(n->length>SKY_LEAF){
   int axis=1;double spread=-1;
   for(int d=1;d<sky_dimensions;d++){
    double low=coordinate(n->points[0],d);
    for(int i=1;i<n->length;i++)low=minimum(low,coordinate(n->points[i],d));
    if(n->maxima[d]-low>spread){axis=d;spread=n->maxima[d]-low;}
   }
   for(int i=1;i<n->length;i++){
    int value=n->points[i],j=i;
    while(j>0&&coordinate(n->points[j-1],axis)<coordinate(value,axis)){n->points[j]=n->points[j-1];j--;}
    n->points[j]=value;
   }
   int middle=(n->length+1)/2;
   n->left=sky_leaf(n->points,middle);n->right=sky_leaf(n->points+middle,n->length-middle);n->length=-1;
   if(n->left<0||n->right<0)failure=3;
  }return;
 }
 double left=0,right=0;
 for(int d=1;d<sky_dimensions;d++){
  left+=maximum(0,coordinate(point,d)-sky_nodes[n->left].maxima[d]);
  right+=maximum(0,coordinate(point,d)-sky_nodes[n->right].maxima[d]);
 }
 sky_insert(left<right||(left==right&&sky_nodes[n->left].count<=sky_nodes[n->right].count)?n->left:n->right,point);
}
__attribute__((visibility("default"))) int pareto_node_bytes(void){return sizeof(SkylineNode);}
__attribute__((visibility("default"))) int pareto_frontier(address values,address indices,address temporary,
 address nodes,address result,int count,int capacity){
 if(count<1)return 0;
 sky_values=(double*)values;sky_nodes=(SkylineNode*)nodes;sky_capacity=capacity;sky_used=0;sky_dimensions=0;failure=0;
 int *order=(int*)indices,*buffer=(int*)temporary,*output=(int*)result;
 double spreads[SKY_DIMS];
 for(int d=0;d<SKY_DIMS;d++){
  double low=sky_values[d],high=low;
  for(int i=1;i<count;i++){low=minimum(low,sky_values[i*SKY_DIMS+d]);high=maximum(high,sky_values[i*SKY_DIMS+d]);}
  if(high>low){sky_axes[sky_dimensions]=d;spreads[sky_dimensions++]=high-low;}
 }
 if(sky_dimensions==0){output[0]=0;return 1;}
 for(int i=1;i<sky_dimensions;i++){
  int axis=sky_axes[i],j=i;double spread=spreads[i];
  while(j>0&&spreads[j-1]<spread){sky_axes[j]=sky_axes[j-1];spreads[j]=spreads[j-1];j--;}
  sky_axes[j]=axis;spreads[j]=spread;
 }
 for(int i=0;i<count;i++)order[i]=i;
 for(int width=1;width<count;width*=2){
  for(int start=0;start<count;start+=2*width){
   int middle=start+width<count?start+width:count,end=start+2*width<count?start+2*width:count;
   int left=start,right=middle,next=start;
   while(left<middle&&right<end)buffer[next++]=lex_before(order[left],order[right])?order[left++]:order[right++];
   while(left<middle)buffer[next++]=order[left++];while(right<end)buffer[next++]=order[right++];
  }
  int *swap=order;order=buffer;buffer=swap;
 }
 if(sky_dimensions==1){output[0]=order[0];return 1;}
 sky_stack=buffer;
 int retained=0,root=-1;
 for(int i=0;i<count;i++){
  int point=order[i];if(root>=0&&sky_dominates(root,point))continue;
  output[retained++]=point;
  if(root<0)root=sky_leaf(&point,1);else sky_insert(root,point);
  if(failure)return -failure;
 }
 return retained;
}
