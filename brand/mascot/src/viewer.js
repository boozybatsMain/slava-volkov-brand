/* ================= the viewer: one pipistrelle on a turntable, its moves as clips you can scrub ================= */
const FPS=60,STR=.4;               // timeline frames per second; the glow knob of the mascot (quiet stars, cold eyes)
const GROUND_Y=-150;               // the floor that takes the shadow
const VIEW=[0,0,1];                // unit direction from the bat toward the camera, for the eye trails
// small helpers only the page needs
const appr=(v,t,k,dt)=>v+(t-v)*(1-Math.exp(-k*dt));
const now=()=>performance.now();
const coarse=matchMedia('(pointer: coarse)').matches;
function mulberry(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

/* ---------- renderer, camera, light ---------- */
const app=document.getElementById('app'),cv=document.getElementById('gl');
let R=null;try{R=new THREE.WebGLRenderer({canvas:cv,antialias:false,powerPreference:'high-performance'});if(!R.capabilities.isWebGL2)throw 0}catch(_){R=null}
if(!R){document.getElementById('nogl').hidden=false;throw new Error('WebGL 2 is not available')}
R.toneMapping=THREE.NeutralToneMapping;R.outputColorSpace=THREE.SRGBColorSpace;R.shadowMap.enabled=true;R.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene(),cam=new THREE.PerspectiveCamera(28,1,4,6000);
const pmg=new THREE.PMREMGenerator(R),ENV=pmg.fromScene(new RoomEnvironment(),.04).texture;pmg.dispose();
const hemi=new THREE.HemisphereLight('#fff','#000',1),keyL=new THREE.DirectionalLight('#fff',1),fillL=new THREE.DirectionalLight('#fff',1);
keyL.castShadow=true;keyL.shadow.mapSize.set(2048,2048);keyL.shadow.bias=-.0004;keyL.shadow.radius=4;
{const sc=keyL.shadow.camera;sc.left=-300;sc.right=300;sc.top=300;sc.bottom=-300;sc.near=300;sc.far=3200;sc.updateProjectionMatrix()}
scene.add(hemi,keyL,keyL.target,fillL,fillL.target);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(5000,5000),new THREE.ShadowMaterial({opacity:.3}));ground.rotation.x=-Math.PI/2;ground.position.y=GROUND_Y;ground.receiveShadow=true;scene.add(ground);
// the branch: a tapered twig, thin end to the left, bowing away from where the feet hold it
const branch=(()=>{const g=new THREE.CylinderGeometry(1.9,4.2,720,14,120,false);g.rotateZ(Math.PI/2);const p=g.attributes.position,col=new Float32Array(p.count*3),c=new THREE.Color(),rn=mulberry(11);
  for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),a=Math.atan2(z,y),bark=1+.07*Math.sin(x*.9+a*3)+.05*Math.sin(x*2.3-a*5)+.12*Math.exp(-((x-140)**2)/60)+.1*Math.exp(-((x+190)**2)/40);
    p.setXYZ(i,x,y*bark+6*sm((Math.abs(x)-50)/260),z*bark);
    c.set('#4a3528').multiplyScalar(.7+.2*Math.sin(x*.21+3*Math.sin(x*.05))+.12*Math.sin(x*1.7+a*4)+.1*rn());col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b}
  g.setAttribute('color',new THREE.BufferAttribute(col,3));g.computeVertexNormals();
  const m=new THREE.Mesh(g,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.9,envMap:ENV,envMapIntensity:.35}));m.castShadow=true;m.position.y=PERCH_Y+3.35;m.visible=false;scene.add(m);return m})();
const comp=new EffectComposer(R,new THREE.WebGLRenderTarget(4,4,{type:THREE.HalfFloatType,samples:4}));comp.addPass(new RenderPass(scene,cam));
// one NaN or Inf from any shader spreads through the bloom mips as black boxes on Apple GPUs: zero it before the bloom
comp.addPass(new ShaderPass({uniforms:{tDiffuse:{value:null}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:'uniform sampler2D tDiffuse;varying vec2 vUv;void main(){vec4 c=texture2D(tDiffuse,vUv);if(any(isnan(c))||any(isinf(c)))c=vec4(0.);gl_FragColor=vec4(clamp(c.rgb,0.,48.),clamp(c.a,0.,1.));}'}));
const bloom=new UnrealBloomPass(new THREE.Vector2(4,4),.62,.42,1);comp.addPass(bloom);comp.addPass(new OutputPass());
// the bat itself: 24 fur shells, fine fur, starry wings and cold eyes at the mascot's glow
const view=new BatView(NETOPYR,{shadow:true,env:ENV,shells:24,glow:STR});scene.add(view.g,view.fxg);

/* ---------- backdrops: each with its own light ---------- */
const SKY_JPG='{{SKY}}';
const LOOKS={
  studio:{grad:['#7d8085','#46494e'],hemi:['#ececee','#5e5e62',1.2],key:['#ffffff',2.3,[-.45,1,.35]],fill:['#ffffff',.9,[.45,.2,1]],sheen:[.1,.1,.1],shadow:.32},
  sky:{img:true,hemi:['#a9c4ff','#d9a882',.9],key:['#ffe0bf',3.2,[-.55,.65,.55]],fill:['#fff0dc',1.4,[.7,.3,-.6]],sheen:[.06,.06,.07],shadow:0},
  night:{grad:['#0f1726','#04060b'],glow:'#3a5788',hemi:['#3a4870','#16120f',1.15],key:['#aebfe8',1.6,[-.35,1,-.6]],fill:['#7e90c4',.55,[.3,.3,1]],sheen:[.035,.04,.06],shadow:.22}};
// a vertical gradient; the night one also gets a pale moonlit haze behind the bat, so its dark wings still read
function gradTex(L){const c=document.createElement('canvas');c.width=c.height=512;const x=c.getContext('2d'),g=x.createLinearGradient(0,0,0,512);g.addColorStop(0,L.grad[0]);g.addColorStop(1,L.grad[1]);x.fillStyle=g;x.fillRect(0,0,512,512);
  if(L.glow){const r=x.createRadialGradient(256,240,0,256,240,300);r.addColorStop(0,L.glow);r.addColorStop(.45,L.glow+'66');r.addColorStop(1,L.glow+'00');x.fillStyle=r;x.fillRect(0,0,512,512)}
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t}
const BG={studio:gradTex(LOOKS.studio),night:gradTex(LOOKS.night),sky:new THREE.Texture()};
BG.sky.colorSpace=THREE.SRGBColorSpace;{const im=new Image();im.onload=()=>{BG.sky.image=im;BG.sky.needsUpdate=true;cover()};im.src=SKY_JPG}
function cover(){const t=BG.sky,im=t.image;if(!im||!im.width)return;const a=CW/CH,ia=im.width/im.height;
  if(a>ia){t.repeat.set(1,ia/a);t.offset.set(0,(1-ia/a)/2)}else{t.repeat.set(a/ia,1);t.offset.set((1-a/ia)/2,0)}}
let lookKey='studio';
function setLook(k){if(!LOOKS[k])return;lookKey=k;const L=LOOKS[k];scene.background=BG[k];
  hemi.color.set(L.hemi[0]);hemi.groundColor.set(L.hemi[1]);hemi.intensity=L.hemi[2];
  for(const [l,d] of[[keyL,L.key],[fillL,L.fill]]){l.color.set(d[0]);l.intensity=d[1];const n=Math.hypot(...d[2]);l.position.set(d[2][0]/n*1600,d[2][1]/n*1600,d[2][2]/n*1600);l.target.position.set(0,0,0)}
  ground.visible=L.shadow>0;ground.material.opacity=L.shadow;view.mFur.userData.u.uSheen.value.setRGB(...L.sheen);
  document.querySelectorAll('[data-bg]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.bg===k?'true':'false'));store('bat-viewer-bg',k)}
function store(k,v){try{localStorage.setItem(k,v)}catch(_){}}
function load(k){try{return localStorage.getItem(k)}catch(_){return null}}

/* ---------- camera: orbit, zoom to the cursor, pan; double click sets the centre ---------- */
const ctl=new OrbitControls(cam,cv);Object.assign(ctl,{enableDamping:true,dampingFactor:.08,rotateSpeed:.85,zoomSpeed:1.1,panSpeed:.9,zoomToCursor:true,screenSpacePanning:true,minDistance:60,maxDistance:2400,autoRotateSpeed:1.4});
// each clip's own view: azimuth and elevation in degrees, and the box (world units) it frames around the bat
const HOME={az:28,el:9,w:200,h:150,y:0},HOMES={hover:{az:15,el:4,w:250},glide:{az:35,el:20},hang:{az:20,el:2,w:150,h:115},land:{az:20,el:4},takeoff:{az:25,el:6},ava:{az:0,el:0},spread:{az:20,el:42,w:270}};
const FREE={x:0,y:0,w:1,h:1}; // the part of the window the controls leave open: the bat is framed in it
function homeDist(H){const k=CH/(2*Math.tan(cam.fov*DEG/2)),fw=cam.aspect<1?.88:.75;return Math.max(H.w*k/(fw*FREE.w),H.h*k/(.86*FREE.h))}
let focus=null,tw=null,userCam=false,quiet=false,camMoved=-1e9,touched=false;const ray=new THREE.Raycaster(),ndc=new THREE.Vector2(),_cs=new THREE.Spherical(),_cv=new THREE.Vector3();
// spend what is left of a throw at once, so the camera stands still where it is put
function settle(){const d=ctl.enableDamping;quiet=true;ctl.enableDamping=false;ctl.update();ctl.enableDamping=d;quiet=false}
// back to the clip's own view, at once or gliding there for dur seconds
function resetView(dur){const H=Object.assign({},HOME,HOMES[clip.id]),r=homeDist(H),th=H.az*DEG,ph=Math.PI/2-H.el*DEG,t=new THREE.Vector3(0,H.y,0);
  focus=null;userCam=false;settle();
  if(!dur){tw=null;ctl.target.copy(t);cam.position.setFromSphericalCoords(r,ph,th).add(t);settle();return}
  _cs.setFromVector3(_cv.copy(cam.position).sub(ctl.target));
  tw={u:0,dur,t0:ctl.target.clone(),t1:t,r0:_cs.radius,r1:r,th0:_cs.theta,dth:Math.atan2(Math.sin(th-_cs.theta),Math.cos(th-_cs.theta)),ph0:_cs.phi,ph1:ph}}
// once you move the camera yourself it stays yours: switching clips no longer moves it, «Вид» gives it back
ctl.addEventListener('start',()=>{camMoved=now();focus=null;tw=null;userCam=true;if(!touched){touched=true;setTimeout(()=>hintEl.classList.add('dim'),5000)}});
ctl.addEventListener('change',()=>{if(!quiet&&!tw)camMoved=now()});
cv.addEventListener('pointerdown',()=>cv.classList.add('drag'));for(const ev of['pointerup','pointercancel','pointerleave'])cv.addEventListener(ev,()=>cv.classList.remove('drag'));
cv.addEventListener('dblclick',e=>{const r=cv.getBoundingClientRect();ndc.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(ndc,cam);
  view.memG.boundingSphere=null;const hit=ray.intersectObjects([view.mem,view.body,view.head],false)[0];focus={from:ctl.target.clone(),to:hit?hit.point.clone():new THREE.Vector3(),t:0};tw=null;userCam=true});

/* ---------- playback ---------- */
let clip=CLIPS[0],T=0,playing=true,speed=1,loop=true,follow=true,clock=0,scrubbing=false,wasPlaying=false;
const gz={w:0,y:0,p:0};
const N=()=>Math.round(clip.dur*FPS),frameOf=()=>Math.min(N()-1,Math.floor(T*FPS+1e-6));
// the head turns to the camera while you move it (the pipistrelle is curious), then goes back to what the clip does
function gaze(b,dt){if(dt>0){const m=qmat(b.q),hw=mv(m,[D.neck[0]+D.head.c[0],D.neck[1]+D.head.c[1],0]),
    d=mtv(m,[cam.position.x-(b.x+hw[0]*K),cam.position.y-(-(b.y+b.bobY)+hw[1]*K),cam.position.z-(b.z+hw[2]*K)]),L=D.headLim;
  const on=follow&&now()-camMoved<2600;gz.w=appr(gz.w,on?1:0,on?6:1.6,dt);
  gz.y=appr(gz.y,clamp(Math.atan2(d[2],d[0]),-L[0],L[0]),12,dt);gz.p=appr(gz.p,clamp(Math.atan2(d[1],Math.hypot(d[0],d[2])),-L[1],L[2]),12,dt)}
  b.hyaw=lerp(b.hyaw,gz.y,gz.w);b.hpitch=lerp(b.hpitch,gz.p,gz.w)}
const sph=new THREE.Spherical(),_d=new THREE.Vector3();
function draw(dt){const b=base();clip.fn(Math.min(T,clip.dur-1e-6),b);gaze(b,dt);
  view.pose(b);branch.visible=!!clip.perch;
  _d.copy(cam.position).sub(ctl.target);const dist=_d.length();_d.multiplyScalar(1/(dist||1));VIEW[0]=_d.x;VIEW[1]=_d.y;VIEW[2]=_d.z;
  view.tick(dt,2*dist*Math.tan(cam.fov*DEG/2)/CH,VIEW);
  // the stars are a window into the sky: going round the bat slides it
  sph.setFromVector3(_d);view.mMem.userData.u.uSky.value.set(sph.theta*420,(Math.PI/2-sph.phi)*420);
  comp.render()}
let last=now();
function frame(){const tn=now(),dtR=Math.min(.05,(tn-last)/1000);last=tn;let dt=0;
  if(playing&&!scrubbing){dt=dtR*speed;T+=dt;if(T>=clip.dur){if(loop){T%=clip.dur;view.clearFx()}else{T=clip.dur;setPlaying(false)}}}
  clock+=dt;TIME.value=clock;
  if(focus){focus.t=Math.min(1,focus.t+dtR/.35);const p=focus.from.clone().lerp(focus.to,sm(focus.t)),dv=p.sub(ctl.target);ctl.target.add(dv);cam.position.add(dv);if(focus.t>=1)focus=null}
  let landed=false;
  if(tw){tw.u=Math.min(1,tw.u+dtR/tw.dur);const e=sm(tw.u);ctl.target.lerpVectors(tw.t0,tw.t1,e);
    cam.position.setFromSphericalCoords(tw.r0*Math.pow(tw.r1/tw.r0,e),lerp(tw.ph0,tw.ph1,e),tw.th0+tw.dth*e).add(ctl.target);cam.lookAt(ctl.target);landed=tw.u>=1}
  ctl.update(dtR);if(landed)tw=null;draw(dt);ui();requestAnimationFrame(frame)}

/* ---------- controls ---------- */
const listEl=document.getElementById('clipList'),bar=document.getElementById('bar'),frameLab=document.getElementById('frameLab'),playBtn=document.getElementById('playBtn'),playIco=document.getElementById('playIco'),
  loopBtn=document.getElementById('loopBtn'),followBtn=document.getElementById('followBtn'),spinBtn=document.getElementById('spinBtn'),hintEl=document.getElementById('hint');
const fmt=(v,n)=>v.toFixed(n).replace('.',',');
CLIPS.forEach((c,i)=>{const el=document.createElement('button');el.type='button';el.className='btn clip';el.setAttribute('aria-pressed','false');el.title=c.name+' ('+(i+1)+')';
  el.innerHTML='<span class="k">'+(i+1)+'</span><span></span><span class="d">'+fmt(c.dur,1)+' с</span>';el.children[1].textContent=c.name;el.addEventListener('click',()=>setClip(i));listEl.appendChild(el);c.el=el});
function setClip(i){const c=CLIPS[i];if(!c)return;clip=c;T=0;view.clearFx();CLIPS.forEach(k=>k.el.setAttribute('aria-pressed',k===c?'true':'false'));
  bar.max=String(N()-1);if(!playing)setPlaying(true);store('bat-viewer-clip',c.id);if(!userCam)resetView(.7);if(c.el.scrollIntoView&&matchMedia('(max-width:760px)').matches)c.el.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'})}
function setPlaying(v){playing=v;if(v&&T>=clip.dur)T=0;playBtn.setAttribute('aria-label',v?'Пауза':'Играть');playBtn.title=v?'Пауза (пробел)':'Играть (пробел)';
  playIco.innerHTML=v?'<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/>':'<path d="M4.5 2.2 13.5 8l-9 5.8z"/>'}
function step(n){setPlaying(false);const M=N(),f=frameOf()+n;T=(loop?((f%M)+M)%M:clamp(f,0,M-1))/FPS;view.clearFx()}
function setSpeed(v){speed=v;document.querySelectorAll('[data-sp]').forEach(b=>b.setAttribute('aria-pressed',+b.dataset.sp===v?'true':'false'))}
const SPEEDS=[.1,.25,.5,1];function speedStep(d){const i=SPEEDS.indexOf(speed);setSpeed(SPEEDS[clamp((i<0?3:i)+d,0,3)])}
function setLoop(v){loop=v;loopBtn.setAttribute('aria-pressed',v?'true':'false')}
function setFollow(v){follow=v;followBtn.setAttribute('aria-pressed',v?'true':'false')}
function setSpin(v){ctl.autoRotate=v;spinBtn.setAttribute('aria-pressed',v?'true':'false')}
function cycleLook(){const ks=Object.keys(LOOKS);setLook(ks[(ks.indexOf(lookKey)+1)%ks.length])}
let shown=-1;
function ui(){const f=frameOf(),M=N();if(!scrubbing&&+bar.value!==f)bar.value=String(f);bar.style.setProperty('--p',(M>1?f/(M-1)*100:0)+'%');
  const key=f*1000+M;if(key!==shown){shown=key;frameLab.innerHTML='кадр <b>'+(f+1)+'</b> / '+M+' · '+fmt(f/FPS,2)+' с';bar.setAttribute('aria-valuetext','кадр '+(f+1)+' из '+M)}}
playBtn.addEventListener('click',()=>setPlaying(!playing));
document.getElementById('prevBtn').addEventListener('click',()=>step(-1));document.getElementById('nextBtn').addEventListener('click',()=>step(1));
loopBtn.addEventListener('click',()=>setLoop(!loop));followBtn.addEventListener('click',()=>setFollow(!follow));spinBtn.addEventListener('click',()=>setSpin(!ctl.autoRotate));
document.getElementById('resetBtn').addEventListener('click',()=>resetView(.6));
document.querySelectorAll('[data-sp]').forEach(b=>b.addEventListener('click',()=>setSpeed(+b.dataset.sp)));
document.querySelectorAll('[data-bg]').forEach(b=>b.addEventListener('click',()=>setLook(b.dataset.bg)));
// the timeline: dragging holds the clip on that frame, letting go plays on if it was playing
bar.addEventListener('pointerdown',()=>{if(!scrubbing){scrubbing=true;wasPlaying=playing}});
bar.addEventListener('input',()=>{if(!scrubbing){wasPlaying=false;setPlaying(false)}T=+bar.value/FPS;view.clearFx()});
const endScrub=()=>{if(scrubbing){scrubbing=false;setPlaying(wasPlaying)}};bar.addEventListener('pointerup',endScrub);bar.addEventListener('pointercancel',endScrub);bar.addEventListener('change',endScrub);
addEventListener('keydown',e=>{if(e.metaKey||e.ctrlKey||e.altKey)return;const k=e.key,tg=e.target,l=k.length===1?k.toLowerCase():k;
  if(k===' '){e.preventDefault();setPlaying(!playing);return}
  if(tg&&tg.type==='range'&&(k==='ArrowLeft'||k==='ArrowRight'))return; // the timeline steps by itself
  if(k==='ArrowLeft'||k==='ArrowRight'){e.preventDefault();step((k==='ArrowRight'?1:-1)*(e.shiftKey?10:1));return}
  if(k>='1'&&k<='9'){setClip(+k-1);return}
  if(l==='r'||l==='к')resetView(.6);else if(l==='g'||l==='п')setFollow(!follow);else if(l==='a'||l==='ф')setSpin(!ctl.autoRotate);else if(l==='l'||l==='д')setLoop(!loop);
  else if(l==='b'||l==='и')cycleLook();else if(l==='['||l==='х')speedStep(-1);else if(l===']'||l==='ъ')speedStep(1)});
// space on a focused button would press it again
addEventListener('keyup',e=>{if(e.key===' '&&e.target&&e.target.tagName==='BUTTON')e.preventDefault()});
if(coarse)hintEl.textContent='палец — вращать · два пальца — ближе и сдвиг · двойной тап — центр сюда';

/* ---------- size ---------- */
let CW=1,CH=1;
function layout(){const r=app.getBoundingClientRect();CW=Math.max(1,r.width);CH=Math.max(1,r.height);const pr=Math.min(Math.min(2,devicePixelRatio||1),Math.sqrt(3.6e6/(CW*CH)));
  PXU.value=pr;R.setPixelRatio(pr);R.setSize(CW,CH,false);comp.setPixelRatio(pr);comp.setSize(CW,CH);bloom.resolution.set(CW*pr,CH*pr);
  // the free part: below the name and tools, above the transport (and the clip strip on phones), right of the clip list on wide screens
  const q=s=>document.querySelector(s).getBoundingClientRect(),phone=matchMedia('(max-width:760px)').matches,top=Math.max(q('.cap').bottom,q('.tools').bottom)-r.top+8,
    bot=q(phone?'.dock':'.transport').top-r.top-8,left=phone?0:q('.clips').right-r.left+8;
  Object.assign(FREE,{x:left,y:top,w:Math.max(80,CW-left),h:Math.max(80,bot-top)});
  // the camera's centre goes to the middle of the free part
  cam.setViewOffset(CW,CH,CW/2-(FREE.x+FREE.w/2),CH/2-(FREE.y+FREE.h/2),CW,CH);cover();if(!userCam)resetView(0)}

/* ---------- boot ---------- */
setLook(LOOKS[load('bat-viewer-bg')]?load('bat-viewer-bg'):'studio');
{const id=load('bat-viewer-clip'),i=CLIPS.findIndex(c=>c.id===id);setClip(i<0?0:i)}
layout();resetView(0);new ResizeObserver(()=>layout()).observe(app);if(document.fonts)document.fonts.ready.then(()=>layout());
setPlaying(true);setSpeed(1);requestAnimationFrame(frame);
window.__viewer={CLIPS,FREE,HOMES,get userCam(){return userCam},get tw(){return tw},get camMoved(){return camMoved},setClip,setLook,setPlaying,setSpeed,step,resetView,ui,get T(){return T},set T(v){T=v;view.clearFx()},cam,ctl,view,draw,R,get playing(){return playing}};
