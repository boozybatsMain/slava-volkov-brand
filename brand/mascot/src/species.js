/* ================= Нетопырь: proportions, colours, rhythm =================
   Common pipistrelle (Pipistrellus pipistrellus), one of the smallest bats: «крошечный, не сидит на месте».
   Lengths are in head-and-body lengths (B); the bat frame is x to the nose, y to the back, z to the right wing.
   Wingspan with the wings fully spread ≈ 5.3 B. */
const NETOPYR={
  name:'Нетопырь',
  // body: an egg of fur; head with a short snout and big eyes for its size
  body:{c:[-.1,0,0],L:.3,r:.18},neck:[.17,.02,0],head:{c:[.1,0,0],r:.128},
  snout:{x:.08,y:-.032,L:.06,ry:.052,rz:.058},eye:{d:[.6,.36,.72],r:.026},
  furLen:.024,furDens:150,   // short, fine fur (150 hairs per B across)
  // wing: F is the forearm; d are the four fingers (length in F, angle spread and folded, degrees)
  S:[.06,.04,.08],
  wing:{F:.78,hum:.62,spread:{h:100,f:62},fold:{h:172,f:4},d:[{l:.8,sa:72,fa:186},{l:1.8,sa:91,fa:183},{l:1.32,sa:117,fa:181},{l:1.08,sa:143,fa:179}],notch:[.2,.22,.3],thumb:.13},
  vein:.2,                   // how much the elastic fibres darken the membrane
  // legs, tail and the membrane between them
  H:[-.33,-.01,.07],feet:[-.68,.02,0],tail:1,uroNotch:.14,
  // rounded ears with a tragus, cupped forward
  ear:{L:.21,W:.16,cup:.3,base:[-.08,.8,.6],up:[.12,.88,.46],front:[1,.08,.55],
    shape:[[0,-.5],[.5,-.5],[.85,-.28],[1,0],[.75,.32],[.35,.55],[0,.5]],
    tr:{L:.4,W:.25,off:-.25,shape:[[0,-.5],[.6,-.35],[1,0],[.6,.35],[0,.5]]}},
  // folded and hanging: wings wrap around the body
  foldPhi:-40*DEG,wrapPhi:-60*DEG,wrapO:.3,wrapR:0,
  // colours: dark brown, close to the real animal (the starry wing turns the membrane itself almost black)
  pal:{fur:'#6d5140',belly:'#8e735e',face:'#3f2f26',nose:'#241a14',ear:'#2a211c',earIn:'#3d3029',earTrans:'#6a4232',
    mem:'#231d19',trans:'#5a2c1c',bone:'#15110e'},
  // flight: 11 wing beats a second, deep strokes, a small bob; it glides with the wings a little raised
  flapF:11,amp:.95,flex:.5,bob:.06,phiBias:.08,glidePhi:.1,
  speed:230,accel:6,yawSide:42*DEG,             // world units (54 per B) per second; how fast it gets there
  // hanging: a damped pendulum from the feet; landing and letting go
  damp:2.2,gMul:1,landSwing:.9,landTime:.42,dropTime:.28,dropG:900,
  // head and eyelids
  headLim:[1.1,1.5,.6],blinkDur:.14};
