import '@fontsource-variable/geist'
import type { AboutKnobs } from './knobs'

/**
 * ABOUT — the letters of the holes as signed distance fields, built at runtime from the config texts
 * (about.holes.*.text, in about.word's font: Geist Variable 900; tracking and stretchY — the hole's own
 * or about.word's). One field per distinct look (text + stretch + tracking: glyphId), so the finale can
 * be a heavy condensed block while ABOUT keeps the word's proportions.
 *
 * Each text is drawn once with canvas 2D at a moderate size (cap height CAP px), thresholded to a
 * binary mask and turned into an exact Euclidean distance field (Felzenszwalb & Huttenlocher, both
 * signs). The fields of all texts are packed into one atlas:
 *   dist  — Float32, glyph px, + inside the letter: uploaded as R16F and sampled LINEAR (the output
 *           is still binary per cell: the shader thresholds it, after its own blocky quantisation);
 *   bytes — the CPU copy, Uint8 (128 + d · 127 / RANGE): the 2D fallback reads it.
 * Only RANGE px around every edge is kept — more than the erosion band + wobble + crumbs ever reach
 * (sky.config.ts → about.letters, in sheet units; 1 glyph px ≈ 0.0016 of ABOUT's width).
 *
 * The deepest point of the first letter of ABOUT (the A) is measured here too: the camera pulls back
 * from it (about.pull.entry, written into the config after measuring; stats() reports this value).
 * The whole build is ≈ 1 Mpx of EDT; every text is its own task (awaited one by one) so no single
 * task blocks the page for long. A font that comes after the timeout (wordFontReady) gets the
 * letters rebuilt in it (core.ts).
 */

/** Cap height of the raster, px: the resolution of the letters' shapes. */
const CAP = 104
/** Signed distance kept around every edge, glyph px (both sides). */
export const RANGE = 32
/** Padding around the ink box, px: the field must reach RANGE outside the ink. */
const PAD = RANGE + 2
/** Atlas width, px (the widest text, ALL FOR NOW at CAP, is ≈ 1.1k). A wider text widens the atlas… */
const ATLAS_W = 2048
/** …up to this (every WebGL2 device takes 4096 px textures); a text wider still is left out, with a warning. */
const ATLAS_MAX = 4096

export interface Glyph {
  /** glyphId: text + stretch + tracking */
  id: string
  text: string
  /** the padded rect in the atlas, px */
  ax: number
  ay: number
  w: number
  h: number
  /** the ink box inside the padded rect, px */
  inkX: number
  inkY: number
  inkW: number
  inkH: number
}

export interface GlyphSet {
  /** what it was built from: font, weight, tracking, stretch, texts */
  key: string
  width: number
  height: number
  /** signed distance, glyph px, + inside (row-major, atlas px) */
  dist: Float32Array
  /** 128 + d · 127 / RANGE, clamped */
  bytes: Uint8Array
  /** by glyphId */
  glyphs: Map<string, Glyph>
  /** deepest inside point of the first letter of glyph `id`: glyph px in its padded rect, r — its distance */
  entry: { id: string; gx: number; gy: number; r: number } | null
  /** build time, ms (EDT + raster) */
  ms: number
  /** per text: raster ms + EDT ms @ size */
  timing: string[]
}

/** What a hole's letters look like in the atlas: its text in its own stretch and tracking. */
export interface GlyphLook {
  text: string
  stretchY: number
  tracking: number
}

/** The atlas entry of a hole (holes with the same text and look share it). */
export const glyphId = (h: GlyphLook) => `${h.text}\u0002${h.stretchY}\u0002${h.tracking}`

export function glyphKey(K: AboutKnobs) {
  const ids = [...new Set(K.holes.map(glyphId))].sort()
  const w = K.word
  return `${w.family}|${w.weight}|${ids.join('\u0001')}`
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/**
 * The word's font, loaded — or given up on after `timeout` ms: the system fallback draws then, and
 * `arrives` settles when the font does land (null: nothing more to wait for). The caller rebuilds the
 * letters then. (Wrapped in an object: an async function would adopt a bare promise and wait for it.)
 */
export async function wordFontReady(K: AboutKnobs, timeout = 3000): Promise<{ arrives: Promise<void> } | null> {
  const fonts = document.fonts
  if (!fonts?.load) return null
  const sample = [...new Set(K.holes.map((h) => h.text).join(''))].join('') || 'ABOUT'
  let settled = false
  const load = fonts.load(`${K.word.weight} 100px "${K.word.family}"`, sample).then(
    (faces) => ((settled = true), faces.length > 0),
    () => ((settled = true), false),
  )
  await Promise.race([load, sleep(timeout)])
  if (settled) return null
  // still on its way: settles only if it does arrive (a font that fails keeps the fallback)
  return { arrives: new Promise<void>((done) => void load.then((ok) => ok && done())) }
}

interface Raster {
  w: number
  h: number
  /** 1 inside */
  mask: Uint8Array
  inkX: number
  inkY: number
  inkW: number
  inkH: number
  /** x range of the first character, raster px (for the entry search) */
  firstX0: number
  firstX1: number
}

/** One text in its look → a binary mask, cropped to its ink box ± PAD. */
function rasterise(look: GlyphLook, K: AboutKnobs): Raster {
  const { family, weight } = K.word
  const { text, tracking, stretchY } = look
  const font = (px: number) => `${weight} ${px}px "${family}", system-ui, sans-serif`
  const c = document.createElement('canvas')
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.font = font(100)
  const capRatio = (g.measureText('H').actualBoundingBoxAscent || 71) / 100
  const F = CAP / Math.max(0.3, capRatio)
  g.font = font(F)
  const chars = [...text]
  // advances with the pair kerning: width(ab) − width(b)
  const adv = chars.map((ch, i) => (i < chars.length - 1 ? g.measureText(ch + chars[i + 1]).width - g.measureText(chars[i + 1]).width : g.measureText(ch).width))
  const track = tracking * F
  const total = adv.reduce((s, a) => s + a, 0) + track * (chars.length - 1)
  const m = g.measureText(text)
  const asc = Math.max(m.actualBoundingBoxAscent, F * 0.8)
  const desc = Math.max(m.actualBoundingBoxDescent, F * 0.25)
  const W = Math.ceil(total + F * 0.6 + 2 * PAD)
  const H = Math.ceil((asc + desc) * stretchY + 2 * PAD)
  c.width = W
  c.height = H
  g.font = font(F)
  g.fillStyle = '#fff'
  g.textBaseline = 'alphabetic'
  g.textAlign = 'left'
  const x0 = PAD + F * 0.3
  const base = PAD + asc * stretchY
  g.setTransform(1, 0, 0, stretchY, 0, base)
  let x = x0
  const starts: number[] = []
  for (let i = 0; i < chars.length; i++) {
    starts.push(x)
    g.fillText(chars[i], x, 0)
    x += adv[i] + track
  }
  g.setTransform(1, 0, 0, 1, 0, 0)
  const data = g.getImageData(0, 0, W, H).data
  // binary + ink box
  let minX = W
  let minY = H
  let maxX = -1
  let maxY = -1
  const full = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let xx = 0; xx < W; xx++) {
      if (data[(y * W + xx) * 4 + 3] >= 128) {
        full[y * W + xx] = 1
        if (xx < minX) minX = xx
        if (xx > maxX) maxX = xx
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) {
    // nothing drawn (font missing, a text of spaces): a 1×1 empty field
    return { w: 2 * PAD + 1, h: 2 * PAD + 1, mask: new Uint8Array((2 * PAD + 1) ** 2), inkX: PAD, inkY: PAD, inkW: 1, inkH: 1, firstX0: 0, firstX1: 0 }
  }
  // crop to the ink ± PAD
  const cx0 = Math.max(0, minX - PAD)
  const cy0 = Math.max(0, minY - PAD)
  const cx1 = Math.min(W, maxX + 1 + PAD)
  const cy1 = Math.min(H, maxY + 1 + PAD)
  const w = cx1 - cx0
  const h = cy1 - cy0
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) mask.set(full.subarray((y + cy0) * W + cx0, (y + cy0) * W + cx0 + w), y * w)
  const firstEnd = chars.length > 1 ? starts[1] : x
  return {
    w,
    h,
    mask,
    inkX: minX - cx0,
    inkY: minY - cy0,
    inkW: maxX + 1 - minX,
    inkH: maxY + 1 - minY,
    firstX0: Math.max(0, starts[0] - cx0 - F * 0.05),
    firstX1: Math.min(w, firstEnd - cx0 - track * 0.5),
  }
}

const INF = 1e20

/** 1-D squared distance transform of f (Felzenszwalb & Huttenlocher), in place into d. */
function edt1(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q
    let s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/** Squared distance of every pixel to the nearest pixel where `seed(i)` is true. */
function edt2(w: number, h: number, seed: (i: number) => boolean) {
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = seed(i) ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float32Array(n)
  const d = new Float32Array(n)
  const v = new Int32Array(n)
  const z = new Float32Array(n + 1)
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x]
    edt1(f, h, d, v, z)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]
  }
  // rows
  for (let y = 0; y < h; y++) {
    const row = out.subarray(y * w, y * w + w)
    f.set(row)
    edt1(f, w, d, v, z)
    row.set(d.subarray(0, w))
  }
  return out
}

/** Signed distance (px, + inside) of a binary mask, at pixel centres. */
function signedField(r: Raster) {
  const { w, h, mask } = r
  const toOut = edt2(w, h, (i) => mask[i] === 0)
  const toIn = edt2(w, h, (i) => mask[i] === 1)
  const sd = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) sd[i] = mask[i] ? Math.sqrt(toOut[i]) - 0.5 : 0.5 - Math.sqrt(toIn[i])
  return sd
}

/** The deepest inside point between columns x0…x1 (sub-pixel: a parabola through the neighbours). */
function deepest(sd: Float32Array, w: number, h: number, x0: number, x1: number) {
  let best = -INF
  let bx = 0
  let by = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = Math.max(1, Math.floor(x0)); x < Math.min(w - 1, Math.ceil(x1)); x++) {
      const v = sd[y * w + x]
      if (v > best) {
        best = v
        bx = x
        by = y
      }
    }
  }
  const at = (x: number, y: number) => sd[y * w + x]
  const vertex = (a: number, b: number, c: number) => {
    const den = a - 2 * b + c
    return Math.abs(den) > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0
  }
  const ox = vertex(at(bx - 1, by), best, at(bx + 1, by))
  const oy = vertex(at(bx, by - 1), best, at(bx, by + 1))
  // the peak of a distance field is a cone, not a paraboloid: keep the sampled value (a lower bound)
  return { gx: bx + 0.5 + ox, gy: by + 0.5 + oy, r: best }
}

/**
 * Build the atlas of every hole look. `entryId` — the glyphId whose first letter the camera enters
 * (the 'about' hole's).
 */
export async function buildGlyphs(K: AboutKnobs, entryId: string | null): Promise<GlyphSet> {
  const looks = new Map<string, GlyphLook>()
  for (const h of K.holes) if (!looks.has(glyphId(h))) looks.set(glyphId(h), { text: h.text, stretchY: h.stretchY, tracking: h.tracking })
  let ms = 0
  const fields: { id: string; text: string; r: Raster; sd: Float32Array }[] = []
  let entry: GlyphSet['entry'] = null
  const timing: string[] = []
  for (const [id, look] of looks) {
    const text = look.text
    const t0 = performance.now()
    const r = rasterise(look, K)
    const t1 = performance.now()
    const sd = signedField(r)
    timing.push(`${text}×${look.stretchY}/${look.tracking}:${(t1 - t0).toFixed(1)}+${(performance.now() - t1).toFixed(1)}@${r.w}x${r.h}`)
    if (id === entryId) entry = { id, ...deepest(sd, r.w, r.h, r.firstX0, r.firstX1) }
    fields.push({ id, text, r, sd })
    ms += performance.now() - t0
    // one text per task: the page keeps its frames while the rest are built
    await sleep(0)
  }
  // the atlas is as wide as the widest text needs (≥ ATLAS_W); a text past ATLAS_MAX is left out — it
  // would wrap into the next row and smear over its neighbours
  const fits = fields.filter((f) => {
    if (f.r.w <= ATLAS_MAX) return true
    console.warn(`[about] hole text "${f.text}" is too long for the letter atlas (${f.r.w} px > ${ATLAS_MAX}) — left out`)
    return false
  })
  const shelfW = Math.max(ATLAS_W, ...fits.map((f) => f.r.w))
  // shelf packing, tallest first
  const order = [...fits].sort((a, b) => b.r.h - a.r.h)
  const place = new Map<string, { x: number; y: number }>()
  let sx = 0
  let sy = 0
  let shelf = 0
  let width = 1
  for (const f of order) {
    if (sx + f.r.w > shelfW && sx > 0) {
      sy += shelf
      sx = 0
      shelf = 0
    }
    place.set(f.id, { x: sx, y: sy })
    sx += f.r.w
    width = Math.max(width, sx)
    shelf = Math.max(shelf, f.r.h)
  }
  const height = Math.max(1, sy + shelf)
  width = Math.min(shelfW, Math.max(1, width))
  const dist = new Float32Array(width * height).fill(-RANGE)
  const bytes = new Uint8Array(width * height)
  const glyphs = new Map<string, Glyph>()
  for (const f of fits) {
    const at = place.get(f.id)!
    const { w, h } = f.r
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) dist[(at.y + y) * width + at.x + x] = Math.max(-RANGE, Math.min(RANGE, f.sd[y * w + x]))
    }
    glyphs.set(f.id, { id: f.id, text: f.text, ax: at.x, ay: at.y, w, h, inkX: f.r.inkX, inkY: f.r.inkY, inkW: f.r.inkW, inkH: f.r.inkH })
  }
  const k = 127 / RANGE
  for (let i = 0; i < dist.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(128 + dist[i] * k)))
  return { key: glyphKey(K), width, height, dist, bytes, glyphs, entry, ms, timing }
}

/** CPU lookup: signed distance at atlas point (x, y), glyph px (bilinear over the Uint8 copy). */
export function distAt(set: GlyphSet, x: number, y: number) {
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const W = set.width
  const H = set.height
  const b = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : set.bytes[yy * W + xx])
  const v = (b(x0, y0) * (1 - tx) + b(x0 + 1, y0) * tx) * (1 - ty) + (b(x0, y0 + 1) * (1 - tx) + b(x0 + 1, y0 + 1) * tx) * ty
  return ((v - 128) * RANGE) / 127
}
