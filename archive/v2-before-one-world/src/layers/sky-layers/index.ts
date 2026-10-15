import { aberrationAt } from '../../core/aberration'
import { createChannelSplit } from '../../core/channel-split'
import { Follower } from '../../core/spring'
import type { Frame, Layer, LayerFactory, Layout, ResolvedConfig } from '../../core/types'
import { veilClouds, type VeilCloudBox } from '../../core/veil-clouds'
import { fogOf, getSkyLayersKnobs, riseOf, type Grade, type LayerKind, type LayerKnobs, type SkyBlock, type SkyLayersKnobs, type WindKnobs } from './params'
import { BAKE_FS, FULLSCREEN_VS, compositorFS, type CompositorMode } from './shaders'

/**
 * LAYERED SKY — version 2 (index.html, sky.source = 'layers'): a living sky built from separate
 * photographic layers that move on their own, plus film grain. Back → front, in the order of
 * the keys of `sky.layers` (sky.config.ts):
 *
 *   plate      opaque sky photo; covers the screen like `object-fit: cover` (focus / zoom), with a
 *              margin that always exceeds what parallax + drift can ask → its edge never shows.
 *              Colour grade (saturation / brightness / contrast / tint) to match the reference
 *              without regenerating the picture.
 *   moon       disc found automatically in the picture's alpha (x / y / width = the DISC on
 *              screen, whatever padding the file has); phase mask (terminator), haze, glow,
 *              additive-ish blend — read as seen through the air.
 *   clouds     a free-floating picture (cloudlets): x / y / width / anchor, ping-pong or wrapping
 *              drift, optional slow "billow" (flow distortion of a few px).
 *   bank       a wall of clouds along the bottom: repeated sideways (mirrored, or cross-faded
 *              seam) and mirrored downward, so its sides and bottom can never show. Never
 *              narrower than the screen + everything that can move it (cover rule): the mirrored
 *              copies never enter the frame, however wide the screen.
 *
 * THREE INSTANCES of this renderer on the page (src/sky.ts):
 *   createSkyLayersLayer  (`sky`, behind the title)  — every layer except those marked front;
 *   createSkyFrontLayer   (`skyFront`, above it)     — only the `front: true` clouds / banks, on a
 *       transparent canvas (premultiplied), no plate; the same film grain (same seed, grid and
 *       size → one photo), only where a cloud is. It ignores the pointer (pointer-events: none),
 *       and while no front layer is visible its canvas is hidden and shrunk to 1×1 px.
 *   createSkyVeilLayer    (`veil`, above the title AND the tagline, under the nav) — the second
 *       screen's curtain, read from `config.veil` instead of `config.sky`. A transparent canvas
 *       like the front one; scrolling down it does three things in a row: its clouds rise over the
 *       hero (a leading wisp, then a wall: a `solid` bank), the FOG dissolves whatever is left
 *       into its own plate until the canvas is opaque, and from then on it IS the second screen's
 *       white void (plate + the `afterFog` mist + the same grain). No aberration, no channel
 *       split. Without WebGL2 (or with its context lost) the same acts are played in plain DOM.
 *
 * Scroll (Frame.scroll.pos, core/scroll.ts): every layer may rise with it by its own amount
 * (params.ts → ScrollRise) — the sky's by descent.rise.<layer>, nearer layers more: the camera
 * sinks into the cloud deck. Only the position moves, never a size; at rise 0 nothing changes.
 *
 * One WebGL2 canvas per instance, one full-screen draw per frame (see shaders.ts): linear-light
 * compositing of premultiplied textures, sRGB encode, grain + dither. Pictures are downloaded once
 * per page (index.html preloads them; both instances share the download), decoded off the main
 * thread (createImageBitmap) and baked once into premultiplied-linear sRGB mipmapped textures —
 * ONE texture per file per canvas (layers that use the same file share it, ref-counted), no
 * bigger than 1.25 × the largest size it is drawn at (≤ sky.maxTexture); a larger window
 * re-decodes it sharper. Layers at opacity 0 are not loaded at all.
 *
 * Motion:
 *   parallax — world.parallax × layer.depth, opposite to the pointer (as v1's world). Every
 *     layer follows the pointer with its own inertia, `mass` (core/spring.ts → Follower; 1 = the
 *     shared spring): heavy far layers turn later and slower, light near ones snap quicker.
 *   wind — ONE shared wind (sky.wind) for both canvases: x = range · sin(2π t / period) ·
 *     direction, the same phase for every layer, so all of them sway the same way at the same
 *     time and nearer layers (bigger range) further; wrapped layers travel at wind.speed × |depth|.
 *     × world.drift (damped by prefers-reduced-motion in resolveConfig; grain stops flickering).
 * Time comes from the frame (?freeze=t gives a repeatable still). Nothing is redrawn when
 * nothing changed.
 *
 * Chromatic aberration (post.aberration, core/aberration.ts): both canvases sample their stack once
 * per channel. The front one is transparent, so while it is on it is composited per channel
 * (core/channel-split.ts): drawn twice per frame — the mask, taken into a 2D canvas, then the light.
 *
 * No WebGL2 → the DOM photo sky (src/layers/photo-sky) behind, nothing in front.
 */

const ASSET_DIR = `${import.meta.env.BASE_URL}assets/sky-layers/`
/** Texture units: one per layer + the billow noise. WebGL2 guarantees 16. */
const MAX_LAYERS = 12
const NOISE_SIZE = 64
const NOISE_CELLS = 8

type GL = WebGL2RenderingContext

const linearCache = new Map<string, [number, number, number]>()
/** '#rrggbb' → linear rgb. */
function hexToLinear(hex: string): [number, number, number] {
  const hit = linearCache.get(hex)
  if (hit) return hit
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const v = parseInt(h.slice(0, 6), 16)
  const ch = (x: number) => {
    const c = x / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const out: [number, number, number] = Number.isFinite(v) ? [ch((v >> 16) & 255), ch((v >> 8) & 255), ch(v & 255)] : [1, 1, 1]
  if (linearCache.size > 64) linearCache.clear()
  linearCache.set(hex, out)
  return out
}

/** '#rrggbb' → display-space 0..1, divided by its luminance (a tint that keeps brightness). */
function tintRgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToLinear(hex).map((c) => Math.pow(c, 1 / 2.2))
  const l = Math.max(1e-3, 0.2126 * r + 0.7152 * g + 0.0722 * b)
  return [r / l, g / l, b / l]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** A stable 0…1 number per layer name (its billow field offset: the same in either canvas,
 *  whatever the order or the number of layers). */
function nameSeed(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}
const mod = (a: number, n: number) => ((a % n) + n) % n

function compile(gl: GL, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s)
      gl.deleteShader(s)
      throw new Error(`[sky-layers] shader compile failed: ${log}`)
    }
    return s
  }
  const p = gl.createProgram()!
  const v = make(gl.VERTEX_SHADER, vs)
  const f = make(gl.FRAGMENT_SHADER, fs)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`[sky-layers] program link failed: ${gl.getProgramInfoLog(p)}`)
  }
  return p
}

// ── assets ────────────────────────────────────────────────────────────────────────────────────

/** Downloaded files by URL, shared by both instances: a picture is downloaded once per page. */
const blobs = new Map<string, Promise<Blob>>()

/** Fetch — matches the `<link rel=preload as=fetch crossorigin>` in index.html (no second download). */
function fetchBlob(url: string): Promise<Blob> {
  let p = blobs.get(url)
  if (!p) {
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // a dev server / SPA host answers a missing file with the page itself
      if (/^text\/html/i.test(res.headers.get('content-type') ?? '')) throw new Error('missing (got an HTML page)')
      return res.blob()
    })
    blobs.set(url, p)
    p.catch(() => blobs.delete(url))
  }
  return p
}

/**
 * The one wind of the page (sky.wind). Both instances read it with the frame's time, so every
 * layer — behind the title or in front of it — sways the same way at the same moment.
 * Integrated (× world.drift), so a tuner / reduced-motion change never makes anything jump;
 * started from t itself, so ?freeze=t gives the same still every time.
 *   phase  — of the ping-pong sway, radians;  travel — of wrapped layers, px per unit of depth.
 */
const wind = { time: NaN, phase: 0, travel: 0 }

function windAt(time: number, driftMul: number, w: WindKnobs) {
  const rate = (2 * Math.PI) / Math.max(1, w.period)
  if (Number.isNaN(wind.time)) {
    wind.phase = time * driftMul * rate
    wind.travel = time * driftMul * w.speed * w.direction
  } else if (time !== wind.time) {
    const dt = clamp(time - wind.time, 0, 0.1) * driftMul
    wind.phase = (wind.phase + dt * rate) % (Math.PI * 2000)
    wind.travel += dt * w.speed * w.direction
  }
  wind.time = time
  return wind
}

/** The moon's disc in the picture, in uv (0..1): centre and radius (x and y units). */
interface Disc {
  cx: number
  cy: number
  rx: number
  ry: number
}

/**
 * Finds the disc from the alpha: radius = half the opaque height (true for any phase), centre on
 * the round limb's side — the limb is the side whose edge column is thinner (a terminator, being
 * a half-ellipse or a straight line, is always fuller). Full moon, half, crescent, gibbous: all fine.
 */
function findDisc(bmp: ImageBitmap): Disc | null {
  const s = Math.min(1, 256 / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * s))
  const h = Math.max(1, Math.round(bmp.height * s))
  const ctx =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
      : Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(bmp, 0, 0, w, h)
  const a = ctx.getImageData(0, 0, w, h).data
  const solid = (x: number, y: number) => a[(y * w + x) * 4 + 3] > 127
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  const r = (y1 - y0 + 1) / 2
  const inset = Math.max(1, Math.round(r * 0.08))
  const column = (x: number) => {
    let n = 0
    for (let y = y0; y <= y1; y++) if (solid(x, y)) n++
    return n
  }
  const left = column(Math.min(x1, x0 + inset))
  const right = column(Math.max(x0, x1 - inset))
  const cx = right <= left ? x1 + 1 - r : x0 + r
  return { cx: cx / w, cy: (y0 + y1 + 1) / 2 / h, rx: r / w, ry: r / h }
}

/** One GPU texture per file (per canvas), shared by every layer that uses that file. */
interface TexEntry {
  url: string
  tex: WebGLTexture | null
  /** texture size (0 until baked) */
  w: number
  h: number
  /** the file's own size (0 until the first decode) */
  natW: number
  natH: number
  disc: Disc | null
  /** slots holding it (a slot holds its wanted picture and the one on screen) */
  refs: number
  loading: boolean
  /** bumped to cancel a decode in flight */
  gen: number
}

/** Straight-alpha bitmap → SRGB8_ALPHA8 texture of premultiplied linear colour, mipmapped. */
function bake(gl: GL, bakeProg: WebGLProgram, vao: WebGLVertexArrayObject, bmp: ImageBitmap): WebGLTexture {
  const w = bmp.width
  const h = bmp.height
  const levels = Math.floor(Math.log2(Math.max(w, h))) + 1
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)

  const src = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, src)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

  const dst = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, dst)
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, w, h)
  const fb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
    gl.viewport(0, 0, w, h)
    gl.disable(gl.BLEND)
    gl.useProgram(bakeProg)
    gl.bindVertexArray(vao)
    gl.bindTexture(gl.TEXTURE_2D, src)
    gl.uniform1i(gl.getUniformLocation(bakeProg, 'uSrc'), 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  } else {
    // not expected (SRGB8_ALPHA8 is renderable in WebGL2): premultiply in sRGB space instead
    gl.bindTexture(gl.TEXTURE_2D, dst)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fb)
  gl.deleteTexture(src)

  gl.bindTexture(gl.TEXTURE_2D, dst)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return dst
}

/** Tileable smooth value noise, two independent channels (billow flow field). */
function makeNoise(gl: GL): WebGLTexture {
  const S = NOISE_SIZE
  const C = NOISE_CELLS
  let seed = 1234567
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 16777216
  const lattice = [0, 1].map(() => Array.from({ length: C * C }, rand))
  const data = new Uint8Array(S * S * 2)
  const smooth = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * C
      const fy = (y / S) * C
      const ix = Math.floor(fx)
      const iy = Math.floor(fy)
      const tx = smooth(fx - ix)
      const ty = smooth(fy - iy)
      for (let c = 0; c < 2; c++) {
        const L = lattice[c]
        const at = (i: number, j: number) => L[((j + C) % C) * C + ((i + C) % C)]
        const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx
        const bot = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx
        data[(y * S + x) * 2 + c] = Math.round((top * (1 - ty) + bot * ty) * 255)
      }
    }
  }
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, S, S, 0, gl.RG, gl.UNSIGNED_BYTE, data)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  return tex
}

// ── GL state ──────────────────────────────────────────────────────────────────────────────────

const ARRAYS = ['uRect', 'uP', 'uQ', 'uB', 'uGA', 'uGB'] as const
const SINGLES = ['uView', 'uPR', 'uMoon0', 'uMoon1', 'uMoon2', 'uMoon3', 'uMoon4', 'uGrain', 'uAb0', 'uAb1', 'uMask', 'uFog', 'uFogB', 'uSeed', 'uTop', 'uBottom', 'uNoise'] as const

interface Compositor {
  /** names + kinds it was generated for */
  sig: string
  prog: WebGLProgram
  n: number
  u: Record<(typeof ARRAYS)[number] | (typeof SINGLES)[number], WebGLUniformLocation | null>
}

interface GLState {
  vao: WebGLVertexArrayObject
  bake: WebGLProgram
  noise: WebGLTexture
  empty: WebGLTexture
  comp: Compositor | null
}

function initGL(gl: GL): GLState {
  const vao = gl.createVertexArray()!
  const bakeProg = compile(gl, FULLSCREEN_VS, BAKE_FS)
  const noise = makeNoise(gl)
  const empty = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, empty)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  return { vao, bake: bakeProg, noise, empty, comp: null }
}

function buildCompositor(gl: GL, layers: LayerKnobs[], sig: string, mode: Mode): Compositor {
  const kinds = layers.map((k) => k.kind)
  const prog = compile(gl, FULLSCREEN_VS, compositorFS(kinds, mode, layers.map((k) => k.afterFog)))
  const u = {} as Compositor['u']
  for (const name of ARRAYS) u[name] = gl.getUniformLocation(prog, `${name}[0]`) ?? gl.getUniformLocation(prog, name)
  for (const name of SINGLES) u[name] = gl.getUniformLocation(prog, name)
  gl.useProgram(prog)
  kinds.forEach((_, i) => gl.uniform1i(gl.getUniformLocation(prog, `uT${i}`), i))
  gl.uniform1i(u.uNoise, kinds.length)
  return { sig, prog, n: Math.max(1, kinds.length), u }
}

// ── geometry ──────────────────────────────────────────────────────────────────────────────────

/** A texture is decoded no bigger than this × the largest size it is drawn at (canvas px). */
const TEX_HEADROOM = 1.25
/** …and re-decoded sharper only when the window asks for this much more (no churn on resize). */
const TEX_REGROW = 1.15

interface Geo {
  /** hero size, CSS px */
  W: number
  H: number
  /** what `width` (%) is a share of: min(W, designAspect × H) */
  base: number
  /** the largest parallax offset the pointer can ask for, per unit of depth (with overshoot) */
  par: number
  /** canvas px per CSS px */
  pr: number
}

function geoOf(layout: Layout, config: ResolvedConfig, knobs: SkyLayersKnobs, pr: number): Geo {
  const W = layout.width
  const H = layout.height
  const world = config.world
  return {
    W,
    H,
    // sizes (`width`) are % of the screen width, but of no more than designAspect × height:
    // an ultra-wide screen keeps the composition (banks repeat sideways) instead of blowing up
    base: Math.min(W, H * Math.max(0.5, knobs.designAspect)),
    // largest offset the pointer spring can ask for (it may overshoot a little), per unit depth;
    // a layer's mass changes its timing, never its overshoot (core/spring.ts)
    par: Math.abs(world.parallax) * Math.max(1, config.motion.intensity) * 1.15,
    pr,
  }
}

/** Banks never show their mirrored copies; neither does a front layer that spans the width. */
const covers = (k: LayerKnobs) => !k.drift.wrap && (k.kind === 'bank' || (k.front && k.width >= 100))

/**
 * COVER RULE: the narrowest width at which the picture still covers the screen sideways at
 * every parallax / wind / billow offset (+1 px each side). x 50 / anchor 0.5 →
 * W + 2·(parallax·|depth| + |drift.range| + billow) + 2.
 */
function coverWidth(k: LayerKnobs, g: Geo): number {
  const reach = g.par * Math.abs(k.depth) + Math.abs(k.drift.range) + Math.max(0, k.billow.amount) + 1
  const x0 = (g.W * k.x) / 100
  const ax = clamp(k.anchor.x, 0.05, 0.95)
  return Math.max((x0 + reach) / ax, (g.W - x0 + reach) / (1 - ax))
}

/** The plate's margin: more than parallax + drift can ever ask (its edge never shows). */
function plateReach(k: LayerKnobs, g: Geo) {
  const p = g.par * Math.abs(k.depth) + 1
  return { x: p + (k.drift.wrap ? 0 : Math.abs(k.drift.range)), y: p }
}

/** Default disc when none is found: the whole picture is the moon. */
const wholeDisc = (w: number, h: number): Disc => ({ cx: 0.5, cy: 0.5, rx: 0.5, ry: (0.5 * w) / h })

/**
 * Drawn size of a layer, CSS px. Depends on the picture's proportions (w / h; and the moon's
 * disc), never on its resolution — so it also tells how sharp the texture has to be.
 */
function sizeOf(k: LayerKnobs, w: number, h: number, disc: Disc | null, g: Geo): [number, number] {
  const aspect = w / Math.max(1, h)
  let rw: number
  if (k.kind === 'plate') {
    const r = plateReach(k, g)
    rw = Math.max(Math.max(g.W, g.H * aspect) * Math.max(1, k.zoom), g.W + 2 * r.x, (g.H + 2 * r.y) * aspect)
  } else if (k.kind === 'moon') {
    const d = disc ?? wholeDisc(w, h)
    rw = (g.base * k.width) / 100 / Math.max(1e-6, 2 * d.rx)
  } else {
    rw = (g.base * k.width) / 100
    if (covers(k)) rw = Math.max(rw, coverWidth(k, g))
  }
  return [rw, rw / aspect]
}

// ── the layer ─────────────────────────────────────────────────────────────────────────────────

/** 'back' and 'front' draw config.sky (split by the layers' `front` flag), 'veil' draws config.veil. */
type Mode = CompositorMode

/** `?nogl=veil` (debug builds; the public one strips it from the address first): as if WebGL2 were missing. */
const noGL = (name: string) => new URLSearchParams(location.search).get('nogl')?.split(',').includes(name) ?? false

interface Slot {
  name: string
  kind: LayerKind
  /** the picture this layer wants ('' = none: no src, or opacity 0); holds a reference */
  url: string
  /** the picture on screen; holds a reference. The previous one stays until the wanted one is
   *  baked (wide ↔ tall plate on rotation: no blank frame). */
  drawn: string
  /** 0 → 1 appear ramp for a picture that arrives after the sky is already on screen. */
  fade: number
  /** this layer's own inertia (mass) */
  follow: Follower
  // billow state (integrated from frame time, so tuner / reduced-motion changes never jump)
  started: boolean
  billowA: number
  billowB: number
  /** last placement, for stats() (CSS px) */
  rect: [number, number, number, number]
  drift: number
  pointer: [number, number]
  /** how far the scroll has lifted it, CSS px (already in rect) */
  rise: number
}

/** What the debug handle (window.__hero.layers.get('sky').stats()) reports per layer. */
export interface SkyLayerStats {
  name: string
  front: boolean
  url: string
  /** drawn rect, CSS px */
  rect: [number, number, number, number]
  /** wind offset, px */
  drift: number
  /** this layer's own (mass) pointer position */
  pointer: [number, number]
  /** how far the scroll has lifted it, CSS px (already in rect) */
  rise: number
  /** texture size / the file's own size */
  tex: [number, number]
  file: [number, number]
}

/** …and what the veil reports (window.__hero.layers.get('veil').stats()). */
export interface SkyVeilStats {
  /** the fog for the whole frame, 0…1 (1 = the veil is opaque: the hero behind it may sleep) */
  fog: number
  /** true while the DOM stand-in draws it (no WebGL2, ?nogl=veil, context lost) */
  dom: boolean
  layers: SkyLayerStats[]
}

const NOOP_LAYER: Layer = { resize() {}, update() {}, dispose() {} }

/**
 * How long the veil's factory waits for its pictures, ms. Well inside what the hero gives the second
 * screen's layers before it releases the scroll without them (core/hero.ts → FULL_TIMEOUT).
 */
const VEIL_WAIT = 1500

function makeSkyLayers(mode: Mode): LayerFactory {
  return async (mount, ctx) => {
    if (mode === 'veil' && noGL('veil')) {
      console.warn('[sky-layers] veil: WebGL2 switched off (?nogl=veil) — plain DOM veil instead')
      return veilDomLayer(mount, ctx.layout, ctx.config)
    }
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;pointer-events:none;'
    canvas.setAttribute('aria-hidden', 'true')
    const gl = canvas.getContext('webgl2', {
      // front, veil: a transparent canvas over the title (premultiplied output)
      alpha: mode !== 'back',
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) {
      if (mode === 'front') return NOOP_LAYER
      if (mode === 'veil') {
        console.warn('[sky-layers] veil: no WebGL2 — plain DOM veil instead')
        return veilDomLayer(mount, ctx.layout, ctx.config)
      }
      console.warn('[sky-layers] no WebGL2 — photo sky instead')
      const { createPhotoSkyLayer } = await import('../photo-sky')
      return createPhotoSkyLayer(mount, ctx)
    }
    return skyLayers(mode, gl, canvas, mount, ctx.layout, ctx.config)
  }
}

/** The sky behind the title: every layer of sky.layers except those marked `front`. */
export const createSkyLayersLayer: LayerFactory = makeSkyLayers('back')
/** The layers marked `front: true`, drawn above the title (a transparent canvas). */
export const createSkyFrontLayer: LayerFactory = makeSkyLayers('front')
/**
 * The veil of the second screen (config.veil), above the title and the tagline: the clouds that
 * rise over them as the page scrolls down, the whiteout, then the white void itself.
 */
export const createSkyVeilLayer: LayerFactory = makeSkyLayers('veil')

// ── the veil without WebGL ────────────────────────────────────────────────────────────────────

interface VeilDom {
  /** the fog it last showed, 0…1 */
  readonly fog: number
  resize(layout: Layout, config: ResolvedConfig): void
  update(frame: Frame): void
  show(on: boolean): void
  dispose(): void
}

/**
 * A layer's colour grade as ONE colour matrix: rows r, g, b of [× r, × g, × b, +]. The shader's
 * grade() — contrast around mid-grey → brightness → saturation → tint — is affine in display space,
 * so a single feColorMatrix (in sRGB; the shader's gamma 2.2 is close to it) repeats it in DOM.
 * null — a neutral grade.
 */
function gradeMatrix(g: Grade): number[][] | null {
  if (g.saturation === 1 && g.brightness === 1 && g.contrast === 1 && (g.tintAmount === 0 || g.tint.toLowerCase() === '#ffffff')) return null
  const W = [0.2126, 0.7152, 0.0722]
  const t = tintRgb(g.tint)
  const amount = clamp(g.tintAmount, 0, 1)
  const gain = g.contrast * g.brightness
  const lift = 0.5 * (1 - g.contrast) * g.brightness
  return [0, 1, 2].map((row) => {
    const tint = 1 + (t[row] - 1) * amount
    // saturation mixes every channel with the luminance: s · c + (1 − s) · (w · c)
    const m = W.map((w, col) => tint * gain * ((col === row ? g.saturation : 0) + (1 - g.saturation) * w))
    return [...m, tint * lift]
  })
}

/** '#rrggbb' through a grade matrix → 'rgb(…)'. */
function gradeHex(hex: string, m: number[][] | null): string {
  if (!m) return hex
  const c = hexToLinear(hex).map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))
  const out = m.map((r) => Math.round(255 * clamp(r[0] * c[0] + r[1] * c[1] + r[2] * c[2] + r[3], 0, 1)))
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`
}

let veilDomCount = 0

/**
 * The veil in plain DOM — for a browser without WebGL2, and for the moments the canvas cannot draw
 * (context lost, shader refused): the hero goes to sleep behind the veil (scroll.cover), so it must
 * never leave the stage bare. The same acts with what DOM can do: the first bank of the block (the
 * wall) rises as an <img> — real cloud shapes still cover the tagline and the title — with a flat
 * block of veil.color under it (the file ends in that colour: the `solid` body), then a sheet
 * with the void's picture comes up from the bottom by the fog (fog.lift, as in the shader, without
 * its patches). The wall and the void wear their layers' grades (an SVG colour matrix), so the
 * stand-in shows the same warm cloud and the same white void as the canvas.
 * No wisp, no mist, no grain, no fog patches, no wind.
 */
function veilDom(mount: HTMLElement, initialLayout: Layout, initialConfig: ResolvedConfig): VeilDom {
  let layout = initialLayout
  let config = initialConfig
  let knobs = getSkyLayersKnobs(config, 'veil')
  let fog = 0

  const root = document.createElement('div')
  root.setAttribute('aria-hidden', 'true')
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;'
  // the grades: one <filter> per graded element (ids unique on the page)
  const id = `veil-dom-${veilDomCount++}`
  const SVG = 'http://www.w3.org/2000/svg'
  const defs = document.createElementNS(SVG, 'svg')
  defs.setAttribute('width', '0')
  defs.setAttribute('height', '0')
  defs.style.cssText = 'position:absolute;'
  const filterFor = (name: string) => {
    const f = document.createElementNS(SVG, 'filter')
    f.id = `${id}-${name}`
    f.setAttribute('color-interpolation-filters', 'sRGB')
    const m = document.createElementNS(SVG, 'feColorMatrix')
    m.setAttribute('type', 'matrix')
    f.appendChild(m)
    defs.appendChild(f)
    /** wear this grade (null — none): returns the CSS `filter` value */
    return (g: number[][] | null) => {
      if (g) m.setAttribute('values', [...g.map((r) => `${r[0]} ${r[1]} ${r[2]} 0 ${r[3]}`), '0 0 0 1 0'].join(' '))
      return g ? `url(#${f.id})` : ''
    }
  }
  const wallGrade = filterFor('wall')
  const plateGrade = filterFor('plate')
  root.appendChild(defs)
  const wall = new Image()
  wall.alt = ''
  wall.decoding = 'async'
  wall.style.cssText = 'position:absolute;left:0;top:0;display:block;max-width:none;transform-origin:0 0;visibility:hidden;'
  const body = document.createElement('div')
  body.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;visibility:hidden;'
  const sheet = document.createElement('div')
  sheet.style.cssText = 'position:absolute;inset:0;opacity:0;background-size:cover;background-repeat:no-repeat;'
  root.append(wall, body, sheet)
  mount.appendChild(root)

  let wallKnobs: LayerKnobs | undefined
  let wallUrl = ''
  let plateUrl = ''

  const apply = () => {
    knobs = getSkyLayersKnobs(config, 'veil')
    const tall = layout.height > 0 && layout.width / layout.height < knobs.tallBelow
    const urlOf = (k?: LayerKnobs) => {
      const file = k && k.opacity > 0 ? (tall && k.srcTall ? k.srcTall : k.src) : ''
      return file ? ASSET_DIR + file : ''
    }
    wallKnobs = knobs.layers.find((l) => l.k.kind === 'bank' && !l.k.afterFog)?.k
    const plate = knobs.layers.find((l) => l.k.kind === 'plate')?.k
    const wu = urlOf(wallKnobs)
    if (wu !== wallUrl) {
      wallUrl = wu
      if (wu) wall.src = wu
      else wall.removeAttribute('src')
    }
    const pu = urlOf(plate)
    if (pu !== plateUrl) {
      plateUrl = pu
      sheet.style.backgroundImage = pu ? `url("${pu}")` : ''
    }
    const focus = plate?.focus ?? { x: 0.5, y: 0.5 }
    sheet.style.backgroundPosition = `${clamp(focus.x, 0, 1) * 100}% ${clamp(focus.y, 0, 1) * 100}%`
    sheet.style.backgroundColor = knobs.color
    // the layers' grades: the void's on its sheet, the wall's on its picture and on the flat body under it
    sheet.style.filter = plateGrade(plate && pu ? gradeMatrix(plate.grade) : null)
    const wg = wallKnobs ? gradeMatrix(wallKnobs.grade) : null
    wall.style.filter = wallGrade(wg)
    body.style.background = gradeHex(knobs.color, wg)
  }
  apply()

  /**
   * The fog as the shader lays it (shaders.ts → fogAt), without the patches: none above one height,
   * complete below another, the bottom of the screen first (fog.lift). A mask on the void's sheet.
   */
  const SMOOTH = [0, 0.104, 0.352, 0.648, 0.896, 1]
  let fogKey = ''
  const layFog = () => {
    const v = Math.max(0, knobs.fog.lift)
    const s = Math.max(0, knobs.fog.patchy)
    let mask = ''
    let opacity = fog
    if (fog > 0 && fog < 1 && v > 0) {
      // a(y) = fog · (1 + s + v) − s / 2 − v · (1 − y): 0 at y0, 1 at y1 (shares of the height, y down)
      const y0 = 1 - (fog * (1 + s + v) - s / 2) / v
      const y1 = y0 + 1 / v
      mask = `linear-gradient(to bottom, ${SMOOTH.map((a, i) => `rgba(0,0,0,${a}) ${(100 * (y0 + ((y1 - y0) * i) / (SMOOTH.length - 1))).toFixed(1)}%`).join(', ')})`
      opacity = 1
    }
    const key = `${mask}|${opacity.toFixed(3)}`
    if (key === fogKey) return
    fogKey = key
    sheet.style.opacity = String(opacity)
    sheet.style.maskImage = mask
    sheet.style.setProperty('-webkit-mask-image', mask)
  }

  return {
    get fog() {
      return fog
    },
    resize(l, c) {
      layout = l
      config = c
      apply()
    },
    update(frame) {
      if (frame.config !== config) {
        config = frame.config
        apply()
      }
      const sc = frame.scroll
      const W = layout.width
      const H = layout.height
      fog = fogOf(knobs, sc)
      layFog()
      const k = wallKnobs
      // under the finished fog the wall is not there; a picture that failed to load never is
      const on = !!k && fog < 1 && wall.complete && wall.naturalWidth > 0
      if (k && on) {
        const [rw, rh] = sizeOf(k, wall.naturalWidth, wall.naturalHeight, null, geoOf(layout, config, knobs, 1))
        const par = frame.config.world.parallax * k.depth
        const rx = (W * k.x) / 100 - k.anchor.x * rw - frame.pointer.x * par
        const ry = (H * k.y) / 100 - k.anchor.y * rh - frame.pointer.y * par - riseOf(k, sc, H)
        wall.style.width = `${rw}px`
        wall.style.height = `${rh}px`
        wall.style.transform = k.flipX ? `translate(${rx + rw}px,${ry}px) scaleX(-1)` : `translate(${rx}px,${ry}px)`
        wall.style.opacity = String(clamp(k.opacity, 0, 1))
        body.style.transform = `translateY(${ry + rh - 1}px)`
        body.style.opacity = wall.style.opacity
      }
      wall.style.visibility = body.style.visibility = on ? '' : 'hidden'
    },
    show(on) {
      root.style.display = on ? '' : 'none'
    },
    dispose() {
      wall.removeAttribute('src')
      root.remove()
    },
  }
}

/** The whole veil as a DOM layer (no WebGL2, ?nogl=veil). */
function veilDomLayer(mount: HTMLElement, layout: Layout, config: ResolvedConfig): Layer & { stats(): SkyVeilStats } {
  const dom = veilDom(mount, layout, config)
  return {
    resize: dom.resize,
    update: dom.update,
    dispose: dom.dispose,
    stats: () => ({ fog: dom.fog, dom: true, layers: [] }),
  }
}

async function skyLayers(
  mode: Mode,
  gl: GL,
  canvas: HTMLCanvasElement,
  mount: HTMLElement,
  initialLayout: Layout,
  initialConfig: ResolvedConfig,
): Promise<Layer & { stats(): SkyLayerStats[] | SkyVeilStats }> {
  const front = mode === 'front'
  const veil = mode === 'veil'
  /** front, veil: a transparent canvas over other layers, not the opaque sky */
  const transparent = mode !== 'back'
  /** the block of the config this instance draws */
  const block: SkyBlock = veil ? 'veil' : 'sky'
  let layout: Layout = initialLayout
  let config: ResolvedConfig = initialConfig
  let knobs: SkyLayersKnobs = getSkyLayersKnobs(config, block)
  /** this instance's layers, back → front */
  let list: SkyLayersKnobs['layers'] = []
  let disposed = false
  let state: GLState | null = null
  try {
    state = initGL(gl)
  } catch (err) {
    console.error(err)
  }
  const maxTex = () => (gl.isContextLost() ? 4096 : (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096)
  const maxView = (() => {
    const v = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null
    return v ? Math.min(v[0], v[1]) : 4096
  })()
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)')

  const setKnobs = () => {
    knobs = getSkyLayersKnobs(config, block)
    // the sky's two canvases share one list, split by `front`; the veil draws all of its own
    list = knobs.layers.filter((l) => veil || l.k.front === front).slice(0, MAX_LAYERS)
  }
  setKnobs()

  // Behind: a flat sky in the plate's own colours until the first frame (no flash, no layout
  // shift). In front (and the veil): nothing, and never in the way of the pointer.
  const paintBackdrop = () => {
    if (!transparent) mount.style.background = `linear-gradient(180deg, ${knobs.colorTop} 0%, ${knobs.colorBottom} 100%)`
  }
  mount.style.overflow = 'hidden'
  mount.style.contain = 'strict'
  if (transparent) mount.style.pointerEvents = 'none'
  paintBackdrop()
  mount.appendChild(canvas)
  /** front, aberration on: composited per channel (a multiply mask + this canvas as light) */
  const split = front ? createChannelSplit(mount, canvas) : null
  /** veil: the DOM stand-in, made the first time the canvas cannot draw; `domOn` while it is showing */
  let dom: VeilDom | null = null
  let domOn = false

  const slots = new Map<string, Slot>()
  const texes = new Map<string, TexEntry>()
  /** URLs that failed to load: not retried on every frame. */
  const failed = new Set<string>()
  /** Becomes true after the first frame is on screen: later arrivals fade in on their own. */
  let shown = false
  let lastTime = NaN
  let lastDraw: Float32Array | null = null
  /** front: false while it has nothing to show (canvas hidden, 1×1). The veil always has its fog. */
  let active = !front
  /** the compositor that failed to build: not retried (and not reported) every frame */
  let failedSig = ''
  /** veil: the fog of the last frame, 0…1 */
  let fogNow = 0
  /** veil: how far the fog's patches have slid with the wind, px (integrated, like the billow) */
  let fogShift = NaN

  const isTall = () => layout.height > 0 && layout.width / layout.height < knobs.tallBelow
  const urlFor = (k: LayerKnobs) => {
    const file = isTall() && k.srcTall ? k.srcTall : k.src
    return file ? ASSET_DIR + file : ''
  }
  const wantedUrl = (k: LayerKnobs) => (k.opacity > 0 ? urlFor(k) : '')

  /** render px per CSS px: a share of the screen's density, never below 1 (a 1× screen would get a
   *  blurry sky and blotchy grain), never above the screen's own. Same for both instances, so the
   *  grain of the front canvas lands on the very same grid. */
  const renderPR = () => {
    const dpr = Math.max(0.5, layout.dpr)
    return Math.max(Math.min(dpr, 1), dpr * clamp(knobs.renderScale, 0.25, 1))
  }

  const geo = (): Geo => geoOf(layout, config, knobs, renderPR())

  const capSide = () => Math.max(256, Math.min(knobs.maxTexture, maxTex()))

  // ── textures: one per file, ref-counted ──

  function acquire(url: string) {
    let e = texes.get(url)
    if (!e) {
      e = { url, tex: null, w: 0, h: 0, natW: 0, natH: 0, disc: null, refs: 0, loading: false, gen: 0 }
      texes.set(url, e)
    }
    e.refs++
  }

  function release(url: string) {
    const e = texes.get(url)
    if (!e || --e.refs > 0) return
    e.gen++ // cancels a decode in flight
    if (e.tex && !gl.isContextLost()) gl.deleteTexture(e.tex)
    texes.delete(url)
  }

  /** Longest side the texture needs: 1.25 × the largest size any of its layers is drawn at. */
  function targetSide(e: TexEntry, g: Geo): number {
    if (!e.natW || !e.natH) return 0
    let need = 0
    for (const { name, k } of list) {
      if (slots.get(name)?.url !== e.url) continue
      need = Math.max(need, sizeOf(k, e.natW, e.natH, e.disc, g)[0] * g.pr)
    }
    const natLong = Math.max(e.natW, e.natH)
    return Math.max(64, Math.min(natLong, capSide(), Math.ceil((TEX_HEADROOM * need * natLong) / e.natW)))
  }

  async function load(e: TexEntry) {
    const gen = ++e.gen
    e.loading = true
    const live = () => !disposed && !!state && !gl.isContextLost() && texes.get(e.url) === e && e.gen === gen
    try {
      const blob = await fetchBlob(e.url)
      if (!live()) return
      let bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' })
      try {
        if (!live()) return
        e.natW = bmp.width
        e.natH = bmp.height
        const moon = list.some((l) => l.k.kind === 'moon' && slots.get(l.name)?.url === e.url)
        if (moon && !e.disc) e.disc = findDisc(bmp)
        const side = targetSide(e, geo())
        const longest = Math.max(bmp.width, bmp.height)
        if (side > 0 && side < longest) {
          const s = side / longest
          const small = await createImageBitmap(bmp, {
            premultiplyAlpha: 'none',
            resizeWidth: Math.max(1, Math.round(bmp.width * s)),
            resizeHeight: Math.max(1, Math.round(bmp.height * s)),
            resizeQuality: 'high',
          })
          bmp.close()
          bmp = small
          if (!live()) return
        }
        const tex = bake(gl, state!.bake, state!.vao, bmp)
        if (e.tex) gl.deleteTexture(e.tex)
        e.tex = tex
        e.w = bmp.width
        e.h = bmp.height
        lastDraw = null
      } finally {
        bmp.close()
      }
    } catch (err) {
      if (e.gen === gen && !disposed) {
        failed.add(e.url)
        console.warn(`[sky-layers] "${e.url}" failed to load — skipped (a layer that already shows a picture keeps it)`, err)
      }
    } finally {
      if (e.gen === gen) e.loading = false
    }
  }

  const slotFor = (name: string, kind: LayerKind): Slot => {
    let s = slots.get(name)
    if (!s) {
      s = {
        name, kind, url: '', drawn: '', fade: 1, follow: new Follower(),
        started: false, billowA: 0, billowB: 0, rect: [0, 0, 0, 0], drift: 0, pointer: [0, 0], rise: 0,
      }
      slots.set(name, s)
    }
    s.kind = kind
    return s
  }

  /** Points every layer at the picture the current knobs / viewport want; starts the decodes
   *  that are missing (or too small for this window); returns them. */
  function sync(): Promise<void>[] {
    const names = new Set(list.map((l) => l.name))
    for (const [name, s] of slots) {
      if (names.has(name)) continue
      if (s.url) release(s.url)
      if (s.drawn) release(s.drawn)
      slots.delete(name)
    }
    for (const { name, k } of list) {
      const s = slotFor(name, k.kind)
      const url = wantedUrl(k)
      if (s.url === url) continue
      if (url) acquire(url) // before the release: the same file may stay
      if (s.url) release(s.url)
      s.url = url
      if (!url && s.drawn) {
        release(s.drawn)
        s.drawn = ''
      }
    }
    const nextActive = !front || list.some((l) => !!wantedUrl(l.k))
    if (nextActive !== active) {
      active = nextActive
      sizeCanvas()
    }
    if (!state || gl.isContextLost()) return []
    const wanted = new Set([...slots.values()].map((s) => s.url))
    const g = geo()
    const pending: Promise<void>[] = []
    for (const e of texes.values()) {
      if (!wanted.has(e.url) || e.loading || failed.has(e.url)) continue
      if (!e.tex) {
        pending.push(load(e))
        continue
      }
      const cur = Math.max(e.w, e.h)
      if (targetSide(e, g) > cur * TEX_REGROW || cur > capSide()) pending.push(load(e))
    }
    return pending
  }

  function sizeCanvas() {
    const pr = renderPR()
    // an idle front canvas keeps no full-screen drawing buffer
    const w = active ? clamp(Math.round(layout.width * pr), 1, maxView) : 1
    const h = active ? clamp(Math.round(layout.height * pr), 1, maxView) : 1
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      lastDraw = null
    }
    canvas.style.visibility = active ? '' : 'hidden'
    split?.sync()
  }

  const onLost = (e: Event) => {
    e.preventDefault()
    state = null
    // the light is gone with the context: the mask must not darken the silhouettes it left behind
    split?.clear()
    for (const t of texes.values()) {
      t.tex = null
      t.w = 0
      t.h = 0
      t.loading = false
      t.gen++
    }
  }
  const onRestored = () => {
    try {
      state = initGL(gl)
      failed.clear()
      failedSig = ''
      lastDraw = null
      sync()
    } catch (err) {
      console.error(err)
    }
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  // Wait for every picture (they download in parallel, preloaded by index.html): the sky then
  // appears in one piece instead of layer by layer. A failed picture is skipped, not fatal.
  sizeCanvas()
  const pictures = Promise.allSettled(sync())
  // The veil waits VEIL_WAIT at most. It must be there when the page scrolls, with or without its
  // pictures: the hero goes to sleep behind it, and the second screen is drawn over it. The fog needs
  // none of them (it ends in veil.color); a picture that comes later is simply there from its
  // first frame on (render() takes it up).
  await (veil ? Promise.race([pictures, new Promise((done) => setTimeout(done, VEIL_WAIT))]) : pictures)

  // uniform scratch (sized for MAX_LAYERS)
  const A = Object.fromEntries(ARRAYS.map((n) => [n, new Float32Array(4 * MAX_LAYERS)])) as Record<(typeof ARRAYS)[number], Float32Array>
  const S = {
    uMoon0: new Float32Array(4),
    uMoon1: new Float32Array(4),
    uMoon2: new Float32Array(4),
    uMoon3: new Float32Array(4),
    uMoon4: new Float32Array(4),
    uGrain: new Float32Array(4),
    uAb0: new Float32Array(4),
    uAb1: new Float32Array(4),
    uFog: new Float32Array(4),
    uFogB: new Float32Array(4),
  }
  const SNAP_PARTS = [A.uRect, A.uP, A.uQ, A.uB, A.uGA, A.uGB, S.uMoon0, S.uMoon1, S.uMoon2, S.uMoon3, S.uMoon4, S.uGrain, S.uAb0, S.uAb1, S.uFog, S.uFogB]
  const SNAP_LEN = SNAP_PARTS.reduce((a, p) => a + p.length, 0) + 12
  /** Two snapshot buffers, alternated: the last drawn one vs this frame's. */
  const snaps = [new Float32Array(SNAP_LEN), new Float32Array(SNAP_LEN)]
  let flip = 0
  /** front, veil: the part of the canvas any of its layers can touch this frame (CSS px) */
  const box = { x0: 0, y0: 0, x1: 0, y1: 0 }

  /** The compositor generated for the current list of layers (veil: also for which of them follow
   *  the fog) — built on demand; null when it cannot be (reported once, not retried every frame). */
  function compositor(): Compositor | null {
    if (!state) return null
    const sig = `${mode}|${list.map((l) => `${l.name}:${l.k.kind}${veil && l.k.afterFog ? '+' : ''}`).join(',')}`
    if (state.comp?.sig === sig) return state.comp
    if (state.comp) gl.deleteProgram(state.comp.prog)
    state.comp = null
    if (failedSig === sig) return null
    try {
      state.comp = buildCompositor(gl, list.map((l) => l.k), sig, mode)
    } catch (err) {
      console.error(err)
      failedSig = sig
      return null
    }
    lastDraw = null
    return state.comp
  }

  /** Every layer's picture (or the empty texture) on its unit, the billow noise on the next one. */
  function bindTextures() {
    list.forEach(({ name }, i) => {
      gl.activeTexture(gl.TEXTURE0 + i)
      const s = slots.get(name)
      gl.bindTexture(gl.TEXTURE_2D, (s?.drawn && texes.get(s.drawn)?.tex) || state!.empty)
    })
    gl.activeTexture(gl.TEXTURE0 + list.length)
    gl.bindTexture(gl.TEXTURE_2D, state!.noise)
  }

  /**
   * veil: it sleeps until the page scrolls, and its first frame must not pay for the shader — ≈ 15 ms
   * of compiling plus the driver's own work on the first draw: one long frame exactly when the scroll
   * starts. So the compositor is built ahead and one pixel is drawn with it (every uniform zero →
   * no layer is drawn, the pixel stays transparent).
   */
  function warmUp() {
    if (disposed || !state || gl.isContextLost()) return
    const comp = compositor()
    if (!comp) return
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.disable(gl.BLEND)
    gl.useProgram(comp.prog)
    gl.bindVertexArray(state.vao)
    bindTextures()
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, 0, 1, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disable(gl.SCISSOR_TEST)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    lastDraw = null
  }
  if (veil) warmUp()

  function render(frame: Frame) {
    if (disposed || !state || gl.isContextLost()) return
    const { time, pointer, scroll } = frame
    const world = frame.config.world
    const motion = frame.config.motion
    const W = layout.width
    const H = layout.height
    if (W <= 0 || H <= 0) return

    const dt = Number.isNaN(lastTime) ? 0 : clamp(time - lastTime, 0, 0.1)
    lastTime = time
    const driftMul = Math.max(0, world.drift)
    const dtEff = dt * driftMul
    // the shared wind and every layer's own inertia advance every frame, drawn or not
    const w = windAt(time, driftMul, knobs.wind)
    const sway = knobs.wind.direction * Math.sin(w.phase)
    for (const { name, k } of list) {
      const s = slots.get(name)
      if (!s) continue
      s.follow.step(pointer, frame.dt, motion, k.mass)
      // mass 1 = the shared spring itself (bit-identical to the pointer everyone else uses)
      s.pointer[0] = k.mass === 1 ? pointer.x : s.follow.x
      s.pointer[1] = k.mass === 1 ? pointer.y : s.follow.y
    }
    if (!active) return

    const comp = compositor()
    if (!comp) return
    const n = comp.n

    const fadeStep = knobs.fadeIn > 0 ? (frame.dt * 1000) / knobs.fadeIn : 1
    const prX = canvas.width / W
    const prY = canvas.height / H
    const g = geo()
    let visible = 0
    box.x0 = W
    box.y0 = H
    box.x1 = 0
    box.y1 = 0

    for (const a of Object.values(A)) a.fill(0)
    for (const a of Object.values(S)) a.fill(0)
    // veil: where its own clouds are this frame, for whoever must know without drawing (core/veil-clouds.ts)
    const boxes: VeilCloudBox[] | null = veil ? [] : null

    // veil: the whiteout of this frame. The patches of the fog slide with the wind (integrated,
    // so a tuner / reduced-motion change never makes them jump)
    const fog = veil ? fogOf(knobs, scroll) : 0
    fogNow = fog
    if (veil) {
      const f = knobs.fog
      fogShift = Number.isNaN(fogShift) ? time * driftMul * f.speed : fogShift + dtEff * f.speed
      const cell = Math.max(8, f.size) * NOISE_CELLS
      const c = hexToLinear(knobs.color)
      // the phase only while the fog is on its way: a finished (or absent) fog redraws nothing
      S.uFog.set([c[0], c[1], c[2], fog])
      S.uFogB.set([Math.max(0, f.patchy), 1 / cell, Math.max(0, f.lift), fog > 0 && fog < 1 ? mod(fogShift / cell, 4) : 0])
    }

    list.forEach(({ name, k }, i) => {
      const s = slots.get(name)
      if (!s) return
      // the wanted picture is baked → it goes on screen (the previous one is let go)
      if (s.url && s.drawn !== s.url && texes.get(s.url)?.tex) {
        acquire(s.url)
        const first = !s.drawn
        if (s.drawn) release(s.drawn)
        s.drawn = s.url
        s.fade = shown && first ? 0 : 1
      }
      const t = s.drawn ? texes.get(s.drawn) : undefined
      if (!t?.tex) return
      if (s.fade < 1) s.fade = Math.min(1, s.fade + fadeStep)

      // billow (slow flow distortion): its own slowly sliding field
      const bRate = k.billow.speed / NOISE_CELLS
      if (!s.started) {
        s.started = true
        const off = nameSeed(name) * NOISE_CELLS
        s.billowA = time * driftMul * bRate + off
        s.billowB = time * driftMul * bRate * 0.83 + off * 1.83
      } else {
        s.billowA = (s.billowA + dtEff * bRate) % 64
        s.billowB = (s.billowB + dtEff * bRate * 0.83) % 64
      }
      // the shared wind: same phase for every layer, its own range (nearer = bigger)
      const driftX = k.drift.wrap ? w.travel * Math.abs(k.depth) : k.drift.range * sway

      const ox = -s.pointer[0] * world.parallax * k.depth
      const oy = -s.pointer[1] * world.parallax * k.depth
      // the page scroll lifts the layer (the camera sinks). 0 → not one number below changes
      const rise = riseOf(k, scroll, H)
      const [rw, rh] = sizeOf(k, t.natW, t.natH, t.disc, g)
      let rx: number
      let ry: number
      let period = 0

      if (k.kind === 'plate') {
        const r = plateReach(k, g)
        const bx = clamp((W - rw) * clamp(k.focus.x, 0, 1), W - rw + r.x, -r.x)
        const by = clamp((H - rh) * clamp(k.focus.y, 0, 1), H - rh + r.y, -r.y)
        rx = bx + ox + (k.drift.wrap ? mod(driftX, 2 * rw) : driftX)
        ry = by + oy
        // the photo keeps its size and only slides inside its own margin: it stops at its bottom edge
        if (rise !== 0) ry = Math.max(H - rh, ry - rise)
      } else if (k.kind === 'moon') {
        const d = t.disc ?? wholeDisc(t.natW, t.natH)
        const diameter = (g.base * k.width) / 100
        // (the moon only ping-pongs: drift.wrap is ignored)
        rx = (W * k.x) / 100 + ox + (k.drift.wrap ? 0 : driftX) - d.cx * rw
        ry = (H * k.y) / 100 + oy - d.cy * rh
        // haze: ring of taps at `haze` px, each pre-blurred by the matching mip level
        const texelsPerPx = t.w / rw
        const baseLod = Math.max(0, Math.log2(texelsPerPx / prX))
        const haze = Math.max(0, k.haze)
        const rPx = diameter / 2
        const tilt = (k.terminatorTilt * Math.PI) / 180
        const term = clamp(k.terminator, -1, 1)
        const glowOff = 0.425 * (term + 1)
        S.uMoon0.set([d.cx, d.cy, d.rx, d.ry])
        S.uMoon1.set([haze / rw, haze / rh, Math.max(baseLod, Math.log2(Math.max(1, 0.75 * haze * texelsPerPx))), clamp(k.blend, 0, 1)])
        S.uMoon2.set([term, Math.cos(tilt), Math.sin(tilt), Math.max(1e-3, k.terminatorSoftness + haze / Math.max(1, rPx))])
        const gc = hexToLinear(k.glowColor)
        const gk = Math.max(0, k.glow) * clamp(k.opacity, 0, 1) * s.fade
        S.uMoon3.set([gc[0] * gk, gc[1] * gk, gc[2] * gk, Math.max(0.05, k.glowSize)])
        S.uMoon4.set([Math.cos(tilt) * glowOff, Math.sin(tilt) * glowOff, clamp(k.earthshine, 0, 1), 0])
        if (rise !== 0) ry -= rise
      } else {
        rx = (W * k.x) / 100 - k.anchor.x * rw + ox
        ry = (H * k.y) / 100 - k.anchor.y * rh + oy
        if (k.kind === 'bank') {
          // tiles repeat every 2 widths (mirrored) or (1 − seam) widths: keep x small for precision
          const tile = k.seam > 0 ? (1 - clamp(k.seam, 0, 0.5)) * rw : 2 * rw
          rx += k.drift.wrap ? mod(driftX, tile) : driftX
        } else if (k.drift.wrap) {
          period = W + rw
          rx = mod(rx + driftX + rw, period) - rw
        } else {
          rx += driftX
        }
        if (rise !== 0) ry -= rise
      }

      const opacity = clamp(k.opacity, 0, 1) * s.fade
      // veil: only its own clouds paint by themselves, and only until the fog is complete; the plate
      // (what the fog dissolves into) and the afterFog layers show through the fog alone
      const paints = !veil || (k.kind !== 'plate' && !k.afterFog && fog < 1)
      if (opacity > 0 && paints) {
        visible++
        // front: where this layer can paint (banks: from their top down, mirrored below)
        const b = Math.max(0, k.billow.amount) + 2
        const wide = k.kind === 'bank' || period > 0
        box.x0 = Math.min(box.x0, wide ? 0 : rx - b)
        box.x1 = Math.max(box.x1, wide ? W : rx + rw + b)
        box.y0 = Math.min(box.y0, ry - b)
        box.y1 = Math.max(box.y1, k.kind === 'bank' ? H : ry + rh + b)
      }
      s.rect[0] = rx
      s.rect[1] = ry
      s.rect[2] = rw
      s.rect[3] = rh
      s.drift = driftX
      s.rise = rise
      if (boxes && k.kind !== 'plate' && !k.afterFog) boxes.push({ name, left: rx, top: ry, width: rw, height: rh, rise })

      const j = i * 4
      const lod = Math.max(0, Math.log2(t.w / Math.max(1e-6, rw * prX)))
      A.uRect.set([rx, ry, rw, rh], j)
      // (veil: a cloud under the finished fog is not evaluated at all)
      A.uP.set([(paints || k.afterFog) ? opacity : 0, Math.max(0, k.feather), clamp(k.seam, 0, 0.5), lod], j)
      A.uQ.set([k.flipX ? 1 : 0, period, k.solid ? 1 : 0, 0], j)
      A.uB.set([Math.max(0, k.billow.amount), Math.max(1, k.billow.size), s.billowA, s.billowB], j)
      const gr = k.grade
      const identity = gr.saturation === 1 && gr.brightness === 1 && gr.contrast === 1 && (gr.tintAmount === 0 || gr.tint.toLowerCase() === '#ffffff')
      const tint = tintRgb(gr.tint)
      A.uGA.set([gr.saturation, gr.brightness, gr.contrast, clamp(gr.tintAmount, 0, 1)], j)
      A.uGB.set([tint[0], tint[1], tint[2], identity ? 0 : 1], j)
      // the plate is opaque: without it the backdrop gradient shows (uP.x = 0)
      if (k.kind === 'plate') A.uP[j] = s.fade
    })

    if (boxes) {
      veilClouds.current = boxes
      veilClouds.at = performance.now()
    }
    if (veil) {
      // No aberration on the veil (uAb0 / uAb1 stay zero → one read of the stack): a defocused,
      // near-white curtain shows no fringe, and a multiply mask over the DOM tagline is a risk for nothing.
      // The fog reaches every pixel.
      if (fog > 0) {
        visible++
        box.x0 = 0
        box.y0 = 0
        box.x1 = W
        box.y1 = H
      }
    } else {
      // chromatic aberration (post.aberration): the same lens as the title's and the other canvas's
      const ab = aberrationAt(frame.config, layout, pointer.energy)
      S.uAb0.set(ab.a0)
      S.uAb1.set(ab.a1)
      if (split && split.on !== ab.on) {
        split.set(ab.on)
        lastDraw = null
      }
      // front: a pixel shows its layers from up to `reach` px away
      box.x0 -= ab.reach + 1
      box.y0 -= ab.reach + 1
      box.x1 += ab.reach + 1
      box.y1 += ab.reach + 1
    }
    // front, veil: the band of the canvas their layers can reach (canvas px, y up)
    const x0 = clamp(Math.floor(box.x0 * prX), 0, canvas.width)
    const x1 = clamp(Math.ceil(box.x1 * prX), 0, canvas.width)
    const y0 = clamp(Math.floor((H - box.y1) * prY), 0, canvas.height)
    const y1 = clamp(Math.ceil((H - box.y0) * prY), 0, canvas.height)
    const empty = x1 <= x0 || y1 <= y0

    // front with nothing on it (still loading, all faded out), veil with none of its clouds inside
    // the frame yet and no fog: hide the canvas, skip the GPU
    if (transparent) {
      const hide = visible === 0 || (veil && empty)
      if (hide !== (canvas.style.visibility === 'hidden')) {
        canvas.style.visibility = hide ? 'hidden' : ''
        split?.sync()
        lastDraw = null
      }
      if (hide) return
    }

    const gk = knobs.grain
    const fps = reducedMq.matches ? 0 : Math.max(0, gk.fps)
    const seed = fps > 0 ? Math.floor(time * fps) % 1000003 : 0
    S.uGrain.set([Math.max(0, gk.amount), Math.max(0, gk.size) * prX, clamp(gk.blend, 0, 1), 0])
    const top = hexToLinear(knobs.colorTop)
    const bottom = hexToLinear(knobs.colorBottom)

    // nothing moved since the last frame → keep it (saves the GPU when everything is still)
    const snap = snaps[flip]
    let o = 0
    for (const p of SNAP_PARTS) {
      snap.set(p, o)
      o += p.length
    }
    snap.set([seed, canvas.width, canvas.height, W, H, n, ...top, ...bottom], o)
    if (lastDraw && lastDraw !== snap && lastDraw.every((v, q) => v === snap[q])) return
    lastDraw = snap
    flip ^= 1

    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.disable(gl.BLEND)
    gl.useProgram(comp.prog)
    gl.bindVertexArray(state.vao)
    bindTextures()
    const u = comp.u
    gl.uniform4fv(u.uRect, A.uRect, 0, 4 * n)
    gl.uniform4fv(u.uP, A.uP, 0, 4 * n)
    gl.uniform4fv(u.uQ, A.uQ, 0, 4 * n)
    gl.uniform4fv(u.uB, A.uB, 0, 4 * n)
    gl.uniform4fv(u.uGA, A.uGA, 0, 4 * n)
    gl.uniform4fv(u.uGB, A.uGB, 0, 4 * n)
    gl.uniform2f(u.uView, W, H)
    gl.uniform2f(u.uPR, prX, prY)
    gl.uniform4fv(u.uMoon0, S.uMoon0)
    gl.uniform4fv(u.uMoon1, S.uMoon1)
    gl.uniform4fv(u.uMoon2, S.uMoon2)
    gl.uniform4fv(u.uMoon3, S.uMoon3)
    gl.uniform4fv(u.uMoon4, S.uMoon4)
    gl.uniform4fv(u.uGrain, S.uGrain)
    gl.uniform4fv(u.uAb0, S.uAb0)
    gl.uniform4fv(u.uAb1, S.uAb1)
    gl.uniform1ui(u.uSeed, seed >>> 0)
    gl.uniform3f(u.uTop, top[0], top[1], top[2])
    gl.uniform3f(u.uBottom, bottom[0], bottom[1], bottom[2])
    gl.uniform4fv(u.uFog, S.uFog)
    gl.uniform4fv(u.uFogB, S.uFogB)
    if (transparent) {
      // clear everything, then shade only the band the layers can reach. Aberration on (front) →
      // twice: the mask (cleared white = lets everything through), taken by the split, then the light
      const pass = (mask: boolean) => {
        gl.disable(gl.SCISSOR_TEST)
        gl.clearColor(+mask, +mask, +mask, +mask)
        gl.clear(gl.COLOR_BUFFER_BIT)
        if (empty) return
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(x0, y0, x1 - x0, y1 - y0)
        gl.uniform1f(u.uMask, +mask)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.disable(gl.SCISSOR_TEST)
      }
      if (split?.on) {
        pass(true)
        split.copy()
      }
      pass(false)
      if (empty) return
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    if (!shown) {
      shown = true
      // First drawn behind the veil (a page opened on the second screen: this frame is a hidden one)
      // → no fade: it would be played later, in plain sight, over the visitor's first scroll up.
      const ms = scroll.covered ? 0 : Math.max(0, knobs.fadeIn)
      if (ms > 0) {
        // next frame: the transition needs a committed opacity: 0 to start from
        requestAnimationFrame(() => {
          canvas.style.transition = `opacity ${ms}ms ease-out`
          canvas.style.opacity = '1'
          split?.sync()
        })
      } else {
        // no fade (the veil: it only ever appears by the scroll) → on screen with this very frame
        canvas.style.opacity = '1'
        split?.sync()
      }
    }
  }

  /**
   * veil: the hero sleeps behind it (scroll.cover), so whenever the canvas cannot draw — context
   * lost, compositor refused — the DOM stand-in plays the same scroll in its place.
   */
  function standIn(frame: Frame) {
    const down = !state || gl.isContextLost() || !state.comp
    if ((!down && !dom) || layout.width <= 0 || layout.height <= 0) return
    dom ??= veilDom(mount, layout, config)
    domOn = down
    dom.show(down)
    if (down) dom.update(frame)
  }

  return {
    resize(l, c) {
      layout = l
      config = c
      setKnobs()
      paintBackdrop()
      sizeCanvas()
      void Promise.allSettled(sync())
      lastDraw = null
      dom?.resize(l, c)
    },
    update(frame) {
      if (frame.config !== config) {
        config = frame.config
        setKnobs()
        void Promise.allSettled(sync())
      }
      render(frame)
      if (veil) standIn(frame)
    },
    dispose() {
      disposed = true
      if (veil) veilClouds.current = null
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (state && !gl.isContextLost()) {
        for (const t of texes.values()) if (t.tex) gl.deleteTexture(t.tex)
        if (state.comp) gl.deleteProgram(state.comp.prog)
        gl.deleteProgram(state.bake)
        gl.deleteTexture(state.noise)
        gl.deleteTexture(state.empty)
        gl.deleteVertexArray(state.vao)
      }
      texes.clear()
      slots.clear()
      state = null
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      split?.dispose()
      dom?.dispose()
      canvas.remove()
      mount.style.background = ''
      mount.style.overflow = ''
      mount.style.contain = ''
      mount.style.pointerEvents = ''
    },
    /** Debug / verification: where each layer is and what it holds (CSS px); the veil adds its fog. */
    stats() {
      const layers = list.map(({ name, k }): SkyLayerStats => {
        const s = slots.get(name)
        const t = s?.drawn ? texes.get(s.drawn) : undefined
        return {
          name,
          front: k.front,
          url: s?.drawn ?? '',
          rect: [...(s?.rect ?? [0, 0, 0, 0])] as [number, number, number, number],
          drift: s?.drift ?? 0,
          pointer: [...(s?.pointer ?? [0, 0])] as [number, number],
          rise: s?.rise ?? 0,
          tex: [t?.w ?? 0, t?.h ?? 0] as [number, number],
          file: [t?.natW ?? 0, t?.natH ?? 0] as [number, number],
        }
      })
      if (!veil) return layers
      return { fog: dom && domOn ? dom.fog : fogNow, dom: domOn, layers }
    },
  }
}
