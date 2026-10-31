import { cameraLamp, project3 } from '../../core/about-camera'
import { navDock } from '../../core/nav-dock'
import { FROZEN_SCROLL } from '../../core/scroll'
import type { Frame, Layout } from '../../core/types'
import { onPlane, shadowPool, sheenAt, type AboutCore, type AboutState, type CardInst, type Plane, type WordInst } from './core'
import type { AboutRenderer } from './index'
import { hexRgb, type AboutKnobs, type HazeKnobs, type PhotoKnobs, type V3 } from './knobs'
import { buildWordMesh, cardBox, CARD_FACE, PART, thinBands, type BoxArrays } from './mesh'
import type { PhotoSlot } from './photos'
import { BAYER, channelTable, gauss2, Grid, growBox, hash12, isEmpty, KIND_PAL, KIND_RGB, KIND_STIP, Lattice, quantTable, resolve, type Quant } from './soft'

/**
 * ABOUT — the 2D renderer: no WebGL2, `?nogl=about`, a program that fails to link, a lost context
 * (index.ts swaps it in behind the AboutRenderer seam and back). A SOFTWARE RASTERISER of the very
 * same scene as gl.ts — the same meshes (mesh.ts → buildWordMesh, cardBox), the same models and camera
 * (core.ts → AboutState: core/about-pose.ts, core/about-camera.ts), projected on the CPU onto the same
 * lattice (one canvas pixel per cell, `image-rendering: pixelated`) — so its silhouettes are the WebGL
 * image's, pixel for pixel up to a rounding.
 *
 *   triangles near-clipped in the camera's frame → z-buffered fill, binary coverage (pixel centres,
 *   ./soft.ts) → the shadows' footprints (half resolution) → a gaussian → the dots → ./soft.ts →
 *   resolve (the glitch pass, the dots in the empty pixels, the grain, the framebuffer's bits with the
 *   ordered dither) → putImageData of the box that changed
 *
 * What it draws, after shaders.ts (change one, change both):
 *   · black concrete — the band colours by part (face / chamfers / step / walls / seam / back), the key
 *     light quantised into about.concrete.bands from the per-vertex normals (interpolated per pixel
 *     where a triangle crosses a band), the warm lamp glint in steps where a bevel or wall catches it,
 *     the thin bands (the step, the seam groove) drawn as their neighbour when under a pixel wide, one
 *     haze step per word, the darkening behind the nav's labels (only what is lighter than their ink). NO mottle / aggregate texture: the
 *     concrete is flat per band (the one look it does not copy);
 *   · cards — the box: the graded picture point-sampled at an explicit mip level (its footprint, or the
 *     pop-in's), perspective-correct, swimming toward affine per face cell in motion (raster.affine);
 *     the stepped sheen, the whole-pixel seam, warm edges with the picture leaking into the sides in
 *     blocks, the haze by height, the wash behind the nav's labels;
 *   · shadows — every caster flattened along its own light (core.ts → shadowLamp, lightFrom) onto its plane into a footprint mask
 *     (a word's silhouette; a card's pool — core.ts → shadowPool; × the height fade), softened by the
 *     gaussian (shadow.blur), cut into shadow.steps steps of Bayer dots past shadow.edge, × the
 *     caster's presence; drawn only into the pixels nothing covers;
 *   · reveals — the same Bayer stipples (cards, the tour's words, the reduced-motion dissolve).
 * Its own cost: what does not change is kept (a frame whose geometry is unchanged only re-grains; one
 * that is unchanged altogether is not touched); the pictures are read back and graded once per arrival,
 * in the browser's idle time (until then a card shows its blank face, as the WebGL one does before its
 * upload). Before the pull it draws one hidden frame of the home framing (the JIT and the tables warm).
 */

/** Per-vertex record of a word, camera frame: X, Y (sheet units along the camera's right / down), D (along its view), ndl, world x y z, normal x y z, nh, depth fraction. */
const WS = 12
/** Per-vertex record of a card: X, Y, D, u, v. */
const CS = 5
/** Per-vertex record of a shadow footprint: X, Y, D, height above its plane, u, v. */
const SS = 6
/**
 * A projected vertex for the fill loops: sx, sy (lattice px), w = 1 / D, then the record's attributes
 * from index 3; a word's thin band adds its stand-in's ndl and normal at 12…15.
 */
const TS = 16

const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

/** A triangle is shaded with the per-pixel glint when a sample of it comes this close (in cos) to the glint's cone. */
const GLINT_MARGIN = 0.02

interface Level {
  w: number
  h: number
  /** graded texels, 0xBBGGRR (photo style) */
  px: Uint32Array
  /** halftone style: the stretched, contrasted luma, 0…1 */
  lum: Float32Array | null
}

interface Tex {
  key: string
  levels: Level[]
  /** level 0's size (the GL uTexSize) and the top mip level */
  tw: number
  th: number
  top: number
  /** halftone: the graded grey of each level step, packed */
  grey: Uint32Array | null
}

/** shaders.ts → hazed: how far toward the void at height z (a fog table in steps). */
function hazeAt(z: number, h: HazeKnobs) {
  const k = Math.min(1, Math.max(0, (h.near - z) / Math.max(1e-4, h.near - h.far)))
  return (h.amount * Math.floor(k * h.steps + 1e-4)) / Math.max(1, h.steps)
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

const STILL_POINTER = { x: 0, y: 0, vx: 0, vy: 0, energy: 0, rawX: 0, rawY: 0, targetX: 0, targetY: 0, active: false }

export function createAboutFallback(mount: HTMLElement, core: AboutCore): AboutRenderer {
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated', pointerEvents: 'none' })
  mount.appendChild(canvas)
  const g = canvas.getContext('2d')!
  const Lt = new Lattice()
  /** the shadows' footprint mask, half the lattice's resolution */
  const MG = new Grid()
  let maskR = new Float32Array(0)
  let maskQ = new Float32Array(0)
  let maskT = new Float32Array(0)
  let maskU = new Float32Array(0)
  let maskBox = [0, 0, 0, 0]
  /** the caster being drawn into the mask: its footprint's box */
  let footBox = [0, 0, 0, 0]
  /** per mask pixel: how many of the 16 Bayer ranks are dots */
  let maskN = new Uint8Array(0)
  const size = { w: 0, h: 0, cell: 1 }

  // ── this frame's camera, lattice px (set by frameCamera) ──
  let fl = 1
  let oxL = 0
  let oyL = 0
  /** the eye, sheet units */
  let camX = 0
  let camY = 0
  let camZ = 1
  /** its axes: right (rX…), down (dX…), the view (fX…) */
  let rX = 1, rY = 0, rZ = 0
  let dX = 0, dY = 1, dZ = 0
  let fX = 0, fY = 0, fZ = -1
  let near = 0.01
  /** the concrete's glint lamp this frame (core/about-camera.ts → cameraLamp) */
  let glintLamp: V3 = [0, 0, 1]

  // ── vertex scratch ──
  let VW: Float64Array = new Float64Array(0) // words: WS per vertex
  let PX: Float64Array = new Float64Array(0) // projected x, y, w per vertex (words)
  let VS: Float64Array = new Float64Array(0) // shadow footprints: SS per vertex
  let VC: Float64Array = new Float64Array(0) // cards: CS per vertex
  let PC: Float64Array = new Float64Array(0) // projected x, y, w per vertex (cards)
  const T = new Float64Array(3 * TS) // the triangle being filled
  const CLIP = new Float64Array(4 * TS) // a near-clipped polygon (≤ 4 vertices)
  const grow = (a: Float64Array, n: number): Float64Array => (a.length >= n ? a : new Float64Array(Math.ceil(n * 1.25)))

  // ── the palette (concrete colours → their dithered, grained tables) ──
  let palFor: AboutKnobs | null = null
  let palVoid = ''
  let palette = new Uint32Array(128 * 64)
  let palRgb = new Float64Array(3 * 64)
  let palCount = 0
  const palIds = new Map<string, number>()
  /** per haze amount: ids[(part × (bands + 1) + band) × (glint steps + 1) + glint] */
  const wordIds = new Map<number, Int32Array>()
  /** palette id → its colour under the nav's dock (−1: not made yet) */
  let docked = new Int32Array(64).fill(-1)
  let concreteQ: Quant = { levels: 63, dither: 0.6, grain: 0.02 }
  let cardTable = channelTable({ levels: 63, dither: 0.6, grain: 0.01 })
  let cardQKey = ''
  let voidRgb: V3 = [0.9, 0.87, 0.82]
  let dockInk: V3 = [0.13, 0.13, 0.13]
  let shadowPx = 0

  function palId(r: number, gr: number, b: number) {
    const key = `${Math.round(r * 4096)},${Math.round(gr * 4096)},${Math.round(b * 4096)}`
    let id = palIds.get(key)
    if (id === undefined) {
      id = palCount++
      if (palette.length < palCount * 128) {
        const p = new Uint32Array(palette.length * 2)
        p.set(palette)
        palette = p
        const c = new Float64Array(palRgb.length * 2)
        c.set(palRgb)
        palRgb = c
        const d = new Int32Array(docked.length * 2).fill(-1)
        d.set(docked)
        docked = d
      }
      quantTable(r, gr, b, concreteQ, palette, id * 128)
      palRgb[3 * id] = r
      palRgb[3 * id + 1] = gr
      palRgb[3 * id + 2] = b
      palIds.set(key, id)
    }
    return id
  }

  /**
   * shaders.ts CONCRETE_FS: behind the nav's labels the concrete is no lighter than the dock's ink (×
   * amount) — only a colour that IS lighter than it (+ 0.04 in luma) changes.
   */
  function dockedId(id: number, amount: number) {
    let d = docked[id]
    if (d < 0) {
      const lum = (r: number, gr: number, b: number) => LUMA_R * r + LUMA_G * gr + LUMA_B * b
      if (!(lum(palRgb[3 * id], palRgb[3 * id + 1], palRgb[3 * id + 2]) > lum(dockInk[0], dockInk[1], dockInk[2]) + 0.04)) return (docked[id] = id)
      const ch = (k: number) => {
        const c = palRgb[3 * id + k]
        return c + (Math.min(c, dockInk[k]) - c) * amount
      }
      const r = ch(0)
      const gr = ch(1)
      const b = ch(2)
      d = palId(r, gr, b)
      docked[id] = d
    }
    return d
  }

  /** Everything derived from the knobs and the void colour, rebuilt when they change. */
  function knobsFor(K: AboutKnobs, voidHex: string) {
    if (palFor === K && palVoid === voidHex) return
    palFor = K
    palVoid = voidHex
    palIds.clear()
    wordIds.clear()
    docked.fill(-1)
    palCount = 0
    voidRgb = hexRgb(voidHex)
    dockInk = hexRgb(K.concrete.dock.ink)
    const levels = 2 ** K.raster.bits - 1
    concreteQ = { levels, dither: K.raster.dither, grain: K.concrete.grain }
    const ck = `${levels}|${K.raster.dither}|${K.cards.grain}`
    if (ck !== cardQKey) {
      cardQKey = ck
      cardTable = channelTable({ levels, dither: K.raster.dither, grain: K.cards.grain })
    }
    const s = hexRgb(K.shadow.color)
    shadowPx = (0xff000000 | (Math.round(s[2] * 255) << 16) | (Math.round(s[1] * 255) << 8) | Math.round(s[0] * 255)) >>> 0
  }

  /** The palette ids of one haze step (a word's), every part × band × glint step. */
  function idsFor(K: AboutKnobs, haze: number) {
    let ids = wordIds.get(haze)
    if (ids) return ids
    const C = K.concrete
    const B = C.bands
    const GS = C.glint.steps
    ids = new Int32Array(7 * (B + 1) * (GS + 1))
    const pair = (p: { dark: string; lit: string }) => [hexRgb(p.dark), hexRgb(p.lit)]
    const face = pair(C.face)
    const step = pair(C.step)
    const bevel = pair(C.bevel)
    const wall = pair(C.wall)
    const seam = hexRgb(C.seam)
    const back = hexRgb(C.back)
    const glint = hexRgb(C.glint.color)
    const mix = (p: V3[], t: number): V3 => [p[0][0] + (p[1][0] - p[0][0]) * t, p[0][1] + (p[1][1] - p[0][1]) * t, p[0][2] + (p[1][2] - p[0][2]) * t]
    for (let part = 0; part < 7; part++)
      for (let bi = 0; bi <= B; bi++) {
        const b = bi / B
        const col: V3 =
          part === PART.face ? mix(face, b) :
          part === PART.chamfer1 ? mix(bevel, b) :
          part === PART.step ? mix(step, b) :
          part === PART.chamfer2 ? mix(bevel, b * 0.85) :
          part === PART.wall ? mix(wall, b) :
          part === PART.seam ? seam : back
        for (let gi = 0; gi <= GS; gi++) {
          const a = (gi / GS) * C.glint.amount
          let r = col[0] + (glint[0] - col[0]) * a
          let gr = col[1] + (glint[1] - col[1]) * a
          let bl = col[2] + (glint[2] - col[2]) * a
          r += (voidRgb[0] - r) * haze
          gr += (voidRgb[1] - gr) * haze
          bl += (voidRgb[2] - bl) * haze
          ids[(part * (B + 1) + bi) * (GS + 1) + gi] = palId(r, gr, bl)
        }
      }
    wordIds.set(haze, ids)
    return ids
  }

  // ── pictures: read back once per arrival, mipmapped (2 × 2 boxes, like generateMipmap), graded ──
  const texs: (Tex | null)[] = []
  let texReady = 0
  /** the slowest picture build so far, ms (stats) */
  let buildMs = 0

  function texKey(k: PhotoKnobs, slot: PhotoSlot, K: AboutKnobs) {
    const G = K.photos.grade
    const sat = k.saturation >= 0 ? k.saturation : G.saturation
    return `${slot.version}|${slot.canvas.width}x${slot.canvas.height}|${sat}|${G.contrast}|${G.black}|${G.white}|${G.tint}|${G.tintAmount}|${k.halftone ? `h${K.photos.halftone}|${slot.lo}|${slot.hi}` : 'p'}`
  }

  function buildTex(k: PhotoKnobs, slot: PhotoSlot, K: AboutKnobs, key: string): Tex | null {
    const t0 = performance.now()
    const cv = slot.canvas
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    if (!ctx || cv.width < 1 || cv.height < 1) return null
    let w = cv.width
    let h = cv.height
    let raw: Uint8ClampedArray = ctx.getImageData(0, 0, w, h).data
    const G = K.photos.grade
    const sat = k.saturation >= 0 ? k.saturation : G.saturation
    const tint = hexRgb(G.tint)
    const tl = Math.max(1e-3, LUMA_R * tint[0] + LUMA_G * tint[1] + LUMA_B * tint[2])
    const tm = tint.map((v) => 1 + (v / tl - 1) * G.tintAmount)
    const con = G.contrast
    const bk = G.black
    const wt = G.white
    const half = k.halftone
    const lo = slot.lo
    const span = Math.max(0.05, slot.hi - slot.lo)
    const top = Math.floor(Math.log2(Math.max(1, Math.max(w, h))))
    const levels: Level[] = []
    for (let l = 0; l <= top; l++) {
      const n = w * h
      const px = new Uint32Array(half ? 0 : n)
      const lum = half ? new Float32Array(n) : null
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = raw[p] / 255
        const gr = raw[p + 1] / 255
        const b = raw[p + 2] / 255
        const y = LUMA_R * r + LUMA_G * gr + LUMA_B * b
        if (lum) {
          // shaders.ts → pic(), the halftone: the picture's own luma range stretched, then contrast
          lum[i] = clamp01((clamp01((y - lo) / span) - 0.5) * con + 0.5)
          continue
        }
        let R = clamp01((y + (r - y) * sat - 0.5) * con + 0.5)
        let Gc = clamp01((y + (gr - y) * sat - 0.5) * con + 0.5)
        let Bc = clamp01((y + (b - y) * sat - 0.5) * con + 0.5)
        R = bk + (wt - bk) * clamp01(R * tm[0])
        Gc = bk + (wt - bk) * clamp01(Gc * tm[1])
        Bc = bk + (wt - bk) * clamp01(Bc * tm[2])
        px[i] = (Math.round(Bc * 255) << 16) | (Math.round(Gc * 255) << 8) | Math.round(R * 255)
      }
      levels.push({ w, h, px, lum })
      if (l === top) break
      // the next level: 2 × 2 boxes (an odd last row / column folds into the one before)
      const w2 = Math.max(1, w >> 1)
      const h2 = Math.max(1, h >> 1)
      const next = new Uint8ClampedArray(w2 * h2 * 4)
      for (let y = 0; y < h2; y++) {
        const y0 = Math.min(h - 1, 2 * y)
        const y1 = Math.min(h - 1, 2 * y + 1)
        for (let x = 0; x < w2; x++) {
          const x0 = Math.min(w - 1, 2 * x)
          const x1 = Math.min(w - 1, 2 * x + 1)
          const a = (y0 * w + x0) * 4
          const b = (y0 * w + x1) * 4
          const c2 = (y1 * w + x0) * 4
          const d = (y1 * w + x1) * 4
          const o = (y * w2 + x) * 4
          next[o] = (raw[a] + raw[b] + raw[c2] + raw[d] + 2) >> 2
          next[o + 1] = (raw[a + 1] + raw[b + 1] + raw[c2 + 1] + raw[d + 1] + 2) >> 2
          next[o + 2] = (raw[a + 2] + raw[b + 2] + raw[c2 + 2] + raw[d + 2] + 2) >> 2
        }
      }
      raw = next
      w = w2
      h = h2
    }
    let grey: Uint32Array | null = null
    if (half) {
      const lev = Math.max(1, K.photos.halftone - 1)
      grey = new Uint32Array(lev + 1)
      for (let i = 0; i <= lev; i++) {
        const v = i / lev
        const ch = (m: number) => Math.round((bk + (wt - bk) * clamp01(v * m)) * 255)
        grey[i] = (ch(tm[2]) << 16) | (ch(tm[1]) << 8) | ch(tm[0])
      }
    }
    buildMs = Math.max(buildMs, performance.now() - t0)
    return { key, levels, tw: cv.width, th: cv.height, top, grey }
  }

  /**
   * The pictures are built ahead, in the browser's idle time, as they arrive (like the WebGL renderer
   * uploads them on decode); a card whose picture is not built yet shows its blank face. Only a card
   * that has waited on screen INFRAME_AFTER ms (a busy page, a fresh context loss) gets its picture
   * built inside a frame — one per frame.
   */
  const INFRAME_AFTER = 400
  let idleId = 0
  let disposed = false
  let builtFor = -1
  let waiting = 0
  // (no requestIdleCallback — Safari: a slow timer with a slot assumed free; a forced callback after
  // the timeout finds no time left and only asks again)
  const ric: (cb: (d: { timeRemaining(): number }) => void) => number =
    typeof requestIdleCallback === 'function' ? (cb) => requestIdleCallback(cb, { timeout: 400 }) : (cb) => window.setTimeout(() => cb({ timeRemaining: () => 8 }), 120)
  const cancelIdle = (id: number) => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(id) : window.clearTimeout(id))
  const missing = (c: { k: PhotoKnobs; slot: PhotoSlot }, K: AboutKnobs) => texs[c.k.index]?.key !== texKey(c.k, c.slot, K)
  /** The next picture not built yet (the ones in the last frame first), or null. */
  function nextMissing(K: AboutKnobs) {
    for (const c of lastCards) if (missing(c, K)) return { k: c.k, slot: c.slot }
    for (const k of K.photos.items) {
      const slot = core.photos.get(k.index)
      if (slot && missing({ k, slot }, K)) return { k, slot }
    }
    return null
  }
  let lastCards: readonly CardInst[] = []
  function idleBuild(d: { timeRemaining(): number }) {
    idleId = 0
    if (disposed) return
    const K = core.K
    for (;;) {
      const m = nextMissing(K)
      if (!m) {
        builtFor = core.version
        return
      }
      if (d.timeRemaining() < 4) break
      texs[m.k.index] = buildTex(m.k, m.slot, K, texKey(m.k, m.slot, K))
      texReady++
    }
    idleId = ric(idleBuild)
  }
  function texturesFor(st: AboutState) {
    lastCards = st.cards
    const want = st.cards.find((c) => missing(c, st.K))
    if (!want && builtFor === core.version) {
      waiting = 0
      return
    }
    if (!idleId) idleId = ric(idleBuild)
    if (!want) {
      waiting = 0
      return
    }
    const now = performance.now()
    if (!waiting) waiting = now
    else if (now - waiting > INFRAME_AFTER) {
      texs[want.k.index] = buildTex(want.k, want.slot, st.K, texKey(want.k, want.slot, st.K))
      texReady++
      waiting = now
    }
  }

  // ── the camera ──
  function frameCamera(st: AboutState) {
    const v = st.view
    fl = v.fpx / size.cell
    oxL = v.ox / size.cell
    oyL = v.oy / size.cell
    ;[camX, camY, camZ] = v.eye
    ;[rX, rY, rZ] = v.right
    ;[dX, dY, dZ] = v.down
    ;[fX, fY, fZ] = v.fwd
    near = v.near
    glintLamp = cameraLamp(v, st.K.concrete.glint.lamp)
  }

  /** The height (world z) of the point seen at lattice px (sx, sy) at distance D along the view. */
  const zAt = (sx: number, sy: number, D: number) => camZ + D * (((sx - oxL) / fl) * rZ + ((sy - oyL) / fl) * dZ + fZ)

  /**
   * Clip the triangle a, b, c (records of `stride` in `V`) at the near plane (D ≥ near) into CLIP:
   * its vertex count (0, 3 or 4). A new vertex is always interpolated FROM the inside vertex, so the
   * neighbour across that edge gets the very same point.
   */
  function clipNear(V: Float64Array, stride: number, a: number, b: number, c: number) {
    const idx = [a, b, c]
    let n = 0
    for (let k = 0; k < 3; k++) {
      const p = idx[k]
      const q = idx[(k + 1) % 3]
      const pin = V[p + 2] >= near
      const qin = V[q + 2] >= near
      if (pin) {
        for (let j = 0; j < stride; j++) CLIP[n * stride + j] = V[p + j]
        n++
      }
      if (pin !== qin) {
        const i = pin ? p : q
        const o = pin ? q : p
        const t = (V[i + 2] - near) / (V[i + 2] - V[o + 2])
        for (let j = 0; j < stride; j++) CLIP[n * stride + j] = V[i + j] + (V[o + j] - V[i + j]) * t
        CLIP[n * stride + 2] = near
        n++
      }
    }
    return n
  }

  /** Record `r` (of `stride` in V) → T slot k: projected (× `scale`: the mask's half resolution), its attributes copied. */
  function toT(V: Float64Array, r: number, stride: number, k: number, scale = 1) {
    const o = k * TS
    const w = 1 / V[r + 2]
    T[o] = (V[r] * fl * w + oxL) * scale
    T[o + 1] = (V[r + 1] * fl * w + oyL) * scale
    T[o + 2] = w
    for (let j = 3; j < stride; j++) T[o + j] = V[r + j]
  }

  // ── per-triangle plane gradients (screen-linear functions over T's triangle) ──
  let px0 = 0
  let py0 = 0
  let e1x = 0
  let e1y = 0
  let e2x = 0
  let e2y = 0
  let inv = 0
  function plane() {
    px0 = T[0]
    py0 = T[1]
    e1x = T[TS] - px0
    e1y = T[TS + 1] - py0
    e2x = T[2 * TS] - px0
    e2y = T[2 * TS + 1] - py0
    inv = 1 / (e1x * e2y - e2x * e1y)
  }
  const gx = (f0: number, f1: number, f2: number) => ((f1 - f0) * e2y - (f2 - f0) * e1y) * inv
  const gy = (f0: number, f1: number, f2: number) => ((f2 - f0) * e1x - (f1 - f0) * e2x) * inv
  /** T's attribute j × w at vertex k (perspective-correct interpolation) */
  const qa = (j: number, k: number) => T[k * TS + j] * T[k * TS + 2]
  /** The screen gradient's length (per px) of T's attribute j, perspective-correct, at the centroid. */
  function gradAt(j: number) {
    plane()
    const w0 = T[2]
    const wx = gx(w0, T[TS + 2], T[2 * TS + 2])
    const wy = gy(w0, T[TS + 2], T[2 * TS + 2])
    const f0 = qa(j, 0)
    const fx = gx(f0, qa(j, 1), qa(j, 2))
    const fy = gy(f0, qa(j, 1), qa(j, 2))
    const cx = (T[0] + T[TS] + T[2 * TS]) / 3 - px0
    const cy = (T[1] + T[TS + 1] + T[2 * TS + 1]) / 3 - py0
    const W = w0 + wx * cx + wy * cy
    const F = f0 + fx * cx + fy * cy
    return Math.hypot((fx * W - F * wx) / (W * W), (fy * W - F * wy) / (W * W))
  }

  /**
   * The nav's labels (core/nav-dock.ts: each docked item, its dot and its text) this frame, padded by
   * cards.dock.pad, lattice px (y down): x0, y0, x1, y1 each; null — none (shaders.ts → dockOut).
   */
  let dock: number[][] | null = null
  /** Whether T's triangle comes within `reach` px of a label. */
  function nearDock(reach: number) {
    if (!dock) return false
    const x0 = Math.min(T[0], T[TS], T[2 * TS])
    const x1 = Math.max(T[0], T[TS], T[2 * TS])
    const y0 = Math.min(T[1], T[TS + 1], T[2 * TS + 1])
    const y1 = Math.max(T[1], T[TS + 1], T[2 * TS + 1])
    for (const d of dock) if (x1 > d[0] - reach && x0 < d[2] + reach && y1 > d[1] - reach && y0 < d[3] + reach) return true
    return false
  }
  /**
   * shaders.ts → dockOut: behind a label (a pill: its ends rounded by half its height), across a Bayer
   * edge of `edge` px: the pixel (x, y) with Bayer rank `rank` is in.
   */
  function inDock(x: number, y: number, rank: number, edge: number) {
    const cx = x + 0.5
    const cy = y + 0.5
    // a pixel is in only where o < edge / 2 (below): farther than that outside a pill's box it cannot
    // be — skipped without the distance (a big triangle near the nav calls this for every pixel)
    const m = Math.max(1, edge) / 2
    let o = 1e5
    for (const d of dock!) {
      if (cx < d[0] - m || cx > d[2] + m || cy < d[1] - m || cy > d[3] + m) continue
      const hx = (d[2] - d[0]) / 2
      const hy = (d[3] - d[1]) / 2
      const rad = Math.min(hx, hy)
      const qx = Math.abs(cx - (d[0] + d[2]) / 2) - hx + rad
      const qy = Math.abs(cy - (d[1] + d[3]) / 2) - hy + rad
      o = Math.min(o, Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad)
    }
    return (rank + 0.5) / 16 < clamp01(0.5 - o / Math.max(1, edge))
  }
  /**
   * DB ← the labels' box grown by `edge` / 2 (x0, y0, x1, y1, lattice px): outside it inDock is false,
   * so a fill tests it inline first — a big triangle near the nav covers it only with a few pixels.
   */
  const DB = new Float64Array(4)
  function dockBox(edge: number) {
    const m = Math.max(1, edge) / 2
    DB[0] = DB[1] = 1e9
    DB[2] = DB[3] = -1e9
    for (const d of dock!) {
      DB[0] = Math.min(DB[0], d[0] - m)
      DB[1] = Math.min(DB[1], d[1] - m)
      DB[2] = Math.max(DB[2], d[2] + m)
      DB[3] = Math.max(DB[3], d[3] + m)
    }
  }

  let tris = 0
  /** KIND_STIP while the object being filled is mid-reveal (soft.ts: covered, never crawled), else 0 */
  let stipFlag = 0

  // ── fills ──

  /**
   * A triangle of one flat value (z-tested, stippled below `lim`: Bayer ranks ≤ lim are drawn); with
   * `dockVal` ≥ 0, the value under the dock (`dockEdge` px of Bayer edge).
   */
  function fillFlat(val: number, lim: number, dockVal = -1, dockEdge = 1) {
    if (!Lt.spans(T[0], T[1], T[TS], T[TS + 1], T[2 * TS], T[2 * TS + 1])) return
    plane()
    const w0 = T[2]
    const wx = gx(w0, T[TS + 2], T[2 * TS + 2])
    const wy = gy(w0, T[TS + 2], T[2 * TS + 2])
    const { L, R, depth, pre, bay } = Lt
    const W = Lt.w
    const all = lim >= 15
    if (dockVal >= 0) dockBox(dockEdge)
    for (let y = Lt.ya; y < Lt.yb; y++) {
      const xs = L[y]
      const xe = R[y]
      if (xe <= xs) continue
      let w = w0 + wx * (xs + 0.5 - px0) + wy * (y + 0.5 - py0)
      let i = y * W + xs
      const br = bay[y]
      if (dockVal >= 0) {
        const rowIn = y + 0.5 >= DB[1] && y + 0.5 <= DB[3]
        for (let x = xs; x < xe; x++, i++, w += wx) {
          const rank = BAYER[br + (x & 3)]
          if (w > depth[i] && (all || rank <= lim)) (depth[i] = w), (pre[i] = rowIn && x + 0.5 >= DB[0] && x + 0.5 <= DB[2] && inDock(x, y, rank, dockEdge) ? dockVal : val)
        }
      } else if (all) {
        for (let x = xs; x < xe; x++, i++, w += wx) if (w > depth[i]) (depth[i] = w), (pre[i] = val)
      } else {
        for (let x = xs; x < xe; x++, i++, w += wx) if (w > depth[i] && BAYER[br + (x & 3)] <= lim) (depth[i] = w), (pre[i] = val)
      }
    }
    Lt.touch()
    tris++
  }

  /** fillConcrete's per-pixel planes (× w): slot k → P[3k] at the first vertex, P[3k + 1] per x, P[3k + 2] per y */
  const P = new Float64Array(36)
  function planeSlot(slot: number, j: number) {
    const f0 = qa(j, 0)
    P[3 * slot] = f0
    P[3 * slot + 1] = gx(f0, qa(j, 1), qa(j, 2))
    P[3 * slot + 2] = gy(f0, qa(j, 1), qa(j, 2))
  }
  let lampX = 0
  let lampY = 0
  let lampZ = 0
  /** The lamp's nh at pixel offset (ex, fy) from the triangle's first vertex (D = 1 / w there), normal slot n0 (P). */
  function nhPix(ex: number, fy: number, D: number, n0: number) {
    const pxw = (P[3] + P[4] * ex + P[5] * fy) * D
    const pyw = (P[6] + P[7] * ex + P[8] * fy) * D
    const pzw = (P[9] + P[10] * ex + P[11] * fy) * D
    let Nx = (P[3 * n0] + P[3 * n0 + 1] * ex + P[3 * n0 + 2] * fy) * D
    let Ny = (P[3 * n0 + 3] + P[3 * n0 + 4] * ex + P[3 * n0 + 5] * fy) * D
    let Nz = (P[3 * n0 + 6] + P[3 * n0 + 7] * ex + P[3 * n0 + 8] * fy) * D
    const nl = 1 / (Math.sqrt(Nx * Nx + Ny * Ny + Nz * Nz) || 1)
    Nx *= nl
    Ny *= nl
    Nz *= nl
    let vx = camX - pxw
    let vy = camY - pyw
    let vz = camZ - pzw
    const vl = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1)
    let lx = lampX - pxw
    let ly = lampY - pyw
    let lz = lampZ - pzw
    const ll = 1 / (Math.sqrt(lx * lx + ly * ly + lz * lz) || 1)
    lx = lx * ll + vx * vl
    ly = ly * ll + vy * vl
    lz = lz * ll + vz * vl
    return (Nx * lx + Ny * ly + Nz * lz) / (Math.sqrt(lx * lx + ly * ly + lz * lz) || 1)
  }

  /**
   * What fillConcrete shades a triangle as. `alt` — a thin band's stand-in (its ndl at T[12], its normal
   * at T[13…15]), used where the Bayer rank reaches `altFrom` (shaders.ts: the thin bands' LOD).
   */
  interface Shade {
    part: number
    glint: boolean
    alt: { part: number; glint: boolean; from: number } | null
    /**
     * a chamfer / wall triangle next to its word's thin band drawn as a line (WordInst.bands): its
     * pixels within half a pixel (df — the depth fraction per px) of the band (mid ± half, depth
     * fractions) take the band's part (shaders.ts → CONCRETE_FS)
     */
    line: { mid: number; half: number; df: number; part: number } | null
  }

  /**
   * A concrete triangle whose key light crosses a band, catches the glint or is a thin band: ndl
   * (attribute 3) interpolated per pixel, perspective-correct; the lamp's reflection per pixel where it
   * can reach (world point: attributes 4–6, normal: 7–9).
   */
  function fillConcrete(ids: Int32Array, K: AboutKnobs, lim: number, sh: Shade) {
    if (!Lt.spans(T[0], T[1], T[TS], T[TS + 1], T[2 * TS], T[2 * TS + 1])) return
    plane()
    const C = K.concrete
    const B = C.bands
    const GS = C.glint.steps
    const w0 = T[2]
    const wx = gx(w0, T[TS + 2], T[2 * TS + 2])
    const wy = gy(w0, T[TS + 2], T[2 * TS + 2])
    // per-pixel planes (× w): ndl, the world point, the normal; the stand-in's ndl and normal
    planeSlot(0, 3)
    const anyGlint = sh.glint || (sh.alt?.glint ?? false)
    if (anyGlint) for (let j = 0; j < 6; j++) planeSlot(1 + j, 4 + j)
    if (sh.alt) for (let j = 0; j < 4; j++) planeSlot(7 + j, 12 + j)
    const line = sh.line
    if (line) planeSlot(11, 11)
    const cosS = Math.cos((C.glint.size * Math.PI) / 180)
    ;[lampX, lampY, lampZ] = glintLamp
    const dockOn = dock && C.dock.amount > 0 && nearDock(C.dock.edge + 1)
    if (dockOn) dockBox(C.dock.edge)
    // a big triangle: the glint looked for on a grid of 8 × 8 px blocks first (its corners; the spot is
    // small and smooth) — only the blocks it can reach are shaded per pixel
    let lit: Uint8Array | null = null
    const gx0 = Lt.x0
    const gy0 = Lt.ya
    const gw = ((Lt.x1 - gx0 + 7) >> 3) + 0
    if (anyGlint && (Lt.x1 - Lt.x0) * (Lt.yb - Lt.ya) > 512) {
      const gh = (Lt.yb - gy0 + 7) >> 3
      const cw = gw + 1
      const ch = new Float64Array(cw * (gh + 1))
      for (let j = 0; j <= gh; j++)
        for (let k = 0; k <= gw; k++) {
          const ex = gx0 + 8 * k - px0
          const fy = gy0 + 8 * j - py0
          const ww = w0 + wx * ex + wy * fy
          if (!(ww > 0)) {
            ch[j * cw + k] = 1
            continue
          }
          let m = -1
          if (sh.glint) m = nhPix(ex, fy, 1 / ww, 4)
          if (sh.alt?.glint) m = Math.max(m, nhPix(ex, fy, 1 / ww, 8))
          ch[j * cw + k] = m
        }
      lit = new Uint8Array(gw * gh)
      const at = cosS - GLINT_MARGIN
      for (let j = 0; j < gh; j++)
        for (let k = 0; k < gw; k++) lit[j * gw + k] = Math.max(ch[j * cw + k], ch[j * cw + k + 1], ch[(j + 1) * cw + k], ch[(j + 1) * cw + k + 1]) >= at ? 1 : 0
    }
    const { L, R, depth, pre, bay } = Lt
    const W = Lt.w
    const all = lim >= 15
    for (let y = Lt.ya; y < Lt.yb; y++) {
      const xs = L[y]
      const xe = R[y]
      if (xe <= xs) continue
      const fy = y + 0.5 - py0
      let w = w0 + wx * (xs + 0.5 - px0) + wy * fy
      let i = y * W + xs
      const br = bay[y]
      for (let x = xs; x < xe; x++, i++, w += wx) {
        const rank = BAYER[br + (x & 3)]
        if (!(w > depth[i]) || (!all && rank > lim)) continue
        const ex = x + 0.5 - px0
        const D = 1 / w
        // which shading: the band itself, or (a thin band past its LOD) its stand-in
        const alt = sh.alt !== null && (rank + 0.5) / 16 >= sh.alt.from
        let part = alt ? sh.alt!.part : sh.part
        // a chamfer / wall pixel within half a pixel of its word's thin band: the band's line
        const onLine = line !== null && Math.abs((P[33] + P[34] * ex + P[35] * fy) * D - line.mid) - line.half < 0.5 * line.df
        if (onLine) part = line!.part
        const s0 = alt ? 7 : 0
        const ndl = (P[3 * s0] + P[3 * s0 + 1] * ex + P[3 * s0 + 2] * fy) * D
        let bi = ndl <= 0 ? 0 : Math.floor(ndl * B + 0.5)
        if (bi > B) bi = B
        let gi = 0
        if (!onLine && (alt ? sh.alt!.glint : sh.glint) && (!lit || lit[((y - gy0) >> 3) * gw + ((x - gx0) >> 3)])) {
          gi = Math.ceil(clamp01((nhPix(ex, fy, D, alt ? 8 : 4) - cosS) / Math.max(1e-4, 1 - cosS)) * GS)
        }
        let id = ids[(part * (B + 1) + bi) * (GS + 1) + gi]
        if (dockOn && y + 0.5 >= DB[1] && y + 0.5 <= DB[3] && x + 0.5 >= DB[0] && x + 0.5 <= DB[2] && inDock(x, y, rank, C.dock.edge)) id = dockedId(id, C.dock.amount)
        depth[i] = w
        pre[i] = KIND_PAL | id | stipFlag
      }
    }
    Lt.touch()
    tris++
  }

  // ── words ──

  /** The key light's band of a vertex's ndl. */
  const bandOf = (ndl: number, B: number) => (ndl <= 0 ? 0 : Math.min(B, Math.floor(ndl * B + 0.5)))

  /** How much the lamp's reflection lines up at a point of the triangle (barycentric s, t, r; world records of VW). */
  function nhAt(a: number, b: number, c: number, s: number, t: number, r: number, lamp: V3) {
    const px = VW[a + 4] * s + VW[b + 4] * t + VW[c + 4] * r
    const py = VW[a + 5] * s + VW[b + 5] * t + VW[c + 5] * r
    const pz = VW[a + 6] * s + VW[b + 6] * t + VW[c + 6] * r
    let nx = VW[a + 7] * s + VW[b + 7] * t + VW[c + 7] * r
    let ny = VW[a + 8] * s + VW[b + 8] * t + VW[c + 8] * r
    let nz = VW[a + 9] * s + VW[b + 9] * t + VW[c + 9] * r
    const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1)
    nx *= nl
    ny *= nl
    nz *= nl
    let vx = camX - px
    let vy = camY - py
    let vz = camZ - pz
    const vl = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1)
    let lx = lamp[0] - px
    let ly = lamp[1] - py
    let lz = lamp[2] - pz
    const ll = 1 / (Math.sqrt(lx * lx + ly * ly + lz * lz) || 1)
    vx = vx * vl + lx * ll
    vy = vy * vl + ly * ll
    vz = vz * vl + lz * ll
    return (nx * vx + ny * vy + nz * vz) / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1)
  }

  /**
   * Whether the lamp's reflection can reach this triangle (world records a, b, c of VW): the vertices'
   * own nh, the edges' midpoints and the centroid (smooth normals peak BETWEEN the vertices), and the
   * mirror point of the lamp in the triangle's plane if it lies inside it (a big flat facet).
   */
  function glintNear(a: number, b: number, c: number, cosS: number, lamp: V3) {
    const m = Math.max(VW[a + 10], VW[b + 10], VW[c + 10])
    if (m >= cosS) return true
    if (m >= cosS - 0.08) {
      const near = cosS - GLINT_MARGIN
      if (nhAt(a, b, c, 0.5, 0.5, 0, lamp) >= near || nhAt(a, b, c, 0, 0.5, 0.5, lamp) >= near || nhAt(a, b, c, 0.5, 0, 0.5, lamp) >= near || nhAt(a, b, c, 1 / 3, 1 / 3, 1 / 3, lamp) >= near) return true
    }
    const ax = VW[a + 4], ay = VW[a + 5], az = VW[a + 6]
    const ux = VW[b + 4] - ax, uy = VW[b + 5] - ay, uz = VW[b + 6] - az
    const vx = VW[c + 4] - ax, vy = VW[c + 5] - ay, vz = VW[c + 6] - az
    // outward normal (mesh.ts: cross(b − a, c − a) · n < 0)
    let nx = -(uy * vz - uz * vy)
    let ny = -(uz * vx - ux * vz)
    let nz = -(ux * vy - uy * vx)
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (!(nl > 0)) return false
    nx /= nl
    ny /= nl
    nz /= nl
    const dc = (camX - ax) * nx + (camY - ay) * ny + (camZ - az) * nz
    const dl = (lamp[0] - ax) * nx + (lamp[1] - ay) * ny + (lamp[2] - az) * nz
    if (!(dc > 0 && dl > 0)) return false
    // the camera mirrored in the plane; the lamp → mirror line meets the plane at the reflection point
    const mx = camX - 2 * dc * nx
    const my = camY - 2 * dc * ny
    const mz = camZ - 2 * dc * nz
    const t = dl / (dl + dc)
    const qx = lamp[0] + (mx - lamp[0]) * t - ax
    const qy = lamp[1] + (my - lamp[1]) * t - ay
    const qz = lamp[2] + (mz - lamp[2]) * t - az
    const d00 = ux * ux + uy * uy + uz * uz
    const d01 = ux * vx + uy * vy + uz * vz
    const d11 = vx * vx + vy * vy + vz * vz
    const d20 = qx * ux + qy * uy + qz * uz
    const d21 = qx * vx + qy * vy + qz * vz
    const den = d00 * d11 - d01 * d01
    if (!(Math.abs(den) > 0)) return false
    const s = (d11 * d20 - d01 * d21) / den
    const r = (d00 * d21 - d01 * d20) / den
    // a little outside counts: a spot on the edge lights pixels inside
    return s >= -0.05 && r >= -0.05 && s + r <= 1.05
  }

  function drawWord(st: AboutState, w: WordInst) {
    const K = st.K
    const C = K.concrete
    const mesh = buildWordMesh(w.pose.look, w.pose.profile)
    const n = mesh.count
    if (!n) return
    VW = grow(VW, n * WS)
    PX = grow(PX, n * 3)
    const M = w.M
    const pos = mesh.position
    const nor = mesh.normal
    const fr = mesh.part
    const [kx, ky, kz] = C.light
    const lamp: V3 = glintLamp
    const glintOn = C.glint.amount > 0
    for (let v = 0; v < n; v++) {
      const x = pos[3 * v]
      const y = pos[3 * v + 1]
      const z = pos[3 * v + 2]
      const wx = M[0] * x + M[4] * y + M[8] * z + M[12]
      const wy = M[1] * x + M[5] * y + M[9] * z + M[13]
      const wz = M[2] * x + M[6] * y + M[10] * z + M[14]
      const dx = wx - camX
      const dy = wy - camY
      const dz = wz - camZ
      const X = rX * dx + rY * dy + rZ * dz
      const Y = dX * dx + dY * dy + dZ * dz
      const D = fX * dx + fY * dy + fZ * dz
      const a = nor[3 * v]
      const b = nor[3 * v + 1]
      const c = nor[3 * v + 2]
      let Nx = M[0] * a + M[4] * b + M[8] * c
      let Ny = M[1] * a + M[5] * b + M[9] * c
      let Nz = M[2] * a + M[6] * b + M[10] * c
      const nl = 1 / (Math.sqrt(Nx * Nx + Ny * Ny + Nz * Nz) || 1)
      Nx *= nl
      Ny *= nl
      Nz *= nl
      const o = v * WS
      VW[o] = X
      VW[o + 1] = Y
      VW[o + 2] = D
      VW[o + 3] = Nx * kx + Ny * ky + Nz * kz
      VW[o + 4] = wx
      VW[o + 5] = wy
      VW[o + 6] = wz
      VW[o + 7] = Nx
      VW[o + 8] = Ny
      VW[o + 9] = Nz
      VW[o + 10] = glintOn ? nhOf(wx, wy, wz, Nx, Ny, Nz, lamp) : -1
      VW[o + 11] = fr[2 * v + 1]
      if (D >= near) {
        const iw = 1 / D
        PX[3 * v] = X * fl * iw + oxL
        PX[3 * v + 1] = Y * fl * iw + oyL
        PX[3 * v + 2] = iw
      }
    }
    const ids = idsFor(K, hazeAt(w.pose.z, C.haze))
    const B = C.bands
    const GS = C.glint.steps
    const cosS = Math.cos((C.glint.size * Math.PI) / 180)
    const lim = w.reveal >= 1 ? 16 : 16 * w.reveal - 0.5
    stipFlag = w.reveal >= 1 ? 0 : KIND_STIP
    // the thin bands (mesh.ts → thinBands): lines of at least a pixel for the whole word, or their
    // neighbours (core.ts → WordInst.bands)
    const tb = thinBands(w.pose.profile)
    const lineOn = w.bands
    // the word's own +z (the face's normal), sheet axes
    let zx = M[8]
    let zy = M[9]
    let zz = M[10]
    const zl = 1 / (Math.sqrt(zx * zx + zy * zy + zz * zz) || 1)
    zx *= zl
    zy *= zl
    zz *= zl
    const dockAmount = C.dock.amount
    const part = mesh.part
    const Wd = size.w
    const Hd = size.h
    const sh: Shade = { part: 0, glint: false, alt: null, line: null }
    const lineSh = { mid: 0, half: 0, df: 0, part: 0 }
    const alt = { part: 0, glint: false, from: 1 }

    /** T holds the triangle (records a, b, c of VW projected): shade it. */
    const shadeTri = (a: number, b: number, c: number, pt: number, flatOk: boolean) => {
      const catches = glintOn && (pt === PART.chamfer1 || pt === PART.chamfer2 || pt === PART.wall)
      sh.part = pt
      sh.glint = catches && glintNear(a, b, c, cosS, lamp)
      sh.alt = null
      sh.line = null
      if (lineOn && (pt === PART.chamfer1 || pt === PART.chamfer2 || pt === PART.wall)) {
        // shaders.ts: the word's thin bands are lines of at least a pixel — a chamfer / wall triangle
        // reaching within half a pixel (+ a margin: the gradient is the centroid's) of one is shaded
        // per pixel
        const isStep = pt !== PART.wall
        const mid = isStep ? tb.stepMid : tb.seamMid
        const half = (isStep ? tb.step : tb.seam) / 2
        const df = gradAt(11)
        const reach = half + 0.75 * df
        const f0 = T[11]
        const f1 = T[TS + 11]
        const f2 = T[2 * TS + 11]
        if (Math.min(f0, f1, f2) < mid + reach && Math.max(f0, f1, f2) > mid - reach) {
          lineSh.mid = mid
          lineSh.half = half
          lineSh.df = df
          lineSh.part = isStep ? PART.step : PART.seam
          sh.line = lineSh
        }
      }
      if (pt === PART.step || pt === PART.seam) {
        // shaders.ts: a word too small on screen draws its thin bands as their neighbours (the step as
        // the inner chamfer, its normal tipped 45° toward the face; the groove as the wall); a near one
        // as lines — the groove as itself, the step with that same tipped normal (one even line)
        if (!lineOn || pt === PART.step) {
          alt.part = lineOn ? PART.step : pt === PART.step ? PART.chamfer2 : PART.wall
          alt.from = 0
          for (let k = 0; k < 3; k++) {
            const o = k * TS
            let nx = T[o + 7]
            let ny = T[o + 8]
            let nz = T[o + 9]
            if (pt === PART.step) {
              nx += zx
              ny += zy
              nz += zz
            } else {
              const d = nx * zx + ny * zy + nz * zz
              nx += -d * zx + 1e-5 * zx
              ny += -d * zy + 1e-5 * zy
              nz += -d * zz + 1e-5 * zz
            }
            const l = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1)
            T[o + 13] = nx * l
            T[o + 14] = ny * l
            T[o + 15] = nz * l
            T[o + 12] = (nx * kx + ny * ky + nz * kz) * l
          }
          // the stand-in's glint: tested at its own normals (the step drawn as a line catches none)
          alt.glint = false
          if (glintOn && !lineOn) {
            for (let k = 0; k < 3 && !alt.glint; k++) {
              const o = k * TS
              alt.glint = nhOf(T[o + 4], T[o + 5], T[o + 6], T[o + 13], T[o + 14], T[o + 15], lamp) >= cosS - 0.08
            }
          }
          sh.alt = alt
        }
      }
      if (flatOk && !sh.glint && !sh.alt && !sh.line) {
        const ba = bandOf(T[3], B)
        if (ba === bandOf(T[TS + 3], B) && ba === bandOf(T[2 * TS + 3], B)) {
          // most triangles: one colour
          const id = ids[(pt * (B + 1) + ba) * (GS + 1)]
          const dk = dock !== null && dockAmount > 0 && nearDock(C.dock.edge + 1)
          fillFlat(KIND_PAL | id | stipFlag, lim, dk ? KIND_PAL | dockedId(id, dockAmount) | stipFlag : -1, C.dock.edge)
          return
        }
      }
      fillConcrete(ids, K, lim, sh)
    }

    for (let t = 0; t < n; t += 3) {
      const a = t * WS
      const b = a + WS
      const c = b + WS
      const pt = Math.round(part[2 * t])
      if (VW[a + 2] >= near && VW[b + 2] >= near && VW[c + 2] >= near) {
        const xa = PX[3 * t], ya = PX[3 * t + 1]
        const xb = PX[3 * t + 3], yb = PX[3 * t + 4]
        const xc = PX[3 * t + 6], yc = PX[3 * t + 7]
        // a front face is counter-clockwise on the display: negative area with y down
        if (!((xb - xa) * (yc - ya) - (xc - xa) * (yb - ya) < 0)) continue
        if ((xa < 0 && xb < 0 && xc < 0) || (xa > Wd && xb > Wd && xc > Wd) || (ya < 0 && yb < 0 && yc < 0) || (ya > Hd && yb > Hd && yc > Hd)) continue
        toT(VW, a, WS, 0)
        toT(VW, b, WS, 1)
        toT(VW, c, WS, 2)
        shadeTri(a, b, c, pt, true)
        continue
      }
      if (VW[a + 2] < near && VW[b + 2] < near && VW[c + 2] < near) continue
      // crosses the near plane: the clipped polygon as a fan (the glint tested on the whole triangle)
      const m = clipNear(VW, WS, a, b, c)
      for (let k = 1; k + 1 < m; k++) {
        toT(CLIP, 0, WS, 0)
        toT(CLIP, k * WS, WS, 1)
        toT(CLIP, (k + 1) * WS, WS, 2)
        if (!((T[TS] - T[0]) * (T[2 * TS + 1] - T[1]) - (T[2 * TS] - T[0]) * (T[TS + 1] - T[1]) < 0)) continue
        shadeTri(a, b, c, pt, false)
      }
    }
  }

  /** shaders.ts CONCRETE_FS → the lamp's nh at a world point with normal N. */
  function nhOf(px: number, py: number, pz: number, Nx: number, Ny: number, Nz: number, lamp: V3) {
    let vx = camX - px
    let vy = camY - py
    let vz = camZ - pz
    const vl = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1)
    let lx = lamp[0] - px
    let ly = lamp[1] - py
    let lz = lamp[2] - pz
    const ll = 1 / (Math.sqrt(lx * lx + ly * ly + lz * lz) || 1)
    vx = vx * vl + lx * ll
    vy = vy * vl + ly * ll
    vz = vz * vl + lz * ll
    return (Nx * vx + Ny * vy + Nz * vz) / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1)
  }

  // ── cards ──
  const boxes = new Map<string, BoxArrays>()
  const boxOf = (nx: number, ny: number) => {
    const key = `${nx}x${ny}`
    let b = boxes.get(key)
    if (!b) boxes.set(key, (b = cardBox(nx, ny)))
    return b
  }

  /** A card face's colours, 0…1 each, as one packed 8-bit RGB. */
  const pack = (r: number, gr: number, b: number) => (Math.round(clamp01(b) * 255) << 16) | (Math.round(clamp01(gr) * 255) << 8) | Math.round(clamp01(r) * 255)

  function drawCard(st: AboutState, c: CardInst, frame: Frame) {
    const K = st.K
    const D_ = K.cards
    const nx = K.raster.affineCells
    const ny = Math.max(1, Math.round(nx / Math.max(0.1, c.k.aspect)))
    const box = boxOf(nx, ny)
    const nv = box.position.length / 3
    VC = grow(VC, nv * CS)
    PC = grow(PC, nv * 3)
    const M = c.M
    const P = box.position
    for (let v = 0; v < nv; v++) {
      const x = P[3 * v]
      const y = P[3 * v + 1]
      const z = P[3 * v + 2]
      const dx = M[0] * x + M[4] * y + M[8] * z + M[12] - camX
      const dy = M[1] * x + M[5] * y + M[9] * z + M[13] - camY
      const dz = M[2] * x + M[6] * y + M[10] * z + M[14] - camZ
      const D = fX * dx + fY * dy + fZ * dz
      const o = v * CS
      VC[o] = rX * dx + rY * dy + rZ * dz
      VC[o + 1] = dX * dx + dY * dy + dZ * dz
      VC[o + 2] = D
      VC[o + 3] = box.uv[2 * v]
      VC[o + 4] = box.uv[2 * v + 1]
      if (D >= near) {
        const iw = 1 / D
        PC[3 * v] = VC[o] * fl * iw + oxL
        PC[3 * v + 1] = VC[o + 1] * fl * iw + oyL
        PC[3 * v + 2] = iw
      }
    }

    // ── this card's constants (gl.ts → setup) ──
    const view = st.view
    const cell = size.cell
    const tex = texs[c.k.index]
    const has = !!tex && tex.key === texKey(c.k, c.slot, K)
    const p = project3(view, c.pose.x, c.pose.y, c.pose.z)
    const sh = D_.sheen
    const sheenAmount = has ? sh.amount : 0
    const sheenCentre = sheenAt(K, c, p ? p[0] : null, frame.layout.width)
    const sheenHalf = Math.max(0.01, sh.width / 2)
    const sheenCol = hexRgb(sh.color)
    const kpx = p ? p[2] / cell : 1
    const cellsX = Math.max(1, Math.round((c.pose.thickness * kpx) / 3))
    const cellsY = Math.max(1, Math.round((c.pose.height * kpx) / 10))
    const affine = Math.min(1, K.raster.affine * st.eMove)
    const lim = c.reveal >= 1 ? 16 : 16 * c.reveal - 0.5
    stipFlag = c.reveal >= 1 ? 0 : KIND_STIP
    const seamC = hexRgb(D_.seam.color)
    const seamPx = pack(seamC[0], seamC[1], seamC[2])
    const blank = hexRgb(D_.blank)
    const side = hexRgb(D_.side)
    const edge = hexRgb(D_.edge)
    const hz = D_.haze
    const wash = dock ? D_.dock.wash : 0
    const washEdge = K.concrete.dock.edge
    /** the side faces' blocks: the picture's edge leaking in (per face, per block) */
    const sideCells = new Map<number, V3>()
    const sideCell = (face: number, cx: number, cy: number): V3 => {
      const key = (face * 4096 + cy) * 4096 + cx
      let col = sideCells.get(key)
      if (!col) {
        col = side
        if (has && tex) {
          const L = tex.levels[Math.min(5, tex.top)]
          const u = face === CARD_FACE.left ? 0.02 : 0.98
          const v = (cy + 0.5) / cellsY
          const tx = Math.min(L.w - 1, Math.floor(u * L.w))
          const ty = Math.min(L.h - 1, Math.floor(v * L.h))
          let q: number
          if (L.lum && tex.grey) {
            const lev = tex.grey.length - 1
            q = tex.grey[Math.min(lev, Math.max(0, Math.floor(L.lum[ty * L.w + tx] * lev + 0.5)))]
          } else q = L.px[ty * L.w + tx]
          const e: V3 = [(q & 255) / 255, ((q >> 8) & 255) / 255, ((q >> 16) & 255) / 255]
          const lit = hash12(cx + 3.1 + face, cy + 3.1 + face) >= 0.45 ? 1 : 0
          const k = D_.leak * (0.3 + 0.7 * lit)
          col = [side[0] + (e[0] - side[0]) * k, side[1] + (e[1] - side[1]) * k, side[2] + (e[2] - side[2]) * k]
        }
        sideCells.set(key, col)
      }
      return col
    }

    /** One triangle of the box in T (u, v: attributes 3, 4). */
    const cardTri = (fc: number) => {
      if (!Lt.spans(T[0], T[1], T[TS], T[TS + 1], T[2 * TS], T[2 * TS + 1])) return
      plane()
      const w0 = T[2]
      const wx = gx(w0, T[TS + 2], T[2 * TS + 2])
      const wy = gy(w0, T[TS + 2], T[2 * TS + 2])
      const u0 = qa(3, 0)
      const ux = gx(u0, qa(3, 1), qa(3, 2))
      const uy = gy(u0, qa(3, 1), qa(3, 2))
      const v0 = qa(4, 0)
      const vx = gx(v0, qa(4, 1), qa(4, 2))
      const vy = gy(v0, qa(4, 1), qa(4, 2))
      // the haze: one step for the whole triangle when its corners agree (most do)
      const ha = hazeAt(zAt(T[0], T[1], 1 / T[2]), hz)
      const hazeFlat = ha === hazeAt(zAt(T[TS], T[TS + 1], 1 / T[TS + 2]), hz) && ha === hazeAt(zAt(T[2 * TS], T[2 * TS + 1], 1 / T[2 * TS + 2]), hz)
      // behind the nav's labels: a Bayer edge of concrete.dock.edge px (only for triangles near them)
      const washed = wash > 0 && nearDock(washEdge + 1)
      if (washed) dockBox(washEdge)
      const { L, R, depth, pre, bay } = Lt
      const W = Lt.w
      const Hd = Lt.h
      const all = lim >= 15
      const vr = voidRgb[0]
      const vg = voidRgb[1]
      const vb = voidRgb[2]

      // the picture face: its mip level and the seam's width from the footprint at the centroid
      let lvl: Level | null = null
      let su0 = 0
      let su1 = 1
      let sv0 = 0
      let sv1 = 1
      let afU0 = 0, afUx = 0, afUy = 0, afV0 = 0, afVx = 0, afVy = 0
      if (fc === CARD_FACE.front) {
        const cxp = (T[0] + T[TS] + T[2 * TS]) / 3 - px0
        const cyp = (T[1] + T[TS + 1] + T[2 * TS + 1]) / 3 - py0
        const Wc = w0 + wx * cxp + wy * cyp
        const Uc = u0 + ux * cxp + uy * cyp
        const Vc = v0 + vx * cxp + vy * cyp
        const dudx = (ux * Wc - Uc * wx) / (Wc * Wc)
        const dudy = (uy * Wc - Uc * wy) / (Wc * Wc)
        const dvdx = (vx * Wc - Vc * wx) / (Wc * Wc)
        const dvdy = (vy * Wc - Vc * wy) / (Wc * Wc)
        if (has && tex) {
          // (the geometric mean of the two axes — shaders.ts → CARD_FS: a tilted card is not one or two
          // levels coarser for its foreshortened axis)
          const foot = Math.sqrt(Math.hypot(dudx * tex.tw, dvdx * tex.th) * Math.hypot(dudy * tex.tw, dvdy * tex.th))
          const lod = Math.min(tex.top, Math.max(0, Math.max(Math.floor(Math.log2(Math.max(foot, 1e-6)) + 0.5), c.lod)))
          lvl = tex.levels[lod]
        }
        // the seam: uv within seam.width px of an edge
        const gu = Math.hypot(dudx, dudy) * D_.seam.width
        const gv = Math.hypot(dvdx, dvdy) * D_.seam.width
        su0 = gu
        su1 = 1 - gu
        sv0 = gv
        sv1 = 1 - gv
        if (affine > 0) {
          // the uv interpolated straight across the screen (per polygon): the swim
          afU0 = T[3]
          afUx = gx(T[3], T[TS + 3], T[2 * TS + 3])
          afUy = gy(T[3], T[TS + 3], T[2 * TS + 3])
          afV0 = T[4]
          afVx = gx(T[4], T[TS + 4], T[2 * TS + 4])
          afVy = gy(T[4], T[TS + 4], T[2 * TS + 4])
        }
      }
      const grey = tex?.grey ?? null
      const lev = grey ? grey.length - 1 : 1

      for (let y = Lt.ya; y < Lt.yb; y++) {
        const xs = L[y]
        const xe = R[y]
        if (xe <= xs) continue
        const fx = xs + 0.5 - px0
        const fy = y + 0.5 - py0
        let w = w0 + wx * fx + wy * fy
        let qu = u0 + ux * fx + uy * fy
        let qv = v0 + vx * fx + vy * fy
        let au = afU0 + afUx * fx + afUy * fy
        let av = afV0 + afVx * fx + afVy * fy
        let i = y * W + xs
        const br = bay[y]
        for (let x = xs; x < xe; x++, i++, w += wx, qu += ux, qv += vx, au += afUx, av += afVx) {
          if (!(w > depth[i])) continue
          const rank = BAYER[br + (x & 3)]
          if (!all && rank > lim) continue
          const D = 1 / w
          const u = qu * D
          const v = qv * D
          let r = 0
          let gr = 0
          let bl = 0
          let packed = -1
          if (fc === CARD_FACE.front) {
            if (u < su0 || u > su1 || v < sv0 || v > sv1) packed = seamPx
            else if (!lvl) {
              r = blank[0]
              gr = blank[1]
              bl = blank[2]
            } else {
              let tu = u
              let tv = v
              if (affine > 0) {
                tu += (au - u) * affine
                tv += (av - v) * affine
              }
              tu = tu < 0 ? 0 : tu > 1 ? 1 : tu
              tv = tv < 0 ? 0 : tv > 1 ? 1 : tv
              let tx = (tu * lvl.w) | 0
              let ty = (tv * lvl.h) | 0
              if (tx >= lvl.w) tx = lvl.w - 1
              if (ty >= lvl.h) ty = lvl.h - 1
              if (lvl.lum && grey) {
                // halftone: ordered dots of 2 × 2 px (the GL phase)
                const m2 = BAYER[((((Hd - 1 - y) >> 1) & 3) << 2) + ((x >> 1) & 3)]
                let q = Math.floor(lvl.lum[ty * lvl.w + tx] * lev + (m2 + 0.5) / 16)
                if (q > lev) q = lev
                packed = grey[q < 0 ? 0 : q]
              } else packed = lvl.px[ty * lvl.w + tx]
              if (sheenAmount > 0) {
                let band = 1 - Math.abs(u + (v - 0.5) * sh.slant - sheenCentre) / sheenHalf
                if (band > 0) {
                  band = (Math.ceil(clamp01(band) * sh.steps) / sh.steps) * sheenAmount
                  r = (packed & 255) / 255
                  gr = ((packed >> 8) & 255) / 255
                  bl = ((packed >> 16) & 255) / 255
                  r += (sheenCol[0] - r) * band
                  gr += (sheenCol[1] - gr) * band
                  bl += (sheenCol[2] - bl) * band
                  packed = -1
                }
              }
            }
          } else if (fc === CARD_FACE.left || fc === CARD_FACE.right) {
            const col = sideCell(fc, Math.min(cellsX - 1, Math.max(0, Math.floor(u * cellsX))), Math.min(cellsY - 1, Math.max(0, Math.floor(v * cellsY))))
            r = col[0]
            gr = col[1]
            bl = col[2]
          } else {
            const k = (1.05 - 0.1 * u) * (fc === CARD_FACE.bottom ? 0.9 : 1)
            r = edge[0] * k
            gr = edge[1] * k
            bl = edge[2] * k
          }
          // the dock's wash, the haze: on the colour (a packed texel is opened only when needed)
          const dk = washed && y + 0.5 >= DB[1] && y + 0.5 <= DB[3] && x + 0.5 >= DB[0] && x + 0.5 <= DB[2] && inDock(x, y, rank, washEdge) ? wash : 0
          const h = hazeFlat ? ha : hazeAt(zAt(x + 0.5, y + 0.5, D), hz)
          if (dk > 0 || h > 0) {
            if (packed >= 0) {
              r = (packed & 255) / 255
              gr = ((packed >> 8) & 255) / 255
              bl = ((packed >> 16) & 255) / 255
            }
            if (dk > 0) {
              r += (vr - r) * dk
              gr += (vg - gr) * dk
              bl += (vb - bl) * dk
            }
            if (h > 0) {
              r += (vr - r) * h
              gr += (vg - gr) * h
              bl += (vb - bl) * h
            }
            packed = -1
          }
          depth[i] = w
          pre[i] = KIND_RGB | (packed >= 0 ? packed : pack(r, gr, bl)) | stipFlag
        }
      }
      Lt.touch()
      tris++
    }

    const idx = box.index
    const face = box.face
    const Wd = size.w
    const Hd = size.h
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t]
      const i1 = idx[t + 1]
      const i2 = idx[t + 2]
      const fc = Math.round(face[i0])
      const a = i0 * CS
      const b = i1 * CS
      const cc = i2 * CS
      if (VC[a + 2] >= near && VC[b + 2] >= near && VC[cc + 2] >= near) {
        const xa = PC[3 * i0], ya = PC[3 * i0 + 1]
        const xb = PC[3 * i1], yb = PC[3 * i1 + 1]
        const xc = PC[3 * i2], yc = PC[3 * i2 + 1]
        if (!((xb - xa) * (yc - ya) - (xc - xa) * (yb - ya) < 0)) continue
        if ((xa < 0 && xb < 0 && xc < 0) || (xa > Wd && xb > Wd && xc > Wd) || (ya < 0 && yb < 0 && yc < 0) || (ya > Hd && yb > Hd && yc > Hd)) continue
        toT(VC, a, CS, 0)
        toT(VC, b, CS, 1)
        toT(VC, cc, CS, 2)
        cardTri(fc)
        continue
      }
      if (VC[a + 2] < near && VC[b + 2] < near && VC[cc + 2] < near) continue
      const m = clipNear(VC, CS, a, b, cc)
      for (let k = 1; k + 1 < m; k++) {
        toT(CLIP, 0, CS, 0)
        toT(CLIP, k * CS, CS, 1)
        toT(CLIP, (k + 1) * CS, CS, 2)
        if (!((T[TS] - T[0]) * (T[2 * TS + 1] - T[1]) - (T[2 * TS] - T[0]) * (T[TS + 1] - T[1]) < 0)) continue
        cardTri(fc)
      }
    }
  }

  // ── shadows: footprints → a gaussian → steps of Bayer dots (gl.ts; shaders.ts → SHADOW_*, SHADE_HEAD) ──

  /** A world point flattened onto plane P along its caster's light L (core.ts → lightFrom, onPlane) → a footprint record at o in VS. */
  function footVertex(o: number, x: number, y: number, z: number, L: V3, P: Plane, u: number, v: number) {
    const h = Math.max(0, x * P[0] + y * P[1] + z * P[2] - P[3])
    const q = onPlane(L, P, x, y, z)
    const sx = q[0] - camX
    const sy = q[1] - camY
    const sz = q[2] - camZ
    VS[o] = rX * sx + rY * sy + rZ * sz
    VS[o + 1] = dX * sx + dY * sy + dZ * sz
    VS[o + 2] = fX * sx + fY * sy + fZ * sz
    VS[o + 3] = h
    VS[o + 4] = u
    VS[o + 5] = v
  }

  /**
   * One footprint triangle in T (half-resolution px; attribute 3 — the casting point's height, 4, 5 —
   * a card's pool uv) into the mask, MAX: r — the weight (shape × height fade), q — the weight × presence.
   * `pool` — a card's superellipse table (1 − r² over |2u − 1|ⁿ + |2v − 1|ⁿ), null — a word (shape 1).
   */
  function fillFoot(presence: number, fade: number, pool: { pow: Float32Array; f: Float32Array } | null) {
    if (!MG.spans(T[0], T[1], T[TS], T[TS + 1], T[2 * TS], T[2 * TS + 1])) return
    plane()
    // screen-affine is enough for a mask that is blurred (a card's plane is parallel to the screen at
    // home and on the tour; turned a little on the pull's last stretch, where the shadows fade in)
    const h0 = T[3]
    const hx = gx(h0, T[TS + 3], T[2 * TS + 3])
    const hy = gy(h0, T[TS + 3], T[2 * TS + 3])
    let u0 = 0, ux = 0, uy = 0, v0 = 0, vx = 0, vy = 0
    if (pool) {
      u0 = T[4]
      ux = gx(u0, T[TS + 4], T[2 * TS + 4])
      uy = gy(u0, T[TS + 4], T[2 * TS + 4])
      v0 = T[5]
      vx = gx(v0, T[TS + 5], T[2 * TS + 5])
      vy = gy(v0, T[TS + 5], T[2 * TS + 5])
    }
    const { L, R } = MG
    const W = MG.w
    const mr = maskR
    const mq = maskQ
    for (let y = MG.ya; y < MG.yb; y++) {
      const xs = L[y]
      const xe = R[y]
      if (xe <= xs) continue
      const fx = xs + 0.5 - px0
      const fy = y + 0.5 - py0
      let h = h0 + hx * fx + hy * fy
      let u = u0 + ux * fx + uy * fy
      let v = v0 + vx * fx + vy * fy
      let i = y * W + xs
      for (let x = xs; x < xe; x++, i++, h += hx, u += ux, v += vx) {
        let f = 1
        if (pool) {
          const a = pool.pow[Math.min(255, Math.abs(2 * u - 1) * 255) | 0]
          const b = pool.pow[Math.min(255, Math.abs(2 * v - 1) * 255) | 0]
          f = pool.f[Math.min(511, (a + b) * 255.5) | 0]
          if (f <= 0) continue
        }
        // the weight: the shape × the height fade (a high caster's shadow fainter AND smaller once cut at
        // shadow.edge); q — the weight × the caster's presence (q / r gives it back after the blur)
        f *= clamp01(1 - fade * h)
        if (f > mr[i]) mr[i] = f
        const q = f * presence
        if (q > mq[i]) mq[i] = q
      }
    }
    growBox(maskBox, MG.x0, MG.ya, MG.x1, MG.yb)
    growBox(footBox, MG.x0, MG.ya, MG.x1, MG.yb)
  }

  function footTri(a: number, b: number, c: number, presence: number, fade: number, pool: { pow: Float32Array; f: Float32Array } | null) {
    if (VS[a + 2] >= near && VS[b + 2] >= near && VS[c + 2] >= near) {
      toT(VS, a, SS, 0, 0.5)
      toT(VS, b, SS, 1, 0.5)
      toT(VS, c, SS, 2, 0.5)
      const W = MG.w
      const H = MG.h
      const xa = T[0], xb = T[TS], xc = T[2 * TS], ya = T[1], yb = T[TS + 1], yc = T[2 * TS + 1]
      if ((xa < 0 && xb < 0 && xc < 0) || (xa > W && xb > W && xc > W) || (ya < 0 && yb < 0 && yc < 0) || (ya > H && yb > H && yc > H)) return
      fillFoot(presence, fade, pool)
      return
    }
    if (VS[a + 2] < near && VS[b + 2] < near && VS[c + 2] < near) return
    const m = clipNear(VS, SS, a, b, c)
    for (let k = 1; k + 1 < m; k++) {
      toT(CLIP, 0, SS, 0, 0.5)
      toT(CLIP, k * SS, SS, 1, 0.5)
      toT(CLIP, (k + 1) * SS, SS, 2, 0.5)
      fillFoot(presence, fade, pool)
    }
  }

  /**
   * A word's footprint: the triangles of its lower side (facing away from the light — together they
   * cover the whole flattened solid, and theirs are the lowest casting points along each light ray:
   * the MAX of the height fade, as the GL union of all its triangles), flattened onto its plane.
   */
  function wordFoot(st: AboutState, w: WordInst) {
    const K = st.K
    const L = w.light
    const mesh = buildWordMesh(w.pose.look, w.pose.profile)
    const n = mesh.count
    const M = w.M
    const pos = mesh.position
    VS = grow(VS, n * SS)
    for (let v = 0; v < n; v++) {
      const x = pos[3 * v]
      const y = pos[3 * v + 1]
      const z = pos[3 * v + 2]
      footVertex(v * SS, M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14], L, w.plane, 0, 0)
    }
    // the light in the word's own frame (M: a rotation × a uniform scale): a triangle faces away from
    // it when its outward normal does (mesh.ts: cross(b − a, c − a) · n < 0 → outward = −cross)
    const lx = M[0] * L[0] + M[1] * L[1] + M[2] * L[2]
    const ly = M[4] * L[0] + M[5] * L[1] + M[6] * L[2]
    const lz = M[8] * L[0] + M[9] * L[1] + M[10] * L[2]
    for (let t = 0; t < n; t += 3) {
      const a = 3 * t
      const ux = pos[a + 3] - pos[a]
      const uy = pos[a + 4] - pos[a + 1]
      const uz = pos[a + 5] - pos[a + 2]
      const vx = pos[a + 6] - pos[a]
      const vy = pos[a + 7] - pos[a + 1]
      const vz = pos[a + 8] - pos[a + 2]
      if (!((uy * vz - uz * vy) * lx + (uz * vx - ux * vz) * ly + (ux * vy - uy * vx) * lz > 0)) continue
      footTri(t * SS, (t + 1) * SS, (t + 2) * SS, w.shade, K.shadow.fade, null)
    }
  }

  /** The superellipse's tables for an exponent (cached): t → tⁿ, s → 1 − s^(2 / n) (= 1 − r²). */
  const pools = new Map<number, { pow: Float32Array; f: Float32Array }>()
  function poolTables(n: number) {
    const key = Math.round(n * 1000) / 1000
    let t = pools.get(key)
    if (!t) {
      const pow = new Float32Array(256)
      for (let i = 0; i < 256; i++) pow[i] = Math.pow(i / 255, key)
      const f = new Float32Array(512)
      for (let i = 0; i < 512; i++) f[i] = clamp01(1 - Math.pow(i / 255.5, 2 / key))
      if (pools.size > 64) pools.clear()
      pools.set(key, (t = { pow, f }))
    }
    return t
  }

  /** A card's footprint: its pool (core.ts → shadowPool: the face grown by the penumbra, a superellipse). */
  function cardFoot(st: AboutState, c: CardInst) {
    const S = st.K.shadow
    const M = c.M
    // (its height: the picture's centre where the pointer turn has put it — the model's translation; gl.ts)
    const pool = shadowPool(S, c.M[14] - c.plane[3], c.pose.width, c.pose.height)
    VS = grow(VS, 4 * SS)
    const corners = [
      [-0.5, -0.5, 0, 0],
      [0.5, -0.5, 1, 0],
      [0.5, 0.5, 1, 1],
      [-0.5, 0.5, 0, 1],
    ]
    for (let k = 0; k < 4; k++) {
      const [x0, y0, u, v] = corners[k]
      const x = x0 * pool.gx
      const y = y0 * pool.gy
      footVertex(k * SS, M[0] * x + M[4] * y + M[12], M[1] * x + M[5] * y + M[13], M[2] * x + M[6] * y + M[14], c.light, c.plane, u, v)
    }
    const tables = poolTables(pool.n)
    footTri(0, SS, 2 * SS, c.shade, S.fade, tables)
    footTri(0, 2 * SS, 3 * SS, c.shade, S.fade, tables)
  }

  /** The quarter-resolution grid of the wide gaussian (its 2 channels and their scratch). */
  const QG = { w: 0, h: 0 }
  let qR = new Float32Array(0)
  let qQ = new Float32Array(0)
  let qT = new Float32Array(0)
  let qU = new Float32Array(0)
  /** The mask's box b (half resolution) → the quarter grid (2 × 2 averages) → the gaussian of σ (quarter px) there. */
  function quarterBlur(b: number[], sigma: number) {
    const mw = MG.w
    const qw = QG.w
    const qb = [b[0] >> 1, b[1] >> 1, Math.min(QG.w, (b[2] + 1) >> 1), Math.min(QG.h, (b[3] + 1) >> 1)]
    for (let y = qb[1]; y < qb[3]; y++) {
      const y0 = Math.min(MG.h - 1, 2 * y)
      const y1 = Math.min(MG.h - 1, 2 * y + 1)
      for (let x = qb[0]; x < qb[2]; x++) {
        const x0 = Math.min(mw - 1, 2 * x)
        const x1 = Math.min(mw - 1, 2 * x + 1)
        const a = y0 * mw
        const c = y1 * mw
        qR[y * qw + x] = (maskR[a + x0] + maskR[a + x1] + maskR[c + x0] + maskR[c + x1]) * 0.25
        qQ[y * qw + x] = (maskQ[a + x0] + maskQ[a + x1] + maskQ[c + x0] + maskQ[c + x1]) * 0.25
      }
    }
    gauss2(qR, qQ, qT, qU, qw, qb, sigma)
  }

  /** nd (maskN) over the box b of the half-resolution mask: how many of the 16 Bayer ranks are dots. */
  function countsHalf(b: number[], edge: number, kq: number, dk: Float64Array) {
    const mw = MG.w
    const nd = maskN
    for (let y = b[1]; y < b[3]; y++)
      for (let x = b[0], i = y * mw + b[0]; x < b[2]; x++, i++) {
        const r = maskR[i]
        if (r <= edge) {
          nd[i] = 0
          continue
        }
        const q = maskQ[i]
        const d = dk[Math.ceil((r - edge) * kq - 1e-3)] * (q < r ? q / r : 1)
        nd[i] = d > 0 ? Math.min(16, Math.ceil(16 * d - 0.5)) : 0
      }
  }

  /** countsHalf, the blurred mask read bilinearly from the quarter grid (fixed 2× weights: ¾ / ¼). */
  function countsQuarter(b: number[], edge: number, kq: number, dk: Float64Array) {
    const mw = MG.w
    const nd = maskN
    const qx0 = b[0] >> 1
    const qy0 = b[1] >> 1
    const qx1 = Math.min(QG.w, (b[2] + 1) >> 1) - 1
    const qy1 = Math.min(QG.h, (b[3] + 1) >> 1) - 1
    const qw = QG.w
    for (let y = b[1]; y < b[3]; y++) {
      let ya = (y & 1) === 0 ? (y >> 1) - 1 : y >> 1
      let yb = ya + 1
      const ty = (y & 1) === 0 ? 0.75 : 0.25
      ya = ya < qy0 ? qy0 : ya > qy1 ? qy1 : ya
      yb = yb < qy0 ? qy0 : yb > qy1 ? qy1 : yb
      const ra = ya * qw
      const rb = yb * qw
      for (let x = b[0], i = y * mw + b[0]; x < b[2]; x++, i++) {
        let xa = (x & 1) === 0 ? (x >> 1) - 1 : x >> 1
        let xb = xa + 1
        const tx = (x & 1) === 0 ? 0.75 : 0.25
        xa = xa < qx0 ? qx0 : xa > qx1 ? qx1 : xa
        xb = xb < qx0 ? qx0 : xb > qx1 ? qx1 : xb
        const r = (qR[ra + xa] * (1 - tx) + qR[ra + xb] * tx) * (1 - ty) + (qR[rb + xa] * (1 - tx) + qR[rb + xb] * tx) * ty
        if (r <= edge) {
          nd[i] = 0
          continue
        }
        const q = (qQ[ra + xa] * (1 - tx) + qQ[ra + xb] * tx) * (1 - ty) + (qQ[rb + xa] * (1 - tx) + qQ[rb + xb] * tx) * ty
        const d = dk[Math.ceil((r - edge) * kq - 1e-3)] * (q < r ? q / r : 1)
        nd[i] = d > 0 ? Math.min(16, Math.ceil(16 * d - 0.5)) : 0
      }
    }
  }

  /**
   * The dots of the box b (mask px; a mask pixel is 2 × 2 lattice pixels) — only where nothing covers
   * the pixel: a dot under an object is never seen (the crawl's eaten edge pixels show the void, not a
   * dot — a one-tick difference from the GL frame).
   */
  function dotsOf(b: number[]) {
    const W = Lt.w
    const H = Lt.h
    const mw = MG.w
    const nd = maskN
    const pre = Lt.pre
    const dot = Lt.dot
    const bay = Lt.bay
    let any = false
    for (let y2 = b[1]; y2 < b[3]; y2++) {
      const ya = 2 * y2
      if (ya >= H) break
      const yb = Math.min(H - 1, ya + 1)
      const two = yb > ya
      const bra = bay[ya]
      const brb = bay[yb]
      for (let x2 = b[0], j = y2 * mw + b[0]; x2 < b[2]; x2++, j++) {
        const n = nd[j]
        if (!n) continue
        const xa = 2 * x2
        if (xa >= W) break
        for (let k = 0; k < 4; k++) {
          const x = xa + (k & 1)
          const y = k < 2 ? ya : yb
          if (x >= W || (k >= 2 && !two)) continue
          const i = y * W + x
          if (pre[i] !== 0) continue
          const rank = BAYER[(k < 2 ? bra : brb) + (x & 3)]
          if (rank >= n) continue
          dot[i] = 1
          any = true
        }
      }
    }
    if (any) growBox(Lt.dotBox, b[0] * 2, b[1] * 2, Math.min(W, b[2] * 2), Math.min(H, b[3] * 2))
  }

  /** The dots: the footprints softened (shadow.blur) and cut into steps past shadow.edge — into Lt.dot. */
  function shadows(st: AboutState) {
    const K = st.K
    const S = K.shadow
    const dots = S.opacity * st.shadow
    const casters = st.words.filter((w) => w.shade > 0).length + st.cards.filter((c) => c.shade > 0).length
    // the last frame's footprints out
    const mw = MG.w
    if (!isEmpty(maskBox))
      for (let y = maskBox[1]; y < maskBox[3]; y++) {
        maskR.fill(0, y * mw + maskBox[0], y * mw + maskBox[2])
        maskQ.fill(0, y * mw + maskBox[0], y * mw + maskBox[2])
      }
    maskBox = [MG.w, MG.h, 0, 0]
    if (!(dots > 0) || !casters) return
    // the gaussian (gl.ts: σ in render px on the sheet plane, at most 8; its kernel is cut at 2σ, which
    // spreads like a whole one of 0.88σ), at the mask's half resolution
    const sigma = (0.88 * Math.min(8, (S.blur * st.view.fpx) / Math.max(1e-6, st.view.h) / size.cell)) / 2
    const pad = Math.ceil(3 * sigma) + 1
    // every caster's footprint, and its box grown by the gaussian's reach: boxes that touch are blurred
    // together (as the GL mask is, whole), the others each alone — the void between them is skipped
    const s0 = performance.now()
    const groups: number[][] = []
    const add = () => {
      if (isEmpty(footBox)) return
      groups.push([Math.max(0, footBox[0] - pad), Math.max(0, footBox[1] - pad), Math.min(MG.w, footBox[2] + pad), Math.min(MG.h, footBox[3] + pad)])
    }
    for (const w of st.words) {
      if (!(w.shade > 0)) continue
      footBox = [MG.w, MG.h, 0, 0]
      wordFoot(st, w)
      add()
    }
    for (const c of st.cards) {
      if (!(c.shade > 0)) continue
      footBox = [MG.w, MG.h, 0, 0]
      cardFoot(st, c)
      add()
    }
    sprof[0] = performance.now() - s0
    if (!groups.length) return
    for (let merged = true; merged; ) {
      merged = false
      for (let i = 0; i < groups.length && !merged; i++)
        for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i]
          const b = groups[j]
          if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) {
            growBox(a, b[0], b[1], b[2], b[3])
            groups.splice(j, 1)
            merged = true
            break
          }
        }
    }
    for (const b of groups) growBox(maskBox, b[0], b[1], b[2], b[3])
    const s1 = performance.now()
    // a wide gaussian (the pull's close frames) is taken at a quarter of the resolution and read back
    // bilinearly — the same soft slope at a quarter of the cost
    const quarter = sigma >= 1.5
    // (the 2 × 2 averaging and the bilinear read-back blur a little themselves: taken off σ)
    if (quarter) for (const b of groups) quarterBlur(b, Math.sqrt(Math.max(0.1, sigma * sigma - 0.4)) / 2)
    else if (sigma > 0.3) for (const b of groups) gauss2(maskR, maskQ, maskT, maskU, mw, b, sigma)
    const s2 = performance.now()
    sprof[1] = s2 - s1
    // the dots (SHADE_HEAD): past the edge, the weight in steps × presence (how many of the 16
    // Bayer ranks are dots, per mask pixel). Each loop in a small function of its
    // own (the engine compiles a small hot function sooner than a loop inside a big one)
    const kq = S.steps / Math.max(1e-3, 1 - S.edge)
    const dk = new Float64Array(S.steps + 2)
    for (let k = 0; k <= S.steps + 1; k++) dk[k] = (dots * Math.min(k, S.steps)) / S.steps
    for (const b of groups) {
      if (quarter) countsQuarter(b, S.edge, kq, dk)
      else countsHalf(b, S.edge, kq, dk)
      dotsOf(b)
    }
    sprof[2] = performance.now() - s2
  }
  const sprof = [0, 0, 0]

  // ── the frame ──

  function fit(cell: number, layout: Layout) {
    const w = Math.max(1, Math.ceil(layout.width / cell - 1e-4))
    const h = Math.max(1, Math.ceil(layout.height / cell - 1e-4))
    if (w === size.w && h === size.h && cell === size.cell) return
    mount.style.width = `${w * cell}px`
    mount.style.height = `${h * cell}px`
    size.cell = cell
    geomKey = []
    if (w === size.w && h === size.h) return
    size.w = canvas.width = w
    size.h = canvas.height = h
    Lt.resize(w, h, g)
    MG.setSize(Math.ceil(w / 2), Math.ceil(h / 2))
    maskR = new Float32Array(MG.w * MG.h)
    maskQ = new Float32Array(MG.w * MG.h)
    maskT = new Float32Array(MG.w * MG.h)
    maskU = new Float32Array(MG.w * MG.h)
    maskN = new Uint8Array(MG.w * MG.h)
    QG.w = Math.ceil(MG.w / 2)
    QG.h = Math.ceil(MG.h / 2)
    qR = new Float32Array(QG.w * QG.h)
    qQ = new Float32Array(QG.w * QG.h)
    qT = new Float32Array(QG.w * QG.h)
    qU = new Float32Array(QG.w * QG.h)
    maskBox = [0, 0, 0, 0]
    cleared = true
  }

  let cleared = true
  let geomKey: number[] = []
  let geomGen = 0
  let lastResolve: number[] = []
  let kGen = 0
  let kSeen: AboutKnobs | null = null
  let warmed = false
  const ms = { a: 0, b: 0, put: 0, all: 0 }
  let drawsA = 0
  let drawsB = 0
  let skipped = 0

  /** Everything that decides pass A, as numbers (unchanged → the geometry is kept). */
  function geometryKey(frame: Frame, st: AboutState, affine: number) {
    const v = st.view
    const out: number[] = [size.w, size.h, size.cell, ...v.eye, ...v.right, ...v.fwd, v.h, v.fpx, v.ox, v.oy, v.near, st.shadow, affine, core.version, texReady, kGen]
    for (const w of st.words) out.push(w.pose.width, ...w.M, w.reveal, w.shade, ...w.plane)
    for (const c of st.cards) out.push(c.k.index, ...c.M, c.reveal, c.shade, c.lod, c.slot.version)
    const dk = navDock.current
    if (dk) out.push(dk.x, dk.y, dk.w, dk.h)
    out.push(frame.layout.width)
    return out
  }

  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

  function clearAll() {
    if (cleared) return
    Lt.begin()
    Lt.box = [0, 0, 0, 0]
    Lt.dotBox = [0, 0, 0, 0]
    Lt.shown = [0, 0, 0, 0]
    Lt.out.fill(0)
    g.clearRect(0, 0, size.w, size.h)
    cleared = true
    geomKey = []
    lastResolve = []
  }

  /** Pass A: the geometry of this state into the lattice. */
  function geometry(frame: Frame, st: AboutState, warming = false) {
    tris = 0
    frameCamera(st)
    // (a warm-up frame always has labels — the nav may not be docked yet — so their paths are warm too)
    const W0 = frame.layout.width
    const labels = navDock.current?.labels ?? (warming ? [0, 1, 2].map((i) => ({ x: W0 * 0.86, y: 80 + 78 * i, w: W0 * 0.08, h: 14 })) : null)
    const pad = st.K.cards.dock.pad
    const cell = size.cell
    dock = labels && labels.length ? labels.map((l) => [(l.x - pad) / cell, (l.y - pad) / cell, (l.x + l.w + pad) / cell, (l.y + l.h + pad) / cell]) : null
    Lt.begin()
    // words first (cheap flat fills: the cards behind them are rejected before they are shaded),
    // nearest first
    const t0 = performance.now()
    const words = st.words.slice().sort((a, b) => b.M[14] - a.M[14])
    for (const w of words) drawWord(st, w)
    const t1 = performance.now()
    const cards = st.cards.slice().sort((a, b) => b.pose.z - a.pose.z)
    for (const c of cards) drawCard(st, c, frame)
    const t2 = performance.now()
    shadows(st)
    const t3 = performance.now()
    prof.push([t1 - t0, t2 - t1, t3 - t2, ...sprof])
    sprof.fill(0)
    if (prof.length > 240) prof.shift()
  }
  /** the last passes A: words, cards, shadows, ms (stats: p50 / p95 of each) */
  const prof: number[][] = []

  /**
   * Before the pull, in the browser's idle time: hidden frames along the film (the tunnel, the first
   * shadows, home with its cards, the tour, the finale) — every word / card / shadow path, the palette
   * and the JIT warm, so the first frames of the pull cost no more than the others (a cold path costs
   * 3–5× its warm self). One frame per idle slot of WARM_SLOT ms; stopped as soon as the scene is on
   * screen. The core is stepped with no time passing and its clocks are reset after each (as index.ts
   * does for the WebGL warm-up); the lattice's buffers are emptied again — the canvas is never touched.
   */
  const WARM_SLOT = 8
  let warmAt: number[] | null = null
  let warmId = 0
  let lastFrame: Frame | null = null
  let lastActive = false
  /** The warm-up's places along the film (the pull's tunnel and close-ups, its shadows coming in, home, the tour); started once. */
  function startWarm() {
    if (!warmAt) {
      const { from, to } = core.K.pull
      // (the shadows' and the cards' paths twice over: one pass leaves them only half compiled)
      const pull = [0.1, 0.3, 0.5, 0.56, 0.6, 0.62, 0.66, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 0.58, 0.64, 0.72, 0.82, 0.95]
      warmAt = pull.map((k) => from + (to - from) * k).concat([2, 2.25, 2.5, 2.75, 3, 2.1, 2.6, 2.9])
    }
    if (!warmed) scheduleWarm()
  }
  function scheduleWarm() {
    if (warmId || disposed || !warmAt || !warmAt.length) return
    warmId = ric(warmStep)
  }
  function warmStep(d: { timeRemaining(): number }) {
    warmId = 0
    if (disposed || !warmAt || !lastFrame || lastActive) return
    if (d.timeRemaining() >= WARM_SLOT) {
      const pos = warmAt.shift()!
      const frame = lastFrame
      try {
        const wf = { ...frame, dt: 0, scroll: { ...frame.scroll, pos, pinned: true } } as Frame
        const ws = core.step(wf)
        if (ws.cam.active) {
          fit(ws.cam.cell, wf.layout)
          knobsFor(ws.K, voidOf(frame))
          geometry(wf, ws, true)
          resolve(Lt, resolveArgs(ws, 0.05, 0.0001))
          // nothing of it stays: the buffers empty, the next frame redraws from scratch
          Lt.begin()
          Lt.box = [0, 0, 0, 0]
          Lt.dotBox = [0, 0, 0, 0]
          Lt.shown = [0, 0, 0, 0]
          Lt.out.fill(0)
          geomKey = []
          lastResolve = []
        }
      } finally {
        core.resetPhotos()
      }
      if (!warmAt.length) warmed = true
    }
    scheduleWarm()
  }

  const voidOf = (frame: Frame) => (frame.config as unknown as { veil?: { color?: string } }).veil?.color ?? '#e6ddd0'
  const resolveArgs = (st: AboutState, crawl: number, slip: number) => {
    const R = st.K.raster
    return { pal: palette, rgb: cardTable, shadow: shadowPx, grainTick: st.grainTick, tick: crawl > 0 || slip > 0 ? st.tick : 0, crawl, slip, slipShift: R.rowShift, slipRun: R.rowRun }
  }

  const renderer: AboutRenderer = {
    kind: 'flat',

    resize(layout, config) {
      geomKey = []
      // made before the about layer is first updated (the page's load, `?nogl=about`): the warm-up can
      // start now, from a still frame at the top of the page
      if (!lastFrame) {
        lastFrame = { time: 0, dt: 0, pointer: STILL_POINTER, scroll: { ...FROZEN_SCROLL }, layout, config } as Frame
        startWarm()
      }
    },

    draw(frame, st) {
      fit(st.cam.cell, frame.layout)
      if (!st.cam.active) {
        clearAll()
        lastFrame = frame
        lastActive = false
        startWarm()
        return false
      }
      lastActive = true
      const t0 = performance.now()
      const K = st.K
      if (K !== kSeen) {
        kSeen = K
        kGen++
      }
      knobsFor(K, voidOf(frame))
      // pictures: built ahead in idle time; one in a frame only for a card that has waited too long
      texturesFor(st)
      const affine = Math.min(1, K.raster.affine * st.eMove)

      // ── pass A: the geometry, only when it changed ──
      const gk = geometryKey(frame, st, affine)
      if (!same(gk, geomKey)) {
        geomKey = gk
        geomGen++
        drawsA++
        geometry(frame, st)
        ms.a = performance.now() - t0
      }

      // ── pass B: glitch + dots + grain + bits, on every tick that changes them ──
      const R = K.raster
      const crawl = R.crawl * Math.min(st.e, 1)
      const slip = R.rowGlitch * st.eMove * st.eMove
      const args = resolveArgs(st, crawl, slip)
      const rk = [geomGen, st.grainTick, args.tick, crawl, slip]
      if (same(rk, lastResolve) && !cleared) {
        skipped++
        return true
      }
      lastResolve = rk
      const t1 = performance.now()
      const rect = resolve(Lt, args)
      const t2 = performance.now()
      if (rect && Lt.image) g.putImageData(Lt.image, 0, 0, rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1])
      cleared = false
      drawsB++
      const t3 = performance.now()
      ms.b = t2 - t1
      ms.put = t3 - t2
      ms.all = t3 - t0
      return true
    },

    stats() {
      // cells covered by an object in the last frame drawn (as the GL target: the dots are not in it)
      let covered = 0
      if (!cleared) {
        const b = Lt.box
        const pre = Lt.pre
        for (let y = b[1]; y < b[3]; y++) for (let x = b[0], i = y * Lt.w + b[0]; x < b[2]; x++, i++) if (pre[i] !== 0) covered++
      }
      let dots = 0
      if (!cleared) {
        const b = Lt.dotBox
        for (let y = b[1]; y < b[3]; y++) for (let x = b[0], i = y * Lt.w + b[0]; x < b[2]; x++, i++) if (Lt.dot[i] && Lt.pre[i] === 0) dots++
      }
      return {
        gl: false,
        buffer: [size.w, size.h],
        cell: size.cell,
        covered,
        dots,
        cleared,
        ms: +ms.all.toFixed(2),
        msGeometry: +ms.a.toFixed(2),
        msResolve: +ms.b.toFixed(2),
        msPut: +ms.put.toFixed(2),
        triangles: tris,
        geometry: drawsA,
        resolves: drawsB,
        skipped,
        palette: palCount,
        pictures: texs.filter(Boolean).length,
        pictureMs: +buildMs.toFixed(2),
        warmed,
        prof: ['words', 'cards', 'shadows', 'foot', 'blur', 'dots'].map((name, k) => {
          const v = prof.map((p) => p[k]).sort((a, b) => a - b)
          return v.length ? `${name} ${v[Math.floor(v.length / 2)].toFixed(1)}/${v[Math.floor(v.length * 0.95)].toFixed(1)}` : name
        }),
      }
    },

    dispose() {
      disposed = true
      if (idleId) cancelIdle(idleId)
      if (warmId) cancelIdle(warmId)
      canvas.remove()
      mount.style.width = mount.style.height = ''
    },
  }
  return renderer
}
