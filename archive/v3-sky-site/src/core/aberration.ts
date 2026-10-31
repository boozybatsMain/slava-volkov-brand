import type { Layout, ResolvedConfig } from './types'

/**
 * Chromatic aberration (post.aberration in hero.config.ts) — one lens for the whole frame.
 *
 * There is no shared frame buffer: the sky, the title and the front clouds are separate canvases.
 * So every layer applies the SAME per-channel displacement to its own image — the red image moves
 * by d(p), the blue one by −d(p), green stays — and the result is exactly the aberrated composite,
 * as long as transparent layers are composited per channel (each channel with its own coverage):
 *   composite_c(p − d_c) = layer_c(p − d_c) + below_c(p − d_c) · (1 − alpha_c(p − d_c)).
 * The opaque sky simply samples its layers three times; the title splits into a multiply mask and
 * an additive light (title/raster); the soft front clouds approximate it with one alpha.
 *
 * d(p), CSS px, y down: q = (p − centre) / half-diagonal (|q| = 1 in a corner), r = |q|,
 *   d = amount · k · ramp(r) · q / r + shift · k,      ramp(r) = (max(0, r − start) / (1 − start))^curve,
 *   k = half-diagonal / that of 1440×900, × (1 + motion · pointer.energy).
 * As in games: nothing inside the clean centre (r < start), then it grows toward the corners, where
 * it is exactly `amount`. Shared GLSL: ABERRATION_GLSL (uniforms uAb0 / uAb1, see below).
 */

/** The screen `amount` and `shift` are given for (px at its corner): 1440×900. */
const REF_HALF_DIAG = Math.hypot(1440, 900) / 2

export interface Aberration {
  /** false → no aberration at all: layers draw exactly as without it (no extra passes) */
  on: boolean
  /** uAb0: optical centre (CSS px), 1 / half-diagonal, red displacement at a corner (CSS px) */
  a0: [number, number, number, number]
  /** uAb1: uniform red displacement x, y (CSS px), curve, start (radius of the clean centre) */
  a1: [number, number, number, number]
  /** the largest displacement anywhere on screen, CSS px (margins of partial redraws) */
  reach: number
}

type Knobs = ResolvedConfig['post']['aberration']

/** Structural switch (config only, not the pointer): flips the title's render path, so not per frame. */
export function aberrationOn(config: ResolvedConfig) {
  const k: Knobs | undefined = config.post?.aberration
  return !!k && (k.amount !== 0 || k.shift.x !== 0 || k.shift.y !== 0)
}

/** This frame's lens for a hero of `layout` size. `energy` — frame.pointer.energy (0…1). */
export function aberrationAt(config: ResolvedConfig, layout: Layout, energy: number): Aberration {
  const k = config.post?.aberration
  const W = Math.max(1, layout.width)
  const H = Math.max(1, layout.height)
  if (!k || !aberrationOn(config)) return { on: false, a0: [W / 2, H / 2, 0, 0], a1: [0, 0, 0, 0], reach: 0 }
  const R = Math.hypot(W, H) / 2
  const scale = (R / REF_HALF_DIAG) * (1 + Math.max(0, k.motion) * Math.min(1, Math.max(0, energy)))
  const cx = W * k.center.x
  const cy = H * k.center.y
  const amount = k.amount * scale
  const curve = Math.min(4, Math.max(0.5, k.curve))
  const start = Math.min(0.9, Math.max(0, k.start))
  const sx = k.shift.x * scale
  const sy = k.shift.y * scale
  // farthest corner from the centre → the largest radial term
  const qMax = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy)) / R
  const reach = Math.abs(amount) * Math.pow(Math.max(0, qMax - start) / (1 - start), curve) + Math.hypot(sx, sy)
  return { on: true, a0: [cx, cy, 1 / R, amount], a1: [sx, sy, curve, start], reach }
}

/**
 * GLSL (ES 3.0, also fine inside three's ShaderMaterial): the RED image's displacement at p
 * (CSS px, y down); blue gets the opposite one. Sample red at p − d, green at p, blue at p + d.
 */
export const ABERRATION_GLSL = /* glsl */ `
vec2 aberrationShift(vec2 p, vec4 a0, vec4 a1) {
  vec2 q = (p - a0.xy) * a0.z;
  float r = length(q);
  float ramp = r > a1.w ? pow((r - a1.w) / (1.0 - a1.w), a1.z) : 0.0;
  return q * (a0.w * ramp / max(r, 1e-4)) + a1.xy;
}
`
