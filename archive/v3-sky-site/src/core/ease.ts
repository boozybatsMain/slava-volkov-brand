/**
 * Small pure helpers for choreography: every scroll-driven layer builds its motion from these,
 * so "0.34 → 0.6 of the way" means the same curve everywhere.
 */

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const lerp = (a: number, b: number, k: number) => a + (b - a) * k

/** Where `v` is between `a` and `b`, clamped to 0…1 (a === b: a step at `a`; b < a runs backwards). */
export const remap = (v: number, a: number, b: number) => (a === b ? (v >= a ? 1 : 0) : clamp01((v - a) / (b - a)))

/** Smoothstep on a 0…1 input: soft start and stop. */
export const smooth = (k: number) => {
  const t = clamp01(k)
  return t * t * (3 - 2 * t)
}

/** Smootherstep on a 0…1 input: softer ends (zero acceleration there), a faster middle. */
export const smoother = (k: number) => {
  const t = clamp01(k)
  return t * t * t * (t * (t * 6 - 15) + 10)
}
