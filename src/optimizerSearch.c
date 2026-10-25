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
#define POINT_BYTES 72
static double *context;
static double *factors;
static double budget_weights[4], budget_constant;
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
static double damage(const double *v,int has_tenacity){
 double weapon=factor(5,v[context[9]?7:6]);
 if(context[10]){
  double index=effective(v[1],1,1)-context[11];
  if(index>=0&&index<context[13]&&__builtin_trunc(index)==index)weapon+=((double*)(address)context[12])[(int)index];
 }
 int tenacity_present=has_tenacity||(context[10]&&context[16]);
 return 0.01*weapon*factor(0,v[0])*factor(2,v[3])*(tenacity_present?factor(4,v[5]):1)*context[8]*factor(1,v[2])*factor(3,v[4]);
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
  int stat=order[i];double reduction=minimum(deficit,maximum(0,v[stat+2]-context[36+stat]));
  log_bound-=reduction*weights[stat];deficit-=reduction;
 }
 double independent_factors=factor(1,v[2])*factor(2,v[3])*factor(3,v[4])*factor(4,v[5]);
 return minimum(independent,independent/independent_factors*wasm_exp(log_bound)*(1+1e-12));
}
static double upper(const address *roots){
 double v[8]={0},budget=0,critical_minimum=0;int has_tenacity=0;
 for(int i=0;i<root_count;i++){
  double *n=node(roots[i]);for(int stat=0;stat<8;stat++)v[stat]+=n[stat];
  has_tenacity|=(int)n[8];budget+=n[9];critical_minimum+=n[10];
 }
 double value=damage(v,has_tenacity);
 if(value<=best)return value;
 if(context[14]>0&&mitigation(v,has_tenacity)+1e-12<context[14])return -__builtin_inf();
 return budget_bound(v,critical_minimum,budget,value);
}
__attribute__((visibility("default"))) int search_abi(void){return 2;}
__attribute__((visibility("default"))) int search_cache_bytes(void){return 6*CACHE*8;}
__attribute__((visibility("default"))) int search_frame_bytes(void){return FRAMES*sizeof(Frame);}
__attribute__((visibility("default"))) void configure_search(address pointer){
 context=(double*)pointer;factors=(double*)(address)context[17];frames=(Frame*)(address)context[18];
 for(int dim=0;dim<6;dim++)for(int i=0;i<CACHE;i++)factors[dim*CACHE+i]=0;
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
__attribute__((visibility("default"))) void start_search(address pointers,int count,double threshold){
 root_count=count;best=threshold;visited=0;evaluated=0;covered=0;top=0;failure=0;
 if(count<1||count>ROOTS){failure=1;return;}
 for(int i=0;i<count;i++){frames[0].roots[i]=((address*)pointers)[i];selected[i]=0;}
 frames[0].work=1;frames[0].bound=upper(frames[0].roots);top=1;
}
__attribute__((visibility("default"))) int step_search(int limit){
 for(int processed=0;processed<limit&&top>0;processed++){
  Frame frame;top--;frame.bound=frames[top].bound;frame.work=frames[top].work;
  for(int i=0;i<root_count;i++)frame.roots[i]=frames[top].roots[i];
  if(frame.bound<=best){covered+=frame.work;continue;}
  visited++;
  int split=-1,split_count=0,leaf=1;
  for(int i=0;i<root_count;i++){
   double *n=node(frame.roots[i]);
   if(n[NODE_LENGTH]==0){leaf=0;if(n[NODE_COUNT]>split_count){split=i;split_count=(int)n[NODE_COUNT];}}
  }
  if(leaf){
   double *prefix=node(frame.roots[0]);
   for(int point=0;point<(int)prefix[NODE_LENGTH];point++){
    double v[8]={0};int has_tenacity=0;address choices[ROOTS];
    for(int i=0;i<root_count;i++){
     double *n=node(frame.roots[i]);address ptr=(address)n[NODE_POINTS]+(i==0?point*POINT_BYTES:0);choices[i]=ptr;
     double *p=(double*)ptr;for(int stat=0;stat<8;stat++)v[stat]+=p[stat];has_tenacity|=(int)p[8];
    }
    evaluated++;double value=damage(v,has_tenacity);
    if(value>best&&mitigation(v,has_tenacity)+1e-12>=context[14]){
     best=value;for(int i=0;i<root_count;i++)selected[i]=choices[i];
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
 return top==0;
}
__attribute__((visibility("default"))) double search_damage(void){return best;}
__attribute__((visibility("default"))) double search_visited(void){return visited;}
__attribute__((visibility("default"))) double search_evaluated(void){return evaluated;}
__attribute__((visibility("default"))) double search_coverage(void){return top==0?1:minimum(0.999999,covered);}
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
