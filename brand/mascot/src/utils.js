/* ================= utils ================= */
const TAU=Math.PI*2,DEG=Math.PI/180;
const clamp=(v,a,b)=>v<a?a:v>b?b:v,lerp=(a,b,t)=>a+(b-a)*t;
const sm=t=>{t=clamp(t,0,1);return t*t*(3-2*t)};
