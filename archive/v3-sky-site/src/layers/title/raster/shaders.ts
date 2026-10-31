import { ABERRATION_GLSL } from '../../../core/aberration'

/**
 * Raster title shaders.
 *
 * Vertex: the cut-out render lives on a dense grid. Every vertex is pushed back ALONG ITS
 * REST VIEW RAY (so the still image is pixel-identical to the reference), by
 *   – the depth implied by the render's own perspective (VOLKOV is ~2.7× farther than the S),
 *   – the extrusion relief (front faces in front, wall back-edges behind).
 * Once the object turns toward the cursor, those depths produce real parallax.
 *
 * Fragment: hard alpha threshold on a point-sampled matte (stair-stepped, white-keyed fringe of
 * irregular width), reflection content that slides inside the chrome faces, an environment +
 * a small "lamp" hot spot that only exist as the DIFFERENCE from the rest pose (so the still is
 * the client's render, and the light visibly moves when the object turns), banded blue-white
 * glints on bevels, and energy-driven edge instability (inward threshold jitter / edge crawl,
 * rare short row slips inside a letter). No AA, no smoothing — everything is nearest-sampled on
 * the low-res pixel grid.
 */

export const TITLE_VS = /* glsl */ `
uniform sampler2D uMapsLin;
uniform vec2 uTexSize;
uniform vec2 uAnchor;
uniform vec2 uVanish;
uniform float uPersp;
uniform float uScale;
uniform float uRecess;
uniform float uRelief;
uniform vec3 uCamLocal;

varying vec2 vUv;
varying float vK;

void main() {
  vUv = uv;
  vec2 t = vec2(uv.x, 1.0 - uv.y) * uTexSize;          // texel coords, y down
  float L = uVanish.x - uAnchor.x;
  float q = clamp((t.x - uAnchor.x) / L, -0.9, 0.85);
  // extra perspective (title.perspective): moves the baked vanishing point
  float w = max(0.15, 1.0 + (uPersp - 1.0) * q);
  vec2 pw = vec2((t.x - uAnchor.x) / w, (t.y - uVanish.y) / w + uVanish.y - uAnchor.y);
  vec3 P = vec3(pw.x, -pw.y, 0.0) * uScale;            // rest plane, anchor at origin

  float k = 1.0 / (1.0 - q);                            // baked depth ratio vs the S
  float kp = 1.0 + uPersp * (k - 1.0);
  float relief = textureLod(uMapsLin, uv, 0.0).g;
  vec3 toP = P - uCamLocal;
  float f = 1.0 + uRecess * (kp - 1.0) + (1.0 - relief) * uRelief / length(toP);
  vec3 Pd = uCamLocal + toP * f;
  vK = k;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(Pd, 1.0);
}
`

export const TITLE_FS = /* glsl */ `
precision highp float;

uniform sampler2D uColor;
uniform sampler2D uMaps;
uniform sampler2D uNormals;
uniform vec2 uTexSize;
uniform float uBias;

uniform float uTime;
uniform float uEnergy;
uniform vec2 uPointer;
uniform vec2 uRot;
uniform float uRotZ;

uniform float uThreshold;
uniform float uFringe;
uniform vec3 uFringeColor;
uniform float uFringeWobble;

uniform float uHighlight;
uniform float uSlide;
uniform float uSlideMix;
uniform float uGlint;
uniform vec3 uGlintColor;
uniform float uGlintSharp;
uniform float uGlintSteps;
uniform float uLamp;
uniform float uLampSize;
uniform float uLampTravel;
uniform float uLampFade;
uniform vec3 uLampDir;
uniform float uSideShade;
uniform float uEnvMix;
uniform float uEnvDarken;
uniform float uEnvHorizon;
uniform vec3 uEnvSky;
uniform vec3 uEnvFloor;
uniform vec2 uRes;
uniform float uTanHalf;

uniform float uShimmer;
uniform float uShimmerFps;
uniform float uCrawl;
uniform float uJitter;
uniform float uRowGlitch;
uniform float uRowShift;
uniform float uRowRun;
uniform float uRestShimmer;

varying vec2 vUv;
varying float vK;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 rotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }

// Abstract studio: a ring of strip light around the view axis (brighter on top) + a hard
// little key up-left. Only the DIFFERENCE between "now" and "rest" is added, so the still
// stays the client's render and new glints appear only while the object turns.
float env(vec3 r) {
  float ang = acos(clamp(r.z, -1.0, 1.0));
  float ring = exp(-pow((ang - 0.62) * uGlintSharp * 0.25, 2.0)) * (0.55 + 0.45 * r.y);
  float key = pow(max(dot(r, normalize(vec3(-0.55, 0.65, 0.52))), 0.0), uGlintSharp * 2.0);
  return ring + key;
}

// Abstract, blurred environment (title-material.jpg behaviour, not its picture): grey floor,
// blue-white sky, two soft lights. Looked up with the object's normals and a per-pixel view ray.
vec3 envColor(vec3 r) {
  float sky = smoothstep(-0.28, 0.32, r.y + uEnvHorizon);
  vec3 c = mix(uEnvFloor, uEnvSky, sky);
  c += vec3(0.85, 0.92, 1.0) * pow(max(dot(r, normalize(vec3(-0.45, 0.55, 0.7))), 0.0), 10.0) * 0.7;
  c += vec3(0.55, 0.72, 1.0) * pow(max(dot(r, normalize(vec3(0.65, 0.15, 0.75))), 0.0), 6.0) * 0.35;
  return c;
}

// small hard "lamp" lobe; uLampSize = angular radius (rad)
float lampLobe(vec3 r) {
  return exp(-2.0 * (1.0 - dot(r, uLampDir)) / (uLampSize * uLampSize));
}

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float tick = floor(uTime * uShimmerFps);
  // idle sway gives a tiny energy — keep the edges calm then; instability ramps in with real motion
  float eMove = smoothstep(0.04, 0.6, uEnergy) * uShimmer;
  float e = clamp(eMove + uRestShimmer, 0.0, 2.0);
  vec2 ddx = dFdx(vUv);
  vec2 ddy = dFdy(vUv);
  vec2 uv = vUv;

  // ── rare row slips: a short run (≈ one letter's worth) of 1–3 render rows shifts by 1–2 px ──
  float bandH = 1.0 + floor(hash12(vec2(tick, 3.7)) * 3.0);
  float band = floor(px.y / bandH);
  float run = uRowRun * (1.0 + 2.0 * hash12(vec2(band, tick + 4.1)));
  float seg = floor((px.x + hash12(vec2(band, tick + 5.3)) * 97.0) / run);
  if (hash12(vec2(band * 1.618 + seg * 31.7, tick + 0.5)) < uRowGlitch * eMove * eMove) {
    float dir = hash12(vec2(band + seg, tick + 1.7)) < 0.5 ? -1.0 : 1.0;
    uv += ddx * dir * max(1.0, ceil(hash12(vec2(band, seg + tick + 2.9)) * uRowShift));
  }

  // ── matte + edge crawl (inward only: contour pixels get eaten, never sprinkled outside) ──────
  float m = texture(uMaps, uv, uBias).r;
  float edge = 1.0 - abs(m * 2.0 - 1.0);
  if (edge > 0.02 && hash12(px * 0.37 + vec2(tick * 7.13, tick * 3.1)) < uCrawl * min(e, 1.0)) {
    float h = hash12(px + vec2(tick * 1.31, 9.0));
    vec2 o = h < 0.25 ? vec2(1.0, 0.0) : h < 0.5 ? vec2(-1.0, 0.0) : h < 0.75 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
    m = min(m, texture(uMaps, uv + ddx * o.x + ddy * o.y, uBias).r);
  }
  // threshold jitter in short horizontal runs (3×1 render px) → stair-steps crawl along the
  // contour, mostly eating inward (an outward pop would show the source's white background)
  float blk = hash12(floor(px * vec2(0.3334, 1.0)) + vec2(tick * 13.1, tick * 5.3));
  float thr = uThreshold + (blk - 0.2) * uJitter * e;
  if (m < thr) discard;

  vec3 base = texture(uColor, uv, uBias).rgb;
  vec3 mp = texture(uMaps, uv, uBias).rgb;
  vec3 nt = texture(uNormals, uv, uBias + 1.5).rgb;   // coarse normals → coherent glints, not speckle

  // ── reflection slides inside the chrome faces (bevel rims stay put) ──────────
  vec2 offImg = -uPointer * uSlide * uHighlight / vK;            // texels, image space
  vec2 uv2 = uv + vec2(offImg.x, -offImg.y) / uTexSize;
  float deepHere = smoothstep(0.55, 0.95, mp.b);
  float deepThere = smoothstep(0.55, 0.95, texture(uMaps, uv2, uBias).b);
  vec3 refl = texture(uColor, uv2, uBias).rgb;
  float ws = deepHere * deepThere * uSlideMix * clamp(length(offImg) * 0.6, 0.0, 1.0);
  vec3 col = mix(base, refl, ws);

  // ── pseudo normals (image space → view space) turned with the object ─────────
  vec3 n = vec3(nt.rg * 2.0 - 1.0, 0.0);
  n.y = -n.y;
  n.xy = mat2(cos(uRotZ), sin(uRotZ), -sin(uRotZ), cos(uRotZ)) * n.xy;   // in-plane rotation
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  vec3 nNow = rotY(rotX(n, uRot.x), uRot.y);                     // real turn (wall shading)
  vec3 nRefl = rotY(rotX(n, uRot.x * uHighlight), uRot.y * uHighlight); // reflections: × response.highlight
  vec3 rRest = reflect(vec3(0.0, 0.0, -1.0), n);
  vec3 rNow = reflect(vec3(0.0, 0.0, -1.0), nRefl);
  float onFace = step(0.02, mp.b);
  float lumv = dot(base, vec3(0.299, 0.587, 0.114));

  // environment reflection on the chrome: only the change vs the rest pose, so the still keeps
  // the client's colour and the extra blue/contrast appears as the object turns
  vec3 vdir = normalize(vec3((gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y) * uTanHalf, -1.0));
  vec3 wrap = vec3(0.0, (lumv - 0.6) * 0.35, 0.0);               // wrap it into the baked streaks
  vec3 envNow = envColor(normalize(reflect(vdir, nRefl) + wrap));
  vec3 envRest = envColor(normalize(reflect(vdir, n) + wrap));
  float we = uEnvMix * (onFace * (0.55 + 0.45 * deepHere) + 0.3 * (1.0 - onFace));
  vec3 dEnv = envNow - envRest;
  dEnv = max(dEnv, dEnv * uEnvDarken);                            // darkening side is damped
  col = clamp(col + col * 1.35 * dEnv * we, 0.0, 1.0);

  // lamp: at rest it sits on the render's own hot spots (invisible: they ARE the lamp); as the
  // object turns it slides off them and travels across the faces as a small banded spot
  // (flat face plane, not the pseudo normals → one clean spot, not speckle on the walls)
  float lt = uHighlight * uLampTravel;
  vec3 nFace = vec3(0.0, 0.0, 1.0);
  float lRest = lampLobe(reflect(vdir, nFace));
  float lNow = lampLobe(reflect(vdir, rotY(rotX(nFace, uRot.x * lt), uRot.y * lt)));
  float lAdd = max(lNow - lRest, 0.0) * onFace * (0.25 + 0.75 * deepHere) * (0.45 + 0.7 * lumv);
  float lGone = max(lRest - lNow, 0.0) * nt.b;
  vec3 dull = texture(uColor, uv, uBias + 3.0).rgb;                 // local average of the chrome
  col = mix(col, min(col, dull), clamp(lGone * uLampFade * 1.5, 0.0, 1.0));
  lAdd = clamp(lAdd * uLamp, 0.0, 1.0);
  if (uGlintSteps > 0.5) lAdd = floor(lAdd * (uGlintSteps + 1.0)) / (uGlintSteps + 1.0);
  // blend toward the blue-white (not additive → no clipped pure-white cel blob)
  col = mix(col, max(col, uGlintColor), lAdd);

  float g = max(env(rNow) - env(rRest), 0.0);
  float rim = onFace * (1.0 - smoothstep(0.15, 0.6, mp.b));      // bevel band around each face
  g *= rim + 0.35 * (1.0 - onFace) + 0.2 * (onFace - rim);
  g *= 0.6 + 0.8 * nt.b;                                          // existing hot spots flare more
  if (uGlintSteps > 0.5) g = floor(g * uGlintSteps) / uGlintSteps;
  col += uGlintColor * g * uGlint;

  // walls: grey metal catches a little more / less light as it turns (clamped: never ink-black)
  vec3 Ls = normalize(vec3(-0.6, 0.45, 0.65));
  float dl = dot(nNow, Ls) - dot(n, Ls);
  col *= mix(clamp(1.0 + dl * uSideShade * 2.5, 0.6, 1.45), 1.0, onFace);

  // ── white-keyed fringe right at the cut; its width wanders 1–2.5 px along the contour ─────
  float wob = hash12(floor(vUv * uTexSize / 9.0) + 17.0) * 0.6 + hash12(floor(vUv * uTexSize / 23.0) + 5.0) * 0.4;
  float mF = min(m, texture(uMaps, uv, uBias + 2.4 * wob * uFringeWobble).r);
  float fr = 1.0 - smoothstep(thr, thr + 0.28, mF);
  col = mix(col, uFringeColor, fr * uFringe);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

/*
 * ── Light behind the title (title.glow, ./glow.ts) ─────────────────────────────────────────────
 *
 * A source behind the word throws rays out past the letters: thin shafts fanning out from
 * rays.center, each slowly brightening and fading at its own pace. (Optional: a rim on the contour
 * and a soft halo.) Baked in the render's own texel space (again only when a size knob moves), so it
 * follows the very silhouette the title shows and recedes with it:
 *   R = rim (narrow blur of the matte), G = halo (wide blur), B = ray fan: from every pixel outside
 *   the letters, march toward the source over rays.length — the share of the march inside letters is
 *   the light that reaches here. Behind a letter at least rays.length thick along the ray that is
 *   1 at its edge falling linearly to 0 at rays.length; behind a thinner run it starts at
 *   thickness / length, stays flat, then falls (so rays through long runs of letter are brighter).
 *   Zero inside the letters, softened by a small blur so letter corners leave no razor-straight streaks.
 * Sizes shrink towards VOLKOV like the letters (glow.perspective). The shafts themselves are cut out
 * of the fan per frame (GLOW_FS). Drawn as one mesh on the title's plane, a little behind the front
 * faces, under the title on its low-res pixel grid, written premultiplied as (light, max(light)):
 * over the sky that is screen for a neutral light, close to it for a pale one.
 * Every glow shader starts with GLOW_TAG: a glow program that fails to compile only switches the
 * light off, the title itself stays (index.ts → onShaderError).
 */
export const GLOW_TAG = '// title-glow'

/** Fullscreen quad for the bake passes. */
export const GLOW_BAKE_VS = /* glsl */ `${GLOW_TAG}
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** Shared by the bake passes: texel of a bake uv and the perspective shrink at a column. */
const GLOW_BAKE_COMMON = /* glsl */ `
uniform vec4 uRect;        // bake domain, texels: x0, y0, x1, y1 (y down)
uniform vec2 uAnchor;
uniform vec2 uVanish;
uniform float uPerspK;     // glow.perspective
varying vec2 vUv;

vec2 texelAt(vec2 uv) { return mix(uRect.xy, uRect.zw, vec2(uv.x, 1.0 - uv.y)); }

// 1 at the S, → 1 / (baked depth) further right: the letters' own size ratio
float depthScale(float x) {
  float q = clamp((x - uAnchor.x) / (uVanish.x - uAnchor.x), -0.9, 0.85);
  return mix(1.0, 1.0 - q, uPerspK);
}
`

/** Bake pass 1: matte → R, G (blurred next); ray fan → B. */
export const GLOW_PREP_FS = /* glsl */ `${GLOW_TAG}
precision highp float;
uniform sampler2D uMaps;   // maps.png, linear (R = matte)
uniform vec2 uTexSize;
uniform float uThreshold;
uniform vec2 uCenter;      // ray source, texels
uniform float uRayLen;     // ray length at the S, texels (0 = no rays)
${GLOW_BAKE_COMMON}

float matte(vec2 t) {
  vec2 uv = vec2(t.x / uTexSize.x, 1.0 - t.y / uTexSize.y);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return smoothstep(uThreshold - 0.06, uThreshold + 0.06, texture2D(uMaps, uv).r);
}

void main() {
  vec2 t = texelAt(vUv);
  float m = matte(t);
  float r = 0.0;
  vec2 d = uCenter - t;
  float dl = length(d);
  float L = min(uRayLen * depthScale(t.x), dl);
  if (L > 0.5 && m < 0.999) {
    vec2 dir = d / dl;
    for (int i = 1; i <= 64; i++) r += matte(t + dir * (L * float(i) / 64.0));
    r *= (1.0 - m) / 64.0;
  }
  gl_FragColor = vec4(m, m, r, 1.0);
}
`

/**
 * Bake passes 2–3: separable gaussian per channel — R rim, G halo, B the rays' softening (sigmas in
 * texels at the S, × the perspective shrink at this column). Up to 33 taps a side; wider kernels
 * step over pixels (the target is linearly filtered, so a step of 1.5 px still averages all of it).
 */
export const GLOW_BLUR_FS = /* glsl */ `${GLOW_TAG}
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;     // bake px
uniform vec2 uDir;         // (1, 0) or (0, 1)
uniform vec3 uSigma;       // rim, halo, rays
uniform float uPxPerTexel;
${GLOW_BAKE_COMMON}

void main() {
  vec3 sg = max(uSigma * depthScale(texelAt(vUv).x) * uPxPerTexel, vec3(0.35));
  vec3 st = max(vec3(1.0), 3.0 * sg / 32.0);
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(0.0);
  for (int i = -32; i <= 32; i++) {
    vec3 x = float(i) * st;
    vec3 w = exp(-0.5 * x * x / (sg * sg));
    acc.r += texture2D(uSrc, vUv + uDir * (x.r / uSrcSize)).r * w.r;
    acc.g += texture2D(uSrc, vUv + uDir * (x.g / uSrcSize)).g * w.g;
    acc.b += texture2D(uSrc, vUv + uDir * (x.b / uSrcSize)).b * w.b;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`

/** Per frame: the baked light on the title's plane, a little behind the front faces (title VS math). */
export const GLOW_VS = /* glsl */ `${GLOW_TAG}
uniform vec4 uRect;
uniform vec2 uAnchor;
uniform vec2 uVanish;
uniform float uPersp;
uniform float uScale;
uniform float uRecess;
uniform float uDepth;      // px behind the front faces
uniform vec3 uCamLocal;

varying vec2 vUv;
varying vec2 vT;

void main() {
  vUv = uv;
  vec2 t = mix(uRect.xy, uRect.zw, vec2(uv.x, 1.0 - uv.y));
  vT = t;
  float L = uVanish.x - uAnchor.x;
  float q = clamp((t.x - uAnchor.x) / L, -0.9, 0.85);
  float w = max(0.15, 1.0 + (uPersp - 1.0) * q);
  vec2 pw = vec2((t.x - uAnchor.x) / w, (t.y - uVanish.y) / w + uVanish.y - uAnchor.y);
  vec3 P = vec3(pw.x, -pw.y, 0.0) * uScale;
  float kp = 1.0 + uPersp * (1.0 / (1.0 - q) - 1.0);
  vec3 toP = P - uCamLocal;
  float f = 1.0 + uRecess * (kp - 1.0) + uDepth / length(toP);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uCamLocal + toP * f, 1.0);
}
`

export const GLOW_FS = /* glsl */ `${GLOW_TAG}
precision highp float;
uniform sampler2D uGlow;   // R rim, G halo, B ray fan
uniform vec4 uRect;
uniform float uFade;       // texels: fades out this close to the bake border
uniform float uAmount;
uniform vec3 uColor;
uniform vec3 uHaloColor;
uniform float uCore;
uniform float uHalo;
uniform float uRays;
uniform vec2 uCenter;      // ray source, texels
uniform float uTime;
uniform float uRayCount;
uniform float uRaySharp;
uniform float uRaySpeed;

varying vec2 vUv;
varying vec2 vT;

float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }

// ray k of n around the source: its own brightness, slowly rising and fading at its own pace
float ray(float k, float n) {
  k = mod(k, n);
  float speed = uRaySpeed * (0.5 + hash11(k * 3.7 + n));
  return 0.5 + 0.5 * sin(6.2831853 * (uTime * speed + hash11(k * 1.3 + 0.5 * n)));
}

// n rays per turn, blended smoothly into each other (th: 0…1 around the source)
float fan(float th, float n) {
  float x = th * n;
  float i = floor(x);
  return mix(ray(i, n), ray(i + 1.0, n), smoothstep(0.0, 1.0, x - i));
}

void main() {
  vec3 G = texture2D(uGlow, vUv).rgb;
  vec3 g = uColor * (G.r * uCore) + uHaloColor * (G.g * uHalo);
  if (uRays > 0.0 && G.b > 0.0) {
    vec2 d = vT - uCenter;
    float th = atan(d.y, d.x) / 6.2831853 + 0.5;
    float n = max(3.0, floor(uRayCount + 0.5));
    // two interleaved fans of different counts → shafts of uneven width and spacing
    float s = 0.6 * fan(th, n) + 0.4 * fan(fract(th + 0.37), floor(n * 2.3));
    s = pow(s, uRaySharp);
    // a brighter ray also reaches further: the fan falls off outward, its power sets the length
    g += uColor * (pow(G.b, mix(2.5, 0.8, s)) * s * uRays);
  }
  g = 1.0 - exp(-uAmount * g);            // soft knee: where lights pile up they never clip flat
  vec2 e = min(vT - uRect.xy, uRect.zw - vT);
  g *= smoothstep(0.0, uFade, min(e.x, e.y));
  // premultiplied (light, max(light)) → ≈ screen over the sky behind the canvas
  gl_FragColor = vec4(g, max(g.r, max(g.g, g.b)));
}
`

/**
 * Chromatic aberration of the title (post.aberration; the lens itself — core/aberration.ts).
 * The title is first rendered as usual into a target of its own size, then this pass reads it once
 * per channel — red at p − d, green at p, blue at p + d — nearest-sampled on the same low-res grid:
 * the fringes are whole render pixels, nothing is smoothed. The canvas is transparent, and the
 * three channels no longer share one coverage, so the pass is drawn twice (raster/aberration.ts):
 *   uMask 1 — (1 − alpha_r, 1 − alpha_g, 1 − alpha_b), opaque: multiplied into what is below;
 *   uMask 0 — the premultiplied colour of each channel: added on top (plus-lighter).
 * Together: below_c · (1 − alpha_c) + colour_c — source-over, per channel.
 * Both start with POST_TAG: if they fail to compile the title is drawn without the aberration.
 */
export const POST_TAG = '// title-aberration'

export const POST_VS = /* glsl */ `${POST_TAG}
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const POST_FS = /* glsl */ `${POST_TAG}
precision highp float;
uniform sampler2D uSrc;    // the title as usual (premultiplied), nearest
uniform vec2 uRes;         // canvas px
uniform vec2 uView;        // hero size, CSS px
uniform vec4 uAb0;         // core/aberration.ts
uniform vec4 uAb1;
uniform float uMask;
${ABERRATION_GLSL}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 k = uView / uRes;                                           // CSS px per render px
  vec2 d = aberrationShift(vec2(fc.x, uRes.y - fc.y) * k, uAb0, uAb1) / k;
  d.y = -d.y;                                                      // y down → canvas y up
  vec4 r = texture(uSrc, (fc - d) / uRes);
  vec4 g = texture(uSrc, fc / uRes);
  vec4 b = texture(uSrc, (fc + d) / uRes);
  gl_FragColor = uMask > 0.5
    ? vec4(1.0 - vec3(r.a, g.a, b.a), 1.0)
    : vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a)));
}
`
