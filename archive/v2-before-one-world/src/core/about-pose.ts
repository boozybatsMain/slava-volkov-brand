import { num, obj } from './loose'
import type { ResolvedConfig } from './types'

/**
 * ABOUT — a word turned in depth (sky.config.ts → about.holes.*.yaw / pitch, about.turn).
 *
 * A hole (ABOUT, THAT'S, ALL FOR NOW, a giant letter) is a flat line of letters turned in 3D like the
 * title SLAVA VOLKOV and seen through a perspective camera, then laid on the 2D sheet. In the hole's
 * own frame (sheet units, origin at its centre, x along the line, y down) a point (x, y) is rotated
 *   P = Ry(yaw) · Rx(pitch) · (x, y, 0)
 * and projected from distance d (= about.turn.perspective × the hole's width):
 *   x' = P.x · d / (d + P.z),   y' = P.y · d / (d + P.z)
 * — one projective map, the same for the canvas, the 2D fallback, the notes' overlap check and the
 * camera (which must know where the A's deepest point lands: the pull-back starts there).
 *
 * Signs: yaw > 0 — the right end comes nearer (bigger), < 0 — it recedes (SLAVA VOLKOV recedes to the
 * right); pitch > 0 — the bottom recedes, < 0 — the top recedes. The centre stays where it is.
 */

export type M3 = Float64Array

const DEG = Math.PI / 180

/**
 * The turn of a hole as a 3×3 homogeneous map of its own frame (x, y, 1) → (x', y', w): null when the
 * hole is not turned. `d` — the camera distance, sheet units.
 */
export function turnMatrix(yawDeg: number, pitchDeg: number, d: number): M3 | null {
  if (!yawDeg && !pitchDeg) return null
  const cy = Math.cos(yawDeg * DEG)
  const sy = Math.sin(yawDeg * DEG)
  const cp = Math.cos(pitchDeg * DEG)
  const sp = Math.sin(pitchDeg * DEG)
  // Ry · Rx applied to (x, y, 0): columns of x and y
  //   Rx: (x, y, 0) → (x, y·cp, y·sp)
  //   Ry: (X, Y, Z) → (X·cy + Z·sy, Y, −X·sy + Z·cy)
  const r11 = cy
  const r12 = sp * sy
  const r21 = 0
  const r22 = cp
  const r31 = -sy
  const r32 = sp * cy
  const k = 1 / Math.max(1e-6, d)
  return new Float64Array([r11, r12, 0, r21, r22, 0, r31 * k, r32 * k, 1])
}

export function applyM3(m: M3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8]
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 0
  return [(m[0] * x + m[1] * y + m[2]) * iw, (m[3] * x + m[4] * y + m[5]) * iw]
}

/** Smallest local stretch of the map at (x, y) (σ_min of its Jacobian): how much a small circle shrinks. */
export function minStretch(m: M3, x: number, y: number) {
  const e = 1e-4
  const [x0, y0] = applyM3(m, x, y)
  const [x1, y1] = applyM3(m, x + e, y)
  const [x2, y2] = applyM3(m, x, y + e)
  const a = (x1 - x0) / e
  const c = (y1 - y0) / e
  const b = (x2 - x0) / e
  const dd = (y2 - y0) / e
  // singular values of [[a, b], [c, dd]]
  const s1 = a * a + b * b + c * c + dd * dd
  const s2 = Math.sqrt(Math.max(0, (a * a + b * b - c * c - dd * dd) ** 2 + 4 * (a * c + b * dd) ** 2))
  return Math.sqrt(Math.max(0, (s1 - s2) / 2))
}

/** about.turn read loosely. */
export function turnKnobs(config: ResolvedConfig) {
  const t = obj(obj((config as unknown as { about?: unknown }).about).turn)
  const fade = obj(t.fade)
  return {
    /** camera distance in widths of the hole */
    perspective: Math.max(0.2, num(t.perspective, 1.6)),
    tiltX: num(t.tiltX, 5),
    tiltY: num(t.tiltY, 8),
    maxTurn: Math.max(0, num(t.maxTurn, 12)),
    mass: Math.max(0.05, num(t.mass, 1.1)),
    /** the pointer's turn is full below zoom `full` and gone above zoom `none` (the pull-back's close-ups) */
    fadeFull: Math.max(0.1, num(fade.full, 1.6)),
    fadeNone: Math.max(0.2, num(fade.none, 4)),
  }
}

/**
 * The base turn (no pointer) of a hole from the config: about.holes.<key> { width, yaw, pitch }.
 * null — not turned (or no such hole).
 */
export function holeTurn(config: ResolvedConfig, key: string): M3 | null {
  const h = obj(obj(obj((config as unknown as { about?: unknown }).about).holes)[key])
  const width = Math.max(1e-3, num(h.width, 1))
  return turnMatrix(num(h.yaw, 0), num(h.pitch, 0), turnKnobs(config).perspective * width)
}
