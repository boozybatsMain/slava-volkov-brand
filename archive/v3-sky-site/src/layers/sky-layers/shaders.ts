import { ABERRATION_GLSL } from '../../core/aberration'
import type { LayerKind } from './params'

/** What a compositor draws: the opaque sky, the transparent canvas over the title, or the veil. */
export type CompositorMode = 'back' | 'front' | 'veil'

/**
 * Shaders of the layered sky. One full-screen pass composites every layer (plate → moon →
 * clouds / banks), in linear light with premultiplied alpha, then encodes to sRGB and adds the
 * film grain + a dither. The compositor is generated for the current list of layers (each layer
 * needs its own sampler and its own drawing function), and recompiled only if that list changes.
 *
 * FRONT mode (the second canvas, above the title): only clouds / banks, composited onto
 * transparency; the output is premultiplied sRGB (what a transparent canvas wants), and the very
 * same grain field (same seed, same canvas grid, same size) is added only where a cloud is —
 * scaled by its alpha, so the bare title under the canvas never gets grain.
 *
 * VEIL mode (the third canvas, above the title AND the tagline; config.veil): front mode plus the
 * FOG — after its clouds, everything dissolves into the veil's own plate (the void), in drifting
 * patches and from the bottom up, until the canvas is opaque; layers marked afterFog are drawn over
 * the fog and come in with it. No aberration there (its uniforms are zero: one read of the stack).
 *
 * Conventions (all shaders): p = CSS px from the top-left of the hero, y down. Layer textures
 * are SRGB8_ALPHA8 holding PREMULTIPLIED linear colour (baked once on load, see BAKE_FS), so
 * filtering, mipmaps and compositing are all correct — no dark fringes around clouds.
 * Every sample uses an explicit LOD (layers are axis-aligned and uniformly scaled → one LOD per
 * layer, computed on the CPU): no derivative glitches at the wrapped / mirrored seams.
 */

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

/**
 * Straight-alpha sRGB image → premultiplied linear, written to an SRGB8_ALPHA8 target (the GPU
 * re-encodes on write). Texel for texel (texelFetch), so the image orientation is preserved.
 */
export const BAKE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 o;
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
void main() {
  vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  o = vec4(toLinear(c.rgb) * c.a, c.a);
}
`

const COMMON = /* glsl */ `
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 linToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// pcg3d — integer hash, stable on every GPU (no sin() precision games)
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float rnd(uvec2 q, uint s) { return float(pcg3d(uvec3(q, s)).x) * (1.0 / 4294967296.0); }

/** Colour grade of one layer, on unpremultiplied colour in a perceptual (gamma 2.2) space:
 *  contrast around mid-grey → brightness → saturation → tint (luminance-normalised multiply). */
vec4 grade(vec4 p, int i) {
  if (uGB[i].w < 0.5 || p.a <= 1e-5) return p;
  vec4 g = uGA[i];
  vec3 c = pow(p.rgb / p.a, vec3(1.0 / 2.2));
  c = (c - 0.5) * g.z + 0.5;
  c *= g.y;
  c = mix(vec3(dot(c, LUMA)), c, g.x);
  c *= mix(vec3(1.0), uGB[i].rgb, g.w);
  return vec4(pow(max(c, 0.0), vec3(2.2)) * p.a, p.a);
}

/** Slow flow distortion ("billow"), CSS px. Attached to the layer (moves with it), the field
 *  itself slides slowly through noise space: clouds seem to breathe, not to swim. */
vec2 flow(vec2 p, int i) {
  vec4 b = uB[i];
  if (b.x <= 0.0) return vec2(0.0);
  vec2 q = (p - uRect[i].xy) / (max(b.y, 1.0) * 8.0);
  vec2 n = textureLod(uNoise, q + vec2(b.z, 0.37 * b.z), 0.0).rg
         + 0.5 * textureLod(uNoise, q * 2.03 + vec2(-0.61 * b.w, b.w) + 0.5, 0.0).rg;
  return (n - 0.75) * (b.x / 0.75);
}

/** Film grain (display space, monochrome) added to sRGB colour s at canvas pixel fc. */
vec3 filmGrain(vec3 s, vec2 fc) {
  if (uGrain.x <= 0.0) return s;
  float n;
  float gsz = uGrain.y;
  if (gsz <= 1.0) {
    n = rnd(uvec2(fc), uSeed);
  } else {
    vec2 q = fc / gsz;
    vec2 c0 = floor(q);
    vec2 f = q - c0;
    f = f * f * (3.0 - 2.0 * f);
    uvec2 k = uvec2(c0);
    float a = rnd(k, uSeed), b = rnd(k + uvec2(1u, 0u), uSeed);
    float c = rnd(k + uvec2(0u, 1u), uSeed), d = rnd(k + uvec2(1u, 1u), uSeed);
    // value noise has less variance than white noise: bring it back up
    n = 0.5 + (mix(mix(a, b, f.x), mix(c, d, f.x), f.y) - 0.5) * 1.6;
  }
  float L = dot(s, LUMA);
  float w = mix(1.0, 4.0 * L * (1.0 - L), uGrain.z);
  return s + (n - 0.5) * 2.0 * uGrain.x * w;
}

/** ±1 LSB triangular dither. */
float dither(vec2 fc) {
  return (rnd(uvec2(fc), uSeed ^ 0x9e3779b9u) - rnd(uvec2(fc) + 7919u, uSeed ^ 0x85ebca6bu)) / 255.0;
}

float mirror1(float u) { return 1.0 - abs(1.0 - mod(u, 2.0)); }
vec2 mirror2(vec2 u) { return 1.0 - abs(1.0 - mod(u, 2.0)); }

/** The sky photo: covers the screen (the CPU guarantees it), mirrored beyond its edges as a
 *  last line of defence. Returns linear rgb. */
vec3 plateLayer(sampler2D t, int i, vec2 p) {
  vec4 r = uRect[i];
  vec2 uv = mirror2((p - r.xy) / r.zw);
  return grade(textureLod(t, uv, uP[i].w), i).rgb;
}

/** A free-floating picture (cloudlets): premultiplied, feathered towards its own borders;
 *  with uQ.y > 0 it repeats every uQ.y px horizontally (wrap drift). */
vec4 cloudsLayer(sampler2D t, int i, vec2 p) {
  vec4 r = uRect[i];
  p += flow(p, i);
  vec2 uv = (p - r.xy) / r.zw;
  if (uQ[i].y > 0.0) uv.x = mod(p.x - r.x, uQ[i].y) / r.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec2 e = min(uv, 1.0 - uv) * r.zw;
  if (uQ[i].x > 0.5) uv.x = 1.0 - uv.x;
  vec4 c = textureLod(t, uv, uP[i].w);
  float f = uP[i].y * min(r.z, r.w);
  if (f > 0.0) c *= smoothstep(0.0, f, min(e.x, e.y));
  return grade(c, i) * uP[i].x;
}

/** A cloud bank: repeated sideways (mirrored, or plain repeat with a cross-faded seam of
 *  uP.z of the width), mirrored downward below the image, transparent above (top feather).
 *  uQ.z = solid: below the image its last rows simply go on (a wall with a flat body — its file
 *  ends in one flat colour), so no upside-down skyline can ever rise into the frame. */
vec4 bankLayer(sampler2D t, int i, vec2 p) {
  vec4 r = uRect[i];
  p += flow(p, i);
  vec2 uv = (p - r.xy) / r.zw;
  if (uv.y < 0.0) return vec4(0.0);
  float top = uv.y;
  uv.y = uQ[i].z > 0.5 ? min(uv.y, 0.998) : mirror1(uv.y);
  bool flip = uQ[i].x > 0.5;
  float seam = uP[i].z;
  float lod = uP[i].w;
  vec4 c;
  if (seam <= 0.0) {
    float u = mirror1(uv.x);
    c = textureLod(t, vec2(flip ? 1.0 - u : u, uv.y), lod);
  } else {
    float period = 1.0 - seam;
    float u = uv.x - floor(uv.x / period) * period;
    c = textureLod(t, vec2(flip ? 1.0 - u : u, uv.y), lod);
    if (u < seam) {
      float v = u + period;
      vec4 prev = textureLod(t, vec2(flip ? 1.0 - v : v, uv.y), lod);
      c = mix(prev, c, smoothstep(0.0, seam, u));
    }
  }
  float f = uP[i].y;
  if (f > 0.0) c *= smoothstep(0.0, f, top);
  return grade(c, i) * uP[i].x;
}

/** The moon, composited in place: hazy disc (ring blur), phase mask (terminator), soft glow.
 *  blend 0 = covers the sky like paint, 1 = adds light to it (as the real moon does). */
void moonLayer(inout vec3 col, sampler2D t, int i, vec2 p) {
  vec4 r = uRect[i];
  vec2 uv = (p - r.xy) / r.zw;
  vec2 d = (uv - uMoon0.xy) / uMoon0.zw;          // disc units: 1 = the limb
  float gs = max(uMoon3.w, 0.05);
  vec2 gd = (d - uMoon4.xy) / gs;
  float reach = dot(gd, gd);
  if (reach > 16.0 && dot(d, d) > 1.6) return;
  vec4 c = vec4(0.0);
  if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
    vec2 h = uMoon1.xy;
    float lod = uMoon1.z;
    if (h.x > 0.0) {
      c = 0.2 * textureLod(t, uv, lod);
      for (int k = 0; k < 8; k++) {
        float a = float(k) * 0.785398 + 0.39;
        c += 0.1 * textureLod(t, uv + h * vec2(cos(a), sin(a)), lod);
      }
    } else {
      c = textureLod(t, uv, lod);
    }
    vec2 dr = vec2(uMoon2.y * d.x + uMoon2.z * d.y, -uMoon2.z * d.x + uMoon2.y * d.y);
    float edge = uMoon2.x * sqrt(max(0.0, 1.0 - dr.y * dr.y));
    float lit = smoothstep(-uMoon2.w, uMoon2.w, dr.x - edge);
    c = grade(c, i) * mix(uMoon4.z, 1.0, lit) * uP[i].x;
  }
  col = col * (1.0 - c.a * (1.0 - uMoon1.w)) + c.rgb;
  col += uMoon3.rgb * exp(-reach);
}

/** Veil: how much fog there is at p, 0…1. uFog.a is the amount for the whole frame; the densest
 *  patches of a slow noise field (uFogB.x) and the bottom of the screen (uFogB.z) get there first,
 *  the thinnest patches at the top last — but at 0 there is none anywhere, at 1 it is everywhere. */
float fogAt(vec2 p) {
  float k = uFog.a;
  if (k <= 0.0) return 0.0;
  if (k >= 1.0) return 1.0;
  float s = uFogB.x;
  float v = uFogB.z;
  float a = k * (1.0 + s + v) - v * (1.0 - clamp(p.y / max(uView.y, 1.0), 0.0, 1.0));
  if (s > 0.0) {
    vec2 q = p * uFogB.y;
    // (the phase wraps at 4: every offset below is then a whole number of noise tiles)
    float n = textureLod(uNoise, q + vec2(uFogB.w, 0.25 * uFogB.w), 0.0).r
            + 0.5 * textureLod(uNoise, q * 2.03 + vec2(0.5 - 1.25 * uFogB.w, 0.5 + 0.5 * uFogB.w), 0.0).g;
    a -= s * n / 1.5;
  }
  a = clamp(a, 0.0, 1.0);
  return a * a * (3.0 - 2.0 * a);
}
`

/**
 * The compositor for this list of layers (back → front).
 * 'back':  the sky behind the title (opaque: backdrop → plate → … → grain).
 * 'front': the layers above the title (clouds / banks only) on a transparent canvas.
 * 'veil':  as 'front', then the fog into the plate, then the layers flagged in `afterFog`.
 */
export function compositorFS(kinds: LayerKind[], mode: CompositorMode = 'back', afterFog: boolean[] = []): string {
  const n = Math.max(1, kinds.length)
  // a transparent canvas over other layers (premultiplied output): 'front' and 'veil'
  const transparent = mode !== 'back'
  const samplers = kinds.map((_, i) => `uniform sampler2D uT${i};`).join('\n')
  const over = (fn: string, i: number, mul = '') =>
    transparent
      ? `  if (uP[${i}].x > 0.0) { vec4 c = ${fn}(uT${i}, ${i}, p)${mul}; acc = c + acc * (1.0 - c.a); }`
      : `  if (uP[${i}].x > 0.0) { vec4 c = ${fn}(uT${i}, ${i}, p); col = c.rgb + col * (1.0 - c.a); }`
  const layer = (kind: LayerKind, i: number, mul = '') => {
    switch (kind) {
      case 'plate':
        return transparent ? '' : `  col = mix(col, plateLayer(uT${i}, ${i}, p), uP[${i}].x);`
      case 'moon':
        return transparent ? '' : `  if (uP[${i}].x > 0.0) moonLayer(col, uT${i}, ${i}, p);`
      case 'bank':
        return over('bankLayer', i, mul)
      default:
        return over('cloudsLayer', i, mul)
    }
  }
  const lines = (after: boolean, mul = '') =>
    kinds
      .map((kind, i) => (mode === 'veil' && !!afterFog[i] !== after ? '' : layer(kind, i, mul)))
      .filter(Boolean)
      .join('\n')
  let body = lines(false)
  if (mode === 'veil') {
    // the fog: what is drawn so far — and, the canvas turning opaque, everything under it —
    // dissolves into the plate (the void); without a plate (or until it loads) into the flat colour
    const plate = kinds.indexOf('plate')
    const target = plate < 0 ? 'uFog.rgb' : `mix(uFog.rgb, plateLayer(uT${plate}, ${plate}, p), uP[${plate}].x)`
    body += /* glsl */ `
  float fog = fogAt(p);
  if (fog > 0.0) {
    acc = mix(acc, vec4(${target}, 1.0), fog);
  ${lines(true, ' * fog').replace(/\n/g, '\n  ')}
  }`
  }

  // The layers are composited by a function of the position, so the chromatic aberration
  // (post.aberration, core/aberration.ts) can sample the whole stack once per channel: red at
  // p − d, green at p, blue at p + d — exact for this canvas. Where the shift is below a quarter of
  // a canvas pixel (the clean centre; everywhere with the aberration off) the stack is evaluated
  // once, as before.
  const main = transparent
    ? /* glsl */ `
vec4 stackAt(vec2 p) {
  vec4 acc = vec4(0.0);
${body}
  return acc;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = vec2(fc.x, uView.y * uPR.y - fc.y) / uPR;
  vec2 d = aberrationShift(p, uAb0, uAb1);
  vec4 r, g, b;
  if (dot(d * uPR, d * uPR) < 0.0625) {
    g = stackAt(p);
    r = g;
    b = g;
  } else {
    r = stackAt(clamp(p - d, vec2(0.0), uView));
    g = stackAt(p);
    b = stackAt(clamp(p + d, vec2(0.0), uView));
  }
  // three coverages: with the aberration on, the canvas is composited per channel
  // (core/channel-split.ts) — first drawn as the mask (uMask 1: 1 − coverage of each channel,
  // multiplied into what is below), then as the light (each channel's own premultiplied colour,
  // added). Its alpha is the largest coverage: valid premultiplied, and the right one wherever the
  // channels agree (everything without the aberration).
  vec3 a = vec3(r.a, g.a, b.a);
  float alpha = max(a.r, max(a.g, a.b));
  if (uMask > 0.5) { o = vec4(1.0 - a, 1.0); return; }
  // nothing here → fully transparent: the title below stays untouched (no grain, no dither)
  if (alpha < 1.0 / 1024.0) { o = vec4(0.0); return; }
  vec3 s = linToSrgb(vec3(r.r, g.g, b.b) / max(a, vec3(1e-6)));
  s = filmGrain(s, fc) + dither(fc);
  o = vec4(clamp(s, 0.0, 1.0) * a, alpha);
}
`
    : /* glsl */ `
vec3 stackAt(vec2 p) {
  vec3 col = mix(uTop, uBottom, clamp(p.y / max(uView.y, 1.0), 0.0, 1.0));
${body}
  return col;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = vec2(fc.x, uView.y * uPR.y - fc.y) / uPR;
  vec2 d = aberrationShift(p, uAb0, uAb1);
  vec3 col;
  if (dot(d * uPR, d * uPR) < 0.0625) {
    col = stackAt(p);
  } else {
    // a post effect on the finished frame: beyond the screen edge, the edge itself
    col = vec3(stackAt(clamp(p - d, vec2(0.0), uView)).r, stackAt(p).g, stackAt(clamp(p + d, vec2(0.0), uView)).b);
  }
  // film grain (display space, monochrome), then a ±1 LSB triangular dither
  vec3 s = filmGrain(linToSrgb(col), fc) + dither(fc);
  o = vec4(s, 1.0);
}
`

  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
#define N ${n}
uniform vec2 uView;        // hero size, CSS px
uniform vec2 uPR;          // canvas px per CSS px (x, y)
uniform vec4 uRect[N];     // layer image rect: x, y, w, h (CSS px)
uniform vec4 uP[N];        // opacity, feather, seam, lod
uniform vec4 uQ[N];        // flipX, wrap period (px), solid (bank), -
uniform vec4 uB[N];        // billow: amount px, size px, phase a, phase b
uniform vec4 uGA[N];       // grade: saturation, brightness, contrast, tint amount
uniform vec4 uGB[N];       // grade: tint rgb (luminance 1), on
uniform vec4 uMoon0;       // disc centre (uv), radius (uv x, uv y)
uniform vec4 uMoon1;       // haze radius (uv x, uv y), haze lod, blend
uniform vec4 uMoon2;       // terminator, cos tilt, sin tilt, softness
uniform vec4 uMoon3;       // glow colour × strength (linear), glow size (disc radii)
uniform vec4 uMoon4;       // glow centre offset (disc units), earthshine, -
uniform vec4 uGrain;       // amount, size (canvas px), blend, -
uniform vec4 uAb0;         // aberration: centre (CSS px), 1 / half-diagonal, amount (CSS px)
uniform vec4 uAb1;         // aberration: shift x, y (CSS px), curve, clean centre radius
uniform float uMask;       // front, aberration on: 1 = the mask pass (core/channel-split.ts)
uniform vec4 uFog;         // veil: fog colour (linear rgb), amount 0…1
uniform vec4 uFogB;        // veil: patchiness, 1 / (patch size px × 8), lift, drift phase (noise uv)
uniform uint uSeed;
uniform vec3 uTop;         // backdrop while the plate is missing (linear)
uniform vec3 uBottom;
uniform sampler2D uNoise;
${samplers}
out vec4 o;
${COMMON}
${ABERRATION_GLSL}
${main}`
}
