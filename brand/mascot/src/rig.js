/* ================= Нетопырь, the mascot: the 3D model =================
   A common pipistrelle built from code: furry body and head, cupped ears, finger bones, membranes rebuilt
   every frame between the bones. Its own features: a cold night sky seen through the wings and cold glowing eyes
   that leave a short trail. Needs THREE in scope, the helpers from utils.js and the data from species.js. */

/* ================= quaternions ================= */
// Bat frame: x to the nose, y to the back, z to the bat's right wing; lengths in head-and-body lengths (B).
// World frame: X right, Y up, Z toward the viewer. Quaternions are [w,x,y,z].
function qa(ax,ang){const s=Math.sin(ang/2);return[Math.cos(ang/2),ax[0]*s,ax[1]*s,ax[2]*s]}
function qm(a,b){return[a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]]}
function qslerp(a,b,t){let d=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3];if(d<0){b=[-b[0],-b[1],-b[2],-b[3]];d=-d}
  let k0=1-t,k1=t;if(d<.9995){const th=Math.acos(d),s=Math.sin(th);k0=Math.sin((1-t)*th)/s;k1=Math.sin(t*th)/s}
  const r=[a[0]*k0+b[0]*k1,a[1]*k0+b[1]*k1,a[2]*k0+b[2]*k1,a[3]*k0+b[3]*k1],l=Math.hypot(r[0],r[1],r[2],r[3]);return[r[0]/l,r[1]/l,r[2]/l,r[3]/l]}
function qmat(q){const w=q[0],x=q[1],y=q[2],z=q[3];return[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y),2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x),2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)]}
const mv=(m,p)=>[m[0]*p[0]+m[1]*p[1]+m[2]*p[2],m[3]*p[0]+m[4]*p[1]+m[5]*p[2],m[6]*p[0]+m[7]*p[1]+m[8]*p[2]];
const mtv=(m,p)=>[m[0]*p[0]+m[3]*p[1]+m[6]*p[2],m[1]*p[0]+m[4]*p[1]+m[7]*p[2],m[2]*p[0]+m[5]*p[1]+m[8]*p[2]];
const nrm=a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l]};
const crs=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const v3l=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
// upright, nose up and belly toward the viewer; hanging head down from the feet
const Q_UP=qm(qa([0,1,0],-Math.PI/2),qa([0,0,1],Math.PI/2)),Q_HANG=qm(qa([0,0,1],Math.PI),Q_UP);

/* ================= the glow: starry wings and cold eyes, one knob (the mascot: 0.4) ================= */
const glowE=s=>.22+6.6*Math.pow(s,1.7); // knob 0…1 → emission; 1.0 is where the bloom starts

/* ================= materials: fur with a soft fringe, translucent skin, membranes ================= */
const C=h=>new THREE.Color(h),COLD=C('#9ccaff'); // the eyes and their trails: cold blue-white
const TIME={value:0},PXU={value:1}; // shared by every material
const GLSL_NOISE=`
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float h31(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+1.),f.x),f.y);}
vec3 sn_m(vec3 x){return x-floor(x*(1./289.))*289.;}vec2 sn_m(vec2 x){return x-floor(x*(1./289.))*289.;}vec3 sn_p(vec3 x){return sn_m(((x*34.)+1.)*x);}
float snoise2(vec2 v){const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;
  i=sn_m(i);vec3 p=sn_p(sn_p(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);m=m*m;m=m*m;
  vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.*dot(m,g);}`;
// a cold night sky seen through the wing (screen space, CSS px); o is the wing's own position, so deeper layers lag behind it
const GLSL_SKY=`
vec3 starL(vec2 p,float cell,float dens,float sz,float br,float t,float glint){vec2 g=p/cell,ci=floor(g);float r=h21(ci+cell*1.37);if(r>dens)return vec3(0.);
  r/=dens;vec2 so=.18+.64*vec2(h21(ci+7.1+cell),h21(ci+3.3+cell)),d=(fract(g)-so)*cell;float rad=sz*(.6+.8*fract(r*17.3)),c=exp(-dot(d,d)/(rad*rad));
  c+=glint*.5*(exp(-abs(d.x)*1.6-d.y*d.y/(rad*rad*7.))+exp(-abs(d.y)*1.6-d.x*d.x/(rad*rad*7.)))*step(.55,fract(r*5.3));
  float tw=.72+.28*sin(t*(.6+1.3*fract(r*7.7))+r*91.);
  return mix(vec3(.62,.78,1.),vec3(.95,.97,1.),fract(r*31.))*c*br*tw*(.35+.65*fract(r*5.1));}
vec3 nightSky(vec2 fp,vec2 o,float t){vec2 q=(fp-o*.1)/300.;float band=exp(-pow(dot(q,vec2(.62,-.78))*2.2+.18*sin(q.x*2.3+q.y),2.));
  float neb=vn(q*3.2+vec2(t*.005,0.))*.62+vn(q*7.9)*.38;vec3 s=vec3(.012,.03,.06)*neb*neb*(.35+band);
  s+=starL(fp-o*.15,5.,.16,.5,.42*(.45+.8*band),t,0.);
  s+=starL(fp-o*.35,12.,.13,.72,.8,t,0.);
  s+=starL(fp-o*.6,31.,.11,1.,1.7,t,1.);
  return s;}`;
// light that passes through thin skin from the far side
const GLSL_TRANS=`
vec3 transLight(vec3 N){vec3 t=vec3(0.);
#if NUM_DIR_LIGHTS>0
for(int i=0;i<NUM_DIR_LIGHTS;i++)t+=directionalLights[i].color*max(0.,-dot(N,directionalLights[i].direction));
#endif
#if NUM_POINT_LIGHTS>0
for(int i=0;i<NUM_POINT_LIGHTS;i++){vec3 lv=pointLights[i].position+vViewPosition;float ld=max(length(lv),1e-4);t+=pointLights[i].color*getDistanceAttenuation(ld,pointLights[i].distance,pointLights[i].decay)*max(0.,-dot(N,lv/ld));}
#endif
#if NUM_HEMI_LIGHTS>0
for(int i=0;i<NUM_HEMI_LIGHTS;i++){float hd=dot(N,hemisphereLights[i].direction);t+=.5*(hemisphereLights[i].skyColor*max(0.,-hd)+hemisphereLights[i].groundColor*max(0.,hd));}
#endif
return t;}`;
function MEM_COMPILE(sh){Object.assign(sh.uniforms,this.userData.u);
  sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute vec2 aRest;attribute float aBone,aFib;varying vec2 vRest;varying float vBone,vFib;')
    .replace('#include <begin_vertex>','#include <begin_vertex>\nvRest=aRest;vBone=aBone;vFib=aFib;');
  sh.fragmentShader=sh.fragmentShader
    .replace('#include <common>','#include <common>\nuniform vec3 uTrans;uniform float uVein,uStars,uTime,uPx;uniform vec2 uSky;varying vec2 vRest;varying float vBone,vFib;'+GLSL_NOISE+GLSL_SKY)
    .replace('#include <lights_pars_begin>','#include <lights_pars_begin>'+GLSL_TRANS)
    .replace('#include <color_fragment>',`#include <color_fragment>
      // elastic fibres: fine lines across each membrane (span-wise in the arm wing, finger to finger in the hand wing)
      float fb=vFib+.09*snoise2(vRest*4.6),fw=fwidth(fb),fl=abs(fract(fb+.5)-.5);
      float vmask=(1.-smoothstep(fw*.35,fw*1.2,fl))*clamp(1.5-3.*fw,0.,1.)*(.45+.55*h21(vec2(floor(fb+.5),3.1)));
      float nb=smoothstep(.004,.045,vBone),thin=smoothstep(.02,.22,vBone),thick=.8+.4*vn(vRest*vec2(6.,3.5));
      diffuseColor.rgb*=(1.-uVein*vmask)*mix(.7,1.,nb);
      // the starry wing is a dark window: the skin itself goes almost black
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.005,.008,.018),smoothstep(0.,.5,uStars)*.985);`)
    .replace('#include <opaque_fragment>',`
      float nv=abs(dot(normal,normalize(vViewPosition)));
      outgoingLight+=uTrans*transLight(normal)*thick*mix(.3,1.,nb)*(.55+.45*thin)*(1.-.4*vmask)*(1.-.97*smoothstep(0.,.5,uStars));
      // the night sky through the wing: dimmer light, a faint cold rim, stars fading at grazing angles and near the bones
      if(uStars>0.){float ks=smoothstep(0.,.5,uStars);outgoingLight*=1.-.85*ks;outgoingLight+=vec3(.012,.022,.04)*pow(1.-nv,2.)*ks;
        vec2 fp=gl_FragCoord.xy/uPx;float win=uStars*smoothstep(.06,.5,nv)*mix(.5,1.,nb);
        outgoingLight+=win*nightSky(fp,uSky,uTime);}
      #include <opaque_fragment>`)}
function FUR_COMPILE(sh){Object.assign(sh.uniforms,this.userData.u);
  sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float aFur;varying float vFur;').replace('#include <begin_vertex>','#include <begin_vertex>\nvFur=aFur;');
  sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nuniform vec3 uSheen;uniform float uRoot;varying float vFur;')
    .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb*=mix(1.,uRoot,vFur);')
    .replace('#include <opaque_fragment>',`float nv=abs(dot(normal,normalize(vViewPosition)));outgoingLight+=uSheen*pow(1.-nv,2.2);
      #include <opaque_fragment>`)}
// fur shells: the skin pushed out along its normal in layers, hairs thinning to their tips, combed toward the tail
function SHELL_COMPILE(sh){Object.assign(sh.uniforms,this.userData.u);
  sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float aFur;uniform float uN,uLen;uniform vec3 uComb;varying float vFh,vFur;varying vec3 vSkin;')
    .replace('#include <begin_vertex>',`#include <begin_vertex>
      vFur=aFur;vSkin=position;float fh=(float(gl_InstanceID)+1.)/uN;vFh=fh;transformed+=(objectNormal*uLen+uComb*fh)*fh*aFur;`);
  sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nuniform vec3 uSheen;uniform float uDens;varying float vFh,vFur;varying vec3 vSkin;'+GLSL_NOISE)
    .replace('#include <color_fragment>',`#include <color_fragment>
      vec3 gq=vSkin*uDens,ci=floor(gq),fq=fract(gq)-.5;float r1=h31(ci);vec3 jt=vec3(h31(ci+1.7),h31(ci+5.3),h31(ci+9.1))-.5;
      float d=length(fq-jt*.34),th=(.4+.6*r1)*vFur,rad=.44*(1.-vFh/max(th,1e-3)),aw=length(fwidth(gq))*.45+1e-4,a=smoothstep(rad+aw,rad-aw,d);
      if(vFh>th||a<.04)discard;diffuseColor.a=a;diffuseColor.rgb*=mix(.62,1.05,vFh)*(.9+.2*h31(ci+3.9));`)
    .replace('#include <opaque_fragment>',`float nv=abs(dot(normal,normalize(vViewPosition)));outgoingLight+=uSheen*pow(1.-nv,2.)*(.5+vFh);
      #include <opaque_fragment>`)}
function EAR_COMPILE(sh){Object.assign(sh.uniforms,this.userData.u);
  sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nuniform vec3 uIn,uOut,uTrans;')
    .replace('#include <lights_pars_begin>','#include <lights_pars_begin>'+GLSL_TRANS)
    .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb=gl_FrontFacing?uIn:uOut;')
    .replace('#include <opaque_fragment>',`outgoingLight+=uTrans*transLight(normal);
      #include <opaque_fragment>`)}
function memMat(){const m=new THREE.MeshStandardMaterial({side:THREE.DoubleSide,roughness:.86,metalness:0});
  m.userData.u={uTrans:{value:C('#000')},uVein:{value:.3},uStars:{value:0},uSky:{value:new THREE.Vector2()},uTime:TIME,uPx:PXU};
  m.onBeforeCompile=MEM_COMPILE;return m}
function furMat(vc,col){const m=new THREE.MeshStandardMaterial({vertexColors:!!vc,color:col||'#ffffff',roughness:1,metalness:0});m.userData.u={uSheen:{value:C('#000')},uRoot:{value:1}};m.onBeforeCompile=FUR_COMPILE;return m}
function shellMat(base,n,len,dens){const m=new THREE.MeshStandardMaterial({vertexColors:base.vertexColors,color:base.color,roughness:1,metalness:0,alphaToCoverage:true});
  m.userData.u={uSheen:base.userData.u.uSheen,uN:{value:n},uLen:{value:len},uDens:{value:dens},uComb:{value:new THREE.Vector3(-len*.9,-len*.25,0)}};m.onBeforeCompile=SHELL_COMPILE;return m}
function earMat(){const m=new THREE.MeshStandardMaterial({side:THREE.DoubleSide,roughness:.62,metalness:0});
  m.userData.u={uIn:{value:C('#000')},uOut:{value:C('#000')},uTrans:{value:C('#000')}};m.onBeforeCompile=EAR_COMPILE;return m}
// additive glow strips for the eye trails (intensity rides in the vertex colour)
const ADD_MAT=new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-4});

/* ================= small geometry kit ================= */
const G_SPH=new THREE.SphereGeometry(1,24,16),G_SPH_LO=new THREE.SphereGeometry(1,10,8);
const G_BONE=new THREE.CylinderGeometry(.68,1,1,8,1).translate(0,.5,0),G_CLAW=new THREE.ConeGeometry(1,1,7).translate(0,.5,0);
const _v=new THREE.Vector3(),_p=new THREE.Vector3(),_s=new THREE.Vector3(),_q=new THREE.Quaternion(),_m=new THREE.Matrix4(),_Y=new THREE.Vector3(0,1,0),_bx=new THREE.Vector3(),_by=new THREE.Vector3(),_bz=new THREE.Vector3();
const P3=()=>[0,0,0],mk=n=>Array.from({length:n},P3);
const set3=(o,x,y,z)=>{o[0]=x;o[1]=y;o[2]=z;return o},cp3=(o,a)=>{o[0]=a[0];o[1]=a[1];o[2]=a[2];return o};
const RS_CUM=new Float64Array(64);
// a polyline resampled by arc length into out.length points
function resample(pts,out){const m=pts.length,n=out.length-1;let L=0;RS_CUM[0]=0;
  for(let i=1;i<m;i++){const a=pts[i-1],b=pts[i];L+=Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]);RS_CUM[i]=L}
  let sg=1;for(let k=0;k<=n;k++){const d=L*k/n;while(sg<m-1&&RS_CUM[sg]<d)sg++;const a=pts[sg-1],b=pts[sg],sl=RS_CUM[sg]-RS_CUM[sg-1],t=sl>1e-9?clamp((d-RS_CUM[sg-1])/sl,0,1):0;
    const o=out[k];o[0]=a[0]+(b[0]-a[0])*t;o[1]=a[1]+(b[1]-a[1])*t;o[2]=a[2]+(b[2]-a[2])*t}return out}
// trailing edge between two tips, its middle pulled toward P (a scallop)
function notchPts(A,B,P,dep,out,i0,i1){const mx=(A[0]+B[0])/2,my=(A[1]+B[1])/2,mz=(A[2]+B[2])/2,px=(P[0]-mx)*dep,py=(P[1]-my)*dep,pz=(P[2]-mz)*dep,n=i1-i0;
  for(let k=0;k<=n;k++){const t=k/n,w=4*t*(1-t),o=out[i0+k];o[0]=A[0]+(B[0]-A[0])*t+px*w;o[1]=A[1]+(B[1]-A[1])*t+py*w;o[2]=A[2]+(B[2]-A[2])*t+pz*w}return out}
// rotate P about the line through W along (ax,ay,0)
function rotAx(P,W,ax,ay,ang){if(!ang)return;const dx=P[0]-W[0],dy=P[1]-W[1],dz=P[2]-W[2],al=dx*ax+dy*ay,px=dx-al*ax,py=dy-al*ay,pz=dz,c=Math.cos(ang),s=Math.sin(ang);
  const cx=ay*pz,cy=-ax*pz,cz=ax*py-ay*px;P[0]=W[0]+al*ax+px*c+cx*s;P[1]=W[1]+al*ay+py*c+cy*s;P[2]=W[2]+pz*c+cz*s}
function coons(pos,off,nu,nv,c0,c1,d0,d1){const P00=c0[0],P10=c0[nu],P01=c1[0],P11=c1[nu];
  for(let j=0;j<=nv;j++){const v=j/nv,c=d0[j],d=d1[j];for(let i=0;i<=nu;i++){const u=i/nu,a=c0[i],b=c1[i],k=(off+j*(nu+1)+i)*3,w00=(1-u)*(1-v),w10=u*(1-v),w01=(1-u)*v,w11=u*v;
    pos[k]=(1-v)*a[0]+v*b[0]+(1-u)*c[0]+u*d[0]-(w00*P00[0]+w10*P10[0]+w01*P01[0]+w11*P11[0]);
    pos[k+1]=(1-v)*a[1]+v*b[1]+(1-u)*c[1]+u*d[1]-(w00*P00[1]+w10*P10[1]+w01*P01[1]+w11*P11[1]);
    pos[k+2]=(1-v)*a[2]+v*b[2]+(1-u)*c[2]+u*d[2]-(w00*P00[2]+w10*P10[2]+w01*P01[2]+w11*P11[2])}}}
function segDist2(px,py,ax,ay,bx,by){const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy,t=l>0?clamp(((px-ax)*dx+(py-ay)*dy)/l,0,1):0,ex=ax+dx*t-px,ey=ay+dy*t-py;return Math.sqrt(ex*ex+ey*ey)}

/* ================= camera-facing glow strips ================= */
const VIEW_Z=[0,0,1]; // toward a camera looking down -Z
class Ribbons{
  constructor(nR,nP){this.nR=nR;this.nP=nP;const nV=nR*nP*2;this.pos=new Float32Array(nV*3);this.col=new Float32Array(nV*3);const idx=[];
    for(let r=0;r<nR;r++)for(let i=0;i<nP-1;i++){const a=(r*nP+i)*2;idx.push(a,a+1,a+2,a+1,a+3,a+2)}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(this.pos,3).setUsage(THREE.DynamicDrawUsage));g.setAttribute('color',new THREE.BufferAttribute(this.col,3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);this.g=g;this.mesh=new THREE.Mesh(g,ADD_MAT);this.mesh.frustumCulled=false;this.mesh.renderOrder=5;this.vis=false}
  // pts: flat [x,y,z…] of n points; hw(i,t): half width; br(i,t): brightness; vw: direction to the viewer in this space
  set(r,pts,n,hw,br,col,vw){const P=this.pos,Cc=this.col,nP=this.nP;n=Math.min(n,nP);let base=r*nP*2*3,last=0;
    for(let i=0;i<nP;i++){const k=base+i*6;
      if(i>=n||n<2){P[k]=P[k+3]=P[last];P[k+1]=P[k+4]=P[last+1];P[k+2]=P[k+5]=P[last+2];Cc[k]=Cc[k+1]=Cc[k+2]=Cc[k+3]=Cc[k+4]=Cc[k+5]=0;continue}
      const a=Math.max(0,i-1)*3,b=Math.min(n-1,i+1)*3;let tx=pts[b]-pts[a],ty=pts[b+1]-pts[a+1],tz=pts[b+2]-pts[a+2];
      let sx=ty*vw[2]-tz*vw[1],sy=tz*vw[0]-tx*vw[2],sz=tx*vw[1]-ty*vw[0];const sl=Math.hypot(sx,sy,sz);const t=n>1?i/(n-1):0,w=hw(i,t);
      if(sl<1e-9){sx=sy=sz=0}else{sx*=w/sl;sy*=w/sl;sz*=w/sl}
      const x=pts[i*3],y=pts[i*3+1],z=pts[i*3+2];P[k]=x+sx;P[k+1]=y+sy;P[k+2]=z+sz;P[k+3]=x-sx;P[k+4]=y-sy;P[k+5]=z-sz;last=k;
      const q=br(i,t);Cc[k]=Cc[k+3]=col.r*q;Cc[k+1]=Cc[k+4]=col.g*q;Cc[k+2]=Cc[k+5]=col.b*q}}
  clear(r){this.pos.fill(0,r*this.nP*6,(r+1)*this.nP*6);this.col.fill(0,r*this.nP*6,(r+1)*this.nP*6)}
  commit(){this.g.attributes.position.needsUpdate=true;this.g.attributes.color.needsUpdate=true}}
// a fading line behind a moving point (world space)
class Trail{
  constructor(life){this.life=life;this.p=[];this.buf=new Float32Array(3*48)}
  push(x,y,z,t){const l=this.p[this.p.length-1];if(l&&Math.hypot(x-l[0],y-l[1])<.6)l[3]=Math.max(l[3],t-.0001);else this.p.push([x,y,z,t]);while(this.p.length>40||(this.p.length&&t-this.p[0][3]>this.life))this.p.shift()}
  clear(){this.p.length=0}
  fill(head){const n=this.p.length,B=this.buf;if(head)for(let i=0;i<n;i++){const q=this.p[n-1-i];B[i*3]=q[0];B[i*3+1]=q[1];B[i*3+2]=q[2]}return n}}

/* ================= one bat as meshes ================= */
// a wing lives in its own plane: u along the body toward the nose, v outward, n to the back; phi raises the plane.
const SK={S:0,E:1,W:2,M2:3,T2:4,M3:5,T3:6,M4:7,T4:8,M5:9,T5:10,TH:11};
const BONES=[[0,1,.02],[1,2,.022],[2,11,.013],[2,3,.012],[3,4,.0085],[2,5,.0125],[5,6,.008],[2,7,.011],[7,8,.0075],[2,9,.011],[9,10,.0075]];
// new BatView(NETOPYR,{env,shadow,shells,glow}): .g is the bat, .fxg its eye trails (add both to one parent).
// Every frame: pose(b) with a pose from clips.js, then tick(dt,px,vw): px is world units per CSS pixel at the bat,
// vw the unit direction from the bat toward the camera (the trails turn their flat side to it).
class BatView{
  constructor(D,opt){this.D=D;this.opt=opt||{};const P=D.pal;this.k=1;this.env=this.opt.env||null;
    this.g=new THREE.Group();this.fxg=new THREE.Group();this.str=.4;this.e=1;this.t=0;
    this.mFur=furMat(true);this.mSkin=new THREE.MeshStandardMaterial({color:C(P.face),roughness:.7});
    this.mMem=memMat();this.mMem.color=C(P.mem);this.mMem.userData.u.uTrans.value=C(P.trans||P.mem);this.mMem.userData.u.uVein.value=D.vein!=null?D.vein:.2;
    this.mBone=new THREE.MeshStandardMaterial({color:C(P.bone),roughness:.55});this.mClaw=new THREE.MeshStandardMaterial({color:C(P.claw||'#1c1612'),roughness:.4});
    this.mEye=new THREE.MeshStandardMaterial({color:C(P.eyeS||'#060403'),roughness:.08,metalness:0,envMapIntensity:2.2});
    this.mNose=new THREE.MeshStandardMaterial({color:C(P.nose||P.face),roughness:.45});
    this.mEar=earMat();const eu=this.mEar.userData.u;eu.uIn.value=C(P.earIn);eu.uOut.value=C(P.ear);eu.uTrans.value=C(P.earTrans||P.earIn).multiplyScalar(.3);
    {const t=this.mMem.userData.u.uTrans.value,l=t.r*.3+t.g*.59+t.b*.11;t.lerp(new THREE.Color(l,l,l),.3).multiplyScalar(.3)}
    this.buildBody();this.buildHead();this.buildMem();this.buildBones();this.buildFur();
    // the eye trails: one fading strip behind each eye, 0.2 s long
    this.trails=new Ribbons(2,40);this.fxg.add(this.trails.mesh);this.tr=[new Trail(.2),new Trail(.2)];this.tw=[0,0,0];
    for(const o of this.g.children)o.frustumCulled=false;this.setShadow(!!this.opt.shadow);
    for(const [m,k] of[[this.mFur,.22],[this.mSkin,.3],[this.mMem,.16],[this.mBone,.45],[this.mClaw,.8],[this.mEye,2.4],[this.mNose,.5],[this.mEar,.3],[this.mShell,.22]])if(m){m.envMap=this.env;m.envMapIntensity=k}
    this.setGlow(this.opt.glow!=null?this.opt.glow:.4)}
  setShadow(on){this.g.traverse(o=>{if(o.isMesh&&!o.userData.shell)o.castShadow=on})}
  /* ---------- body: an egg of fur, lighter belly ---------- */
  buildBody(){const D=this.D,P=D.pal,b=D.body,g=G_SPH.clone(),p=g.attributes.position,n=p.count,col=new Float32Array(n*3);
    const cF=C(P.fur),cB=C(P.belly),c=new THREE.Color();
    for(let i=0;i<n;i++){const sx=p.getX(i),sy=p.getY(i),sz=p.getZ(i),f=1+.14*sy;
      // sphere y → body axis, z → back, x → right side (a cyclic swap keeps the winding)
      p.setXYZ(i,b.c[0]+sy*b.L,sz*b.r*.94*f,sx*b.r*f);
      c.copy(cB).lerp(cF,sm((sz+.3)/.62));
      col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b}
    g.setAttribute('color',new THREE.BufferAttribute(col,3));g.setAttribute('aFur',new THREE.BufferAttribute(new Float32Array(n).fill(1),1));g.computeVertexNormals();
    this.body=new THREE.Mesh(g,this.mFur);this.g.add(this.body)}
  /* ---------- head: skull, snout, nose, eyes, cupped ears with a tragus ---------- */
  buildHead(){const D=this.D,P=D.pal,h=D.head,hg=new THREE.Group();hg.position.set(D.neck[0],D.neck[1],D.neck[2]);this.hg=hg;this.g.add(hg);
    const ed=nrm(D.eye.d),g=G_SPH.clone(),p=g.attributes.position,n=p.count,col=new Float32Array(n*3),fur=new Float32Array(n),cF=C(P.fur),cA=C(P.face),cH=C(P.head||P.fur),c=new THREE.Color();
    for(let i=0;i<n;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);p.setXYZ(i,h.c[0]+x*h.r*1.06,h.c[1]+y*h.r*.97,h.c[2]+z*h.r);
      const fw=sm((x-.25)/.6)*sm((.55-y)/.7),de=x*ed[0]+y*ed[1]+Math.abs(z)*ed[2];c.copy(cH).lerp(cA,fw);col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b;fur[i]=(1-.82*fw)*(1-.8*sm((de-.88)/.08))}
    g.setAttribute('color',new THREE.BufferAttribute(col,3));g.setAttribute('aFur',new THREE.BufferAttribute(fur,1));g.computeVertexNormals();this.head=new THREE.Mesh(g,this.mFur);hg.add(this.head);
    const sn=D.snout,sx=h.c[0]+sn.x,sy=h.c[1]+sn.y;
    const snout=new THREE.Mesh(G_SPH,this.mSkin);snout.position.set(sx,sy,0);snout.scale.set(sn.L,sn.ry,sn.rz);hg.add(snout);
    for(const s of[-1,1]){const no=new THREE.Mesh(G_SPH_LO,this.mNose);no.position.set(sx+sn.L*.9,sy+sn.ry*.18,s*sn.rz*.3);no.scale.set(.012,.011,.013);hg.add(no)}
    this.eyes=[];for(const s of[-1,1]){const d=nrm([D.eye.d[0],D.eye.d[1],s*D.eye.d[2]]),e=new THREE.Mesh(G_SPH,this.mEye);e.position.set(h.c[0]+d[0]*h.r*.97,h.c[1]+d[1]*h.r*.95,h.c[2]+d[2]*h.r*.97);e.scale.setScalar(D.eye.r*1.1);hg.add(e);this.eyes.push(e)}
    // ears: built once in the ear's own frame (x across, y along, z back), posed every frame
    const e=D.ear;this.ears=[];this.tragi=[];
    for(const s of[-1,1]){const m=new THREE.Mesh(this.earGeo(e.shape,e.W,1,e.cup!=null?e.cup:.32,s,9,7),this.mEar);hg.add(m);this.ears.push(m);
      if(e.tr){const t=new THREE.Mesh(this.earGeo(e.tr.shape,e.W*e.tr.W,1,.05,s,4,3),this.mEar);hg.add(t);this.tragi.push(t)}}}
  earGeo(shape,W,L,cup,s,nt,nw){// outline (t along, w across) → grid between its back and front edges
    const back=[],front=[];for(const q of shape)(q[1]<0?back:front).push(q);back.sort((a,b)=>a[0]-b[0]);front.sort((a,b)=>a[0]-b[0]);
    const at=(arr,t)=>{if(!arr.length)return 0;if(t<=arr[0][0])return arr[0][1];for(let i=1;i<arr.length;i++)if(t<=arr[i][0]){const a=arr[i-1],b=arr[i],u=(t-a[0])/((b[0]-a[0])||1);return lerp(a[1],b[1],u)}return arr[arr.length-1][1]};
    const pos=[],idx=[];
    for(let j=0;j<=nt;j++){const t=j/nt,w0=t>=1?0:at(back,t),w1=t>=1?0:at(front,t),hw=(w1-w0)/2,wm=(w0+w1)/2;
      for(let i=0;i<=nw;i++){const q=i/nw*2-1,w=wm+q*hw;pos.push(s*w*W,t*L,cup*W*(1-q*q)*Math.sin(Math.PI*Math.min(1,.15+t*.95))+.12*L*t*t)}}
    for(let j=0;j<nt;j++)for(let i=0;i<nw;i++){const a=j*(nw+1)+i,b=a+1,c=a+nw+1,d=c+1;idx.push(a,b,c,b,d,c)}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);g.computeVertexNormals();
    // the hollow of the ear must be its front face: front faces look toward -z here
    const nz=g.attributes.normal.getZ(Math.floor(nt/2)*(nw+1)+Math.floor(nw/2));if(nz>0){for(let i=0;i<idx.length;i+=3){const t=idx[i+1];idx[i+1]=idx[i+2];idx[i+2]=t}g.setIndex(idx);g.computeVertexNormals()}
    return g}
  /* ---------- fur: layered shells over the body and the head ---------- */
  buildFur(){const D=this.D,n=this.opt.shells||24,len=D.furLen||.024,dens=D.furDens||78;this.mShell=shellMat(this.mFur,n,len,dens);
    const add=(mesh,mat)=>{const s=new THREE.InstancedMesh(mesh.geometry,mat,n);_m.identity();for(let i=0;i<n;i++)s.setMatrixAt(i,_m);s.position.copy(mesh.position);s.scale.copy(mesh.scale);s.quaternion.copy(mesh.quaternion);
      s.frustumCulled=false;s.castShadow=false;s.userData.shell=true;mesh.parent.add(s)};
    add(this.body,this.mShell);add(this.head,this.mShell);this.mFur.userData.u.uRoot.value=.62}
  /* ---------- membranes: Coons patches between bones, edges scalloped between the finger tips ---------- */
  buildMem(){const D=this.D;this.pt=[];let off=0;
    const add=(key,side,nu,nv,bil)=>{const p={key,side,nu,nv,off,bil,c0:mk(nu+1),c1:mk(nu+1),d0:mk(nv+1),d1:mk(nv+1)};this.pt.push(p);off+=(nu+1)*(nv+1);return p};
    this.PS=[0,1].map(i=>({pro:add('pro',i,8,2,0),pla:add('pla',i,14,10,.05),d54:add('d54',i,6,10,.038),d43:add('d43',i,6,10,.038),d32:add('d32',i,3,10,.025)}));
    this.PU=add('uro',-1,12,6,.025);this.nV=off;
    const idx=[];for(const p of this.pt)for(let j=0;j<p.nv;j++)for(let i=0;i<p.nu;i++){const a=p.off+j*(p.nu+1)+i,b=a+1,c=a+p.nu+1,d=c+1;idx.push(a,c,b,b,c,d)}
    const g=new THREE.BufferGeometry();this.mpos=new Float32Array(off*3);this.loc=new Float32Array(off*3);
    g.setAttribute('position',new THREE.BufferAttribute(this.mpos,3).setUsage(THREE.DynamicDrawUsage));g.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(off*3),3).setUsage(THREE.DynamicDrawUsage));g.setIndex(idx);
    this.memG=g;this.mem=new THREE.Mesh(g,this.mMem);this.g.add(this.mem);
    // skeleton buffers
    this.L=[mk(12),mk(12)];this.Bk=[mk(12),mk(12)];this.H=mk(2);this.K=mk(2);this.A=mk(2);this.TB=P3();this.TT=P3();this.lH=mk(2);this.lK=mk(2);this.lA=mk(2);this.Pn=[P3(),P3()];this.tmp=P3();this.hm=P3();
    this.wrap=[0,0];this.phiS=[0,0];this.oS=[0,0];
    // rest layout (wings spread flat) for the patterns painted in the membrane
    const rb={o:1,wo:[0,0],phi:0,wphi:[0,0],ph:0,flap:0,ampK:1,hang:0,wr:0,cl:0,k:1};this.poseMem(rb);
    const rest=new Float32Array(off*2),bone=new Float32Array(off);
    const segs=[];for(const i of[0,1]){const L=this.Bk[i];for(const s of BONES)segs.push([L[s[0]][0],Math.abs(L[s[0]][2]),L[s[1]][0],Math.abs(L[s[1]][2])])}
    for(const i of[0,1])segs.push([this.H[i][0],Math.abs(this.H[i][2]),this.K[i][0],Math.abs(this.K[i][2])],[this.K[i][0],Math.abs(this.K[i][2]),this.A[i][0],Math.abs(this.A[i][2])]);
    for(let v=0;v<off;v++){const x=this.mpos[v*3],z=Math.abs(this.mpos[v*3+2]);rest[v*2]=x;rest[v*2+1]=z;let d=9;for(const s of segs)d=Math.min(d,segDist2(x,z,s[0],s[1],s[2],s[3]));bone[v]=d}
    const fib=new Float32Array(off),NF={pro:2.5,pla:11,d54:8,d43:9,d32:6,uro:7};
    this.pt.forEach((p,pi)=>{for(let j=0;j<=p.nv;j++)for(let k=0;k<=p.nu;k++)fib[p.off+j*(p.nu+1)+k]=j/p.nv*NF[p.key]+pi*31+.5});
    g.setAttribute('aRest',new THREE.BufferAttribute(rest,2));g.setAttribute('aBone',new THREE.BufferAttribute(bone,1));g.setAttribute('aFib',new THREE.BufferAttribute(fib,1))}
  /* ---------- bones, joints, claws, feet ---------- */
  buildBones(){this.bones=new THREE.InstancedMesh(G_BONE,this.mBone,BONES.length*2+5);this.joints=new THREE.InstancedMesh(G_SPH_LO,this.mBone,16);this.claws=new THREE.InstancedMesh(G_CLAW,this.mClaw,8);this.feet=new THREE.InstancedMesh(G_SPH_LO,this.mSkin,2);
    for(const m of[this.bones,this.joints,this.claws,this.feet]){m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);m.frustumCulled=false;this.g.add(m)}}
  setSeg(im,i,a,b,r){_v.set(b[0]-a[0],b[1]-a[1],b[2]-a[2]);const L=_v.length();if(L<1e-6)_v.set(0,1,0);else _v.multiplyScalar(1/L);_q.setFromUnitVectors(_Y,_v);_s.set(r,Math.max(L,1e-5),r);_p.set(a[0],a[1],a[2]);_m.compose(_p,_q,_s);im.setMatrixAt(i,_m)}
  setBall(im,i,a,rx,ry,rz){_p.set(a[0],a[1],a[2]);_q.identity();_s.set(rx,ry==null?rx:ry,rz==null?rx:rz);_m.compose(_p,_q,_s);im.setMatrixAt(i,_m)}
  /* ---------- wing pose for one side, in its plane ---------- */
  skel(b,i){const D=this.D,Wd=D.wing,F=Wd.F,L=this.L[i];
    const wrap=b.cl*b.wr*(1-clamp(3*b.wo[i],0,1));this.wrap[i]=wrap;
    const o=lerp(clamp(b.o+b.wo[i],0,1),D.wrapO,wrap),phi=lerp(b.phi+b.wphi[i],D.wrapPhi,wrap);this.oS[i]=o;this.phiS[i]=phi;
    const ah=lerp(Wd.fold.h,Wd.spread.h,o)*DEG,af=lerp(Wd.fold.f,Wd.spread.f,o)*DEG,hum=Wd.hum*F;
    set3(L[0],0,0,0);set3(L[1],Math.cos(ah)*hum,Math.sin(ah)*hum,0);set3(L[2],L[1][0]+Math.cos(af)*F,L[1][1]+Math.sin(af)*F,0);
    // the hand wing trails the arm through each beat
    const lag=b.flap*(Math.sin(b.ph-.65)-Math.sin(b.ph))*D.amp*b.ampK*.62,ax=Math.cos(af),ay=Math.sin(af),fo=sm(o);
    for(let j=0;j<4;j++){const d=Wd.d[j],am=lerp(d.fa,d.sa,o)*DEG,lm=.5*d.l*F,lp=.5*d.l*F,be=(j?lerp(165,-3,fo):lerp(28,0,o))*DEG,M=L[3+2*j],T=L[4+2*j];
      const ca=Math.cos(am),sa=Math.sin(am),cb=Math.cos(be),sb=Math.sin(be);
      set3(M,L[2][0]+ca*lm,L[2][1]+sa*lm,0);set3(T,M[0]+ca*cb*lp,M[1]+sa*cb*lp,-sb*lp*(j?1:.3));
      rotAx(M,L[2],ax,ay,lag*.75);rotAx(T,L[2],ax,ay,lag*1.3)}
    const ta=lerp(70,22,o)*DEG;set3(L[11],L[2][0]+Math.cos(ta)*Wd.thumb*F,L[2][1]+Math.sin(ta)*Wd.thumb*F,.02)}
  toBat(out,l,i){const S=this.D.S,s=i?1:-1,c=Math.cos(this.phiS[i]),sp=Math.sin(this.phiS[i]),u=l[0],v=l[1],n=l[2];out[0]=S[0]+u;out[1]=S[1]+v*sp+n*c;out[2]=s*(S[2]+v*c-n*sp);return out}
  toLoc(out,p,i){const S=this.D.S,s=i?1:-1,c=Math.cos(this.phiS[i]),sp=Math.sin(this.phiS[i]),x=p[0]-S[0],y=p[1]-S[1],z=s*p[2]-S[2];out[0]=x;out[1]=y*sp+z*c;out[2]=y*c-z*sp;return out}
  legs(b){const D=this.D,bf=D.bigFeet||1;
    for(const i of[0,1]){const s=i?1:-1,H=set3(this.H[i],D.H[0],D.H[1],s*D.H[2]),A=this.A[i];
      set3(A,lerp(-.62,D.feet[0],b.hang),lerp(-.03+Math.sin(b.phi)*.06,D.feet[1],b.hang),lerp(s*(.15+.25*b.o),s*.05,b.hang));
      set3(this.K[i],(H[0]+A[0])/2-.05,(H[1]+A[1])/2-.05*(1-b.hang),(H[2]+A[2])/2+s*.06)}
    set3(this.TB,D.body.c[0]-D.body.L*.8,0,0);const tl=D.tail;set3(this.TT,lerp(this.TB[0],lerp(-.8,-.66,b.hang),tl),lerp(0,-.08*b.hang,tl),0)}
  // keep skin outside the furry body (folded and wrapped wings hug it)
  push(p,m){const b=this.D.body,ax=(p[0]-b.c[0])/(b.L*1.04);if(ax<=-1||ax>=1)return;const f=1+.14*ax,ry=b.r*.94*f,rz=b.r*f,rx=Math.sqrt(1-ax*ax)*(1+m);
    const q=Math.hypot(p[1]/ry,p[2]/rz);if(q>=rx)return;if(q<1e-5){p[1]=-ry*rx;return}const k=rx/q;p[1]*=k;p[2]*=k}
  // wrapping: the folded wing rolls around the body like a sheet around a cylinder, toward the belly
  wrapPt(p,i,w){if(w<=0)return;const b=this.D.body,ax=clamp((p[0]-b.c[0])/(b.L*1.04),-.97,.97),f=1+.14*ax,s=i?1:-1,
      R=b.r*f*Math.sqrt(1-ax*ax)*1.04+(i===0?.044:.024)+(this.D.furLen||.024)+this.D.wrapR,y=p[1],z=s*p[2],r=Math.hypot(y,z);if(r<1e-6)return;
    const a=Math.atan2(y,z),ex=Math.max(0,r-R),a2=Math.max(a-w*ex/R,-Math.PI/2-(i===0?.62:.45)),r2=lerp(r,R+ex*.1,w*sm(ex/.03));
    p[1]=Math.sin(a2)*r2;p[2]=s*Math.cos(a2)*r2}
  poseMem(b){const D=this.D,nt=D.wing.notch,loc=this.loc,pos=this.mpos;
    this.legs(b);
    for(const i of[0,1]){this.skel(b,i);const L=this.L[i],P=this.PS[i],W=L[2],E=L[1],S=L[0];
      this.toLoc(this.lH[i],this.H[i],i);this.toLoc(this.lK[i],this.K[i],i);this.toLoc(this.lA[i],this.A[i],i);
      const Pn=set3(this.Pn[i],.07,.03,0);
      // propatagium: in front of the arm
      {const p=P.pro;for(let k=0;k<=p.nu;k++){const t=k/p.nu;set3(p.c0[k],lerp(Pn[0],W[0],t),lerp(Pn[1],W[1],t),lerp(Pn[2],W[2],t))}resample([S,E,W],p.c1);
        for(let k=0;k<=p.nv;k++){const t=k/p.nv;set3(p.d0[k],lerp(Pn[0],S[0],t),lerp(Pn[1],S[1],t),0);cp3(p.d1[k],W)}coons(loc,p.off,p.nu,p.nv,p.c0,p.c1,p.d0,p.d1)}
      // plagiopatagium: body side and leg to the fifth finger
      {const p=P.pla;resample([S,E,W],p.c0);notchPts(this.lA[i],L[10],E,nt[2],p.c1,0,p.nu);resample([S,this.lH[i],this.lK[i],this.lA[i]],p.d0);resample([W,L[9],L[10]],p.d1);coons(loc,p.off,p.nu,p.nv,p.c0,p.c1,p.d0,p.d1)}
      // between the fingers
      for(const [key,a,bb,dep] of[['d54',9,7,nt[1]],['d43',7,5,nt[0]],['d32',5,3,.04]]){const p=P[key];for(let k=0;k<=p.nu;k++)cp3(p.c0[k],W);
        notchPts(L[a+1],L[bb+1],W,dep,p.c1,0,p.nu);resample([W,L[a],L[a+1]],p.d0);resample([W,L[bb],L[bb+1]],p.d1);coons(loc,p.off,p.nu,p.nv,p.c0,p.c1,p.d0,p.d1)}
      // billow, then into the bat frame; a wrapped wing sits a little further out on the near side
      const o=this.oS[i],bil=o*(.78+.22*Math.sin(b.ph)*b.flap),mg=.05+1.1*(D.furLen||.024)/D.body.r+this.wrap[i]*(i===0?.12:.04),tmp=this.tmp;
      for(const key of['pro','pla','d54','d43','d32']){const p=P[key];for(let j=0;j<=p.nv;j++)for(let k=0;k<=p.nu;k++){const v=p.off+j*(p.nu+1)+k,q=v*3;
        tmp[0]=loc[q];tmp[1]=loc[q+1];tmp[2]=loc[q+2]+p.bil*bil*Math.sin(Math.PI*k/p.nu)*Math.sin(Math.PI*j/p.nv);
        this.toBat(tmp,tmp,i);this.wrapPt(tmp,i,this.wrap[i]);this.push(tmp,mg);pos[q]=tmp[0];pos[q+1]=tmp[1];pos[q+2]=tmp[2]}}
      for(let j=0;j<12;j++){this.toBat(this.Bk[i][j],L[j],i);this.wrapPt(this.Bk[i][j],i,this.wrap[i]);if(j)this.push(this.Bk[i][j],mg+.03)}}
    // tail membrane between the legs
    {const p=this.PU,h=p.nu/2;set3(this.hm,(this.H[0][0]+this.H[1][0])/2,(this.H[0][1]+this.H[1][1])/2,0);
      resample([this.H[0],this.TB,this.H[1]],p.c0);notchPts(this.A[0],this.TT,this.hm,this.D.uroNotch,p.c1,0,h);notchPts(this.TT,this.A[1],this.hm,this.D.uroNotch,p.c1,h,p.nu);
      resample([this.H[0],this.K[0],this.A[0]],p.d0);resample([this.H[1],this.K[1],this.A[1]],p.d1);coons(pos,p.off,p.nu,p.nv,p.c0,p.c1,p.d0,p.d1);
      const bil=.6+.4*(1-b.hang);for(let j=0;j<=p.nv;j++)for(let k=0;k<=p.nu;k++){const q=(p.off+j*(p.nu+1)+k)*3;pos[q+1]+=p.bil*bil*Math.sin(Math.PI*k/p.nu)*Math.sin(Math.PI*j/p.nv)}}}
  /* ---------- everything, every frame ---------- */
  pose(b){const D=this.D,k=b.k;this.k=k;
    this.g.position.set(b.x+b.jx,-(b.y+b.bobY+b.jy),b.z||0);this.g.quaternion.set(b.q[1],b.q[2],b.q[3],b.q[0]);this.g.scale.setScalar(k);
    this.hg.quaternion.set(0,0,0,1);_q.setFromAxisAngle(_Y,-b.hyaw);this.hg.quaternion.multiply(_q);_v.set(0,0,1);_q.setFromAxisAngle(_v,b.hpitch+b.hpAdd);this.hg.quaternion.multiply(_q);
    // ears follow the ear amount: up → tucked down, and shorter when curled
    const e=D.ear;for(let i=0;i<2;i++){const s=i?1:-1,mz=a=>[a[0],a[1],s*a[2]],up=nrm(v3l(e.down||e.up,e.up,b.ear)),fr=nrm(e.front),V=nrm(crs(fr,up)),db=nrm(e.base),h=D.head;
      const U=mz(up),Vs=mz(V),N=crs(Vs,U);_bx.set(Vs[0]*s,Vs[1]*s,Vs[2]*s);_by.set(U[0],U[1],U[2]);_bz.set(N[0]*s,N[1]*s,N[2]*s);
      // mirrored ears: flip the across axis back so the basis stays right-handed (the geometry carries the mirror)
      _m.makeBasis(_bx,_by,_bz);const m=this.ears[i];m.quaternion.setFromRotationMatrix(_m);m.position.set(h.c[0]+db[0]*h.r*.86,h.c[1]+db[1]*h.r*.86,s*db[2]*h.r*.86);
      const Ls=e.L*lerp(e.curl||1,1,b.ear);m.scale.set(1,Ls,1);
      if(this.tragi[i]){const ua=nrm(e.up),Vt=nrm(crs(fr,ua)),Ua=mz(ua),Va=mz(Vt),Na=crs(Va,Ua);_bx.set(Va[0]*s,Va[1]*s,Va[2]*s);_by.set(Ua[0],Ua[1],Ua[2]);_bz.set(Na[0]*s,Na[1]*s,Na[2]*s);_m.makeBasis(_bx,_by,_bz);
        const t=this.tragi[i];t.quaternion.setFromRotationMatrix(_m);const off=e.tr.off*e.W;t.position.set(m.position.x+Va[0]*off+fr[0]*.01,m.position.y+Va[1]*off+fr[1]*.01,m.position.z+Va[2]*off+s*fr[2]*.01);t.scale.set(1,e.L*e.tr.L,1)}}
    const bl=b.blinkAmt,er=D.eye.r*1.1;for(const ey of this.eyes)ey.scale.set(er,er*(1-.88*bl),er);
    this.poseMem(b);const G=this.memG;G.attributes.position.needsUpdate=true;G.computeVertexNormals();
    // bones
    let n=0;for(const i of[0,1]){const B=this.Bk[i];for(const s of BONES)this.setSeg(this.bones,n++,B[s[0]],B[s[1]],s[2]);
      this.setSeg(this.bones,n++,this.H[i],this.K[i],.017);this.setSeg(this.bones,n++,this.K[i],this.A[i],.014)}
    this.setSeg(this.bones,n++,this.TB,this.TT,.009*Math.max(.3,D.tail));this.bones.count=n;this.bones.instanceMatrix.needsUpdate=true;
    n=0;for(const i of[0,1]){const B=this.Bk[i];this.setBall(this.joints,n++,B[1],.022);this.setBall(this.joints,n++,B[2],.022);for(const j of[3,5,7,9])this.setBall(this.joints,n++,B[j],.0105);this.setBall(this.joints,n++,this.K[i],.016)}
    this.joints.count=n;this.joints.instanceMatrix.needsUpdate=true;
    n=0;const bf=D.bigFeet||1;for(const i of[0,1]){const B=this.Bk[i];this.setSeg(this.claws,n++,B[11],v3l(B[11],B[2],-.55),.013);
      const A=this.A[i],K=this.K[i],d=nrm([A[0]-K[0],A[1]-K[1],A[2]-K[2]]);for(const sp of[-1,0,1]){const tip=[A[0]+d[0]*.05*bf,A[1]+d[1]*.05*bf+sp*.012,A[2]+d[2]*.05*bf+sp*.016];this.setSeg(this.claws,n++,A,tip,.007*bf)}
      this.setBall(this.feet,i,A,.03*bf,.02*bf,.026*bf)}
    this.claws.count=n;this.claws.instanceMatrix.needsUpdate=true;this.feet.instanceMatrix.needsUpdate=true;
  }
  /* ---------- the glow: how bright the stars, the eyes and the trails are (0…1; the mascot is 0.4) ---------- */
  setGlow(str){this.str=str;const e=glowE(str);this.e=e;
    this.mEye.emissive.copy(COLD);this.mEye.emissiveIntensity=e*2.2;
    this.mMem.userData.u.uStars.value=.2+.8*str}
  // world position of a point in the bat frame
  wpos(p,out){_v.set(p[0],p[1],p[2]).applyQuaternion(this.g.quaternion).multiplyScalar(this.k).add(this.g.position);out[0]=_v.x;out[1]=_v.y;out[2]=_v.z;return out}
  hpos(p,out){_v.set(p[0],p[1],p[2]).applyQuaternion(this.hg.quaternion).add(this.hg.position);return this.wpos([_v.x,_v.y,_v.z],out)}
  tick(dt,px,vw,away){const e=this.e,k=this.k;this.t+=dt;
    // the sky in the wings moves with the bat, its deeper layers lagging behind (a viewer may set uSky itself after this)
    this.mMem.userData.u.uSky.value.set(this.g.position.x/px,this.g.position.y/px);
    // the eye trails: points dropped behind the eyes fade and thin out within 0.2 s
    const tq=this.t,w=this.tw;
    if(!away)for(let s=0;s<2;s++){const p=this.eyes[s].position;this.hpos([p.x,p.y,p.z],w);this.tr[s].push(w[0],w[1],w[2],tq)}
    const hw0=Math.max(.55*px,this.D.eye.r*k*.75),br=e*1.1;
    for(let s=0;s<2;s++){const T=this.tr[s];while(T.p.length&&tq-T.p[0][3]>T.life)T.p.shift();const n=T.fill(true);if(n<2){this.trails.clear(s);continue}
      const P=T.p,life=T.life,age=i=>clamp(1-(tq-P[n-1-i][3])/life,0,1);
      this.trails.set(s,T.buf,n,i=>hw0*Math.pow(age(i),.6),i=>br*Math.pow(age(i),1.6),COLD,vw||VIEW_Z)}
    this.trails.commit()}
  clearFx(){for(const t of this.tr)t.clear();for(let r=0;r<2;r++)this.trails.clear(r);this.trails.commit()}
  dispose(){this.g.traverse(o=>{if(o.isMesh&&o.geometry&&o.geometry!==G_SPH&&o.geometry!==G_SPH_LO&&o.geometry!==G_BONE&&o.geometry!==G_CLAW)o.geometry.dispose()});
    for(const m of[this.mFur,this.mSkin,this.mMem,this.mBone,this.mClaw,this.mEye,this.mNose,this.mEar,this.mShell])m&&m.dispose();this.trails.g.dispose()}
}
