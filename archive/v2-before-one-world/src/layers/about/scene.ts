import { topicCenter, toScreen, withParallax, type AboutCamera } from '../../core/about-camera'
import { turnMatrix } from '../../core/about-pose'
import type { ResolvedConfig } from '../../core/types'
import type { Glyph } from './glyphs'
import type { AboutKnobs, HoleKnobs, PhotoKnobs } from './knobs'

/**
 * ABOUT — where every hole and photo is on screen this frame: pure geometry, shared by the WebGL
 * renderer (its instance rows), the 2D fallback and the notes' composition check (about-text/check.ts),
 * so all of them see the same thing.
 *
 * An element lives in its own frame (sheet units, origin at its centre, unrotated). Its chain to the
 * screen: a hole's turn in depth — core/about-pose.ts: its yaw / pitch + its share of the pointer's
 * turn (holeTurnAt), a photo's keystone tilt — (projective, in its own frame) → its rotation → its
 * place on the sheet (+ the depth parallax of core/about-camera.ts → withParallax) → the camera → the
 * pointer sway × (1 + depth). The chain is projective as a whole, so it is carried as ONE 3×3 matrix —
 * taken the other way, screen CSS px → the element's own coordinates (glyph px for a hole, sheet
 * units from the photo's top-left corner for a photo): the shader and the CPU just multiply.
 */

export type M3 = Float64Array

const DEG = Math.PI / 180

/** Unit square (0,0) (1,0) (1,1) (0,1) → quad q0…q3, as x = (a s + b t + c) / (g s + h t + 1) (Heckbert). */
export function squareToQuad(q: number[]): M3 {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const dy3 = y0 - y1 + y2 - y3
  const det = dx1 * dy2 - dx2 * dy1
  const g = det && (dx3 || dy3) ? (dx3 * dy2 - dx2 * dy3) / det : 0
  const h = det && (dx3 || dy3) ? (dx1 * dy3 - dx3 * dy1) / det : 0
  return new Float64Array([x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1])
}

export function inv3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const k = Math.abs(det) > 1e-30 ? 1 / det : 0
  return new Float64Array([A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k])
}

export function mul3(a: M3, b: M3): M3 {
  const o = new Float64Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}

export function apply3(m: M3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8]
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 0
  return [(m[0] * x + m[1] * y + m[2]) * iw, (m[3] * x + m[4] * y + m[5]) * iw]
}

/**
 * A photo's keystone (photos.items.*.tilt) in its own frame, half-size (hw, hh): the top edge
 * (1 − tilt / 2) as wide, the bottom (1 + tilt / 2) — a picture lying back from the viewer (tilt > 0)
 * or leaning forward (< 0). null — none. (The holes turn in true 3D: holeTurnAt.)
 */
function keystone(hw: number, hh: number, tilt: number): M3 | null {
  if (!tilt) return null
  const t = 1 - tilt / 2
  const b = 1 + tilt / 2
  const src = squareToQuad([-hw, -hh, hw, -hh, hw, hh, -hw, hh])
  const dst = squareToQuad([-hw * t, -hh, hw * t, -hh, hw * b, hh, -hw * b, hh])
  return mul3(dst, inv3(src))
}

/** Identity up to 60 % of `max`, then rolls off smoothly towards `max` (the title's softLimit). */
function softLimit(a: number, max: number) {
  if (max <= 0) return a
  const k = 0.6 * max
  const s = Math.abs(a)
  if (s <= k) return a
  return Math.sign(a) * (k + (max - k) * Math.tanh((s - k) / (max - k)))
}

/**
 * base + add, where the pointer's part `add` gives way as the whole turn nears `max` (soft limit of
 * base + add) — but the base itself is kept exactly (the camera turns the entry point by the bare
 * base: core/about-camera.ts → aboutEntry); add 0 → exactly the base.
 */
function limited(base: number, add: number, max: number) {
  if (!add) return base
  return base + softLimit(base + add, max) - softLimit(base, max)
}

/**
 * The turn of a hole this frame as a 3×3 map of its own frame (sheet units around its centre): its
 * yaw / pitch (degrees) + its share (`turn`) of the pointer's turn `ptr` (core.ts: degrees, already
 * faded by the zoom), the pointer's part softly limited by maxTurn; perspective from perspective ×
 * its width. null — not turned. With the pointer's part at 0 it is exactly core/about-pose → holeTurn.
 */
export function holeTurnAt(
  h: { yaw: number; pitch: number; turn: number; width: number },
  ptr: { yaw?: number; pitch?: number },
  tk: { perspective: number; maxTurn: number },
): M3 | null {
  const yaw = limited(h.yaw, h.turn * (ptr.yaw ?? 0), tk.maxTurn)
  const pitch = limited(h.pitch, h.turn * (ptr.pitch ?? 0), tk.maxTurn)
  return turnMatrix(yaw, pitch, tk.perspective * Math.max(1e-3, h.width))
}

export interface Sway {
  /** the sheet's offset from the pointer, CSS px (snapped to whole cells) */
  x: number
  y: number
  /**
   * The pointer's turn of the words (about.turn), degrees — before each hole's `turn` share: yaw (+ the
   * right end nearer) and pitch (+ the bottom recedes). 0 close up (the pull) and under reduced motion.
   */
  yaw: number
  pitch: number
}

export interface Placed {
  /** screen CSS px → the element's own coordinates (homogeneous) */
  M: M3
  /** screen box of everything the element can draw (crumbs / debris included), CSS px */
  box: [number, number, number, number]
}

/** element frame → screen, CSS px */
function chain(cam: AboutCamera, sway: Sway, cx: number, cy: number, rotation: number, depth: number, T: M3 | null) {
  const c = Math.cos(rotation * DEG)
  const s = Math.sin(rotation * DEG)
  const k = 1 + depth
  return (x: number, y: number): [number, number] => {
    if (T) [x, y] = apply3(T, x, y)
    const [sx, sy] = toScreen(cam, cx + c * x - s * y, cy + s * x + c * y)
    return [sx + sway.x * k, sy + sway.y * k]
  }
}

function boxOf(pts: [number, number][], grow: number): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow]
}

/** Screen → unit square of the screen quad q (corners of the element's (0,0) (1,0) (1,1) (0,1)), scaled to (sx, sy). */
function screenToLocal(q: [number, number][], sx: number, sy: number): M3 {
  const toUnit = inv3(squareToQuad(q.flat()))
  return mul3(new Float64Array([sx, 0, 0, 0, sy, 0, 0, 0, 1]), toUnit)
}

/** The centre of an element on the sheet this frame (its own place + the depth parallax). */
export function centreOf(config: ResolvedConfig, cam: AboutCamera, x: number, y: number, depth: number, topic: string) {
  return withParallax(cam, topicCenter(config, topic), x, y, depth)
}

/** Sheet units per glyph px of a hole (its `width` is the ink width). */
export const unitsPerPx = (k: HoleKnobs, g: Glyph) => k.width / Math.max(1, g.inkW)

/**
 * A hole: M takes screen px to glyph px of its padded atlas rect. `grow` — extra screen margin (aberration
 * reach). Turned in depth (holeTurnAt) about its ink centre — the point the config's x / y put on the sheet.
 */
export function placeHole(config: ResolvedConfig, cam: AboutCamera, sway: Sway, k: HoleKnobs, g: Glyph, grow: number, tk: AboutKnobs['turn']): Placed {
  const upp = unitsPerPx(k, g)
  const [cx, cy] = centreOf(config, cam, k.x, k.y, k.depth, k.topic)
  const T = holeTurnAt(k, sway, tk)
  const f = chain(cam, sway, cx, cy, k.rotation, k.depth, T)
  const icx = g.inkX + g.inkW / 2
  const icy = g.inkY + g.inkH / 2
  const at = (gx: number, gy: number) => f((gx - icx) * upp, (gy - icy) * upp)
  const q = [at(0, 0), at(g.w, 0), at(g.w, g.h), at(0, g.h)]
  return { M: screenToLocal(q, g.w, g.h), box: boxOf(q, grow) }
}

/**
 * A photo: M takes screen px to sheet units from its top-left corner (u · width, v · height). The box
 * covers the debris reach (`reach`, sheet units) on every side.
 */
export function placePhoto(config: ResolvedConfig, cam: AboutCamera, sway: Sway, k: PhotoKnobs, reach: number, grow: number): Placed & { W: number; H: number } {
  const W = k.width
  const H = k.width / k.aspect
  const [cx, cy] = centreOf(config, cam, k.x, k.y, k.depth, k.topic)
  const T = keystone(W / 2, H / 2, k.tilt)
  const f = chain(cam, sway, cx, cy, k.rotation, k.depth, T)
  const q = [f(-W / 2, -H / 2), f(W / 2, -H / 2), f(W / 2, H / 2), f(-W / 2, H / 2)]
  const R = reach
  const outer = [f(-W / 2 - R, -H / 2 - R), f(W / 2 + R, -H / 2 - R), f(W / 2 + R, H / 2 + R), f(-W / 2 - R, H / 2 + R)]
  return { M: screenToLocal(q, W, H), box: boxOf(outer, grow), W, H }
}

/** Does a screen box touch the stage (W × H CSS px)? */
export const onStage = (b: [number, number, number, number], W: number, H: number) => b[2] >= 0 && b[3] >= 0 && b[0] <= W && b[1] <= H

/** The share of a box that lies inside the stage, 0…1 (the tour photos' LOD pop-in waits for 40 %). */
export function shareOnStage(b: [number, number, number, number], W: number, H: number) {
  const area = Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
  const w = Math.max(0, Math.min(W, b[2]) - Math.max(0, b[0]))
  const h = Math.max(0, Math.min(H, b[3]) - Math.max(0, b[1]))
  return (w * h) / area
}

/** Quantise k (0…1) into `steps` stipple steps: 0, then 1/steps as soon as it starts, …, 1 at its end. */
export function stipple(k: number, steps: number) {
  if (k <= 0) return 0
  if (k >= 1) return 1
  return Math.min(steps, Math.floor(k * (steps - 1)) + 1) / steps
}

/** A small stable integer from a key (per-element noise seed). */
export function seedOf(key: string) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return (h >>> 0) % 9973
}
