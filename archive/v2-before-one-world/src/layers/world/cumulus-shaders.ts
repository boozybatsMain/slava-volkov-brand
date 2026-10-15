/**
 * GLSL of the full-screen cumulus sky (version 2, see cumulus.ts).
 *   CUMULUS_SKY_FS — sky gradient + warm low haze, film grain.
 *   PUFF_VS / PUFF_FS — one instanced, camera-facing sprite per cloudlet (and per heap veil).
 * Colours are linear; output is sRGB (the cloud sprites blend over the sky in sRGB,
 * premultiplied, grain included so it stays one even layer across the image).
 */
import { HASH } from './shaders'

/** Pitched pinhole camera (shared by the sky pass and the sprites). */
const CAMERA = /* glsl */ `
uniform vec2  uCanvas;    // canvas size, render px
uniform float uPxScale;   // render px per CSS px
uniform vec2  uCenter;    // optical centre of the screen (incl. parallax), CSS px
uniform float uF;         // focal length, CSS px
uniform vec2  uPitch;     // cos, sin of the camera elevation

// World ray through a page point (CSS px). Camera basis: right (1,0,0),
// up (0, cos p, -sin p), forward (0, sin p, cos p).
vec3 viewRay(vec2 page) {
  vec2 v = vec2(page.x - uCenter.x, uCenter.y - page.y) / uF;
  return normalize(vec3(v.x, v.y * uPitch.x + uPitch.y, uPitch.x - v.y * uPitch.y));
}
`

/** Sky colour along a world direction. */
const SKY = /* glsl */ `
uniform vec3  uSunDir;    // world: x right, y up, z forward
uniform vec3  uZenith;    // linear colours
uniform vec3  uHorizon;
uniform vec3  uHazeCol;
uniform float uGradient;  // radians
uniform float uVeil;
uniform float uSunSide;

float sat(float x) { return clamp(x, 0.0, 1.0); }

vec3 skyColor(vec3 d) {
  float e = asin(clamp(d.y, 0.0, 1.0));
  float t = 1.0 - exp(-e / uGradient);
  vec3 c = mix(uHorizon, uZenith, t);
  // the low sun is behind the camera, to one side: that side of the sky is a bit lighter
  vec2 s = normalize(uSunDir.xz + vec2(1e-5, 0.0));
  c *= 1.0 + uSunSide * clamp(d.x * sign(s.x) * 2.5, -1.0, 1.0);
  // warm haze low in the sky
  c = mix(c, uHazeCol, sat(uVeil * exp(-e / 0.3)));
  return c;
}
`

/** sRGB output + film grain (identical in both passes). */
const OUTPUT = /* glsl */ `
uniform float uGrain;
uniform float uFrame;
${HASH}

vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// film grain (luminance), re-seeded at ~24 fps
float grainAt(vec2 frag) {
  return (hash12(frag + fract(uFrame * 0.618) * 917.0) + hash12(frag.yx * 1.3 + uFrame) - 1.0) * uGrain;
}
`

export const CUMULUS_SKY_FS = /* glsl */ `#version 300 es
precision highp float;
${CAMERA}
${SKY}
${OUTPUT}
out vec4 outColor;

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 page = vec2(frag.x, uCanvas.y - frag.y) / uPxScale;
  outColor = vec4(toSrgb(skyColor(viewRay(page))) + grainAt(frag), 1.0);
}`

export const PUFF_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aA;   // x, z (deck tile), base height, radius
layout(location = 1) in vec4 aB;   // centre above base, seed, strength, random
layout(location = 2) in vec4 aC;   // height of the whole heap, random per heap, 1 = veil

${CAMERA}
${SKY}
uniform vec2  uWind;
uniform vec2  uTileXZ;
uniform float uZ0;
uniform vec2  uShift;     // parallax part of uCenter (the coverage mask ignores it)
uniform vec2  uView;      // CSS px
uniform float uCoverage;
uniform vec3  uClear;     // clear top: strength, line (share of the screen), tilt
uniform float uFarCover;
uniform float uSizeK;
uniform float uThick;     // vertical development: 1 = cumulus heaps, lower = flat altocumulus
uniform float uVeils;     // opacity of the thin veils around the heaps
uniform float uHazeK;     // aerial haze per world unit

out vec2  vQ;      // sprite coords, 1 = cloudlet radius (y up)
out vec3  vSeed;   // offset into the billow noise
out float vBase;   // sprite y of the flat cloud base
out float vFade;   // coverage fade-in (veils: × their opacity)
out float vFar;    // 0 = top edge of the screen … 1 = bottom edge
out vec3  vHeap;   // height in the heap (0 = base … 1 = top) = x + q.y · y; z: random per heap
out float vPx;     // render px per sprite unit
out float vVeil;   // 1 = the soft veil sprite of a heap
out vec4  vAir;    // aerial perspective: sky colour behind the sprite (rgb) and amount (a)

const vec2 EXT = vec2(2.3, 1.7);       // sprite half-size, cloudlet radii
const vec2 VEIL_EXT = vec2(1.8, 1.3);

void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  bool isVeil = aC.z > 0.5;
  // clouds move with the wind (field offset uWind = −wind · t), wrapped on the tile
  float x = mod(aA.x - uWind.x + uTileXZ.x * 0.5, uTileXZ.x) - uTileXZ.x * 0.5;
  float z = mod(aA.y - uWind.y - uZ0, uTileXZ.y) + uZ0;
  float y0 = aA.z + aB.x;
  float vz0 = y0 * uPitch.y + z * uPitch.x;
  // where the cloud sits on the screen (no parallax), 0…1
  vec2 sn = (uCenter - uShift + uF * vec2(x, -(y0 * uPitch.x - z * uPitch.y)) / vz0) / uView;

  // coverage: none at the top of the screen (the clearing may slope), a bit denser far down
  float t = sn.y + uClear.z * (sn.x - 0.5);
  float ramp = smoothstep(uClear.y - 0.18, uClear.y + 0.18, t);
  float cov = uCoverage * mix(1.0 - uClear.x, 1.0, ramp) * (1.0 + uFarCover * smoothstep(0.5, 1.0, sn.y));
  float margin = aB.z - (1.0 - cov);
  float fade = smoothstep(0.0, 0.03, margin);
  // a cloud only just above the threshold is a small stray, and the clear sky keeps
  // only small fragments (sparse sky = small cumulus)
  float k = uSizeK * mix(0.5, 1.0, smoothstep(0.0, 0.25, margin)) * mix(0.4, 1.0, ramp);
  // thin clouds look flatter the lower they are in the sky (seen more edge-on)
  float el = atan(y0, length(vec2(x, z)));
  float sq = clamp(uThick * cos(el) + sin(el), 0.2, 1.0) * (isVeil ? 0.6 : 1.0);
  float r = aA.w * k;
  float y = aA.z + aB.x * k * sq;
  float vy = y * uPitch.x - z * uPitch.y;
  float vz = y * uPitch.y + z * uPitch.x;
  float far = clamp(sn.y, 0.0, 1.0);
  // veils belong to the far, low part of the field (near the top they read as a glow)
  if (isVeil) fade *= uVeils * smoothstep(0.25, 0.7, far);

  vec2 ext = isVeil ? VEIL_EXT : EXT;
  vec2 local = corner * ext * r * vec2(1.0, sq);
  vec2 s = uCenter + uF * vec2(x + local.x, -(vy + local.y)) / vz;
  gl_Position = vec4(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0, 0.0, 1.0);
  if (fade <= 0.001 || vz < 0.05) gl_Position = vec4(-4.0, -4.0, 0.0, 1.0);

  vQ = corner * ext;
  vSeed = fract(aB.y * vec3(97.31, 41.17, 13.73)) * 3.0 + vec3(0.0, 0.0, aB.w);
  vBase = -aB.x / (aA.w * uPitch.x);
  vFade = fade;
  vFar = far;
  vHeap = vec3(aB.x / aC.x, aA.w / aC.x, aC.y);
  vPx = uF * r / vz * uPxScale;
  vVeil = aC.z;
  // far clouds sink into the sky behind them (sky taken at the sprite centre: it barely
  // changes across one cloud, and this keeps the per-pixel work down)
  vec3 pos = vec3(x, y, z);
  vAir = vec4(skyColor(normalize(pos)), 1.0 - exp(-length(pos) * uHazeK));
}`

export const PUFF_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
${OUTPUT}
uniform sampler3D uDetail;
uniform vec3  uShade;     // linear colours
uniform vec3  uLit;
uniform vec3  uGlow;
uniform vec3  uSunV;      // sun in view space (x right, y up, z toward the camera)
uniform float uErosion;
uniform float uSoft;
uniform float uDensity;
uniform float uShadow;
uniform float uFarShade;
uniform float uEvolveZ;

in vec2  vQ;
in vec3  vSeed;
in float vBase;
in float vFade;
in float vFar;
in vec3  vHeap;
in float vPx;
in float vVeil;
in vec4  vAir;
out vec4 outColor;

const vec2 EXT = vec2(2.3, 1.7);
const vec2 VEIL_EXT = vec2(1.8, 1.3);

float sat(float x) { return clamp(x, 0.0, 1.0); }

float profile(vec2 q) {
  float yq = q.y < 0.0 ? q.y * 1.3 : q.y;
  return 1.0 - length(vec2(q.x * 0.66, yq * 1.05));
}

// Cloudlet density: a broad dome (tucked in below, warped so it is not round) shaped by
// big billow lumps, its edge broken up by a finer octave, softly cut at the cloud base,
// zero at the sprite border. Explicit texture gradients (gx, gy = screen derivatives of q),
// so the early exits in main() are safe.
float field(vec2 q, vec2 gx, vec2 gy, out float lump) {
  vec3 gx3 = vec3(gx, 0.0), gy3 = vec3(gy, 0.0);
  vec2 w = textureGrad(uDetail, vec3(q * 0.05, uEvolveZ * 0.5) + vSeed.zxy, gx3 * 0.05, gy3 * 0.05).gb - 0.5;
  float prof = profile(q + w * 0.9);
  vec3 p = vec3(q * 0.11, uEvolveZ) + vSeed;
  vec4 t1 = textureGrad(uDetail, p, gx3 * 0.11, gy3 * 0.11);
  float n1 = t1.r;
  // the finer octave is sampled through a small warp: ragged, less "round" edges
  float n2 = textureGrad(uDetail, p * 2.2 + vec3(0.21, 0.47, 0.13) + (t1.gba - 0.5) * 0.12, gx3 * 0.24, gy3 * 0.24).r;
  lump = n1;
  float f = prof + ((n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.35) * uErosion;
  f = min(f, (q.y - vBase + (n2 - 0.5) * 0.5) * 0.8);
  vec2 b = abs(q) / EXT;
  return min(f, (1.0 - max(b.x, b.y)) * 3.0);
}

// Whole heaps in the shadow of others: more of them far away, low in the frame.
float shadowedHeap() {
  return smoothstep(0.0, 0.25, uFarShade * smoothstep(0.35, 1.0, vFar) - vHeap.z * 0.6);
}

vec4 premultiplied(vec3 col, float a) {
  col = mix(col, vAir.rgb, vAir.a);
  return vec4((toSrgb(col) + grainAt(gl_FragCoord.xy)) * a, a);
}

// The thin veil of a heap: low-frequency shape, very soft edge, translucent,
// greyer than the flakes in front of it.
vec4 veil(vec2 gx, vec2 gy) {
  vec3 gx3 = vec3(gx, 0.0), gy3 = vec3(gy, 0.0);
  vec2 w = textureGrad(uDetail, vec3(vQ * 0.05, uEvolveZ * 0.5) + vSeed.zxy, gx3 * 0.05, gy3 * 0.05).gb - 0.5;
  vec4 n = textureGrad(uDetail, vec3(vQ * 0.08, uEvolveZ) + vSeed, gx3 * 0.08, gy3 * 0.08);
  vec2 b = abs(vQ) / VEIL_EXT;
  float f = min(profile(vQ + w * 1.6) * 0.6 + (n.r - 0.5) * 0.9 + (n.b - 0.5) * 0.4, (1.0 - max(b.x, b.y)) * 2.0);
  if (f <= 0.0) return vec4(0.0);
  float h = sat(vHeap.x + vQ.y * vHeap.y);
  float lit = mix(1.0 - uShadow, 0.7, smoothstep(0.0, 1.0, h + (n.r - 0.5) * 0.6));
  lit *= mix(1.0, 0.55, shadowedHeap());
  return premultiplied(mix(uShade, uLit, smoothstep(0.1, 0.9, lit)), smoothstep(0.0, 0.7, f) * vFade);
}

void main() {
  vec2 gx = dFdx(vQ), gy = dFdy(vQ);
  if (vVeil > 0.5) { outColor = veil(gx, gy); return; }
  // cheap reject: even the most generous warp + erosion cannot reach out here
  if (profile(vQ) + 0.5 + 0.63 * uErosion <= 0.0) { outColor = vec4(0.0); return; }
  float l0, l1, l2;
  const float E = 0.25;
  float f = field(vQ, gx, gy, l0);
  if (f <= 0.0) { outColor = vec4(0.0); return; }
  float fx = field(vQ + vec2(E, 0.0), gx, gy, l1);
  float fy = field(vQ + vec2(0.0, E), gx, gy, l2);

  // Golden hour, sun low behind the camera: the tops and the sun-facing lumps are lit,
  // the lower part of every heap turns grey-violet and goes translucent.
  vec2 g = vec2(fx - f, fy - f) / E;                  // points into the cloud
  float h = sat(vHeap.x + vQ.y * vHeap.y);             // 0 = base … 1 = top of the heap
  // rim / lump facing the sun: lit edges, but no dark outline on the far side (it would
  // draw crescents over the brighter puff behind)
  float face = clamp(dot(-g, normalize(uSunV.xy)) * 0.12, -0.04, 0.1);
  // lumps: brighter domes, darker creases (averaged over the three samples, so the
  // creases stay soft instead of drawing thin arcs)
  float lump = (l0 + l1 + l2) / 3.0;
  float top = smoothstep(-0.35, 1.2, h + (lump - 0.5) * 0.7 + face);
  float lit = mix(1.0 - uShadow, 1.0, top) * mix(0.85, 1.0, sat(uSunV.z));
  float shadowed = shadowedHeap();
  lit *= mix(1.0, 0.45, shadowed);
  lit *= mix(0.82, 1.06, vHeap.z);                       // heaps differ a little in light
  // three-tone ramp: grey-violet → peach → warm cream on the tops
  lit = sat(lit);
  vec3 col = mix(uShade, uLit, smoothstep(0.1, 0.78, lit));
  col = mix(col, uGlow, smoothstep(0.65, 1.0, lit) * top);

  // edge width: relative to the puff, but never a blur of a whole near cloud, never aliased
  float softQ = max(min(uSoft * 0.45, 10.0 / max(vPx, 1e-3)), 3.0 / max(vPx, 1e-3));
  float a = smoothstep(0.0, softQ, f);
  a *= mix(0.35, 1.0, smoothstep(0.0, 0.55, h));        // thin, translucent underside
  a *= 1.0 - 0.5 * shadowed;
  a = (1.0 - exp(-uDensity * 2.0 * a)) / (1.0 - exp(-uDensity * 2.0)) * vFade;
  outColor = premultiplied(col, a);
}`
