import { RASTER_GLSL } from '../../../core/raster-gl'
import { GLOW_TAG } from '../raster/shaders'

/**
 * Mesh title shaders. Everything works in display space (raw sRGB), like the raster title and an old
 * renderer: no tone mapping, no colour management.
 *
 * TITLE: real geometry, two sources of colour.
 *   paint — the client's render (color.png) PROJECTED onto the solid from the rest pose (the same
 *     camera that "photographed" it: pose.ts / fit). At rest the screen shows exactly the render; once
 *     the solid turns the paint stays glued to the faces and walls it was projected onto, and the
 *     change of the reflections is added on top: env(now) − env(rest) from the solid's own normals
 *     (the raster title's trick, but on real geometry). Only where the rest camera saw that very
 *     surface: not facing away at rest, not hidden behind another letter (a depth map of the rest
 *     pose) and deep inside the render's cut, fading in from a few texels off its edge (index.ts →
 *     buildPaint) — elsewhere (near and past the render's edges, a wall the turn reveals) the chrome
 *     takes over, so the render's own edges never land on the wrong surface.
 *   chrome — the render's own chrome as an environment: every direction a face (or a wall) of the
 *     render reflects, with the colour it has there (learned once by scripts/title-mesh/fit.mjs --env
 *     from the fitted solid's normals; public/assets/title-mesh/env.png), looked up with the solid's
 *     real, slightly pillowed normals; a hard light on the bevel bands; per-letter wobble.
 *   title.mesh.paint mixes them (1 — the render where it can, 0 — chrome everywhere).
 *
 * POST: the low-res frame → the canvas: the white-keyed fringe inside the cut (as if keyed off the
 * render's white background), edge crawl and row slips while the title moves (the raster title's
 * formulas, core/raster-gl.ts → glitch), alpha strictly 0 / 1; empty pixels are discarded so the
 * light behind the letters (glow) shows through.
 */

export const TITLE_VS = /* glsl */ `
attribute vec2 aPart;
attribute vec2 aLocal;
attribute float aGlyph;

uniform mat4 uRestMV;     // object → camera at rest
uniform mat3 uRestN;      // its normal matrix
uniform mat3 uTexel;      // rest camera (x, −y, −z) → texel · w
uniform float uBulge;

varying vec3 vPos;        // camera space, now
varying vec3 vN;          // normal now (faces pillowed)
varying vec3 vRestPos;    // camera space at rest
varying vec3 vRestN;      // normal at rest (pillowed the same way)
varying vec3 vTexH;       // texel at rest, homogeneous (perspective-correct after the divide)
varying vec2 vPart;       // part id, depth fraction (0 front … 1 back)
varying float vGlyph;
varying float vLocalY;

void main() {
  vec3 n = normal;
  // faces: a slight "pillow" — the normal leans out toward the letter's edges (bigger letters, same
  // curvature), so every face runs sky → horizon → floor top to bottom like the render's chrome
  if (aPart.x < 0.5) n = normalize(n + vec3(aLocal * uBulge, 0.0));
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPos = mv.xyz;
  vN = normalize(normalMatrix * n);
  vec4 rp = uRestMV * vec4(position, 1.0);
  vRestPos = rp.xyz;
  vRestN = normalize(uRestN * n);
  vTexH = uTexel * vec3(rp.x, -rp.y, -rp.z);
  vPart = aPart;
  vGlyph = aGlyph;
  vLocalY = aLocal.y;
  gl_Position = projectionMatrix * mv;
}
`

export const TITLE_FS = /* glsl */ `
precision highp float;

uniform sampler2D uPaint;      // the render (color.png), nearest + mips; A — how much of it may be used here
uniform sampler2D uRestDepth;  // depth seen by the rest camera, texel space (RG: 16-bit)
uniform vec2 uTexSize;
uniform vec2 uDepthRange;      // near, far of the rest depth encoding
uniform float uBias;           // mip bias of the paint
uniform float uPaintMix;       // title.mesh.paint
uniform float uEnvMix;         // how strongly the change of reflections shows on the paint
uniform float uEnvDarken;

// chrome
uniform sampler2D uEnv;        // the render's chrome as environments (equirect): top — faces, bottom — walls
uniform vec2 uEnvSize;         // its size (both halves)
uniform float uWobble;
uniform float uBevelLight;
uniform float uSeamShade;
uniform float uContrast;
uniform vec3 uKey;             // key light direction, camera space (the bevels' hard frame)

varying vec3 vPos;
varying vec3 vN;
varying vec3 vRestPos;
varying vec3 vRestN;
varying vec3 vTexH;
varying vec2 vPart;
varying float vGlyph;
varying float vLocalY;

float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }

// The render's chrome, by reflection direction (camera space: x right, y up, z toward the viewer):
// learned from the render itself (scripts/title-mesh/fit.mjs --env). walls 0 — faces and bevels, 1 — walls.
vec3 envAt(vec3 r, float walls) {
  float lon = atan(r.x, r.z);
  float lat = asin(clamp(r.y, -1.0, 1.0));
  float halfH = uEnvSize.y * 0.5;
  float y = clamp((0.5 - lat / 3.14159265) * halfH, 0.5, halfH - 0.5) + walls * halfH;   // px from the top
  return texture2D(uEnv, vec2(lon / 6.2831853 + 0.5, 1.0 - y / uEnvSize.y)).rgb;
}

vec3 chrome(vec3 N, vec3 V, float part) {
  // every letter sees its environment a little turned (the render's reflections are never uniform)
  float g = vGlyph;
  vec3 w = vec3(hash11(g) - 0.5, hash11(g + 7.0) - 0.5, 0.0) * uWobble;
  vec3 r = normalize(reflect(-V, normalize(N + w * step(part, 3.5))));
  vec3 c = envAt(r, step(3.5, part));
  if (part > 0.5 && part < 3.5) {
    // bevel bands: plus a hard light — bright toward the key, dark away: a crisp frame
    float lit = smoothstep(-0.15, 0.25, dot(N, uKey));
    c = mix(c, mix(c * 0.45, max(c, vec3(0.92)), lit), uBevelLight);
  } else if (part > 4.5 && part < 5.5) {
    c *= uSeamShade;
  } else if (part > 5.5) {
    c *= 0.6;
  }
  return clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
}

void main() {
  vec3 V = normalize(-vPos);
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  float part = floor(vPart.x + 0.5);
  vec3 col = chrome(N, V, part);

  if (uPaintMix > 0.0) {
    vec2 t = vTexH.xy / vTexH.z;                                  // texel at rest, y down
    vec2 uv = vec2(t.x / uTexSize.x, 1.0 - t.y / uTexSize.y);
    vec3 Vr = normalize(-vRestPos);
    vec3 Nr = normalize(vRestN);
    float facing = dot(Nr, Vr);
    // what the rest camera saw at this texel: the nearest surface (16-bit depth)
    vec2 dd = texture2D(uRestDepth, uv).rg;
    float seen = mix(uDepthRange.x, uDepthRange.y, dd.r + dd.g / 255.0);
    float here = -vRestPos.z;
    float vis = step(0.02, facing) * step(here, seen + 0.02 + 0.01 * here / max(facing, 0.05));
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    vec4 pt = texture(uPaint, uv, uBias);
    float w = uPaintMix * vis * inside * pt.a;
    if (w > 0.0) {
      vec3 paint = pt.rgb;
      // the change of the reflections since the rest pose, from the solid's real normals (same env)
      float walls = step(3.5, part);
      vec3 dEnv = envAt(reflect(-V, N), walls) - envAt(reflect(-Vr, Nr), walls);
      dEnv = max(dEnv, dEnv * uEnvDarken);
      paint = clamp(paint + paint * 1.35 * dEnv * uEnvMix, 0.0, 1.0);
      col = mix(col, paint, w);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`

/** The rest camera's depth (texel space): −z encoded into RG (16 bits) between uDepthRange.x … y. */
export const DEPTH_VS = /* glsl */ `
varying float vZ;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

export const DEPTH_FS = /* glsl */ `
precision highp float;
uniform vec2 uDepthRange;
varying float vZ;
void main() {
  float v = clamp((vZ - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 1.0) * 255.0;
  gl_FragColor = vec4(floor(v) / 255.0, fract(v), 0.0, 1.0);
}
`

export const POST_TAG = '// title-mesh-post'

export const POST_VS = /* glsl */ `${POST_TAG}
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/**
 * The frame → the canvas. Row slips and edge crawl as in core/raster-gl.ts (the title's formulas:
 * crawl on e = eMove + restShimmer, slips on eMove², re-rolled on the shimmer tick), plus the inner
 * white-keyed fringe: a covered pixel within 1…(1 + wobble · 1.5) px of an empty one is pulled
 * toward the fringe colour. Empty pixels are discarded (the glow below shows through).
 */
export const POST_FS = /* glsl */ `${POST_TAG}
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uTick;
uniform vec2 uE;            // e (crawl), eMove (row slips)
uniform float uCrawl;
uniform vec3 uRow;          // probability, largest shift (px), run length (px)
uniform float uFringe;
uniform vec3 uFringeColor;
uniform float uFringeWobble;
${RASTER_GLSL}
vec4 src(vec2 p) {
  if (p.x < 0.0 || p.y < 0.0 || p.x >= uRes.x || p.y >= uRes.y) return vec4(0.0);
  return texelFetch(uSrc, ivec2(p), 0);
}
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  vec2 p = px;

  float bandH = 1.0 + floor(hash12(vec2(uTick, 3.7)) * 3.0);
  float band = floor(px.y / bandH);
  float run = uRow.z * (1.0 + 2.0 * hash12(vec2(band, uTick + 4.1)));
  float seg = floor((px.x + hash12(vec2(band, uTick + 5.3)) * 97.0) / run);
  if (hash12(vec2(band * 1.618 + seg * 31.7, uTick + 0.5)) < uRow.x * uE.y * uE.y) {
    float dir = hash12(vec2(band + seg, uTick + 1.7)) < 0.5 ? -1.0 : 1.0;
    p.x += dir * max(1.0, ceil(hash12(vec2(band, seg + uTick + 2.9)) * uRow.y));
  }

  vec4 c = src(p);
  if (c.a < 0.5) discard;
  float m = min(min(src(p + vec2(1.0, 0.0)).a, src(p - vec2(1.0, 0.0)).a), min(src(p + vec2(0.0, 1.0)).a, src(p - vec2(0.0, 1.0)).a));
  if (m < 0.5 && hash12(px * 0.37 + vec2(uTick * 7.13, uTick * 3.1)) < uCrawl * min(uE.x, 1.0)) discard;

  // fringe: 1 px everywhere on the cut, up to ~2.5 px where the wobble says so
  float wob = hash12(floor(px / 9.0) + 17.0) * 0.6 + hash12(floor(px / 23.0) + 5.0) * 0.4;
  float fr = m < 0.5 ? 1.0 : 0.0;
  if (fr < 0.5 && wob * uFringeWobble > 0.45) {
    float m2 = min(min(src(p + vec2(2.0, 0.0)).a, src(p - vec2(2.0, 0.0)).a), min(src(p + vec2(0.0, 2.0)).a, src(p - vec2(0.0, 2.0)).a));
    fr = m2 < 0.5 ? 0.6 : 0.0;
  }
  vec3 col = mix(c.rgb, uFringeColor, fr * uFringe);
  gl_FragColor = vec4(col, 1.0);
}
`

/**
 * The light behind the letters (raster/glow.ts) on the MESH: the same bake in texel space, drawn on a
 * plane of the solid. `uTexelToObj` maps a texel (x, y, 1, 0) to the object point the rest camera saw
 * there on that plane (homogeneous), so at rest the light sits exactly around the render's silhouette
 * and it turns with the solid. GLOW_FS reads vUv / vT as with the raster's own vertex shader.
 */
export const GLOW_MESH_VS = /* glsl */ `${GLOW_TAG}
uniform vec4 uRect;
uniform mat4 uTexelToObj;
varying vec2 vUv;
varying vec2 vT;
void main() {
  vUv = uv;
  vec2 t = mix(uRect.xy, uRect.zw, vec2(uv.x, 1.0 - uv.y));
  vT = t;
  vec4 P = uTexelToObj * vec4(t, 1.0, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * P;
}
`
