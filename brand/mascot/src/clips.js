/* ================= the moves: pure functions of time, so any frame can be shown, scrubbed or stepped =================
   A clip fills a pose b (from base()) for time t; BatView.pose(b) shows it. World units: K per head-and-body length, y up. */
const D=NETOPYR;
const K=54;                        // world units per head-and-body length: the stage's scale, so the rig's screen-sized details keep their size
const FEET=Math.abs(D.feet[0])*K;  // branch to body origin when hanging
const PERCH_Y=30;                  // the branch sits so a hanging bat is centred like a flying one
const qY=a=>qa([0,1,0],a),qZ=a=>qa([0,0,1],a),qX=a=>qa([1,0,0],a);
// orientations: flying (yaw, pitch, roll), hanging (swing), upright (turn)
const qF=(yaw,pitch,roll)=>qm(qm(qY(-yaw),qZ(pitch)),qX(roll)),qH=sw=>qm(qZ(sw),Q_HANG),qU=a=>qm(qZ(a),Q_UP);

/* ---------- one pose: the fields BatView reads ---------- */
function base(){return{mode:'fly',k:K,x:0,y:0,z:0,jx:0,jy:0,bobY:0,q:qF(Math.PI/2,0,0),phi:D.glidePhi,o:1,open:1,flap:0,ph:0,ampK:1,hang:0,wr:0,cl:0,ear:1,
  wo:[0,0],wphi:[0,0],hyaw:0,hpitch:0,hpAdd:0,blink:0,perch:false,get blinkAmt(){return this.blink}}}
const at=(b,X,Y,Z)=>{b.x=X;b.y=-Y;b.z=Z||0}; // world position, y up (BatView takes the stage's y down)
// the wing beat exactly as the behaviour code makes it
function beat(b,ph,f,open,ampK){const s=Math.sin(ph),c=Math.cos(ph);b.ph=ph;b.flap=f;b.open=open;b.ampK=ampK;
  b.phi=(D.amp*ampK*s+D.phiBias)*f+D.glidePhi*(1-f);b.o=clamp(open*(1-D.flex*Math.max(0,c)*f),0,1);b.bobY=D.bob*K*s*f}
// beat phase while the flapping fades in or out: integrated from the clip start, so it is the same on every visit
function phase(t,fa){let ph=0;const h=1/240;for(let s=0;s<t;s+=h){const d=Math.min(h,t-s);ph+=TAU*D.flapF*d*Math.max(.05,fa(s+d/2))}return ph}
const pulse=(t,t0,d)=>{const p=(t-t0)/d;return p>0&&p<1?1-Math.abs(2*p-1):0};
const blinks=(t,ts)=>ts.reduce((m,t0)=>Math.max(m,pulse(t,t0,D.blinkDur)),0);
// keys [t,a,b…], eased between neighbours
function keyed(t,ks){if(t<=ks[0][0])return ks[0].slice(1);for(let i=1;i<ks.length;i++)if(t<=ks[i][0]){const a=ks[i-1],c=ks[i],u=sm((t-a[0])/((c[0]-a[0])||1));return a.slice(1).map((v,j)=>lerp(v,c[j+1],u))}return ks[ks.length-1].slice(1)}
// hanging: a damped pendulum (the stage's constants) driven by kicks [t,v]; feet on the branch at x
const PEND=(()=>{const w2=900/Math.max(4,FEET)*D.gMul,c=D.damp;return{c,wd:Math.sqrt(Math.max(.01,w2-c*c/4))}})();
function swingAt(t,kicks){let s=0;for(const [t0,v] of kicks){const u=t-t0;if(u>0)s+=v/PEND.wd*Math.exp(-PEND.c*u/2)*Math.sin(PEND.wd*u)}return s}
function hangAt(b,sw,px){b.q=qH(sw);const f=mv(qmat(b.q),D.feet);at(b,px-f[0]*K,PERCH_Y-f[1]*K,-f[2]*K);
  Object.assign(b,{mode:'perch',o:0,open:0,flap:0,phi:D.foldPhi,hang:1,wr:1,cl:0,bobY:0,perch:true})}
const HANG0=(()=>{const f=mv(qmat(qH(0)),D.feet);return[-f[0]*K,PERCH_Y-f[1]*K,-f[2]*K]})(); // body origin hanging still at x 0
const dirYaw=v=>Math.atan2(v[2],v[0]),dirPitch=v=>Math.atan2(v[1],Math.hypot(v[0],v[2]));

/* ---------- the clips ---------- */
const FWD=Math.PI/2; // nose toward the default camera
const CLIPS=[
  {id:'fly',name:'Полёт',dur:2,fn(t,b){const w=TAU/2;beat(b,TAU*D.flapF*t,1,1,1);
    // a pipistrelle never flies straight: heading and height jitter, every wobble repeats inside the loop
    const yaw=FWD+.5+.16*Math.sin(2*w*t+.4)+.06*Math.sin(5*w*t+1.3),pitch=.06*Math.sin(3*w*t+2)+.035*Math.sin(b.ph),roll=.1*Math.sin(2*w*t+1.6)+.04*Math.sin(7*w*t);
    b.q=qF(yaw,pitch,roll);at(b,7*Math.sin(2*w*t+.4),5*Math.sin(3*w*t),4*Math.sin(w*t));b.hpitch=-.03*Math.sin(b.ph);b.blink=blinks(t,[1.25])}},
  {id:'hover',name:'Зависает',dur:2,fn(t,b){const w=TAU/2;beat(b,TAU*D.flapF*t,1,1,1.08);
    // body upright, head level: it hangs in the air in front of you
    b.q=qF(FWD+.1*Math.sin(w*t),.95+.05*Math.sin(b.ph),.05*Math.sin(2*w*t+1));at(b,3*Math.sin(w*t),3*Math.sin(2*w*t+.5),0);b.hpitch=-.85;b.blink=blinks(t,[.7])}},
  {id:'glide',name:'Планирует',dur:4,fn(t,b){const w=TAU/4,fa=s=>sm((s-2.5)/.06)*(1-sm((s-2.84)/.08));
    // three quick beats in the middle of a glide; between them the wings only give a little in the air
    beat(b,phase(t,fa),fa(t),1,1);b.phi+=(.05*Math.sin(w*t)+.03*Math.sin(3*w*t+1))*(1-b.flap);
    b.q=qF(FWD+.5+.12*Math.sin(w*t),-.06+.04*Math.sin(2*w*t),.16*Math.sin(w*t+.6));at(b,10*Math.sin(w*t),8*Math.sin(2*w*t+.3),0);b.blink=blinks(t,[1.1,3.4])}},
  {id:'hang',name:'Висит',dur:6,perch:true,fn(t,b){
    // shuffles along the branch (three steps right, three back), looks around, blinks; each step sets it swinging
    const st=[[1.6,1],[1.8,1],[2,1],[3.9,-1],[4.1,-1],[4.3,-1]],L=14;let px=-L*1.5;for(const [t0,d] of st)px+=d*L*sm((t-t0)/.12);
    const kicks=[];for(const [t0,d] of st)kicks.push([t0,-d*.9],[t0-6,-d*.9]);
    hangAt(b,swingAt(t,kicks),px);
    const h=keyed(t,[[0,0,-1],[.6,0,-1],[1.1,.5,-.8],[1.5,.5,-.8],[2.4,0,-.9],[2.8,0,-1.35],[3.6,0,-1.35],[4.6,-.55,-.9],[5.4,-.55,-.9],[6,0,-1]]);
    b.hyaw=h[0];b.hpitch=h[1];b.blink=blinks(t,[.9,3.3,5.45]);b.ear=1-.4*pulse(t,3,.3)}},
  {id:'land',name:'Посадка',dur:3,perch:true,fn(t,b){
    // flies in from the left, pulls up, turns over and catches the branch with its feet, then swings to rest
    const TA=.85,TL=D.landTime,O=HANG0,P0=[O[0]-300,O[1]-150,-70],P1=[O[0]-40,O[1]-80,0],V=[P1[0]-P0[0],P1[1]-P0[1],P1[2]-P0[2]];
    const yaw=dirYaw(V),pitch=dirPitch(V)*.6,q0=qF(yaw,pitch,0),fa=s=>s<TA?1:1-sm((s-TA)/TL/.5);
    if(t<TA){const u=t/TA,e=.3*u+.7*(1-(1-u)*(1-u));beat(b,TAU*D.flapF*t,1,1,1);b.q=qF(yaw,pitch+.03*Math.sin(b.ph),.06*Math.sin(TAU*t/TA));
      at(b,lerp(P0[0],P1[0],e),lerp(P0[1],P1[1],e),lerp(P0[2],P1[2],e));return}
    const p=clamp((t-TA)/TL,0,1);
    if(p<1){beat(b,phase(t,fa),1-sm(p/.5),1-sm(p/.7),1);b.phi=lerp(b.phi,D.foldPhi,sm((p-.3)/.7));b.hang=sm(p);b.wr=sm((p-.55)/.45);
      b.q=p<.4?qslerp(q0,qU(0),sm(p/.4)):qU(-Math.PI*sm((p-.4)/.6));const s=sm(p);at(b,lerp(P1[0],O[0],s),lerp(P1[1],O[1],s),lerp(P1[2],O[2],s));return}
    hangAt(b,swingAt(t,[[TA+TL,-D.landSwing]]),0);const h=keyed(t,[[TA+TL,0,-.6],[2,0,-.6],[2.4,.15,-1.3]]);b.hyaw=h[0];b.hpitch=h[1];b.blink=blinks(t,[2.55])}},
  {id:'takeoff',name:'Взлёт',dur:2.4,perch:true,fn(t,b){
    // lets go, drops, opens the wings on the way down and flies off up and to the right
    const T0=.7,TD=D.dropTime,G=D.dropG,O=HANG0,vx=14,qT=qF(D.yawSide,-.45,0);
    if(t<T0){hangAt(b,0,0);const h=keyed(t,[[0,0,-1.3],[.35,0,-1.3],[.62,.25,-.5]]);b.hyaw=h[0];b.hpitch=h[1];b.blink=blinks(t,[.22]);return}
    const fa=s=>s<T0?0:sm(((s-T0)/TD-.3)/.7),ph=phase(t,fa),tau=Math.min(t-T0,TD),p=tau/TD,PD=[O[0]+vx*tau,O[1]-.5*G*tau*tau,O[2]];
    if(t<T0+TD){beat(b,ph,sm((p-.3)/.7),sm((p-.12)/.6),1);b.hang=1-sm(p/.5);b.wr=Math.exp(-14*tau);b.q=qslerp(qH(0),qT,sm(p*1.1));at(b,PD[0],PD[1],PD[2]);return}
    // after the drop: steer toward the exit with the bat's own acceleration, nose along the flight
    const u=t-T0-TD,a=D.accel*1.5,vD=[vx,-G*TD,0],dir=nrm([.6,.7,.38]),vT=dir.map(c=>c*D.speed),e=Math.exp(-a*u),v=vT.map((c,i)=>c+(vD[i]-c)*e);
    const P=vT.map((c,i)=>PD[i]+c*u+(vD[i]-c)*(1-e)/a);beat(b,ph,1,1,1);b.q=qslerp(qT,qF(dirYaw(v),clamp(dirPitch(v),-.7,.7)*.7,-.12),sm(u/.25));at(b,P[0],P[1],P[2])}},
  {id:'ava',name:'Как на аве',dur:4,fn(t,b){const w=TAU/4;
    // the avatar's frame: coming at you at the top of the stroke, wings up and open, eyes on you
    b.q=qm(qX(.45),Q_UP);Object.assign(b,{flap:0,phi:.95+.025*Math.sin(w*t),o:1,open:1,hpitch:-.8});at(b,0,3*Math.sin(w*t),0);b.blink=blinks(t,[1.6]);b.ear=1-.35*pulse(t,2.9,.3)}},
  {id:'spread',name:'Крылья раскрыты',dur:4,fn(t,b){b.q=qF(FWD,0,0);Object.assign(b,{flap:0,phi:0,o:1,open:1});b.blink=blinks(t,[2.2])}}];
