import { navDock } from '../../core/nav-dock'
import type { Frame, Layout, ResolvedConfig } from '../../core/types'
import type { AboutCore, AboutState, HoleInst, PhotoInst } from './core'
import { distAt, type GlyphSet } from './glyphs'
import type { AboutRenderer } from './index'
import { hexRgb, type AboutKnobs } from './knobs'
import { debrisReach, DOCK_PAD, MARGIN, type PhotoSlot } from './photos'
import { apply3, inv3 } from './scene'

/**
 * ABOUT — the sheet without WebGL (no WebGL2, `?nogl=about`, a shader that fails, a lost context).
 *
 * The weak devices this is for cannot afford per-cell work every frame, so everything is
 * PRE-RASTERISED once and only drawn with drawImage on the same low-res lattice as the WebGL sheet
 * (one canvas pixel per cell, `image-rendering: pixelated`, image smoothing off — nearest everywhere,
 * never CSS-transformed):
 *   · each hole: its eroded mask at the HOME zoom (the letters' texel = raster.block cells, locked to
 *     the sheet like the WebGL letters: a closer camera magnifies those texels, nearest), cut out of
 *     the sheet (destination-out), then its «photocopy» overlay (wash, flat blotches, toner
 *     rectangles, the grit — resolved on a giant fragment, a faint mottle on the word — scratches,
 *     specks) drawn back in; the row slip as in the shader;
 *   · each photo: its torn, graded, quantised picture at the home size × a half-octave zoom bucket
 *     (√2 steps, with hysteresis: the tour's 0.9…1.6 needs two or three) — the same edge blocks,
 *     bites, debris and displaced blocks as the shader, the halftone auto-levelled in 2 × 2 dots;
 *   · crosses: a few cells each.
 * The art never depends on the live zoom — the draw transform does the zooming — so a tour reuses
 * it: per kind a small LRU (≈ 2 × the instances on screen, ≥ 8), each photo file's pixels read once
 * per version. A new piece of art is built progressively (BUILD_MS of rows a frame, the elements on
 * screen in order) and drawn once complete: a giant fragment never costs one frame 50 ms. Meanwhile
 * the last finished art of that hole / window (another size, bucket or knob set) stands in, drawn
 * through the current transform — a resize or a new bucket never blanks anything. The art keys carry
 * what the art depends on (knobs, cell, unit), so nothing is ever cleared wholesale.
 * No grain, no aberration, no LOD; a projective map (a hole's turn in depth with its share of the
 * pointer's turn, a photo's keystone tilt) is drawn as the affine through the midpoints of its sides
 * (the far end of a turned word is not smaller here — the slant and the squeeze survive). The camera is the reduced-motion one (the sheet dissolves
 * in at the home framing instead of the pull-back — without reduced motion only after the slab's own
 * leave, core.ts; the tour is a straight line through the keys). The photo zoom bucket is a pure
 * function of pos when the scroll is pinned. The stipples (the dissolve, the photo and cross reveals,
 * the nav dock's edge) are a Bayer pattern on the cell lattice, as in the shader. Photos
 * under the nav dock are darkened (about.photos.dock) like the shader does.
 * It still publishes aboutFrame (index.ts, core.ts).
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
/** Time spent building new art per frame, ms (at least one row of one piece always gets done). */
const BUILD_MS = 2.5

/** pcg3d's first lane — the JS twin of the shaders' h3 (the same decisions, as far as it matters). */
function h3(cx: number, cy: number, s: number) {
  let x = (Math.imul((cx + 65536) >>> 0, 1664525) + 1013904223) >>> 0
  let y = (Math.imul((cy + 65536) >>> 0, 1664525) + 1013904223) >>> 0
  let z = (Math.imul((s + 4096) >>> 0, 1664525) + 1013904223) >>> 0
  x = (x + Math.imul(y, z)) >>> 0
  y = (y + Math.imul(z, x)) >>> 0
  z = (z + Math.imul(x, y)) >>> 0
  x ^= x >>> 16
  y ^= y >>> 16
  z ^= z >>> 16
  x = (x + Math.imul(y, z)) >>> 0
  return x / 4294967296
}

/** Soft value noise, −1…1 (the shaders' vnoise). */
function vnoise(x: number, y: number, s: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  let fx = x - ix
  let fy = y - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = h3(ix, iy, s)
  const b = h3(ix + 1, iy, s)
  const c = h3(ix, iy + 1, s)
  const d = h3(ix + 1, iy + 1, s)
  return (a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fy) * 2 - 1
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** The letters' erosion at the home zoom (the shader's erodes() without the zoom octaves). */
function erodes(K: AboutKnobs, qx: number, qy: number, d: number, rough: number, seed: number, tx: number) {
  const L = K.letters
  const band = L.band * rough
  const cs = Math.max(L.cell, tx)
  if (d > band + 2 * cs) return true
  if (d < -3 * cs - band) return false
  const bx = Math.floor(qx / L.chunk)
  const by = Math.floor(qy / L.chunk)
  let e = d
  const hc = h3(bx, by, seed + 7)
  const amt = L.chunkAmount * rough * L.home
  const cam = L.cellAmount * rough * L.home
  if (hc < amt) e -= band * (0.5 + 0.5 * h3(bx, by, seed + 9))
  else if (hc > 1 - amt * 0.35) e += band * (0.3 + 0.4 * h3(bx, by, seed + 9))
  const cx = Math.floor(qx / cs)
  const cy = Math.floor(qy / cs)
  if (Math.abs(e) < cs && h3(cx, cy, seed + 11) < cam) e = -e
  if (e < 0 && e > -3 * cs && h3(cx, cy, seed + 13) < cam * 0.12 * (1 + e / (3 * cs))) return true
  if (e > 0 && e < 0.5 * band && h3(cx, cy, seed + 14) < cam * 0.08) return false
  return e > 0
}

/** The shader's row slip: a band of 2–4 rows in a block of 5 pushed sideways by 1…4 texels (0 — not this row). */
function slipAt(row: number, slip: number, seed: number) {
  if (slip <= 0) return 0
  const blk = Math.floor(row / 5)
  const r0 = row - blk * 5
  const hb = 2 + Math.floor(h3(blk, 5, seed) * 3)
  const s0 = Math.floor(h3(blk, 6, seed) * (6 - hb))
  if (h3(blk, 7, seed) >= (slip * 5) / 3 || r0 < s0 || r0 >= s0 + hb) return 0
  const sh = 1 + Math.floor(h3(blk, 11, seed) * 4)
  return h3(blk, 13, seed) < 0.5 ? -sh : sh
}

const makeCanvas = (w: number, h: number) => {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return c
}

/** A piece of pre-rasterised art; `job` — the rows still to do (until: performance.now() deadline → done?). */
interface Art {
  job: ((until: number) => boolean) | null
}

interface HoleArt extends Art {
  /** the cut (alpha 255 = hole) and what is drawn back into it, one pixel per texel */
  mask: HTMLCanvasElement
  over: HTMLCanvasElement
}

interface PhotoArt extends Art {
  canvas: HTMLCanvasElement
}

/** A small least-recently-used map: get / set move a key to the young end, trim drops the old end. */
class Lru<T> {
  private map = new Map<string, T>()
  get(k: string) {
    const v = this.map.get(k)
    if (v !== undefined) {
      this.map.delete(k)
      this.map.set(k, v)
    }
    return v
  }
  set(k: string, v: T) {
    this.map.delete(k)
    this.map.set(k, v)
  }
  trim(cap: number) {
    for (const k of this.map.keys()) {
      if (this.map.size <= cap) break
      this.map.delete(k)
    }
  }
  clear() {
    this.map.clear()
  }
  get size() {
    return this.map.size
  }
}

/**
 * How close up a hole's letters are at the home zoom (the shader's closeness(): the fallback lives at
 * zoom 1, so only the hole's own letter scale counts — ABOUT and the finale 0, a giant fragment ≈ 1).
 */
function closeness(K: AboutKnobs, tex: number) {
  return smoothstep(0, 1, clamp01(Math.log(Math.max(1e-3, tex)) / Math.log(Math.max(1.01, K.letters.texture.full))))
}

/**
 * A hole's mask + overlay at texel `tx` (sheet units), over its padded glyph rect — built row by row.
 * The overlay is the shader's interior() at the home zoom, one pixel per texel (the fallback's fine
 * cell and grit cell are the texel itself).
 */
function holeArt(set: GlyphSet, h: HoleInst, tx: number, K: AboutKnobs): HoleArt | null {
  const g = h.g
  const step = tx / h.upp
  const nx = Math.ceil(g.w / step)
  const ny = Math.ceil(g.h / step)
  const mask = makeCanvas(nx, ny)
  const over = makeCanvas(nx, ny)
  const mg = mask.getContext('2d')
  const og = over.getContext('2d')
  if (!mg || !og) return null
  const mi = mg.createImageData(nx, ny)
  const oi = og.createImageData(nx, ny)
  const L = K.letters
  const wash = hexRgb(L.wash.color)
  const wa = L.wash.amount
  const ps = L.patches.size * h.tex
  // the blotches' own texel grows with the letter (the shader's bt)
  const kb = Math.max(1, Math.floor(h.tex + 0.5))
  const bt = tx * kb
  const cl = closeness(K, h.tex)
  // patches.home of the blotches at the home framing … all of them close up (a giant fragment)
  const amount = L.patches.amount * (L.patches.home + (1 - L.patches.home) * cl)
  const cover = L.patches.cover
  const t0 = 0.6 - (cover - 0.25) * 0.5
  const t1 = t0 + 0.1 / kb + (0.004 - 0.1 / kb) * cl
  const mottle = h.k.mottle
  const dark = clamp01(mottle - 1)
  const seed = h.seed
  const upp = h.upp
  const gr = L.grit * cl
  // scratches: scratches.length screen cells at the home zoom, in texels (the fallback's fine cell)
  const len = Math.max(2, L.scratches.length / K.raster.block)
  // the toner bars: about a patch tall, in texels
  const blen = Math.max(4, (ps * 0.9) / tx)
  let j = 0
  const art: HoleArt = { mask, over, job: null }
  art.job = (until) => {
    while (j < ny) {
      const shift = slipAt(j, h.k.slip, seed)
      for (let i = 0; i < nx; i++) {
        const gx = (i + shift + 0.5) * step
        const gy = (j + 0.5) * step
        if (gx < 0 || gx > g.w) continue
        const qx = gx * upp
        const qy = gy * upp
        const d = distAt(set, g.ax + gx, g.ay + gy) * upp
        if (!erodes(K, qx, qy, d, h.k.rough, seed, tx)) continue
        const o = (j * nx + i) * 4
        mi.data[o + 3] = 255
        // the photocopy (the full texture ramp: the fallback lives at the home zoom), premultiplied
        let r = wash[0] * wa
        let gg = wash[1] * wa
        let b = wash[2] * wa
        let a = wa
        const darken = (k: number) => {
          r *= 1 - k
          gg *= 1 - k
          b *= 1 - k
          a += k * (1 - a)
        }
        const bx = (Math.floor(qx / bt) + 0.5) * bt
        const by = (Math.floor(qy / bt) + 0.5) * bt
        const n = (vnoise(bx / ps, by / ps, seed + 21) * 0.65 + vnoise(bx / (ps * 0.3), by / (ps * 0.3), seed + 20) * 0.35) * 0.5 + 0.5
        const bl = smoothstep(t0, t1, n)
        let pa = amount * mottle * bl * (0.75 + 0.25 * vnoise(bx / (ps * 0.5), by / (ps * 0.5), seed + 27)) * (1 - 0.6 * cl)
        const pbx = Math.floor(qx / ps)
        const pby = Math.floor(qy / (ps * 2.6))
        const toner = h3(pbx, pby, seed + 22) < cover * 0.1 * mottle * mottle
        if (toner) {
          const tn = 0.45 + 0.25 * h3(pbx, pby, seed + 23)
          const light = amount * tn * (1 + 1.2 * cl)
          pa = Math.max(pa, light + (tn - light) * dark)
        }
        pa = Math.max(pa, amount * 0.08 * (0.5 + 0.5 * vnoise(bx / (ps * 0.6), by / (ps * 0.6), seed + 26)))
        pa *= 1 + (h3(i, j, seed + 45) - 0.5) * 0.9 * cl
        darken(Math.min(0.85, Math.max(0, pa)))
        // the grit seen from afar: a faint flat mottle of its clusters
        const gz = smoothstep(0.35, 0.8, vnoise(qx / (ps * 0.35), qy / (ps * 0.35), seed + 40) * 0.5 + 0.5)
        darken(L.grit * (1 - cl) * (0.07 + 0.12 * Math.max(gz * 0.9, (toner ? 1 : bl) * mottle * 0.85)))
        // the grit itself (close up: a giant fragment): one texel a grain
        if (gr > 0) {
          const gz2 = vnoise(qx / (ps * 0.08), qy / (ps * 0.08), seed + 46) * 0.5 + 0.5
          const bc = Math.floor(i / 3)
          const bo = Math.floor(h3(bc, 1, seed + 47) * blen)
          const bs = Math.floor((j + bo) / blen)
          const bar = h3(bc, bs, seed + 48) < 0.04 && h3(i, bs, seed + 49) < 0.7 ? 0.8 : 0
          const k = Math.max(gz * (0.4 + 1.2 * gz2 * gz2), (toner ? 1 : bl) * mottle * (0.5 + 0.7 * gz2))
          const wv = vnoise(qx / (tx * 2.5), qy / (tx * 2.5), seed + 54) * 0.5 + 0.5
          let tone = gr * 0.4 * clamp01(0.6 * h3(i, j, seed + 51) + 0.7 * wv - 0.35) * (0.45 + 0.55 * Math.min(k, 1))
          if (h3(i, j, seed + 52) < gr * Math.max(0.01 + 0.085 * k * k, bar)) tone = 0.2 + 0.5 * h3(i, j, seed + 53)
          if (h3(Math.floor(i / 3), Math.floor(j / 3), seed + 55) < gr * 0.03 * k && h3(i, j, seed + 56) < 0.75) tone = 0.85
          darken(tone)
        }
        const off = Math.floor(h3(i, 0, seed + 31) * len)
        const segment = Math.floor((j + off) / len)
        if (h3(i, segment, seed + 32) < 0.006) darken(L.scratches.amount * (0.6 + 0.4 * h3(i, segment, seed + 33)))
        const near = 1 + 1.5 * (1 - smoothstep(0, 0.012, d))
        if (h3(i, j, seed + 25) < L.specks * near) darken(0.9)
        // un-premultiply for ImageData
        oi.data[o] = a > 0 ? Math.round((r / a) * 255) : 0
        oi.data[o + 1] = a > 0 ? Math.round((gg / a) * 255) : 0
        oi.data[o + 2] = a > 0 ? Math.round((b / a) * 255) : 0
        oi.data[o + 3] = Math.round(a * 255)
      }
      j++
      if (j < ny && performance.now() > until) return false
    }
    mg.putImageData(mi, 0, 0)
    og.putImageData(oi, 0, 0)
    return true
  }
  return art
}

/**
 * The block grid of a torn edge (the shader's tornGrid): stripes along the nearest torn side, each
 * shifted along it by a hash. [block x, block y, centre x, centre y].
 */
function tornGrid(x: number, y: number, size: number, across: boolean, seed: number): [number, number, number, number] {
  if (across) {
    const ix = Math.floor(x / size)
    const o = h3(ix, 0, seed) * size
    const iy = Math.floor((y + o) / size)
    return [ix, iy, (ix + 0.5) * size, (iy + 0.5) * size - o]
  }
  const iy = Math.floor(y / size)
  const o = h3(0, iy, seed) * size
  const ix = Math.floor((x + o) / size)
  return [ix, iy, (ix + 0.5) * size - o, (iy + 0.5) * size]
}

/** The shader's edgeCut / edgeBlock: blocks along a torn side 0.44…1.56 chunk wide. [index, start, end]. */
const edgeCut = (k: number, chunk: number, s: number) => (k + 0.56 * (h3(k, 0, s) - 0.5)) * chunk
function edgeBlock(u: number, chunk: number, s: number): [number, number, number] {
  const k = Math.floor(u / chunk)
  const b0 = edgeCut(k, chunk, s)
  const b1 = edgeCut(k + 1, chunk, s)
  if (u < b0) return [k - 1, edgeCut(k - 1, chunk, s), b0]
  if (u >= b1) return [k + 1, b1, edgeCut(k + 2, chunk, s)]
  return [k, b0, b1]
}

/**
 * A photo's torn, graded, quantised picture over its window + margin, `px` canvas px per sheet unit —
 * built row by row. `pixels` — the slot's picture (read once per version); `minBlock` — the smallest
 * edge block, sheet units (2 cells at the home zoom, as the shader's).
 */
function photoArt(K: AboutKnobs, p: PhotoInst, pixels: () => ImageData | null, px: number, minBlock: number): PhotoArt | null {
  const W = p.placed.W
  const H = p.placed.H
  const m = MARGIN * W
  const nx = Math.max(2, Math.round((W + 2 * m) * px))
  const ny = Math.max(2, Math.round((H + 2 * m) * px))
  const out = makeCanvas(nx, ny)
  const og = out.getContext('2d')
  if (!og) return null
  const img = og.createImageData(nx, ny)
  const slot = p.slot
  const e = K.photos.edge
  const g = K.photos.grade
  const tint = hexRgb(g.tint)
  const tl = Math.max(1e-3, 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2])
  const sat = p.k.saturation < 0 ? g.saturation : p.k.saturation
  const levels = 2 ** K.raster.bits - 1
  const torn = p.k.torn
  const am = p.k.tornAmount
  const reach = debrisReach(K, p.k) * W
  const band = e.band * W * am
  const chunk = e.chunk * W
  const small = Math.max(e.small * W, minBlock)
  const seed = p.seed
  const halftone = p.k.halftone
  const hn = Math.max(2, K.photos.halftone) - 1
  const lvSpan = Math.max(slot.hi - slot.lo, 0.05)
  const lo = [torn & 1 ? -reach : 0, torn & 4 ? -reach : 0]
  const hi = [W + (torn & 2 ? reach : 0), H + (torn & 8 ? reach : 0)]
  const tornDist = (x: number, y: number) => {
    let t = 1e9
    if (torn & 1) t = Math.min(t, x)
    if (torn & 2) t = Math.min(t, W - x)
    if (torn & 4) t = Math.min(t, y)
    if (torn & 8) t = Math.min(t, H - y)
    return t
  }
  let src: ImageData | null = null
  let j = 0
  const art: PhotoArt = { canvas: out, job: null }
  art.job = (until) => {
    src ??= pixels()
    if (!src) return true
    const S = src.width
    const data = src.data
    while (j < ny) {
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) / px - m
        const y = (j + 0.5) / px - m
        if (x < lo[0] || y < lo[1] || x > hi[0] || y > hi[1]) continue
        let on = x >= 0 && y >= 0 && x <= W && y <= H
        let ox = 0
        let oy = 0
        let lift = 0
        if (torn) {
          const dl = torn & 1 ? x : 1e9
          const dr = torn & 2 ? W - x : 1e9
          const dt = torn & 4 ? y : 1e9
          const db = torn & 8 ? H - y : 1e9
          const across = Math.min(dl, dr) < Math.min(dt, db)
          const side = across ? (dl < dr ? 0 : 1) : dt < db ? 2 : 3
          const u = across ? y : x
          const t = tornDist(x, y)
          const [kk, b0, b1] = edgeBlock(u, chunk, seed + 17 + side * 5)
          const rs = h3(kk, side, seed + 41) < 0.5 ? 0 : (h3(kk, side, seed + 42) - 0.4) * 0.6 * chunk
          const [sbx, sby, smx, smy] = tornGrid(x, y, small, across, seed + 18)
          const [cbx, cby, cmx, cmy] = tornGrid(x, y, chunk, across, seed + 17)
          const ts = tornDist(smx, smy)
          const tc = tornDist(cmx, cmy)
          if (t >= rs) {
            on = true
            if (h3(kk, side, seed) < e.missing * am * 0.75) {
              let bd = band * (0.3 + 0.7 * h3(kk, side, seed + 7))
              if (h3(kk, side, seed + 43) < 0.5 && u > b0 + (b1 - b0) * (0.3 + 0.4 * h3(kk, side, seed + 44))) bd *= 0.3 + 0.7 * h3(kk, side, seed + 45)
              if (t < bd) on = false
            }
            const ks = 1 - clamp01(ts / Math.max(band * 0.6, 1e-6))
            if (on && ts < band * 0.6 * (0.4 + 0.6 * h3(sbx, sby, seed + 9)) && h3(sbx, sby, seed + 1) < e.missing * am * 0.8 * ks) on = false
            if (on && tc < band * 1.6 && h3(cbx, cby, seed + 2) < e.shift) {
              ox = (h3(cbx, cby, seed + 3) < 0.5 ? -0.5 : 0.5) * chunk
              oy = h3(cbx, cby, seed + 4) < 0.35 ? (h3(cbx, cby, seed + 8) < 0.5 ? -0.5 : 0.5) * chunk : 0
              if (h3(cbx, cby, seed + 19) < 0.15) lift = 0.25
            }
          } else {
            on = false
            const k = 1 + Math.max(ts, -reach) / Math.max(reach, 1e-6)
            if (h3(sbx, sby, seed + 5) < e.debris * am * k * k) on = true
            else if (h3(cbx, cby, seed + 6) < e.debris * am * 0.25 * (1 + Math.max(tc, -reach) / Math.max(reach, 1e-6))) on = true
          }
        }
        if (!on) continue
        // the picture (nearest; a displaced block from half a block away)
        const sx = Math.min(S - 1, Math.max(0, Math.floor(((x + ox + m) / (W + 2 * m)) * S)))
        const sy = Math.min(S - 1, Math.max(0, Math.floor(((y + oy + m) / (H + 2 * m)) * S)))
        const o = (sy * S + sx) * 4
        let r = data[o] / 255
        let gg = data[o + 1] / 255
        let b = data[o + 2] / 255
        let L = 0.2126 * r + 0.7152 * gg + 0.0722 * b
        const t = (j * nx + i) * 4
        if (halftone) {
          // auto-levelled from the picture's own range, the grade's contrast, 2 × 2 dots
          const l = clamp01(((L - slot.lo) / lvSpan - 0.5) * g.contrast + 0.5 + lift)
          const th2 = (BAYER[((i >> 1) & 3) + ((j >> 1) & 3) * 4] + 0.5) / 16
          const v = g.black + (g.white - g.black) * (Math.floor(l * hn + th2) / hn)
          img.data[t] = img.data[t + 1] = img.data[t + 2] = Math.round(v * 255)
        } else {
          r = L + (r - L) * sat
          gg = L + (gg - L) * sat
          b = L + (b - L) * sat
          r = (r - 0.5) * g.contrast + 0.5 + lift
          gg = (gg - 0.5) * g.contrast + 0.5 + lift
          b = (b - 0.5) * g.contrast + 0.5 + lift
          L = 0.2126 * r + 0.7152 * gg + 0.0722 * b
          r += (L * (tint[0] / tl) - r) * g.tintAmount
          gg += (L * (tint[1] / tl) - gg) * g.tintAmount
          b += (L * (tint[2] / tl) - b) * g.tintAmount
          const th = (BAYER[(i & 3) + (j & 3) * 4] + 0.5) / 16
          const q = (v: number) => {
            const c = g.black + (g.white - g.black) * clamp01(v)
            return Math.floor(c * levels + 0.5 + (th - 0.5) * K.raster.dither) / levels
          }
          img.data[t] = Math.round(q(r) * 255)
          img.data[t + 1] = Math.round(q(gg) * 255)
          img.data[t + 2] = Math.round(q(b) * 255)
        }
        img.data[t + 3] = 255
      }
      j++
      if (j < ny && performance.now() > until) return false
    }
    og.putImageData(img, 0, 0)
    return true
  }
  return art
}

export function createAboutFallback(mount: HTMLElement, core: AboutCore): AboutRenderer {
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    imageRendering: 'pixelated',
    pointerEvents: 'none',
  })
  mount.appendChild(canvas)
  const g = canvas.getContext('2d')
  // one photo's reveal stipple; all the photos together (the nav dock darkens photos only)
  const scratch = makeCanvas(1, 1)
  const sg = scratch.getContext('2d')
  const layer = makeCanvas(1, 1)
  const lg = layer.getContext('2d')
  const size = { w: 0, h: 0, cell: 1 }
  const holes = new Lru<HoleArt>()
  const photos = new Lru<PhotoArt>()
  /**
   * Per hole / per photo window (any knobs, cell size, unit or bucket): its last FINISHED art — drawn,
   * through the current transform, while its new art is still being built (a resize, a new bucket, a
   * tuned knob): nothing ever blanks for the frames a rebuild takes.
   */
  const holeReady = new Lru<HoleArt>()
  const ready = new Lru<PhotoArt>()
  /** the knobs each kind of art depends on, as a key part (per knobs object: one per config) */
  let sigFor: AboutKnobs | null = null
  let holeSig = ''
  let photoSig = ''
  /** each photo file's pixels, read once per slot version (CPU-backed slot canvas: no GPU readback) */
  const pixels = new Lru<ImageData>()
  const patterns = new Map<number, CanvasPattern | null>()
  let lastKey = ''
  /** the photos' zoom bucket, half-octaves (√2 steps) from the home zoom, with hysteresis (none when pinned) */
  let bucket = 0
  let bucketStarted = false
  /** bumped whenever a piece of art is finished (it is drawn from then on: the frame must redraw) */
  let built = 0
  /** debug: art built (pieces, ms) */
  const made = { holes: 0, photos: 0, ms: 0 }

  /** 4×4 Bayer coverage `level` (0…1) as a pattern: opaque where the threshold is below it. */
  const bayer = (level: number) => {
    const k = Math.round(level * 16)
    if (!patterns.has(k)) {
      const t = makeCanvas(4, 4)
      const tg = t.getContext('2d')
      if (!tg) return null
      const id = tg.createImageData(4, 4)
      for (let i = 0; i < 16; i++) id.data[i * 4 + 3] = (BAYER[i] + 0.5) / 16 < level ? 255 : 0
      tg.putImageData(id, 0, 0)
      patterns.set(k, g?.createPattern(t, 'repeat') ?? null)
    }
    return patterns.get(k) ?? null
  }

  const fit = (cell: number, layout: Layout) => {
    const w = Math.max(1, Math.ceil(layout.width / cell - 1e-4))
    const h = Math.max(1, Math.ceil(layout.height / cell - 1e-4))
    if (w === size.w && h === size.h && cell === size.cell) return
    mount.style.width = `${w * cell}px`
    mount.style.height = `${h * cell}px`
    canvas.width = scratch.width = layer.width = w
    canvas.height = scratch.height = layer.height = h
    size.w = w
    size.h = h
    size.cell = cell
    lastKey = ''
  }

  /**
   * The forward map of an element's own coordinates (w × h of them) → canvas px, as the affine through
   * the midpoints of its four true sides: a projective map (a hole's turn in depth, a photo's keystone)
   * becomes the parallelogram that splits its error evenly — 2D canvas has no projective drawImage.
   */
  const forward = (M: Float64Array, w: number, h: number, cell: number) => {
    const F = inv3(M)
    const [lx, ly] = apply3(F, 0, h / 2)
    const [rx, ry] = apply3(F, w, h / 2)
    const [tx, ty] = apply3(F, w / 2, 0)
    const [bx, by] = apply3(F, w / 2, h)
    const ax = (rx - lx) / w
    const ay = (ry - ly) / w
    const cx = (bx - tx) / h
    const cy = (by - ty) / h
    // the centre: the mean of the four midpoints
    const mx = (lx + rx + tx + bx) / 4
    const my = (ly + ry + ty + by) / 4
    const x0 = mx - (ax * w + cx * h) / 2
    const y0 = my - (ay * w + cy * h) / 2
    return [ax / cell, ay / cell, cx / cell, cy / cell, x0 / cell, y0 / cell] as const
  }

  /** A slot's picture, read once per version. */
  const slotPixels = (slot: PhotoSlot, index: number) => () => {
    const k = `${index}|${slot.version}`
    let d = pixels.get(k)
    if (!d) {
      const c = slot.canvas.getContext('2d', { willReadFrequently: true })
      if (!c) return null
      d = c.getImageData(0, 0, slot.canvas.width, slot.canvas.height)
      pixels.set(k, d)
      pixels.trim(6)
    }
    return d
  }

  /**
   * Darken what is in the photo layer under the nav dock (+ DOCK_PAD), the boundary a Bayer stipple
   * over ±2 cells — the shader's rule, cell for cell.
   */
  const dockShade = (lc: CanvasRenderingContext2D, d: { x: number; y: number; w: number; h: number }, cell: number, dark: number) => {
    lc.save()
    lc.setTransform(1, 0, 0, 1, 0, 0)
    lc.globalCompositeOperation = 'source-atop'
    lc.globalAlpha = 1 - dark
    const F = 2 * cell
    // cells whose centre is within distance r (Chebyshev, CSS px) of the dock rect
    const rect = (r: number) => {
      const x0 = Math.ceil((d.x - r) / cell - 0.5)
      const y0 = Math.ceil((d.y - r) / cell - 0.5)
      const x1 = Math.floor((d.x + d.w + r) / cell - 0.5)
      const y1 = Math.floor((d.y + d.h + r) / cell - 0.5)
      return [x0, y0, x1 + 1, y1 + 1] as const
    }
    // the ring of cells between two distances gets the stipple of the coverage at its middle
    const STEPS = 4
    for (let s = 0; s <= STEPS; s++) {
      const outer = DOCK_PAD + F - (s * 2 * F) / STEPS
      const inner = s === STEPS ? -Infinity : DOCK_PAD + F - ((s + 1) * 2 * F) / STEPS
      const k = s === STEPS ? 1 : (s + 0.5) / STEPS
      const [ox0, oy0, ox1, oy1] = rect(outer)
      lc.beginPath()
      lc.rect(ox0, oy0, ox1 - ox0, oy1 - oy0)
      if (inner > -Infinity) {
        const [ix0, iy0, ix1, iy1] = rect(inner)
        if (ix1 > ix0 && iy1 > iy0) lc.rect(ix0, iy0, ix1 - ix0, iy1 - iy0)
      }
      const pat = k >= 1 ? '#000' : bayer(k)
      if (!pat) continue
      lc.fillStyle = pat
      lc.fill('evenodd')
    }
    lc.restore()
  }

  const renderer: AboutRenderer = {
    kind: 'flat',

    // no clears: every art key carries what the art depends on (the knobs, cell and unit), so a new
    // config or size builds new art only where it must, the last finished art standing in meanwhile;
    // the LRUs' trim bounds the memory
    resize(_l: Layout, _c: ResolvedConfig) {
      lastKey = ''
    },

    draw(frame: Frame, st: AboutState) {
      if (!g || !sg || !lg) return false
      const cell = st.cam.cell
      fit(cell, frame.layout)
      if (!st.cam.active) {
        if (lastKey !== 'off') g.clearRect(0, 0, size.w, size.h)
        lastKey = 'off'
        return false
      }
      const K = st.K
      const set = core.glyphs
      const U = st.cam.U
      // the art is at the home zoom (the letters' texel: raster.block cells) — never the live zoom;
      // photos get a half-octave bucket (hysteresis 0.15 of a step) so a close-up is not mush
      const tx = (K.raster.block * cell) / U
      const zb = 2 * Math.log2(Math.max(1e-3, st.cam.scale / U))
      // pinned (or the first draw): a pure function of pos — no memory of the scrub order
      if (frame.scroll.pinned || !bucketStarted || Math.abs(zb - bucket) > 0.65) bucket = Math.max(-2, Math.min(4, Math.round(zb)))
      bucketStarted = true
      if (sigFor !== K) {
        sigFor = K
        holeSig = JSON.stringify([K.letters, K.raster.block])
        photoSig = JSON.stringify([K.photos.edge, K.photos.grade, K.photos.halftone, K.raster.bits, K.raster.dither])
      }
      const px = (U * 2 ** (bucket / 2)) / cell
      const minBlock = (2 * cell) / U
      const base = `${cell}|${U.toFixed(3)}`

      // ── the art of what is on screen: found, or started; unfinished art gets BUILD_MS this frame ──
      const t0 = performance.now()
      const until = t0 + BUILD_MS
      let spent = false
      let worked = false
      const run = (a: Art, kind: 'holes' | 'photos') => {
        if (!a.job || spent) return
        worked = true
        if (a.job(until)) {
          a.job = null
          built++
          made[kind]++
        }
        if (performance.now() > until) spent = true
      }
      const holeArts = st.holes.map((h) => {
        if (!set) return null
        // the stand-in is per hole and text (its glyph rect: drawn into the same place)
        const id = `${h.k.key}|${h.g.id}`
        const key = `${h.g.id}|${set.key}|${base}|${h.k.rough}|${h.k.mottle}|${h.k.slip}|${h.seed}|${h.tex.toFixed(4)}|${holeSig}`
        let a = holes.get(key)
        if (!a) {
          const art = holeArt(set, h, tx, K)
          if (!art) return null
          a = art
          holes.set(key, a)
        }
        run(a, 'holes')
        if (!a.job) holeReady.set(id, a)
        return a.job ? (holeReady.get(id) ?? a) : a
      })
      const photoArts = st.photos.map((p) => {
        const k = p.k
        const key = `${k.key}|${p.slot.version}|${base}|${bucket}|${k.torn}|${k.tornAmount}|${k.halftone}|${k.saturation}|${p.placed.W.toFixed(5)}|${p.placed.H.toFixed(5)}|${photoSig}`
        let a = photos.get(key)
        if (!a) {
          const art = photoArt(K, p, slotPixels(p.slot, p.k.index), px, minBlock)
          if (!art) return null
          a = art
          photos.set(key, a)
        }
        run(a, 'photos')
        if (!a.job) ready.set(k.key, a)
        return a.job ? (ready.get(k.key) ?? a) : a
      })
      holes.trim(Math.max(8, 2 * st.holes.length))
      holeReady.trim(Math.max(8, 2 * st.holes.length))
      photos.trim(Math.max(8, 2 * st.photos.length))
      ready.trim(Math.max(8, 2 * st.photos.length))
      if (worked) made.ms += performance.now() - t0

      const dk = navDock.current
      const dockOn = !!dk && K.photos.dock < 1
      const key = [
        st.cam.cx.toFixed(5), st.cam.cy.toFixed(5), st.cam.dissolve, st.sway.x, st.sway.y, st.sway.yaw, st.sway.pitch, core.version, set?.key, built, bucket,
        dockOn ? `${dk.x},${dk.y},${dk.w},${dk.h},${K.photos.dock}` : '',
        st.holes.map((h) => h.k.key).join(), st.photos.map((p) => `${p.k.key}${p.reveal}${p.slot.version}`).join(), st.crosses.map((c) => `${c.cx},${c.cy},${c.reveal},${c.alpha}`).join(),
      ].join('|')
      if (key === lastKey) return true
      lastKey = key
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'source-over'
      g.imageSmoothingEnabled = false
      g.clearRect(0, 0, size.w, size.h)
      g.fillStyle = K.sheet.color
      g.fillRect(0, 0, size.w, size.h)
      st.holes.forEach((h, i) => {
        const art = holeArts[i]
        if (!art || art.job) return
        g.setTransform(...forward(h.placed.M, h.g.w, h.g.h, cell))
        g.globalCompositeOperation = 'destination-out'
        g.drawImage(art.mask, 0, 0, h.g.w, h.g.h)
        g.globalCompositeOperation = 'source-over'
        g.drawImage(art.over, 0, 0, h.g.w, h.g.h)
      })
      g.setTransform(1, 0, 0, 1, 0, 0)
      // the photos: straight onto the sheet, or (the nav docked) into their own layer first
      const pg = dockOn ? lg : g
      if (dockOn) {
        lg.setTransform(1, 0, 0, 1, 0, 0)
        lg.globalCompositeOperation = 'source-over'
        lg.imageSmoothingEnabled = false
        lg.clearRect(0, 0, size.w, size.h)
      }
      st.photos.forEach((p, i) => {
        const art = photoArts[i]
        if (!art || art.job) return
        const m = MARGIN * p.placed.W
        const target: CanvasRenderingContext2D = p.reveal >= 1 ? pg : sg
        if (target === sg) {
          sg.setTransform(1, 0, 0, 1, 0, 0)
          sg.globalCompositeOperation = 'source-over'
          sg.clearRect(0, 0, size.w, size.h)
          sg.imageSmoothingEnabled = false
        }
        target.setTransform(...forward(p.placed.M, p.placed.W, p.placed.H, cell))
        target.drawImage(art.canvas, -m, -m, p.placed.W + 2 * m, p.placed.H + 2 * m)
        target.setTransform(1, 0, 0, 1, 0, 0)
        if (target === sg) {
          sg.globalCompositeOperation = 'destination-in'
          const pat = bayer(p.reveal)
          if (pat) {
            sg.fillStyle = pat
            sg.fillRect(0, 0, size.w, size.h)
          }
          pg.drawImage(scratch, 0, 0)
        }
      })
      if (dockOn) {
        dockShade(lg, dk, cell, K.photos.dock)
        g.drawImage(layer, 0, 0)
      }
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'source-over'
      // the crosses, cell by cell through their reveal stipple (the shader's bayer4(cell) < reveal)
      const arm = K.crosses.size
      g.fillStyle = K.crosses.color
      const dot = (x: number, y: number, reveal: number) => {
        if ((BAYER[(x & 3) + (y & 3) * 4] + 0.5) / 16 < reveal) g.fillRect(x, y, 1, 1)
      }
      for (const c of st.crosses) {
        g.globalAlpha = c.alpha
        for (let d = -arm; d <= arm; d++) {
          dot(c.cx + d, c.cy, c.reveal)
          if (d !== 0) dot(c.cx, c.cy + d, c.reveal)
        }
      }
      g.globalAlpha = 1
      // the dissolve: the whole sheet as a stipple
      if (st.cam.dissolve < 1) {
        g.globalCompositeOperation = 'destination-in'
        const pat = bayer(st.cam.dissolve)
        g.fillStyle = pat ?? 'rgba(0,0,0,0)'
        g.fillRect(0, 0, size.w, size.h)
        g.globalCompositeOperation = 'source-over'
      }
      return true
    },

    stats() {
      return { gl: false, buffer: [size.w, size.h], holeArt: holes.size, photoArt: photos.size, pixels: pixels.size, bucket, built: { ...made, ms: +made.ms.toFixed(1) } }
    },

    dispose() {
      canvas.remove()
      holes.clear()
      holeReady.clear()
      photos.clear()
      ready.clear()
      pixels.clear()
    },
  }
  return renderer
}
