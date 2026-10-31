/**
 * GLSL for the sky world.
 *
 * Bake programs (run once at start-up, all the expensive noise lives here):
 *   BAKE_MAP_FS    — tileable 2D cumulus field: R = column height (flat base, domed
 *                    top), G = how tall the cloud there may grow side-on (big masses
 *                    tower, small strays stay low), B = slow macro field (patchy
 *                    coverage + evolution).
 *                    Clouds gather in warped groups (big masses + medium heaps +
 *                    small strays) with clear gaps, so the sky does not read as a
 *                    uniform field of identical cloudlets.
 *   BAKE_DETAIL_FS — tileable 3D billow noise (inverted Worley fbm), one z-slice per
 *                    draw; erodes the column shapes into cauliflower puffs.
 * Per frame:
 *   SKY_FS — scissored to each paper cutout. One ray per pixel from one page-space
 *            camera (per window: horizon shift, lens zoom, deck height). Overhead:
 *            slices through a thin cumulus slab. Near the horizon: a heightfield
 *            march through the slab (flat grey bases, lit domed tops; the last
 *            few degrees above the horizon average 2 sub-row rays). Short light
 *            probes toward the sun, sky gradient, aerial haze, a hazy featureless
 *            distant ground, film grain.
 */

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  // one oversized triangle covering the viewport
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

export const HASH = /* glsl */ `
// Hashes without sine (Dave Hoskins) — stable on integer lattices.
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`

export const BAKE_MAP_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uSize;
uniform vec2 uSeed;
out vec4 outColor;
${HASH}

// Periodic gradient noise: lattice period P (integer), returns ~[-1, 1].
float gnoise(vec2 p, float P) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = hash22(mod(i, P) + uSeed) * 2.0 - 1.0;
  vec2 g10 = hash22(mod(i + vec2(1, 0), P) + uSeed) * 2.0 - 1.0;
  vec2 g01 = hash22(mod(i + vec2(0, 1), P) + uSeed) * 2.0 - 1.0;
  vec2 g11 = hash22(mod(i + vec2(1, 1), P) + uSeed) * 2.0 - 1.0;
  float a = dot(g00, f);
  float b = dot(g10, f - vec2(1, 0));
  float c = dot(g01, f - vec2(0, 1));
  float d = dot(g11, f - vec2(1, 1));
  return 1.6 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Periodic fbm; base frequency F must be an integer so the tile wraps.
float fbm(vec2 uv, float F, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(uv * F, F);
    n += a;
    F *= 2.0;
    a *= 0.5;
  }
  return s / n;
}

// Where clouds gather: a slow, warped field. Clear gaps between groups keep the
// sky from reading as a uniform "stamped" field of identical cloudlets.
float cluster(vec2 uv) {
  float c = fbm(uv + vec2(0.13, 0.71), 7.0, 3);
  return smoothstep(-0.38, 0.22, c);
}

// Periodic cellular field: soft domes with random radius / strength per cell.
// Each cell asks the cluster field (at its own centre) how strong it may be,
// so big cells pile up in the groups and only small strays drift in the gaps.
float cells(vec2 uv, float F, vec2 salt, float rmin, float rmax, float stray) {
  vec2 p = uv * F;
  vec2 i = floor(p);
  vec2 f = p - i;
  float v = 0.0;
  for (int y = -2; y <= 2; y++)
  for (int x = -2; x <= 2; x++) {
    vec2 g = vec2(x, y);
    vec2 id = mod(i + g, F);
    vec2 h = hash22(id + salt + uSeed);
    vec2 h2 = hash22(id.yx + salt * 1.7 + uSeed + 19.1);
    float cl = cluster((i + g + h) / F);
    vec2 r = g + h - f;
    r.y *= 1.0 + 0.5 * h2.x;                       // a little broader than deep
    r.x *= 1.0 - 0.25 * h.y;
    float rad = mix(rmin, rmax, h2.y) * mix(0.55, 1.0, cl);
    float strength = clamp(cl * 1.2 - 0.15 + (h.x - 0.5) * 0.9 + stray * (h2.x - 0.8), 0.0, 1.0);
    float dd = length(r) / rad;
    float dome = 1.0 - smoothstep(0.0, 1.0, dd);
    v = max(v, strength * dome);
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;

  // strong domain warp so groups lose their round, procedural look
  vec2 w = vec2(fbm(uv, 5.0, 5), fbm(uv + vec2(0.37, 0.71), 5.0, 5));
  vec2 q = uv + w * 0.045;
  vec2 w2 = vec2(fbm(q, 16.0, 3), fbm(q + vec2(0.53, 0.19), 16.0, 3));
  q += w2 * 0.012;

  // big masses + medium heaps (merged where they touch) + small strays
  float big = cells(q, 9.0, vec2(3.1, 7.7), 0.55, 1.2, 0.0);
  float med = cells(q, 18.0, vec2(11.3, 2.9), 0.5, 1.1, 0.35);
  float small = cells(q, 36.0, vec2(5.7, 13.1), 0.5, 1.0, 0.9);
  float body = max(max(big, med * 0.85), small * 0.65) + big * med * 0.2;
  float lumps = fbm(q, 24.0, 4);

  // gentle S-curve: thin milky skirts drop under the threshold, cores stay as they are
  float m = smoothstep(0.02, 0.95, body + lumps * 0.12);

  // macro field: patchy coverage + slow evolution (sampled at another scale at runtime)
  float macro = fbm(uv, 3.0, 5) * 0.5 + 0.5;

  // how tall a cloud here may grow (seen side-on near the horizon): big masses
  // tower, small strays stay low heaps instead of thin columns
  float tall = smoothstep(0.1, 0.85, max(big, med * 0.7));

  outColor = vec4(m, tall, macro, 1.0);
}`

export const BAKE_DETAIL_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uSize;
uniform float uZ;
out vec4 outColor;
${HASH}

// Periodic 3D Worley F1, F cells per tile.
float worley(vec3 p, float F) {
  p *= F;
  vec3 i = floor(p);
  vec3 f = p - i;
  float d = 1e9;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(x, y, z);
    vec3 o = hash33(mod(i + g, F) + 7.31);
    vec3 r = g + o - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}

void main() {
  vec3 p = vec3(gl_FragCoord.xy, uZ + 0.5) / uSize;
  // inverted Worley fbm = billowy puffs (1 = puff core, 0 = crease between puffs)
  float a = 1.0 - worley(p, 3.0);
  float b = 1.0 - worley(p, 7.0);
  float c = 1.0 - worley(p, 15.0);
  float v = a * 0.6 + b * 0.28 + c * 0.12;
  v = clamp((v - 0.18) / 0.62, 0.0, 1.0);
  outColor = vec4(v, a, b, 1.0);
}`

export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D uMap;
uniform sampler3D uDetail;
uniform vec2  uCanvas;     // canvas size, render px
uniform float uPxScale;    // render px per CSS px
uniform vec2  uShift;      // CSS px: world offset + window offset + parallax
uniform float uCx;         // camera centre x, CSS px
uniform float uHy;         // horizon line of this window, CSS px (page space)
uniform float uF;          // focal length, CSS px
uniform vec2  uWind;       // cloud field offset, world units (cloud-base height = 1)
uniform vec3  uEvolve;     // xy: macro field offset (tiles), z: detail boil (detail tiles)
uniform vec3  uSunDir;     // world: x right, y up, z into the page
uniform vec3  uZenith;     // linear colours
uniform vec3  uHorizon;
uniform vec3  uLit;
uniform vec3  uShade;
uniform vec3  uGround;
uniform float uGradient;   // radians
uniform float uCoverage;
uniform float uSoft;
uniform float uDensity;
uniform float uShadow;
uniform float uErosion;
uniform float uTile;       // world units per 2D tile
uniform float uDetailScale;// 3D detail tiles per world unit
uniform float uHaze;       // 1 / haze distance, world units
uniform float uVeil;
uniform float uGrain;
uniform float uFrame;
uniform float uDebug;
uniform float uThick;      // cloud height above its flat base (base = 1); visible near the horizon only
uniform float uDeck;       // cloud-base height in this window (1 = shared world; lower = closer, larger clouds)

out vec4 outColor;
${HASH}

const float DEPTH_SQUEEZE = 0.7;
// Lighting of cloud lumps: the sun-facing slope is read over LAM_OFF world units
// (large enough that whole cloud bodies are shaded, not every little dome).
const float LAM_OFF = 0.04;
const float LAM_K = 2.5;
// The shaded side is a little more diffuse than the sunlit one (edge width x).
const float SHADE_SOFT = 1.6;
// Aerial perspective: quadratic close up, linear far out.
const float FOG_K = 0.85;
// The broad milky veil levels off below this sine of elevation (blue stays low).
const float VEIL_FLOOR = 0.15;
// Cumulus with height (near the horizon): field a sample must exceed at the top
// of the slab (only the cores reach it → domes, not flat lids); TOP_CURVE < 1
// keeps the steep lower sides short and gives the dome most of the height;
// TALL_MIN = relative height of the smallest strays (map G), so they stay low
// heaps instead of thin columns. The flat base sits in soft grey; optical
// density per world unit of path.
const float TOP_NEED = 0.6;
const float TOP_CURVE = 0.6;
const float TALL_MIN = 0.3;
const float BASE_SHADE = 0.6;
const float VOL_DENSITY = 20.0;
// Step along the slab in world units and the step cap (cost guard: a long fixed
// loop here falls off a performance cliff on some GPUs).
const float MARCH_STEP = 0.03;
const int   MARCH_MAX = 64;
// Below this sine of elevation a pixel averages SUPER_N sub-row rays (clouds there
// are only a few pixel rows tall).
const float SUPER_DY = 0.08;
const int   SUPER_N = 2;
// Distant ground: eye height (cloud-base units) and how much denser its haze is.
const float EYE_HEIGHT = 0.2;
const float GROUND_HAZE = 1.4;

float sat(float x) { return clamp(x, 0.0, 1.0); }

// View ray through page point w (CSS px, world offset already removed).
vec3 rayDir(vec2 w) { return normalize(vec3((w.x - uCx) / uF, (uHy - w.y) / uF, 1.0)); }
// Interleaved gradient noise: a static, evenly spread per-pixel dither.
float ign(vec2 frag) { return fract(52.9829189 * fract(dot(floor(frag), vec2(0.06711056, 0.00583715)))); }

vec3 skyColor(vec3 d) {
  float e = asin(clamp(d.y, 0.0, 1.0));
  float t = 1.0 - exp(-e / uGradient);
  vec3 c = mix(uHorizon, uZenith, t);
  // faint brightening of the whole sky toward the sun side (no disc, no flare)
  c *= 1.0 + 0.05 * dot(d, uSunDir);
  return c;
}

vec3 veilColor() { return mix(uHorizon, uLit, 0.3); }
float veilAmount(float dy, float mask) {
  // broad milky gradient (levels off low down, so the sky stays blue to a few
  // degrees above the horizon) + a tight haze band hugging the horizon
  float lo = VEIL_FLOOR;
  float dyb = 0.5 * (dy + lo + sqrt((dy - lo) * (dy - lo) + 0.002));
  return sat(uVeil * (0.4 + mask) * (0.45 * exp(-dyb / 0.2) + 0.24 * exp(-dy / 0.03)));
}

// Aerial perspective for something hz haze-lengths away: quadratic up close
// (clouds overhead stay crisp), linear far out (low clouds fade gradually).
float airFog(float hz) { return 1.0 - exp(-hz * hz / (1.0 + FOG_K * hz)); }

// Cloud field on the deck at world position P (xz), with screen derivatives gx/gy
// (for mip / anisotropic filtering). Positive = inside a cloud. The smooth cell
// field is pushed around by three octaves of billowy noise, so outlines become
// lumpy / cauliflower-like; the noise's 3rd axis is time (slow "boiling").
float cloudField(vec2 P, vec2 gx, vec2 gy, float thr, float hy, out float det) {
  float m = textureGrad(uMap, P / uTile, gx / uTile, gy / uTile).r;
  vec3 p3 = vec3(P.x * uDetailScale, uEvolve.z + hy, P.y * uDetailScale);
  vec3 g3x = vec3(gx.x, 0.0, gx.y) * uDetailScale, g3y = vec3(gy.x, 0.0, gy.y) * uDetailScale;
  det = textureGrad(uDetail, p3, g3x, g3y).r;
  float det2 = textureGrad(uDetail, p3 * 2.73 + vec3(0.31, 0.57, 0.11), g3x * 2.73, g3y * 2.73).r;
  float det3 = textureGrad(uDetail, p3 * 7.41 + vec3(0.73, 0.13, 0.41), g3x * 7.41, g3y * 7.41).r;
  det = det * 0.6 + det2 * 0.3 + det3 * 0.1;
  return (m - thr) + ((det - 0.5) * 0.36 + (det3 - 0.5) * 0.06) * uErosion;
}

// Heightfield march through the slab [1, 1 + T], near (base) → far (top), for
// one ray d. jit: static dither of the step start; fpx: pixel footprint per unit
// of height. Returns premultiplied colour + alpha.
vec4 marchSlab(vec3 d, float T, float thr, float jit, float fpx, vec3 sky, vec2 sunXZ) {
  float dy = max(d.y, 0.0025);
  vec2 dir = d.xz / dy * uDeck;
  // The step count follows the path length (few steps where the ray climbs steeply).
  float fn = clamp(ceil(T * length(dir) / MARCH_STEP), 20.0, float(MARCH_MAX));
  int n = int(fn);
  vec4 acc = vec4(0.0);
  float stepLen = T / fn / dy;                  // 3D path length per step
  float erodeMax = 0.21 * uErosion;             // most the detail noise can add to the field
  for (int i = 0; i < MARCH_MAX; i++) {
    if (i >= n) break;
    float s = (float(i) + jit) / fn;             // 0 = base … 1 = top of the tallest towers
    float h = 1.0 + T * s;
    float fogH = airFog(uHaze * h / dy);
    if (fogH > 0.985) break;                     // anything farther is lost in the haze
    vec2 Ph = dir * h * vec2(1.0, DEPTH_SQUEEZE) + uWind;
    // isotropic pixel footprint at the sample (the deck-plane derivatives
    // would smear the field along the depth axis into vertical streaks)
    float fp = fpx * h;
    vec2 gxh = vec2(fp, 0.0), gyh = vec2(0.0, fp);
    vec2 mt = textureGrad(uMap, Ph / uTile, gxh / uTile, gyh / uTile).rg;
    // domes: only the cores reach the top; small clouds stay low
    float need = TOP_NEED * pow(s / mix(TALL_MIN, 1.0, mt.y), TOP_CURVE);
    // cheap test on the cell map before paying for the detail noise
    if (mt.x - thr + erodeMax <= need) continue;
    float dh;
    float fh = cloudField(Ph, gxh, gyh, thr, T * s * uDetailScale, dh);
    float ex = fh - need - (0.5 - dh) * 0.25 * s * uErosion;   // lumpy tops, not lids
    if (ex <= 0.0) continue;
    float dj;
    float fs = cloudField(Ph + sunXZ * LAM_OFF, gxh, gyh, thr, T * s * uDetailScale, dj);
    float fb = cloudField(Ph - sunXZ * LAM_OFF, gxh, gyh, thr, T * s * uDetailScale, dj);
    float lam = sat(0.55 + (fb - fs) * LAM_K);
    float occ = sat(cloudField(Ph + sunXZ * 0.12, gxh, gyh, thr, T * s * uDetailScale, dj) / 0.3);
    float tau = (sat(ex / 0.35) * 0.6 + occ * 0.6) * uShadow;
    float sunVis = lam * max(exp(-tau), 0.25 * exp(-tau * 0.3));
    sunVis *= mix(BASE_SHADE, 1.0, smoothstep(0.0, 0.55, s));   // flat grey base, lit tops
    sunVis *= mix(0.8, 1.0, sat(dh * 1.3 - 0.1));
    vec3 c = mix(uShade, uLit, sat(sunVis * 1.6));
    c = mix(c, sky, fogH);
    float D = sat(ex / (uSoft * 0.32 * mix(1.0, SHADE_SOFT, 1.0 - lam)));
    float a = 1.0 - exp(-uDensity * VOL_DENSITY * D * stepLen);
    acc += (1.0 - acc.a) * vec4(c * a, a);
    if (acc.a > 0.97) break;
  }
  return acc;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 page = vec2(frag.x, uCanvas.y - frag.y) / uPxScale;
  vec2 w = page - uShift;
  vec3 d = rayDir(w);

  // Plane coordinates per unit of height and their screen derivatives (for mip / aniso).
  float dy = max(d.y, 0.0025);
  // uDeck: cloud-base height in this window (1 = shared world; lower = clouds closer, larger)
  vec2 dir = d.xz / dy * uDeck;
  vec2 gdx = dFdx(dir);
  vec2 gdy = dFdy(dir);

  if (uDebug > 0.5) {
    vec4 mm = texture(uMap, page / 400.0);
    float thrD = 1.0 - uCoverage;
    outColor = vec4(vec3(uDebug > 1.5 ? sat((mm.r - thrD) / (1.0 - thrD)) : mm.r), 1.0);
    if (uDebug > 2.5) outColor = vec4(texture(uDetail, vec3(page / 200.0, 0.3)).rrr, 1.0);
    if (uDebug > 3.5) {
      vec2 Pd = page * (3.0 / 351.0);
      vec2 gd = vec2(3.0 / 351.0 / uPxScale, 0.0);
      float dd;
      float fd = cloudField(Pd, gd, gd.yx, 1.0 - uCoverage, 0.0, dd);
      outColor = vec4(vec3(sat(fd / (uSoft * 0.5))), 1.0);
    }
    return;
  }

  vec3 sky = skyColor(d);
  vec3 col;

  if (d.y > 0.0) {
    // World position on the cloud deck (height 1). Depth is squeezed a little so
    // clouds keep some of the apparent height a real cumulus has (less pancake).
    vec2 P = dir * vec2(1.0, DEPTH_SQUEEZE) + uWind;
    // Toward the horizon the deck is seen edge-on: blur it vertically a little so
    // distant clouds read as soft hazy bands rather than sharp scratches.
    float edgeOn = 1.0 + 2.5 * (1.0 - smoothstep(0.02, 0.12, dy));
    vec2 gx = gdx * vec2(1.0, DEPTH_SQUEEZE), gy = gdy * vec2(1.0, DEPTH_SQUEEZE) * edgeOn;
    float macro = textureGrad(uMap, P / uTile * 0.29 + uEvolve.xy, gx * 0.29 / uTile, gy * 0.29 / uTile).b;
    float thr = clamp(1.0 - uCoverage + (macro - 0.5) * 0.2, 0.02, 0.98);

    // Thin high veil: barely there overhead, it thickens toward the horizon
    // (the sky goes milky and a touch warm low down).
    float veilMask = textureGrad(uMap, P / uTile * 0.13 + vec2(0.41, 0.17), gx * 0.13 / uTile, gy * 0.13 / uTile).b;
    sky = mix(sky, veilColor(), veilAmount(dy, veilMask));

    // Near the horizon the deck is seen from the side: there clouds need their
    // height (flat grey base, lit domed tops). Overhead it does not show, so the
    // upward-looking window keeps the plain deck slice.
    float T = uThick * (1.0 - smoothstep(0.10, 0.30, dy));
    vec2 sunXZ = normalize(uSunDir.xz + vec2(1e-4, 0.0));
    float det;
    float f = T > 0.004 ? -1.0 : cloudField(P, gx, gy, thr, 0.0, det);
    if (T > 0.004) {
      // Heightfield march through the slab. Close to the horizon a cloud spans
      // only a few pixel rows: there each pixel averages a few stratified sub-row
      // rays, so the far bank reads as one soft band, not 1-px slices.
      float jit = ign(frag);
      float jit2 = ign(frag + vec2(17.0, 31.0));
      int ns = dy < SUPER_DY ? SUPER_N : 1;
      float fpx = length(gdx);
      vec4 acc = vec4(0.0);
      for (int k = 0; k < SUPER_N; k++) {
        if (k >= ns) break;
        float o = (float(k) + jit2) / float(ns) - 0.5;   // sub-row offset, render px
        vec3 dk = ns > 1 ? rayDir(w + vec2(0.0, o / uPxScale)) : d;
        acc += marchSlab(dk, T, thr, fract(jit + 0.618034 * float(k)), fpx, sky, sunXZ);
      }
      acc /= float(ns);
      col = sky * (1.0 - acc.a) + acc.rgb;
    } else if (f > 0.0) {
      float th = sat(f / 0.35);                    // body thickness, graded to the core
      float dj;
      // small scale: lumps whose slope faces the sun catch light (pseudo-normal)
      float fs = cloudField(P + sunXZ * LAM_OFF, gx, gy, thr, 0.0, dj);
      float fb = cloudField(P - sunXZ * LAM_OFF, gx, gy, thr, 0.0, dj);
      float lam = sat(0.55 + (fb - fs) * LAM_K);
      // large scale: cloud between this point and the sun casts it into shade
      float occ = 0.0;
      for (int j = 1; j <= 3; j++) {
        float L = 0.04 * float(j * j);
        occ += sat(cloudField(P + sunXZ * L, gx, gy, thr, 0.0, dj) / 0.3) * (0.5 + 0.25 * float(j));
      }
      float tau = (th * 0.6 + occ * 0.5) * uShadow;
      float sunVis = lam * max(exp(-tau), 0.25 * exp(-tau * 0.3));   // + cheap multiple scattering
      sunVis *= mix(0.8, 1.0, sat(det * 1.3 - 0.1));  // creases between puffs sit in shade
      vec3 c = mix(uShade, uLit, sat(sunVis * 1.6));

      // aerial perspective: far clouds dissolve into the sky behind them
      c = mix(c, sky, airFog(uHaze / dy));

      // silhouette / opacity: crisp on the sunlit side, more diffuse in the shade
      float D = sat(f / (uSoft * 0.32 * mix(1.0, SHADE_SOFT, 1.0 - lam)));
      // oblique views look through more cloud
      float a = 1.0 - exp(-uDensity * D / max(dy, 0.05));
      col = mix(sky, c, a);
    } else {
      col = sky;
    }
  } else {
    // Distant ground: swallowed by haze, nothing recognisable.
    float camH = EYE_HEIGHT;                      // eye height in cloud-base units
    float t = camH / max(-d.y, 1e-4);
    vec2 G = d.xz * t;
    float v = textureLod(uMap, G / (uTile * 3.0) + 0.37, 5.0).b;
    float v2 = textureLod(uMap, G / (uTile * 0.7) + 0.61, 3.5).b;
    vec3 ground = uGround * (0.8 + 0.3 * v + 0.12 * v2);
    float fog = 1.0 - exp(-t * uHaze * GROUND_HAZE);  // ground haze is denser than the air above
    // at the horizon the haze must equal the sky just above it (no seam)
    vec3 hazeCol = mix(skyColor(normalize(vec3(d.x, 0.0, d.z))), veilColor(), veilAmount(0.0025, 0.5));
    col = mix(ground, hazeCol, fog);
  }

  // to sRGB
  col = max(col, 0.0);
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));

  // film grain (luminance), re-seeded at ~24 fps
  float n = hash12(frag + fract(uFrame * 0.618) * 917.0) + hash12(frag.yx * 1.3 + uFrame) - 1.0;
  col += n * uGrain;

  outColor = vec4(col, 1.0);
}`
