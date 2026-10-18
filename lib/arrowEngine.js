// lib/arrowEngine.js — server copy of the Arrow Puzzle ENGINE (levels + replay validation).
//
// This block is copied VERBATIM from the /*ENGINE_START*/ … /*ENGINE_END*/ region of games/arrow-puzzle.html.
// Levels are deterministic (seeded), so the server can rebuild exactly the board the player saw and
// re-run their taps (`replay`) to prove a win. Do NOT edit by hand: if the engine in the game file changes,
// re-copy it (node scripts/check-arrow-engine.mjs reports any drift).
const DIRS=[{k:'U',x:0,y:-1},{k:'R',x:1,y:0},{k:'D',x:0,y:1},{k:'L',x:-1,y:0}];
function rng(s){return function(){s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const inB=(x,y,C,R)=>x>=0&&y>=0&&x<C&&y<R;
const dirIdx=(dx,dy)=>DIRS.findIndex(d=>d.x===dx&&d.y===dy);
function blockerOf(a,occ,C,R){const h=a.pts[a.pts.length-1],d=DIRS[a.d];let x=h[0]+d.x,y=h[1]+d.y;
  while(inB(x,y,C,R)){const b=occ.get(y*C+x);if(b)return b;x+=d.x;y+=d.y}return null}
function gen(C,R,seed,P){
  const r=rng(seed),rnd=n=>Math.floor(r()*n),total=C*R,asg=new Int16Array(total).fill(-1),paths=[];
  const cells=[...Array(total).keys()];for(let i=total-1;i>0;i--){const j=rnd(i+1);[cells[i],cells[j]]=[cells[j],cells[i]]}
  // 1) tile the board with short, tightly winding paths (hugging walls/paths, frequent turns)
  for(const k0 of cells){if(asg[k0]>=0)continue;
    const pid=paths.length,L=P.minL+rnd(P.maxL-P.minL+1),path=[[k0%C,Math.floor(k0/C)]];asg[k0]=pid;let dir=-1;
    while(path.length<L){const[x,y]=path[path.length-1],opts=[],w=[];
      for(let d=0;d<4;d++){const nx=x+DIRS[d].x,ny=y+DIRS[d].y;if(!inB(nx,ny,C,R)||asg[ny*C+nx]>=0)continue;
        let h=0;for(const e of DIRS){const mx=nx+e.x,my=ny+e.y;if(!inB(mx,my,C,R)||asg[my*C+mx]>=0)h++}
        opts.push(d);w.push((d!==dir?1+P.pt*3:.5)+h*P.hug)}
      if(!opts.length)break;
      let t=r()*w.reduce((a,b)=>a+b,0),i=0;while(i<w.length-1&&t>w[i]){t-=w[i];i++}
      const d=opts[i],q=[x+DIRS[d].x,y+DIRS[d].y];path.push(q);asg[q[1]*C+q[0]]=pid;dir=d}
    if(path.length>1){paths.push(path);continue}
    asg[k0]=-1; // lone cell: glue it onto a neighbouring path end if possible, else leave empty
    const[x,y]=path[0];for(const d of DIRS){const nx=x+d.x,ny=y+d.y;if(!inB(nx,ny,C,R))continue;const q=asg[ny*C+nx];if(q<0)continue;
      const pp=paths[q],e0=pp[0],e1=pp[pp.length-1];
      if(e0[0]===nx&&e0[1]===ny){pp.unshift([x,y]);asg[k0]=q;break}if(e1[0]===nx&&e1[1]===ny){pp.push([x,y]);asg[k0]=q;break}}}
  // 2) helpers: an end is a possible head; its ray must be clear of every other cell (own body included)
  const occ=new Map();paths.forEach((p,i)=>p.forEach(c=>occ.set(c[1]*C+c[0],i)));
  const end=(i,e)=>{const p=paths[i],n=p.length,h=e?p[n-1]:p[0],b=e?p[n-2]:p[1];return{h,dx:h[0]-b[0],dy:h[1]-b[1]}};
  const scan=(i,e,o)=>{const{h,dx,dy}=end(i,e);let x=h[0]+dx,y=h[1]+dy;while(inB(x,y,C,R)){const q=o.get(y*C+x);if(q!==undefined)return q;x+=dx;y+=dy}return-1};
  const clear=(i,e,o)=>scan(i,e,o)<0,selfHit=(i,e)=>scan(i,e,occ)===i;
  // 3) peel from the outside in; paths that can never get out (cyclic blockers) are deleted, leaving a few holes
  let left=new Set(paths.keys()),o2=new Map(occ);
  const drop=i=>paths[i].forEach(c=>{occ.delete(c[1]*C+c[0]);o2.delete(c[1]*C+c[0])});
  while(left.size){const rem=[...left].filter(i=>clear(i,0,o2)||clear(i,1,o2));
    if(!rem.length){const v=[...left],k=v[rnd(v.length)];left.delete(k);drop(k);continue}
    rem.forEach(i=>{left.delete(i);paths[i].forEach(c=>o2.delete(c[1]*C+c[0]))})}
  const ids=paths.map((_,i)=>i).filter(i=>paths[i].some(c=>occ.get(c[1]*C+c[0])===i));
  // 4) heads: prefer the end that is blocked at the start (few free arrows), then repair only where the run would deadlock
  const ori=new Map();
  for(const i of ids){const v=[0,1].filter(e=>!selfHit(i,e)),b=v.filter(e=>!clear(i,e,occ));ori.set(i,(b.length?b:v)[rnd((b.length?b:v).length)])}
  const o3=new Map(occ),l3=new Set(ids);
  while(l3.size){const f=[...l3].filter(i=>clear(i,ori.get(i),o3));
    if(!f.length){const c=[...l3].filter(i=>{const e=1-ori.get(i);return!selfHit(i,e)&&clear(i,e,o3)});if(!c.length)return null;const k=c[rnd(c.length)];ori.set(k,1-ori.get(k));continue}
    f.forEach(i=>{l3.delete(i);paths[i].forEach(c=>o3.delete(c[1]*C+c[0]))})}
  return ids.map((pid,id)=>{const pts=ori.get(pid)?paths[pid]:paths[pid].slice().reverse(),n=pts.length;
    return{id,pts,d:dirIdx(pts[n-1][0]-pts[n-2][0],pts[n-1][1]-pts[n-2][1]),cells:pts.map(p=>p[1]*C+p[0])}})}
function solve(arrows,C,R){ // greedy is exact: removing a path can only unblock others
  const occ=new Map(),gone=new Set();arrows.forEach(a=>a.cells.forEach(k=>occ.set(k,a)));let rounds=0,free0=0;const order=[];
  while(gone.size<arrows.length){const free=arrows.filter(a=>!gone.has(a.id)&&!blockerOf(a,occ,C,R));
    if(!free.length)return{ok:false,order,rounds,free0};if(!rounds)free0=free.length;
    free.forEach(a=>{a.cells.forEach(k=>occ.delete(k));gone.add(a.id);order.push(a.id)});rounds++}
  return{ok:true,order,rounds,free0}}
// 100 levels: the board grows 6x9 -> 13x19, paths stay short (3-9 cells) but wind harder (zigzags, U-bends, hugging neighbours),
// and later levels pick the sampled board with the deepest blocking chains and the fewest paths free at the start.
const LEVELS_DEF=Array.from({length:100},(_,i)=>{const n=i+1,t=(n-1)/99,c=6+Math.round(t*7);
  return{c,r:Math.min(19,Math.round(c*1.4)+(n%2)),minL:3,maxL:6+Math.round(t*3),pt:.5+t*.4,hug:.6+t*1.6,N:24+Math.round(t*56),s:n*1000003+101}});
const _cache={};
function buildLevel(n){ // n = 1..100, deterministic; best of N sampled boards, every one re-solved before it can be used
  if(_cache[n])return _cache[n];const L=LEVELS_DEF[n-1],t=(n-1)/99;let best=null;
  for(let i=0;i<L.N;i++){const arrows=gen(L.c,L.r,L.s+i*7919,L);if(!arrows||arrows.length<4)continue;
    const sv=solve(arrows,L.c,L.r);if(!sv.ok||sv.order.length!==arrows.length)continue;
    const cells=arrows.reduce((a,b)=>a+b.cells.length,0),cover=cells/(L.c*L.r),score=cover*30+sv.rounds*(.3+t*3.7)-sv.free0*(.3+t*6);
    if(!best||score>best.score)best={cols:L.c,rows:L.r,arrows,rounds:sv.rounds,free0:sv.free0,cover,score}}
  if(!best)throw new Error('Level '+n+' failed validation');
  return _cache[n]=best}
function replay(n,moves){ // server-side verification: moves = ordered arrow ids tapped
  const lv=buildLevel(n),occ=new Map(),byId=new Map(lv.arrows.map(a=>[a.id,a])),done=new Set();let mistakes=0;
  lv.arrows.forEach(a=>a.cells.forEach(k=>occ.set(k,a)));
  for(const id of moves){const a=byId.get(id);if(!a||done.has(id))return{valid:false};
    if(blockerOf(a,occ,lv.cols,lv.rows))mistakes++;else{a.cells.forEach(k=>occ.delete(k));done.add(id)}}
  return{valid:true,cleared:done.size===lv.arrows.length,mistakes}}
export { buildLevel, solve, replay, blockerOf, LEVELS_DEF };
