/**
 * Procedural paper sheet — rendered once per size into a canvas at device resolution.
 *
 * Everything is zero-mean around the base colour and seeded, so the same seed gives
 * the same sheet on every load. Features are defined in CSS px (not device px), so a
 * 1× and a 2× screen show the same paper; only the per-pixel grain follows the device.
 *
 * Layers (all luminance offsets in 0…255 units, scaled by `intensity`):
 *   mottle    – soft low-frequency density clouds (fbm on a coarse grid)
 *   tint      – barely-there warm/cool drift of the colour
 *   tooth     – paper fibre roughness at 1–4 px (value noise) — the dominant fine texture
 *   formation – pulp "flocs" at 5–25 px, three non-commensurate lattices so no single
 *               blob size (and no grid-aligned cells) dominates
 *   grain     – per-pixel scan grain
 *   scan    – faint horizontal scanner banding
 *   crease  – long, almost invisible folds (light/shade ridge + hairline)
 *   specks / fibres – a handful of tiny dots and hairs drawn on top
 */
import type { PaperParams } from './params'

export interface TextureSpec {
  /** CSS px */
  width: number
  height: number
  dpr: number
  color: string
  intensity: number
  t: PaperParams['texture']
}

// ── deterministic helpers ──────────────────────────────────────────────────

/** 2D integer hash → [0, 1). */
function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** 2D value noise in [-1, 1], lattice spacing 1. */
function vnoise(x: number, y: number, s: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = smooth(x - ix)
  const fy = smooth(y - iy)
  const a = hash(ix, iy, s)
  const b = hash(ix + 1, iy, s)
  const c = hash(ix, iy + 1, s)
  const d = hash(ix + 1, iy + 1, s)
  return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * 2 - 1
}

/** 1D value noise in [-1, 1]. */
function vnoise1(x: number, s: number): number {
  const i = Math.floor(x)
  const f = smooth(x - i)
  const a = hash(i, 0, s)
  const b = hash(i + 1, 0, s)
  return (a + (b - a) * f) * 2 - 1
}

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * A lattice field sampled with separable smooth bilinear interpolation.
 * `cell` is the lattice spacing in device px. Returns a row sampler: call `row(y)`
 * once per scanline, then `at(x)` per pixel.
 */
function latticeField(W: number, H: number, cell: number, gen: (gx: number, gy: number) => number) {
  const gw = Math.ceil(W / cell) + 2
  const gh = Math.ceil(H / cell) + 2
  const g = new Float32Array(gw * gh)
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) g[gy * gw + gx] = gen(gx, gy)
  // per-column index + weight
  const ix = new Int32Array(W)
  const wx = new Float32Array(W)
  for (let x = 0; x < W; x++) {
    const u = x / cell
    const i = Math.floor(u)
    ix[x] = i
    wx[x] = smooth(u - i)
  }
  const rowBuf = new Float32Array(gw)
  return {
    row(y: number) {
      const v = y / cell
      const j = Math.floor(v)
      const w = smooth(v - j)
      const o0 = j * gw
      const o1 = o0 + gw
      for (let i = 0; i < gw; i++) rowBuf[i] = g[o0 + i] + (g[o1 + i] - g[o0 + i]) * w
    },
    at(x: number) {
      const i = ix[x]
      const a = rowBuf[i]
      return a + (rowBuf[i + 1] - a) * wx[x]
    },
  }
}

// ── main ───────────────────────────────────────────────────────────────────

/** Knobs added after the first config pass; read with fallbacks so older configs still work. */
const extra = (t: TextureSpec['t']) => t as TextureSpec['t'] & { formation?: number; maxMpx?: number }

/**
 * Texture pixels per CSS px: the device ratio, but capped by area (`maxMpx`) so a 5K
 * screen doesn't allocate ~80 MB per regeneration. The canvas is stretched to the sheet.
 */
export function texScale(spec: TextureSpec): number {
  const max = (extra(spec.t).maxMpx ?? 9) * 1e6
  const area = Math.max(1, spec.width * spec.height)
  return Math.max(0.5, Math.min(spec.dpr, Math.sqrt(max / area)))
}

export const deviceSize = (spec: TextureSpec) => {
  const s = texScale(spec)
  return {
    W: Math.max(1, Math.round(spec.width * s)),
    H: Math.max(1, Math.round(spec.height * s)),
  }
}

/**
 * The per-pixel part (pure, no DOM — runs in a Web Worker). Returns RGBA bytes
 * for a W×H device-pixel canvas.
 */
export function paperPixels(spec: TextureSpec): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, intensity: k, t } = spec
  const dpr = texScale(spec) // texture px per CSS px (≤ device ratio)
  const { W, H } = deviceSize(spec)
  const [R0, G0, B0] = parseHex(spec.color)
  const seed = Math.round(t.seed) | 0
  const d = new Uint8ClampedArray(W * H * 4)

  if (k <= 0) {
    for (let o = 0; o < d.length; o += 4) {
      d[o] = R0
      d[o + 1] = G0
      d[o + 2] = B0
      d[o + 3] = 255
    }
    return d
  }

  const css = 1 / dpr // device px → CSS px

  // Mottle: fbm evaluated on a coarse grid (8 CSS px), wavelengths 520 → 36 CSS px.
  const aMottle = 5.2 * t.mottle * k
  const aTint = 0.9 * t.tint * k
  const mottle = latticeField(W, H, 8 * dpr, (gx, gy) => {
    const x = gx * 8
    const y = gy * 8
    return (
      vnoise(x / 520, y / 520, seed + 11) * 0.36 +
      vnoise(x / 210, y / 210, seed + 12) * 0.3 +
      vnoise(x / 90, y / 90, seed + 13) * 0.21 +
      vnoise(x / 36, y / 36, seed + 14) * 0.13
    )
  })
  const tint = latticeField(W, H, 16 * dpr, (gx, gy) => vnoise((gx * 16) / 700, (gy * 16) / 700, seed + 21))

  // Tooth: fibre roughness (≈1.3 and ≈3.6 CSS px). This is what makes the sheet read as
  // rough paper at 1:1, so it carries most of the fine-scale energy.
  const aTooth = 2.7 * t.tooth * k
  const toothA = latticeField(W, H, 1.3 * dpr, (gx, gy) => hash(gx, gy, seed + 31) * 2 - 1)
  const toothB = latticeField(W, H, 3.6 * dpr, (gx, gy) => hash(gx, gy, seed + 32) * 2 - 1)
  // Formation: pulp flocs, kept separate from tooth and well below it — a single strong
  // ≈11 px octave read as soft digital clouds with grid-aligned cells.
  const aFloc = 1.62 * (extra(t).formation ?? 1) * k
  const flocS = latticeField(W, H, 4.7 * dpr, (gx, gy) => hash(gx, gy, seed + 34) * 2 - 1)
  const floc = latticeField(W, H, 11 * dpr, (gx, gy) => hash(gx, gy, seed + 33) * 2 - 1)
  const flocL = latticeField(W, H, 23 * dpr, (gx, gy) => hash(gx, gy, seed + 35) * 2 - 1)

  // Grain: per-texture-pixel triangular noise (a little softer where a pixel is a whole CSS px).
  const aGrain = 4 * t.grain * k * Math.min(1, 0.5 + dpr / 4)

  // Scanner banding: per-row offset (smooth + a little row-to-row flicker).
  const aScan = 0.55 * t.scan * k
  const bandY = new Float32Array(H)
  for (let y = 0; y < H; y++) {
    const cy = y * css
    bandY[y] =
      aScan * (vnoise1(cy / 140, seed + 41) * 0.55 + vnoise1(cy / 11, seed + 42) * 0.3 + (hash(y, 7, seed + 43) - 0.5) * 0.3)
  }

  // Creases: long folds, mostly near-vertical / near-horizontal, slightly wavy.
  interface Crease {
    nx: number; ny: number; c: number; tx: number; ty: number
    t0: number; t1: number; fade: number; wob: Float32Array; wobOff: number; amp: number
  }
  const creases: Crease[] = []
  const nCrease = Math.max(0, Math.min(3, Math.round(t.creaseCount)))
  const aCrease = t.crease * k
  if (aCrease > 0) {
    const r = rng(seed * 7919 + 5)
    for (let i = 0; i < nCrease; i++) {
      const vertical = r() < 0.6
      const ang = (vertical ? Math.PI / 2 : 0) + (r() - 0.5) * 0.09
      const tx = Math.cos(ang)
      const ty = Math.sin(ang)
      const nx = -ty
      const ny = tx
      const cx = width * (0.22 + r() * 0.56)
      const cy = height * (0.22 + r() * 0.56)
      const c = cx * nx + cy * ny
      const span = vertical ? height : width
      const len = span * (0.55 + r() * 0.6)
      const mid = (cx * tx + cy * ty) + (r() - 0.5) * span * 0.3
      const tmin = -Math.hypot(width, height)
      const wobLen = Math.ceil(Math.hypot(width, height) * 2) + 4
      const wob = new Float32Array(wobLen)
      for (let j = 0; j < wobLen; j++) {
        const tt = j + tmin
        wob[j] = vnoise1(tt / 90, seed + 50 + i) * 2.2 + vnoise1(tt / 13, seed + 60 + i) * 0.5
      }
      creases.push({
        nx, ny, c, tx, ty,
        t0: mid - len / 2, t1: mid + len / 2,
        fade: 140,
        wob, wobOff: -tmin,
        amp: aCrease * (0.7 + r() * 0.5),
      })
    }
  }

  let s = (seed * 2654435761) >>> 0 || 1 // xorshift32 state for grain

  for (let y = 0; y < H; y++) {
    mottle.row(y)
    tint.row(y)
    toothA.row(y)
    toothB.row(y)
    flocS.row(y)
    floc.row(y)
    flocL.row(y)
    const band = bandY[y]
    const cy = y * css
    let o = y * W * 4
    for (let x = 0; x < W; x++, o += 4) {
      // grain (two xorshift draws → triangular distribution)
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const g1 = (s >>> 0) / 4294967296
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      const g2 = (s >>> 0) / 4294967296

      let L =
        mottle.at(x) * aMottle +
        (toothA.at(x) * 1.6 + toothB.at(x) * 0.5) * aTooth +
        (flocS.at(x) * 0.5 + floc.at(x) * 0.6 + flocL.at(x) * 0.7) * aFloc +
        (g1 + g2 - 1) * aGrain +
        band

      if (creases.length) {
        const cx = x * css
        for (let i = 0; i < creases.length; i++) {
          const cr = creases[i]
          const tt = cx * cr.tx + cy * cr.ty
          if (tt < cr.t0 - cr.fade || tt > cr.t1 + cr.fade) continue
          const fa = Math.min(1, (tt - (cr.t0 - cr.fade)) / cr.fade, ((cr.t1 + cr.fade) - tt) / cr.fade)
          const f = fa * fa * (3 - 2 * fa) * cr.amp
          const dd = cx * cr.nx + cy * cr.ny - cr.c - cr.wob[(tt + cr.wobOff) | 0]
          // the two halves of the fold face the light at slightly different angles
          const side = dd / Math.sqrt(1600 + dd * dd)
          let v = side * 1.1
          // the fold itself: a thin shade line with a lifted highlight right next to it
          if (dd > -6 && dd < 6) {
            const a = dd / 0.7
            const b = (dd - 1.25) / 0.9
            v += -3.2 * Math.exp(-a * a) + 2.2 * Math.exp(-b * b)
          }
          L += v * f
        }
      }

      const tv = tint.at(x) * aTint
      d[o] = R0 + L + tv
      d[o + 1] = G0 + L
      d[o + 2] = B0 + L - tv
      d[o + 3] = 255
    }
  }
  return d
}

/** Tiny vector details drawn over the pixels: pepper dots, rare specks and fibres. */
export function paperDecor(ctx: CanvasRenderingContext2D, spec: TextureSpec) {
  const { width, height, intensity: k, t } = spec
  if (k <= 0) return
  const dpr = texScale(spec)
  const { W, H } = deviceSize(spec)
  const seed = Math.round(t.seed) | 0

  // ── pepper: scanner dust / pulp dots, warm grey, faint ──
  // Counted per CSS area but drawn in texture px, so on a 1× screen a dot is a whole
  // CSS px: there they stay single pixels (no 2×2 "big" ones) — otherwise it reads as dirt.
  const rp = rng(seed * 31337 + 3)
  const nPepper = Math.round(0.0024 * t.pepper * width * height)
  const aP = Math.min(1.6, k)
  const allowBig = dpr >= 1.5
  for (let i = 0; i < nPepper; i++) {
    const x = Math.floor(rp() * W)
    const y = Math.floor(rp() * H)
    const big = allowBig && rp() < 0.3
    const a = (0.03 + Math.pow(rp(), 3) * 0.17) * aP
    ctx.fillStyle = `rgba(92, 80, 70, ${a.toFixed(3)})`
    ctx.fillRect(x, y, big ? 2 : 1, big && rp() < 0.5 ? 2 : 1)
  }

  // ── specks & fibres (vector, drawn in CSS px space) ──
  ctx.save()
  ctx.scale(dpr, dpr)
  const area = (width * height) / (1440 * 900)
  const r = rng(seed * 104729 + 17)
  const nSpecks = Math.round(15 * t.specks * area)
  for (let i = 0; i < nSpecks; i++) {
    const x = r() * width
    const y = r() * height
    const light = r() < 0.18
    const rad = 0.3 + Math.pow(r(), 2.2) * 0.9
    const el = 1 + r() * 1.4
    const a = Math.min(1, (light ? 0.35 : 0.12 + r() * 0.3) * Math.min(1.5, k))
    ctx.fillStyle = light ? `rgba(255,255,252,${a})` : `rgba(78,70,62,${a})`
    ctx.beginPath()
    ctx.ellipse(x, y, rad * el, rad, r() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  const nFibres = Math.round(5 * t.fibers * area)
  ctx.lineCap = 'round'
  for (let i = 0; i < nFibres; i++) {
    const x = r() * width
    const y = r() * height
    const len = 4 + r() * 12
    const ang = r() * Math.PI * 2
    const bend = (r() - 0.5) * len * 0.8
    const ex = x + Math.cos(ang) * len
    const ey = y + Math.sin(ang) * len
    const mx = (x + ex) / 2 - Math.sin(ang) * bend
    const my = (y + ey) / 2 + Math.cos(ang) * bend
    const a = Math.min(1, (0.06 + r() * 0.08) * Math.min(1.5, k))
    ctx.strokeStyle = r() < 0.5 ? `rgba(70,72,84,${a})` : `rgba(96,84,72,${a})`
    ctx.lineWidth = 0.35 + r() * 0.25
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(mx, my, ex, ey)
    ctx.stroke()
  }
  ctx.restore()
}

/** Synchronous fallback (main thread): pixels + decor straight into a canvas. */
export function renderPaper(canvas: HTMLCanvasElement, spec: TextureSpec) {
  const { W, H } = deviceSize(spec)
  const data = paperPixels(spec)
  blit(canvas, spec, W, H, data)
}

/** Put finished pixels into the canvas (resizing it in the same task → no blank frame). */
export function blit(canvas: HTMLCanvasElement, spec: TextureSpec, W: number, H: number, data: Uint8ClampedArray<ArrayBuffer>) {
  if (canvas.width !== W) canvas.width = W
  if (canvas.height !== H) canvas.height = H
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return
  ctx.putImageData(new ImageData(data, W, H), 0, 0)
  paperDecor(ctx, spec)
}
