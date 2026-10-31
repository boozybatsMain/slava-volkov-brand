import type { Layout } from '../../../core/types'
import type { Meta } from './fallback'

/**
 * The title's REST geometry, shared by the title layer (solvePose) and by anything that has to sit
 * on the title's plane (the sky overlay's nav and tagline).
 *
 * Texel space = reference/title-main.jpg as cut by build_assets.py: the render's perspective is
 * baked in — letter verticals stay vertical, the top / bottom edges (meta.lines) run into the
 * vanishing point meta.vanish.
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Texel → rest-plane local (title.perspective), the "S" anchor at the origin. Same as the vertex shader. */
export function warpTexel(meta: Meta, persp: number, x: number, y: number) {
  const [ax, ay] = meta.anchor
  const [vx, vy] = meta.vanish
  const q = clamp((x - ax) / (vx - ax), -0.9, 0.85)
  const w = Math.max(0.15, 1 + (persp - 1) * q)
  return { x: (x - ax) / w, y: (y - vy) / w + vy - ay, q }
}

/** Top / bottom edge of the title at texel column x (texel y). */
export const titleEdgeY = (meta: Meta, edge: 'top' | 'bottom', x: number) =>
  meta.lines[edge][0] * x + meta.lines[edge][1]

/**
 * Texel → CSS px on screen at the title's rest pose: anchor on layout.title.{x,y}, span
 * layout.title.width, in-plane rotation layout.title.rotation. With title.tilt = 0 (both pages)
 * this is exactly where the title layer draws it; a base tilt would move the title a little off it.
 */
export function titleRestMap(meta: Meta, layout: Layout, persp: number) {
  const [bx0, , bx1] = meta.bbox
  const ay = meta.anchor[1]
  const span = warpTexel(meta, persp, bx1, ay).x - warpTexel(meta, persp, bx0, ay).x
  /** CSS px per texel */
  const scale = layout.title.width / Math.max(1, span)
  const a = (layout.title.rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return {
    scale,
    toScreen(x: number, y: number) {
      const c = warpTexel(meta, persp, x, y)
      const lx = c.x * scale
      const ly = c.y * scale
      return { x: layout.title.x + cos * lx - sin * ly, y: layout.title.y + sin * lx + cos * ly }
    },
  }
}
