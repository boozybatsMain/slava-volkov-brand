/**
 * Film grain + dither for the raw-WebGL2 canvases added after the sky (the about sheet): the very
 * same functions as sky-layers/shaders.ts → COMMON, which keeps its own copy on purpose — the sky's
 * shader text must not change under a screen it does not know about. Change one, change both.
 *
 * The GLSL expects the includer to declare:
 *   uniform vec4 uGrain;   // amount, size (in the units of the `fc` passed to filmGrain), blend, -
 *   uniform uint uSeed;
 * filmGrain(s, fc): s — display-space (sRGB) colour, fc — the pixel's position on the grain lattice's
 * grid (gl_FragCoord.xy in sky-layers, where size is pre-multiplied by canvas px per CSS px).
 * The noise lattice is fc / size: the same CSS grid on every canvas whose fc / size agree.
 */
export const GRAIN_GLSL = /* glsl */ `
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
`

export interface GrainKnobs {
  amount: number
  size: number
  fps: number
  blend: number
}

/**
 * This frame's grain uniforms. `unit` — grain-lattice units per CSS px of the `fc` the shader passes
 * (canvas px per CSS px when fc = gl_FragCoord). Under reduced motion the grain stands still (seed 0),
 * as on the sky.
 */
export function grainUniforms(k: GrainKnobs, time: number, reduced: boolean, unit: number) {
  const fps = reduced ? 0 : Math.max(0, k.fps)
  const seed = fps > 0 ? Math.floor(time * fps) % 1000003 : 0
  const grain: [number, number, number, number] = [Math.max(0, k.amount), Math.max(0, k.size) * unit, Math.min(1, Math.max(0, k.blend)), 0]
  return { grain, seed }
}
