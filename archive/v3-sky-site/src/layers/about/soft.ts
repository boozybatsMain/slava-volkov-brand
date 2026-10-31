import { BAYER4 } from '../../core/raster-gl'

/**
 * ABOUT — the 2D fallback's software rasteriser core (fallback.ts draws the scene with it): one pixel
 * per lattice cell, binary coverage, nothing anti-aliased — the same rules as the WebGL frame.
 *
 * TWO PASSES over three buffers per pixel:
 *   A · geometry (fallback.ts) — triangles are filled into `depth` (1 / distance below the camera, 0 —
 *       nothing; the nearer wins) and `pre`: WHAT the pixel is, before the framebuffer's colour depth:
 *         0                       — nothing (the void shows through: alpha 0)
 *         KIND_PAL | id           — a palette colour (the concrete: band × glint × haze × dock, flat)
 *         KIND_RGB | 0xBBGGRR     — a free colour, 8 bits a channel (a card's pixel)
 *         (| KIND_STIP            — of an object mid-reveal: never crawls)
 *       and `dot`: 1 where a shadow dot would be if nothing covered the pixel (fallback.ts → the
 *       footprints, softened, cut into steps of Bayer dots — shaders.ts → SHADE_HEAD).
 *       Pass A runs only when what decides the geometry changed (camera, models, reveals…).
 *   B · resolve (here) — `pre` → the canvas pixels: the glitch pass of the WebGL frame (core/raster-gl.ts
 *       glitchFS: rare row slips by the motion energy, the inward edge crawl — not along the screen's
 *       edge, not of an object mid-reveal; a pixel left empty gets the shadow dot of its source pixel —
 *       the dots land only on the void, slip with their rows, never crawl), then the colour through the film grain and the framebuffer's `bits` with the ordered
 *       dither (shaders.ts → rasterOut). Pass B runs again on every grain / shimmer tick — cheap: a
 *       table lookup per pixel.
 *
 * Triangle rule: a pixel belongs to a triangle when its CENTRE is inside — left / top edges inclusive,
 * right / bottom exclusive, every edge's crossing computed from its endpoints in one canonical order,
 * so two triangles sharing an edge never both take a pixel nor leave a crack between them (a crack
 * in a black letter would show the void through it).
 *
 * The ordered dither and every stipple use the GL frame's own Bayer phase: rows count from the BOTTOM
 * of the lattice (gl_FragCoord), so the dots, the reveals and the dither land on the same pixels as in
 * the WebGL image.
 */

export const KIND_PAL = 0x02000000
export const KIND_RGB = 0x03000000
/**
 * A flag OR-ed into `pre` (with KIND_PAL / KIND_RGB): the pixel belongs to an object in the middle of
 * its Bayer reveal — covered, but the crawl leaves it alone (core/raster-gl.ts: alpha ≈ 0.95 there; its
 * stipple's holes would be eaten into a random maze).
 */
export const KIND_STIP = 0x10000000

/** The 4×4 Bayer ranks, 0…15 (row-major). */
export const BAYER = Uint8Array.from(BAYER4)

/** GLSL hash12 (core/raster-gl.ts), in doubles: the same kind of pattern, not bit-for-bit the same. */
export function hash12(x: number, y: number) {
  let a = x * 0.1031
  let b = y * 0.1031
  let c = x * 0.1031
  a -= Math.floor(a)
  b -= Math.floor(b)
  c -= Math.floor(c)
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33)
  a += d
  b += d
  c += d
  const r = (a + b) * c
  return r - Math.floor(r)
}

/** The grain's table: 8 buckets of the noise (±1 GL grain amplitude). */
export const GRAIN_BUCKETS = 8
/** Side of the noise tiles (dither × grain, crawl), px; a multiple of 4 (the Bayer phase stays put). */
const TILE = 128

/** A pixel grid and the spans of the triangle being filled into it. */
export class Grid {
  w = 0
  h = 0
  /** the current triangle's spans: row y → pixels L[y] ≤ x < R[y]; rows ya ≤ y < yb */
  L = new Int32Array(0)
  R = new Int32Array(0)
  ya = 0
  yb = 0
  /** the current triangle's leftmost / rightmost pixel (x0 ≤ x < x1) */
  x0 = 0
  x1 = 0

  setSize(w: number, h: number) {
    this.w = w
    this.h = h
    this.L = new Int32Array(h)
    this.R = new Int32Array(h)
  }

  /**
   * The rows and spans of a screen triangle (grid px): pixels whose centre is inside. false — none on
   * the grid. The vertices are ordered by (y, x) — the same order for every triangle that shares an
   * edge, so the edge's crossings are bit-identical on both sides.
   */
  spans(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
    let x0 = ax, y0 = ay, x1 = bx, y1 = by, x2 = cx, y2 = cy, t: number
    if (y1 < y0 || (y1 === y0 && x1 < x0)) (t = x0), (x0 = x1), (x1 = t), (t = y0), (y0 = y1), (y1 = t)
    if (y2 < y1 || (y2 === y1 && x2 < x1)) (t = x1), (x1 = x2), (x2 = t), (t = y1), (y1 = y2), (y2 = t)
    if (y1 < y0 || (y1 === y0 && x1 < x0)) (t = x0), (x0 = x1), (x1 = t), (t = y0), (y0 = y1), (y1 = t)
    const ya = Math.max(0, Math.ceil(y0 - 0.5))
    const yb = Math.min(this.h, Math.ceil(y2 - 0.5))
    if (!(yb > ya)) return false
    const W = this.w
    const L = this.L
    const R = this.R
    const k02 = (x2 - x0) / (y2 - y0)
    const k01 = y1 > y0 ? (x1 - x0) / (y1 - y0) : 0
    const k12 = y2 > y1 ? (x2 - x1) / (y2 - y1) : 0
    let lo = W
    let hi = 0
    for (let y = ya; y < yb; y++) {
      const c = y + 0.5
      const xa = x0 + (c - y0) * k02
      const xb = c < y1 ? x0 + (c - y0) * k01 : x1 + (c - y1) * k12
      let l = Math.ceil((xa < xb ? xa : xb) - 0.5)
      let r = Math.ceil((xa < xb ? xb : xa) - 0.5)
      if (l < 0) l = 0
      if (r > W) r = W
      L[y] = l
      R[y] = r
      if (r > l) {
        if (l < lo) lo = l
        if (r > hi) hi = r
      }
    }
    this.ya = ya
    this.yb = yb
    this.x0 = lo
    this.x1 = hi
    return hi > lo
  }
}

/** A box x0, y0, x1, y1 (x1 ≤ x0: empty), grown to hold another. */
export function growBox(b: number[], x0: number, y0: number, x1: number, y1: number) {
  if (x0 < b[0]) b[0] = x0
  if (y0 < b[1]) b[1] = y0
  if (x1 > b[2]) b[2] = x1
  if (y1 > b[3]) b[3] = y1
}
export const isEmpty = (b: number[]) => !(b[2] > b[0] && b[3] > b[1])

/** The canvas's lattice: the buffers of both passes. */
export class Lattice extends Grid {
  depth = new Float32Array(0)
  pre = new Uint32Array(0)
  /** shadow dots (1) of the pixels nothing covers */
  dot = new Uint8Array(0)
  /** the canvas pixels (0xAABBGGRR) */
  image: ImageData | null = null
  out = new Uint32Array(0)
  /** per row: the Bayer row's offset into BAYER (GL rows count from the bottom) */
  bay = new Uint8Array(0)
  /** dither rank × grain bucket per tile pixel: (bayer << 3) | bucket — the tile keeps the GL Bayer phase */
  dt = new Uint8Array(TILE * TILE)
  /** uniform noise per tile pixel, 0…65535 (the crawl's coin) */
  coin = new Uint16Array(TILE * TILE)
  /** what pass A filled (objects) and where it put dots: x0, y0, x1, y1 (empty when x1 ≤ x0) */
  box = [0, 0, 0, 0]
  dotBox = [0, 0, 0, 0]
  /** what the canvas holds non-empty (the last pass B), x0, y0, x1, y1 */
  shown = [0, 0, 0, 0]

  constructor() {
    super()
    // the tiles' noise is fixed (a seeded LCG): every load looks the same, like the GL hash
    let s = 0x2f6b1d3
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    for (let i = 0; i < TILE * TILE; i++) {
      this.dt[i] = Math.min(GRAIN_BUCKETS - 1, Math.floor(rnd() * GRAIN_BUCKETS))
      this.coin[i] = Math.floor(rnd() * 65536)
    }
  }

  /** Size the buffers (w × h lattice pixels); a canvas context makes the ImageData. */
  resize(w: number, h: number, g: CanvasRenderingContext2D) {
    if (w === this.w && h === this.h && this.image) return
    this.setSize(w, h)
    this.depth = new Float32Array(w * h)
    this.pre = new Uint32Array(w * h)
    this.dot = new Uint8Array(w * h)
    this.image = g.createImageData(w, h)
    this.out = new Uint32Array(this.image.data.buffer)
    this.bay = new Uint8Array(h)
    for (let y = 0; y < h; y++) this.bay[y] = ((h - 1 - y) & 3) * 4
    // the dither rank of each tile pixel, by the GL phase of the lattice rows it lands on (tile offsets
    // are multiples of 4, so a tile row r always meets lattice rows with the same phase)
    for (let r = 0; r < TILE; r++)
      for (let c = 0; c < TILE; c++) {
        const i = r * TILE + c
        this.dt[i] = (BAYER[((h - 1 - r) & 3) * 4 + (c & 3)] << 3) | (this.dt[i] & 7)
      }
    this.box = [0, 0, 0, 0]
    this.dotBox = [0, 0, 0, 0]
    this.shown = [0, 0, 0, 0]
  }

  /** Pass A starts: what the last one drew is cleared. */
  begin() {
    const w = this.w
    const b = this.box
    if (!isEmpty(b))
      for (let y = b[1]; y < b[3]; y++) {
        this.depth.fill(0, y * w + b[0], y * w + b[2])
        this.pre.fill(0, y * w + b[0], y * w + b[2])
      }
    const d = this.dotBox
    if (!isEmpty(d)) for (let y = d[1]; y < d[3]; y++) this.dot.fill(0, y * w + d[0], y * w + d[2])
    this.box = [this.w, this.h, 0, 0]
    this.dotBox = [this.w, this.h, 0, 0]
  }

  /** Grow the filled box by the current triangle (its spans). */
  touch() {
    growBox(this.box, this.x0, this.ya, this.x1, this.yb)
  }
}

/** The framebuffer's colour: levels (2^bits − 1), the dither's strength, the grain's amplitude. */
export interface Quant {
  levels: number
  dither: number
  grain: number
}

/**
 * shaders.ts → rasterOut for one colour, as a table over (Bayer rank << 3 | grain bucket): the packed
 * canvas pixel (alpha 255). c — 0…1 display space.
 */
export function quantTable(r: number, g: number, b: number, q: Quant, into: Uint32Array, at: number) {
  const L = q.levels
  for (let m = 0; m < 16; m++) {
    const thr = 0.5 + ((m + 0.5) / 16 - 0.5) * q.dither
    for (let k = 0; k < GRAIN_BUCKETS; k++) {
      const n = ((k + 0.5) / GRAIN_BUCKETS - 0.5) * 2 * q.grain
      const ch = (c: number) => {
        const v = Math.floor(Math.min(1, Math.max(0, c + n)) * L + thr)
        return Math.round((Math.min(L, Math.max(0, v)) / L) * 255)
      }
      into[at + ((m << 3) | k)] = (0xff000000 | (ch(b) << 16) | (ch(g) << 8) | ch(r)) >>> 0
    }
  }
}

/** rasterOut per channel for 8-bit input: table[(rank << 3 | bucket) << 8 | c8] → the output byte. */
export function channelTable(q: Quant) {
  const t = new Uint8Array(128 * 256)
  const L = q.levels
  for (let m = 0; m < 16; m++) {
    const thr = 0.5 + ((m + 0.5) / 16 - 0.5) * q.dither
    for (let k = 0; k < GRAIN_BUCKETS; k++) {
      const n = ((k + 0.5) / GRAIN_BUCKETS - 0.5) * 2 * q.grain
      const base = ((m << 3) | k) << 8
      for (let c = 0; c < 256; c++) {
        const v = Math.floor(Math.min(1, Math.max(0, c / 255 + n)) * L + thr)
        t[base + c] = Math.round((Math.min(L, Math.max(0, v)) / L) * 255)
      }
    }
  }
  return t
}

/** What pass B needs this frame. */
export interface Resolve {
  /** palette: (id << 7 | dither index) → canvas pixel */
  pal: Uint32Array
  /** free colours: channelTable */
  rgb: Uint8Array
  /** the shadow dots' canvas pixel */
  shadow: number
  /** grain tick (the noise moves), shimmer tick (the glitch re-rolls) */
  grainTick: number
  tick: number
  /** crawl coin: crawl × min(e, 1) (0 — none) */
  crawl: number
  /** row slips: probability (rowGlitch × eMove²), largest shift px, run length px */
  slip: number
  slipShift: number
  slipRun: number
}

/**
 * Pass B: `pre` → the canvas pixels over the box that changed, through the glitch (row slips, crawl,
 * the dots in the empty pixels) and the colour tables. Returns the rectangle to put on the canvas
 * (x0, y0, x1, y1), or null.
 */
export function resolve(Lt: Lattice, o: Resolve): number[] | null {
  const W = Lt.w
  const H = Lt.h
  const slipping = o.slip > 0
  const reach = slipping ? Math.max(1, Math.ceil(o.slipShift)) : 0
  // this frame's non-empty region (row slips may pull pixels sideways into it)
  const a = [W, H, 0, 0]
  if (!isEmpty(Lt.box)) growBox(a, Lt.box[0], Lt.box[1], Lt.box[2], Lt.box[3])
  if (!isEmpty(Lt.dotBox)) growBox(a, Lt.dotBox[0], Lt.dotBox[1], Lt.dotBox[2], Lt.dotBox[3])
  const now = isEmpty(a) ? [0, 0, 0, 0] : [Math.max(0, a[0] - reach), a[1], Math.min(W, a[2] + reach), a[3]]
  const s = Lt.shown
  if (isEmpty(now) && isEmpty(s)) return null
  const r = isEmpty(s) ? now.slice() : isEmpty(now) ? s.slice() : [Math.min(now[0], s[0]), Math.min(now[1], s[1]), Math.max(now[2], s[2]), Math.max(now[3], s[3])]
  const [x0, y0, x1, y1] = r
  Lt.shown = now

  // the noise's place this tick (multiples of 4: the dither's Bayer phase stays on the lattice)
  const ox = (Math.floor(hash12(o.grainTick, 7.7) * 32) * 4) & (TILE - 1)
  const oy = (Math.floor(hash12(o.grainTick, 3.3) * 32) * 4) & (TILE - 1)
  const cx = Math.floor(hash12(o.tick, 9.1) * TILE)
  const cy = Math.floor(hash12(o.tick, 2.9) * TILE)
  const crawlAt = Math.round(o.crawl * 65536)
  // row slips (core/raster-gl.ts glitchFS): bands of 1–3 rows (GL rows, from the bottom), runs of
  // rowRun … 3 × rowRun px, a few of them shifted by 1…shift px
  const bandH = 1 + Math.floor(hash12(o.tick, 3.7) * 3)
  const t = o.tick

  for (let y = y0; y < y1; y++) {
    const row = y * W
    const gy = H - 1 - y
    const dtRow = ((y + oy) & (TILE - 1)) * TILE
    const coinRow = ((y + cy) & (TILE - 1)) * TILE
    let band = 0
    let run = 0
    let off = 0
    if (slipping) {
      band = Math.floor(gy / bandH)
      run = o.slipRun * (1 + 2 * hash12(band, t + 4.1))
      off = hash12(band, t + 5.3) * 97
    }
    let x = x0
    while (x < x1) {
      // a segment of the row with one shift
      let end = x1
      let shift = 0
      if (slipping) {
        const seg = Math.floor((x + off) / run)
        end = Math.min(x1, Math.ceil((seg + 1) * run - off))
        if (end <= x) end = x + 1
        if (hash12(band * 1.618 + seg * 31.7, t + 0.5) < o.slip) {
          const dir = hash12(band + seg, t + 1.7) < 0.5 ? -1 : 1
          shift = dir * Math.max(1, Math.ceil(hash12(band, seg + t + 2.9) * o.slipShift))
        }
      }
      copySpan(Lt, o, x, end, shift, y, row, dtRow, coinRow, ox, cx, crawlAt)
      x = end
    }
  }
  return r
}

/**
 * One run of a row (x … end), its source `shift` px away: the glitch's crawl, the dots in the empty
 * pixels, the colour tables. Its own function, the same for every run and row (the slips change only
 * its arguments: the hot loop is compiled once).
 */
function copySpan(Lt: Lattice, o: Resolve, x: number, end: number, shift: number, y: number, row: number, dtRow: number, coinRow: number, ox: number, cx: number, crawlAt: number) {
  const W = Lt.w
  const H = Lt.h
  const pre = Lt.pre
  const dot = Lt.dot
  const out = Lt.out
  const dt = Lt.dt
  const coin = Lt.coin
  const pal = o.pal
  const rgb = o.rgb
  const shadow = o.shadow
  const mask = TILE - 1
  for (; x < end; x++) {
    // a slip at the screen's edge pulls in the edge pixel (glitchFS → srcC), not nothing
    let sx = x + shift
    if (sx < 0) sx = 0
    else if (sx >= W) sx = W - 1
    const i = row + sx
    const v = pre[i]
    const k = (v >>> 24) & 0x0f
    // the crawl: an object pixel next to nothing is eaten now and then (and may show a dot) — past the
    // screen's edge is the edge pixel itself (no crawl along the frame), an object mid-reveal never crawls
    if (
      k === 0 ||
      (crawlAt > 0 &&
        (v & KIND_STIP) === 0 &&
        coin[coinRow + ((x + cx) & mask)] < crawlAt &&
        ((sx > 0 && pre[i - 1] >>> 24 === 0) || (sx < W - 1 && pre[i + 1] >>> 24 === 0) || (y > 0 && pre[i - W] >>> 24 === 0) || (y < H - 1 && pre[i + W] >>> 24 === 0)))
    ) {
      out[row + x] = dot[i] ? shadow : 0
      continue
    }
    const d = dt[dtRow + ((sx + ox) & mask)]
    if (k === 2) out[row + x] = pal[((v & 0xffffff) << 7) | d]
    else {
      const base = d << 8
      out[row + x] = (0xff000000 | (rgb[base | ((v >>> 16) & 255)] << 16) | (rgb[base | ((v >>> 8) & 255)] << 8) | rgb[base | (v & 255)]) >>> 0
    }
  }
}

/**
 * A gaussian of σ px over the box of two single-channel grids at once (in place; `ta`, `tb` as big as
 * they are), as three box blurs per axis (running sums: the cost does not grow with σ; rows and columns
 * both walked row by row), clamped at the box's edges — the box must hold the whole spread (≥ 3σ of
 * zeros around what it blurs) or touch the grid's edge.
 */
export function gauss2(a: Float32Array, b: Float32Array, ta: Float32Array, tb: Float32Array, w: number, box: number[], sigma: number) {
  const [x0, y0, x1, y1] = box
  for (const sz of boxesFor(sigma)) {
    const r = (sz - 1) >> 1
    if (r < 1) continue
    blurH(a, b, ta, tb, w, x0, y0, x1, y1, r)
    blurV(ta, tb, a, b, w, x0, y0, x1, y1, r)
  }
}

/** Widths of 3 box blurs whose sum approximates a gaussian of σ (odd widths). */
function boxesFor(sigma: number) {
  const n = 3
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1)
  let wl = Math.floor(ideal)
  if (wl % 2 === 0) wl--
  const wu = wl + 2
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4))
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(i < m ? wl : wu)
  return out
}

/**
 * One box blur along rows of two grids (sa → da, sb → db), edges clamped (the clamped ends walked apart
 * from the middle: no min / max per pixel).
 */
function blurH(sa: Float32Array, sb: Float32Array, da: Float32Array, db: Float32Array, w: number, x0: number, y0: number, x1: number, y1: number, r: number) {
  const k = 1 / (2 * r + 1)
  const last = x1 - 1
  // x where x + r + 1 ≤ last and x − r ≥ x0: both ends inside
  const mid0 = Math.min(x1, x0 + r)
  const mid1 = Math.max(mid0, last - r)
  for (let y = y0; y < y1; y++) {
    const row = y * w
    const fa = sa[row + x0]
    const fb = sb[row + x0]
    const la = sa[row + last]
    const lb = sb[row + last]
    let A = (r + 1) * fa
    let B = (r + 1) * fb
    for (let j = 1; j <= r; j++) {
      const i = row + Math.min(last, x0 + j)
      A += sa[i]
      B += sb[i]
    }
    let x = x0
    for (; x < mid0; x++) {
      da[row + x] = A * k
      db[row + x] = B * k
      const i = row + Math.min(last, x + r + 1)
      A += sa[i] - fa
      B += sb[i] - fb
    }
    for (let i = row + x; x < mid1; x++, i++) {
      da[i] = A * k
      db[i] = B * k
      A += sa[i + r + 1] - sa[i - r]
      B += sb[i + r + 1] - sb[i - r]
    }
    for (; x < x1; x++) {
      da[row + x] = A * k
      db[row + x] = B * k
      const i = row + Math.max(x0, x - r)
      A += la - sa[i]
      B += lb - sb[i]
    }
  }
}

let accA = new Float64Array(0)
let accB = new Float64Array(0)

/** One box blur along columns of two grids (sa → da, sb → db), edges clamped, walked row by row. */
function blurV(sa: Float32Array, sb: Float32Array, da: Float32Array, db: Float32Array, w: number, x0: number, y0: number, x1: number, y1: number, r: number) {
  if (accA.length < w) {
    accA = new Float64Array(w)
    accB = new Float64Array(w)
  }
  const A = accA
  const B = accB
  const k = 1 / (2 * r + 1)
  const last = y1 - 1
  const r0 = y0 * w
  for (let x = x0; x < x1; x++) {
    A[x] = (r + 1) * sa[r0 + x]
    B[x] = (r + 1) * sb[r0 + x]
  }
  for (let j = 1; j <= r; j++) {
    const rj = Math.min(last, y0 + j) * w
    for (let x = x0; x < x1; x++) {
      A[x] += sa[rj + x]
      B[x] += sb[rj + x]
    }
  }
  for (let y = y0; y < y1; y++) {
    const row = y * w
    const add = Math.min(last, y + r + 1) * w
    const sub = Math.max(y0, y - r) * w
    for (let x = x0; x < x1; x++) {
      da[row + x] = A[x] * k
      db[row + x] = B[x] * k
      A[x] += sa[add + x] - sa[sub + x]
      B[x] += sb[add + x] - sb[sub + x]
    }
  }
}
