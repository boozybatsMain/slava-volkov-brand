/**
 * SLAB — the shadow: a blob on the void's floor, set in dots on the slab's own pixel lattice. Its
 * density falls off in whole steps, each step an ordered (Bayer) stipple — the way a 32-bit console
 * drew "transparency". Binary coverage: a lattice pixel is a dot or it is not.
 *
 * A plain 2D canvas under the slab's (same lattice: same buffer size, same CSS size), not a part of
 * the WebGL frame — for the same reason the void itself has no chromatic aberration: the shadow
 * lies on the floor of the "photograph", and a lens shift of one lattice pixel would pull every
 * dot of a stipple apart into a red, a grey and a blue one — a coloured mesh, not a fringe.
 * It also serves the no-WebGL fallback as it is. No three.js here.
 */

import { slabTexts } from '../../core/slab-pose'
import type { SlabKnobs, SlabSolution } from './solve'

/** 4×4 ordered (Bayer) ranks, row by row: the stipple of the shadow — and of the fallback's arrival (shaders.ts → bayer4 is the same table). */
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

export interface ShadowBlob {
  /** Centre and half-axes of the ellipse, lattice px (y down). */
  cx: number
  cy: number
  rx: number
  ry: number
  /** Share of lattice pixels that are dots at the centre, 0…1. */
  density: number
  /** Whole steps the density falls off in, centre → rim. */
  steps: number
  /**
   * The falloff's shape: the density at radius r (0 centre … 1 rim) is (1 − r²)^soft. 1 — a parabola:
   * the rim is the steepest place, the blob has an outline; 2 and more — the density leaves the rim
   * gently and gathers toward the middle: no outline, a pool.
   */
  soft: number
  color: string
}

/**
 * The blob for this pose on a lattice of `ps` CSS px: under the slab's centre (shifted away from the
 * light), on the floor; it breathes with the float and fills in with the arrival's stipple.
 *
 * It never lies behind the texts under the slab (dots behind small type read as dirt): its top
 * edge stays shadow.clear below where they end at rest (core/slab-pose.ts → slabTexts). On a low
 * window that pushes it down, partly off the bottom of the screen — as a floor that goes on would.
 */
export function shadowBlob(sol: SlabSolution, K: SlabKnobs, ps: number, stipple: number): ShadowBlob {
  const S = K.shadow
  const centre = sol.point(0, 0, -0.5)
  const breathe = 1 + S.breathe * sol.bob
  const half = (S.height * sol.H) / 2
  const texts = slabTexts.current
  const top = Math.max(S.y * sol.safeH - half, texts ? texts.bottom + S.clear * sol.safeH : -Infinity)
  return {
    cx: (centre.x + S.skew * sol.w) / ps,
    cy: (top + half) / ps,
    rx: (S.width * sol.w * breathe) / 2 / ps,
    ry: (half * breathe) / ps,
    density: S.opacity * stipple,
    steps: S.steps,
    soft: S.soft,
    color: S.color,
  }
}

export function createSlabShadow() {
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    display: 'block',
    imageRendering: 'pixelated',
    pointerEvents: 'none',
  })
  canvas.setAttribute('aria-hidden', 'true')
  const g = canvas.getContext('2d')
  let key = ''
  /** rows painted last time (cleared before the next paint) */
  let dirty: [number, number] = [0, 0]
  /** 4×4 tiles, by colour and number of dots (1…16): the canvas pattern repeats them from its origin */
  const tiles = new Map<string, CanvasPattern | null>()

  const tile = (color: string, dots: number) => {
    const id = `${color}|${dots}`
    if (!tiles.has(id) && g) {
      const t = document.createElement('canvas')
      t.width = t.height = 4
      const tg = t.getContext('2d')!
      tg.fillStyle = color
      BAYER.forEach((rank, i) => rank < dots && tg.fillRect(i & 3, i >> 2, 1, 1))
      tiles.set(id, g.createPattern(t, 'repeat'))
    }
    return tiles.get(id) ?? null
  }

  return {
    canvas,

    /**
     * Paint the blob on a lattice of `w` × `h` pixels, each `ps` CSS px (the canvas takes that size).
     * Nothing happens while the blob lands on the same lattice pixels as last time.
     */
    draw(w: number, h: number, ps: number, blob: ShadowBlob) {
      if (!g) return
      const steps = Math.max(1, Math.round(blob.steps))
      const [cx, cy] = [Math.round(blob.cx * 2) / 2, Math.round(blob.cy * 2) / 2]
      const [rx, ry] = [Math.max(0.5, Math.round(blob.rx)), Math.max(0.5, Math.round(blob.ry))]
      const density = Math.min(1, Math.max(0, blob.density))
      const soft = Math.min(8, Math.max(0.25, blob.soft || 1))
      const k = `${w}|${h}|${ps}|${cx}|${cy}|${rx}|${ry}|${density.toFixed(3)}|${steps}|${soft}|${blob.color}`
      if (k === key) return
      key = k
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      } else g.clearRect(0, dirty[0], w, dirty[1] - dirty[0])
      canvas.style.width = `${w * ps}px`
      canvas.style.height = `${h * ps}px`
      const y0 = Math.max(0, Math.floor(cy - ry))
      const y1 = Math.min(h, Math.ceil(cy + ry))
      dirty = [y0, y1]
      // step L (1 = the rim … steps = the centre) covers the ellipse shrunk to where the falloff
      // (1 − r²)^soft reaches (L − 1) / steps — by √(1 − (L − 1) / steps) for soft 1; each one
      // overwrites the lighter step under it
      for (let level = 1; level <= steps; level++) {
        const dots = Math.floor((density * level) / steps * 16 + 0.5)
        const fill = dots > 0 ? tile(blob.color, Math.min(16, dots)) : null
        const k2 = 1 - Math.pow((level - 1) / steps, 1 / soft)
        for (let y = y0; y < y1; y++) {
          const dy = (y + 0.5 - cy) / ry
          const half2 = k2 - dy * dy
          if (half2 <= 0) continue
          const half = rx * Math.sqrt(half2)
          const x0 = Math.max(0, Math.ceil(cx - half - 0.5))
          const x1 = Math.min(w, Math.floor(cx + half - 0.5) + 1)
          if (x1 <= x0) continue
          g.clearRect(x0, y, x1 - x0, 1)
          if (fill) {
            g.fillStyle = fill
            g.fillRect(x0, y, x1 - x0, 1)
          }
        }
      }
    },

    dispose() {
      canvas.remove()
    },
  }
}

export type SlabShadow = ReturnType<typeof createSlabShadow>
