import { aberrationAt } from '../../core/aberration'
import { aboutFrame } from '../../core/about-sheet'
import { createChannelSplit } from '../../core/channel-split'
import { grainUniforms } from '../../core/grain'
import { navDock } from '../../core/nav-dock'
import type { Frame, Layer, LayerFactory, Layout, ResolvedConfig } from '../../core/types'
import { createAboutCore, MAX_CROSSES, MAX_HOLES, MAX_PHOTOS, type AboutCore, type AboutState, type PhotoInst } from './core'
import { createAboutFallback } from './fallback'
import { hexRgb } from './knobs'
import { debrisReach, DOCK_PAD, MARGIN } from './photos'
import { DATA_ROWS, DATA_WIDTH, FULLSCREEN_VS, OUT_FS, ROW_CROSSES, ROW_HOLES, ROW_PHOTOS, SHEET_FS } from './shaders'

/**
 * ABOUT — the black sheet with the holes (version 2, third screen; numbers: sky.config.ts → about).
 *
 * The white void the projects hung in is the inside of a giant letter A: this layer is a near-black
 * SHEET over the (unchanged) veil, cut by the holes ABOUT / THAT'S ALL FOR NOW and a few giant letter
 * fragments, with torn photos and little crosses pasted on it. The camera (core/about-camera.ts, a pure
 * function of the scroll) starts so close that the whole screen is inside the A's stroke — the sheet is
 * fully transparent, the frame is the bare void — and pulls back through art-directed shots; then it
 * zig-zags down the notes to the finale.
 *
 * Drawn by the site's «bad render» recipe: a raw WebGL2 canvas with ONE pixel per raster cell
 * (aboutCell: device-snapped), magnified by CSS with `image-rendering: pixelated` and never
 * CSS-transformed — the camera's zoom is re-rasterised every frame. Coverage is binary, the letters
 * are a low-resolution texture locked to the sheet (power-of-two LOD with hysteresis), photos are
 * point-sampled and dithered, edges fall apart into blocks. Nothing is anti-aliased — do not
 * "improve" it.
 *
 *   core.ts (camera, sway, LOD, reveals, culling) ─▶ pass 1: the sheet → RGBA8 + material targets
 *     (only when something changed) ─▶ pass 2: aberration on coverage + grain → the canvas
 *     (the mask + light of core/channel-split.ts while the aberration is on)
 *
 * It publishes core/about-sheet.ts → aboutFrame (camera, sway, the Frame it was written in; every
 * update: the notes follow it) and reads core/nav-dock.ts (photos under the nav go dark, photos.dock).
 * No WebGL2, `?nogl=about`, a shader that fails, or a lost context → ./fallback (2D, pre-rasterised
 * masks, the reduced-motion dissolve instead of the pull-back); a restored context brings the WebGL
 * sheet back.
 *
 * Awake before its pull (sky.ts wakes it ABOUT_LEAD early) — or on its hidden first update — it does
 * the expensive first-time work off screen: the targets, the atlas, the photo layers (two a frame, as
 * they arrive) and one pass 1 into its target (the programs' first use), so the first frame of the
 * pull costs no more than any other.
 */

const noGL = () => new URLSearchParams(location.search).get('nogl')?.split(',').includes('about') ?? false

/** What draws the sheet: the WebGL renderer below or the 2D fallback. */
export interface AboutRenderer {
  kind: 'gl' | 'flat'
  resize(layout: Layout, config: ResolvedConfig): void
  /** draw this frame's state; true — the sheet is on screen (the camera is past pull.from) */
  draw(frame: Frame, st: AboutState): boolean
  stats(): Record<string, unknown>
  dispose(): void
}

export const createAboutLayer: LayerFactory = async (mount, ctx) => {
  let renderer: AboutRenderer | null = null
  /** the WebGL renderer, kept also while the fallback stands in for it (a lost context): dispose frees both */
  let glr: AboutRenderer | null = null
  let disposed = false
  const core = createAboutCore(ctx.layout, ctx.config, () => undefined)
  // the factory waits for the font and the glyph atlas only — never for the photos
  await core.ready()

  let layout = ctx.layout
  let config = ctx.config
  let st: AboutState | null = null

  const toFlat = () => {
    const prev = renderer
    renderer = createAboutFallback(mount, core)
    renderer.resize(layout, config)
    if (prev?.kind === 'flat') prev.dispose()
    // the fallback frames the sheet differently (the reduced camera): the photos' clocks start over
    // from pos, not from whatever the WebGL sheet (or a sleep long ago) left in them
    core.resetPhotos()
  }

  const makeGL = (): AboutRenderer | null => {
    try {
      return createGLRenderer(mount, core, {
        lost() {
          if (!disposed) toFlat()
        },
        restored(gl) {
          if (disposed) return
          if (renderer?.kind === 'flat') renderer.dispose()
          renderer = gl
          renderer.resize(layout, config)
          core.resetPhotos()
        },
      })
    } catch (err) {
      console.warn('[about] WebGL sheet unavailable → 2D fallback', err)
      return null
    }
  }

  if (!noGL()) renderer = glr = makeGL()
  else console.warn('[about] WebGL switched off (?nogl=about) — 2D fallback')
  if (!renderer) toFlat()

  const layer: Layer & { stats(): unknown; published: unknown } = {
    /** Debug: what this layer tells the others (core/about-sheet.ts), as the page sees it. */
    published: { frame: aboutFrame },

    /** Debug (__hero.layers.get('about').stats(); shot.mjs --stats about). */
    stats() {
      const cam = st?.cam
      const m = core.measured
      const pe = st?.K ? (config as unknown as { about?: { pull?: { entry?: unknown } } }).about?.pull?.entry : null
      return {
        renderer: renderer?.kind,
        camera: cam && { active: cam.active, cx: +cam.cx.toFixed(5), cy: +cam.cy.toFixed(5), zoom: +cam.zoom.toFixed(4), roll: +((cam.roll * 180) / Math.PI).toFixed(3), pull: +cam.pull.toFixed(4), tour: +cam.tour.toFixed(4), key: +cam.key.toFixed(3), z0: +cam.z0.toFixed(3), dissolve: cam.dissolve, U: +cam.U.toFixed(2) },
        cell: cam?.cell,
        lod: st?.lod,
        lodMix: st?.lodMix,
        texelPx: st && +st.texelPx.toFixed(2),
        ramp: st && +st.ramp.toFixed(3),
        sway: st?.sway,
        entry: { measured: m && { x: +m.x.toFixed(4), y: +m.y.toFixed(4), r: +m.r.toFixed(4) }, config: pe },
        glyphs: core.glyphs && { atlas: [core.glyphs.width, core.glyphs.height], ms: +core.glyphs.ms.toFixed(1), timing: core.glyphs.timing, texts: [...core.glyphs.glyphs.values()].map((g) => g.id.split('\u0002').join(' ×')) },
        culled: st && { holes: st.holes.map((h) => h.k.key), photos: st.photos.map((p) => `${p.k.key}:${p.reveal}${p.lod ? `@${p.lod}` : ''}`), crosses: st.crosses.length },
        photos: core.photos.state(),
        ...renderer?.stats(),
      }
    },

    resize(l, c) {
      layout = l
      config = c
      core.resize(l, c)
      renderer?.resize(l, c)
    },

    update(frame) {
      layout = frame.layout
      config = frame.config
      if (!renderer) return
      st = core.step(frame, renderer.kind === 'flat')
      const on = renderer.draw(frame, st)
      aboutFrame.camera = st.cam
      aboutFrame.pointer = st.sway
      if (on) aboutFrame.drawn = true
      aboutFrame.frame = frame
      aboutFrame.time = performance.now()
    },

    dispose() {
      disposed = true
      renderer?.dispose()
      if (glr && glr !== renderer) glr.dispose()
      renderer = glr = null
      core.dispose()
      mount.style.width = mount.style.height = ''
    },
  }
  return layer
}

// ── the WebGL renderer ────────────────────────────────────────────────────────────────────────

interface GLHooks {
  lost(): void
  restored(r: AboutRenderer): void
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string, name: string) {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const v = sh(gl.VERTEX_SHADER, vs)
  const f = sh(gl.FRAGMENT_SHADER, fs)
  const p = gl.createProgram()!
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = [gl.getProgramInfoLog(p), gl.getShaderInfoLog(v), gl.getShaderInfoLog(f)].map((s) => s?.trim()).filter(Boolean).join('\n')
    throw new Error(`[about] ${name} shader failed\n${log}`)
  }
  gl.deleteShader(v)
  gl.deleteShader(f)
  const u = new Map<string, WebGLUniformLocation | null>()
  return { p, u: (n: string) => (u.has(n) ? u.get(n)! : (u.set(n, gl.getUniformLocation(p, n)), u.get(n)!)) }
}

type Prog = ReturnType<typeof compile>

interface GLState {
  sheet: Prog
  out: Prog
  vao: WebGLVertexArrayObject
  fbo: WebGLFramebuffer
  colTex: WebGLTexture
  matTex: WebGLTexture
  atlas: WebGLTexture
  photos: WebGLTexture
  data: WebGLTexture
  /** what is in the textures */
  atlasKey: string
  photoLayers: number
  photoSize: number
  /** per layer: the slot version uploaded, and the one whose mip chain is built (drawn only then) */
  photoVersions: number[]
  photoReady: number[]
  fboW: number
  fboH: number
}

/** Photo layers uploaded per frame at most (each is a texSubImage3D of texWidth²): the rest next frame. */
const UPLOADS_PER_FRAME = 2

function createGLRenderer(mount: HTMLElement, core: AboutCore, hooks: GLHooks): AboutRenderer {
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
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  if (!gl) throw new Error('no WebGL2')
  // the material target is R8: renderable everywhere in WebGL2; the atlas is R16F (filterable in core)
  let S: GLState | null
  try {
    S = init(gl)
  } catch (err) {
    // a program that does not link: give the context back before the fallback takes over
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw err
  }
  mount.appendChild(canvas)
  const split = createChannelSplit(mount, canvas)

  const size = { w: 0, h: 0, cell: 1 }
  const data = new Float32Array(DATA_WIDTH * 4 * DATA_ROWS)
  let snap1: Float32Array | null = null
  let snap2: Float32Array | null = null
  let pass1Count = 0
  let cleared = false
  let lastMs = 0
  let lastDraws = { pass1: 0, pass2: 0 }
  let lostNow = false
  /** the off-screen first pass has run for this canvas size and context (warm()) */
  let warmed = false
  /** debug: what made the last pass 1 run — [index into the snapshot, was, now] */
  let lastDiff: number[] = []

  const onLost = (e: Event) => {
    e.preventDefault()
    lostNow = true
    S = null
    split.set(false)
    canvas.style.display = 'none'
    hooks.lost()
  }
  const onRestored = () => {
    try {
      S = init(gl)
      lostNow = false
      warmed = false
      snap1 = snap2 = null
      canvas.style.display = 'block'
      hooks.restored(renderer)
    } catch (err) {
      console.error(err)
    }
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  function init(g: WebGL2RenderingContext): GLState {
    const sheet = compile(g, FULLSCREEN_VS, SHEET_FS, 'sheet')
    const out = compile(g, FULLSCREEN_VS, OUT_FS, 'out')
    const tex = (target: number) => {
      const t = g.createTexture()!
      g.bindTexture(target, t)
      g.texParameteri(target, g.TEXTURE_MIN_FILTER, g.NEAREST)
      g.texParameteri(target, g.TEXTURE_MAG_FILTER, g.NEAREST)
      g.texParameteri(target, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
      g.texParameteri(target, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
      return t
    }
    const colTex = tex(g.TEXTURE_2D)
    const matTex = tex(g.TEXTURE_2D)
    const atlas = tex(g.TEXTURE_2D)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    g.texImage2D(g.TEXTURE_2D, 0, g.R16F, 1, 1, 0, g.RED, g.FLOAT, new Float32Array([-64]))
    const data = tex(g.TEXTURE_2D)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, DATA_WIDTH, DATA_ROWS, 0, g.RGBA, g.FLOAT, null)
    const photos = tex(g.TEXTURE_2D_ARRAY)
    g.texImage3D(g.TEXTURE_2D_ARRAY, 0, g.RGBA8, 1, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(4))
    const fbo = g.createFramebuffer()!
    const vao = g.createVertexArray()!
    g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.NONE)
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false)
    return { sheet, out, vao, fbo, colTex, matTex, atlas, photos, data, atlasKey: '', photoLayers: 0, photoSize: 0, photoVersions: [], photoReady: [], fboW: 0, fboH: 0 }
  }

  /** The canvas: the whole stage on the cell lattice, rounded UP (the stage clips the overhang). */
  function fit(st: AboutState, layout: Layout) {
    const cell = st.cam.cell
    const w = Math.max(1, Math.ceil(layout.width / cell - 1e-4))
    const h = Math.max(1, Math.ceil(layout.height / cell - 1e-4))
    if (w === size.w && h === size.h && cell === size.cell) return
    mount.style.width = `${w * cell}px`
    mount.style.height = `${h * cell}px`
    size.cell = cell
    size.w = w
    size.h = h
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    snap1 = snap2 = null
    warmed = false
  }

  function syncTargets(s: GLState) {
    if (s.fboW === size.w && s.fboH === size.h) return
    gl!.bindTexture(gl!.TEXTURE_2D, s.colTex)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, size.w, size.h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null)
    gl!.bindTexture(gl!.TEXTURE_2D, s.matTex)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R8, size.w, size.h, 0, gl!.RED, gl!.UNSIGNED_BYTE, null)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, s.fbo)
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, s.colTex, 0)
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT1, gl!.TEXTURE_2D, s.matTex, 0)
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
    s.fboW = size.w
    s.fboH = size.h
  }

  /**
   * Upload what changed: the atlas (a new glyph set), photo layers (arrived / re-cut) — at most
   * UPLOADS_PER_FRAME of them a frame; the mip chain is built once none are left waiting, and only then
   * is a layer drawn (photoReady). A re-created array (the window count or texWidth changed — e.g. a
   * desktop ↔ mobile layout switch, where leafT drops out and every later window moves down a layer)
   * takes every slot already in memory in that same frame (CPU-backed canvases, nothing to decode):
   * the photos on screen never blink out while the new array fills.
   */
  function syncTextures(s: GLState) {
    const g = gl!
    const set = core.glyphs
    if (set && s.atlasKey !== set.key) {
      g.bindTexture(g.TEXTURE_2D, s.atlas)
      g.pixelStorei(g.UNPACK_ALIGNMENT, 4)
      g.texImage2D(g.TEXTURE_2D, 0, g.R16F, set.width, set.height, 0, g.RED, g.FLOAT, set.dist)
      s.atlasKey = set.key
    }
    const P = core.photos
    const n = Math.max(1, P.count)
    const sz = P.size
    let cap = UPLOADS_PER_FRAME
    if (s.photoLayers !== n || s.photoSize !== sz) {
      cap = Infinity
      g.bindTexture(g.TEXTURE_2D_ARRAY, s.photos)
      const levels = Math.floor(Math.log2(sz)) + 1
      // immutable storage cannot be resized: a fresh texture
      g.deleteTexture(s.photos)
      s.photos = g.createTexture()!
      g.bindTexture(g.TEXTURE_2D_ARRAY, s.photos)
      g.texStorage3D(g.TEXTURE_2D_ARRAY, levels, g.RGBA8, sz, sz, n)
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MIN_FILTER, g.NEAREST_MIPMAP_NEAREST)
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_MAG_FILTER, g.NEAREST)
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
      g.texParameteri(g.TEXTURE_2D_ARRAY, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
      s.photoLayers = n
      s.photoSize = sz
      s.photoVersions = []
      s.photoReady = []
    }
    let uploads = 0
    let waiting = false
    for (let i = 0; i < P.count; i++) {
      const slot = P.get(i)
      if (!slot || s.photoVersions[i] === slot.version || slot.canvas.width !== sz) continue
      if (uploads >= cap) {
        waiting = true
        break
      }
      g.bindTexture(g.TEXTURE_2D_ARRAY, s.photos)
      g.texSubImage3D(g.TEXTURE_2D_ARRAY, 0, 0, 0, i, sz, sz, 1, g.RGBA, g.UNSIGNED_BYTE, slot.canvas)
      s.photoVersions[i] = slot.version
      uploads++
    }
    const stale = s.photoVersions.some((v, i) => v !== s.photoReady[i])
    if (stale && !waiting) {
      g.bindTexture(g.TEXTURE_2D_ARRAY, s.photos)
      g.generateMipmap(g.TEXTURE_2D_ARRAY)
      s.photoReady = s.photoVersions.slice()
    }
  }

  /** The instance rows + the scalars of pass 1, packed (and compared: unchanged → no pass 1). */
  function pack(st: AboutState, shown: PhotoInst[]) {
    data.fill(0)
    const row = (r: number, t: number, a: number, b: number, c: number, d: number) => data.set([a, b, c, d], (r * DATA_WIDTH + t) * 4)
    const K = st.K
    st.holes.forEach((h, i) => {
      const r = ROW_HOLES + i
      const M = h.placed.M
      row(r, 0, M[0], M[1], M[2], 0)
      row(r, 1, M[3], M[4], M[5], 0)
      row(r, 2, M[6], M[7], M[8], 0)
      row(r, 3, h.g.ax, h.g.ay, h.g.w, h.g.h)
      row(r, 4, h.upp, st.texel / h.upp, h.k.rough, h.k.mottle)
      row(r, 5, h.k.slip, h.seed, h.tex, 0)
      row(r, 6, ...h.placed.box)
    })
    shown.forEach((p, j) => {
      const r = ROW_PHOTOS + j
      const M = p.placed.M
      row(r, 0, M[0], M[1], M[2], 0)
      row(r, 1, M[3], M[4], M[5], 0)
      row(r, 2, M[6], M[7], M[8], 0)
      row(r, 3, p.placed.W, p.placed.H, p.k.index, Math.min(p.lod, Math.floor(Math.log2(core.photos.size))))
      row(r, 4, p.k.torn, p.k.tornAmount, p.k.halftone ? 1 : 0, p.k.saturation)
      row(r, 5, p.reveal, p.seed, MARGIN, debrisReach(K, p.k) * p.placed.W)
      row(r, 6, ...p.placed.box)
      row(r, 7, p.slot.lo, p.slot.hi, 0, 0)
    })
    st.crosses.forEach((c, k) => row(ROW_CROSSES + k, 0, c.cx, c.cy, c.reveal, c.alpha))
  }

  function uniforms1(st: AboutState) {
    const K = st.K
    const L = K.letters
    const g = K.photos.grade
    const sheet = hexRgb(K.sheet.color)
    const wash = hexRgb(L.wash.color)
    const tint = hexRgb(g.tint)
    const tl = Math.max(1e-3, 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2])
    const cross = hexRgb(K.crosses.color)
    const T = st.ramp
    // the nav dock (core/nav-dock.ts, published by the nav earlier in this frame): photos go dark under it
    const dk = navDock.current
    const dockOn = !!dk && K.photos.dock < 1
    return {
      uView: [size.w, size.h, size.cell, st.cam.scale],
      uSheet: [...sheet, st.cam.dissolve],
      uL1: [L.band, L.chunk, L.chunkAmount, L.cell],
      uL2: [L.cellAmount, L.wobble, L.maxPx, st.crawl],
      uWash: [...wash, L.wash.amount * T],
      uTex: [L.patches.size, L.patches.amount * T, L.patches.cover, L.specks * T],
      uScr: [L.scratches.amount * T, L.scratches.length, T, 0],
      uKeep: [...st.keep, 0],
      uE1: [K.photos.edge.chunk, K.photos.edge.small, K.photos.edge.band, K.photos.edge.missing],
      uE2: [K.photos.edge.debris, K.photos.edge.reach, K.photos.edge.shift, K.photos.halftone],
      uE3: [(2 * size.cell) / st.cam.U, 0, 0, 0],
      uDock: dockOn ? [dk.x, dk.y, dk.x + dk.w, dk.y + dk.h] : [0, 0, 0, 0],
      uDock2: [K.photos.dock, DOCK_PAD, 2 * size.cell, dockOn ? 1 : 0],
      uG1: [g.saturation, g.contrast, g.black, g.white],
      uG2: [tint[0] / tl, tint[1] / tl, tint[2] / tl, g.tintAmount],
      uQ: [2 ** K.raster.bits - 1, K.raster.dither],
      uCross: [...cross, K.crosses.size],
      uCalm: [st.calm],
      // closeness per hole (shaders.ts → closeness): the camera's zoom × the hole's letters
      uGrit: [Math.log(Math.max(1e-3, st.cam.zoom)), Math.log(Math.max(1.01, L.texture.full)), L.patches.home, L.grit * T],
      uFine: [st.texel * 2 ** st.lod, (st.texel * 2 ** st.lod) / K.raster.block],
      uLod: [st.lodRatio, st.lodMix],
    } as Record<string, number[]>
  }

  function same(a: Float32Array | null, b: Float32Array) {
    if (!a || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  function drawClear() {
    if (cleared) return
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
    gl!.viewport(0, 0, canvas.width, canvas.height)
    gl!.clearColor(0, 0, 0, 0)
    gl!.clear(gl!.COLOR_BUFFER_BIT)
    split.set(false)
    cleared = true
    snap1 = snap2 = null
  }

  /** Pass 1: the sheet → the colour + material targets (data already packed). */
  function runPass1(s: GLState, u1: Record<string, number[]>, counts: number[]) {
    const g = gl!
    g.bindTexture(g.TEXTURE_2D, s.data)
    g.texSubImage2D(g.TEXTURE_2D, 0, 0, 0, DATA_WIDTH, DATA_ROWS, g.RGBA, g.FLOAT, data)
    g.bindFramebuffer(g.FRAMEBUFFER, s.fbo)
    g.drawBuffers([g.COLOR_ATTACHMENT0, g.COLOR_ATTACHMENT1])
    g.viewport(0, 0, size.w, size.h)
    g.disable(g.BLEND)
    g.useProgram(s.sheet.p)
    g.bindVertexArray(s.vao)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, s.atlas)
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_2D_ARRAY, s.photos)
    g.activeTexture(g.TEXTURE2)
    g.bindTexture(g.TEXTURE_2D, s.data)
    g.uniform1i(s.sheet.u('uAtlas'), 0)
    g.uniform1i(s.sheet.u('uPhotos'), 1)
    g.uniform1i(s.sheet.u('uData'), 2)
    g.uniform4i(s.sheet.u('uCount'), counts[0], counts[1], counts[2], 0)
    for (const [n, v] of Object.entries(u1)) {
      if (v.length === 4) g.uniform4fv(s.sheet.u(n), v)
      else if (v.length === 2) g.uniform2fv(s.sheet.u(n), v)
      else g.uniform1f(s.sheet.u(n), v[0])
    }
    g.drawArrays(g.TRIANGLES, 0, 3)
    g.bindFramebuffer(g.FRAMEBUFFER, null)
  }

  /** Pass 2: lens + grain → the canvas (with the lens on: the mask into the channel split first). */
  function runPass2(s: GLState, abOn: boolean, a0: number[], a1: number[], grain: number[], seed: number, holeGrain: number) {
    const g = gl!
    g.bindFramebuffer(g.FRAMEBUFFER, null)
    g.viewport(0, 0, size.w, size.h)
    g.useProgram(s.out.p)
    g.bindVertexArray(s.vao)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, s.colTex)
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_2D, s.matTex)
    g.uniform1i(s.out.u('uCol'), 0)
    g.uniform1i(s.out.u('uMat'), 1)
    g.uniform4f(s.out.u('uView'), size.w, size.h, size.cell, abOn ? 1 : 0)
    g.uniform4fv(s.out.u('uAb0'), a0)
    g.uniform4fv(s.out.u('uAb1'), a1)
    g.uniform4fv(s.out.u('uGrain'), grain)
    g.uniform1ui(s.out.u('uSeed'), seed >>> 0)
    g.uniform1f(s.out.u('uHoleGrain'), holeGrain)
    if (abOn) {
      g.uniform1f(s.out.u('uMask'), 1)
      g.drawArrays(g.TRIANGLES, 0, 3)
      split.copy()
    }
    g.uniform1f(s.out.u('uMask'), 0)
    g.drawArrays(g.TRIANGLES, 0, 3)
  }

  /** The photos whose layer (and its mip chain) is on the GPU: the others wait a frame or two. */
  const onGPU = (s: GLState, st: AboutState) => st.photos.filter((p) => s.photoReady[p.k.index] !== undefined)

  /**
   * Awake but before the pull (or the hidden first update): everything a first frame would pay for,
   * done now and off screen — the targets, the atlas, the photo layers as they arrive, and, once per
   * canvas size and context, both programs' first use (pass 1 into its target, pass 2 onto the canvas,
   * which drawClear() then wipes in the same frame: nothing is presented).
   */
  function warm(s: GLState, st: AboutState) {
    syncTargets(s)
    syncTextures(s)
    if (warmed) return
    warmed = true
    const shown = onGPU(s, st)
    pack(st, shown)
    runPass1(s, uniforms1(st), [st.holes.length, shown.length, st.crosses.length])
    runPass2(s, false, [0, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0], 0, 0)
    cleared = false
  }

  const renderer: AboutRenderer = {
    kind: 'gl',

    resize() {
      snap1 = snap2 = null
    },

    draw(frame, st) {
      const s = S
      if (!s || lostNow || gl.isContextLost()) return false
      fit(st, frame.layout)
      if (!st.cam.active) {
        warm(s, st)
        drawClear()
        return false
      }
      cleared = false
      const t0 = performance.now()
      syncTargets(s)
      syncTextures(s)
      const shown = onGPU(s, st)
      pack(st, shown)
      const u1 = uniforms1(st)
      const counts = [st.holes.length, shown.length, st.crosses.length]
      let nu = 0
      for (const v of Object.values(u1)) nu += v.length
      const flat1 = new Float32Array(data.length + nu + 6)
      flat1.set(data)
      let o = data.length
      for (const v of Object.values(u1)) for (const x of v) flat1[o++] = x
      flat1.set([...counts, core.version, s.photoLayers, s.photoSize], o)
      let ran1 = false
      if (!same(snap1, flat1)) {
        if (snap1 && snap1.length === flat1.length) {
          let k = 0
          while (k < flat1.length && snap1[k] === flat1[k]) k++
          lastDiff = [k, snap1[k], flat1[k]]
        }
        snap1 = flat1
        ran1 = true
        pass1Count++
        runPass1(s, u1, counts)
      }

      // ── pass 2: lens + grain → the canvas ──
      const K = st.K
      const ab = aberrationAt(frame.config, frame.layout, frame.pointer.energy)
      const abOn = ab.on && K.aberration > 0 && st.cam.dissolve >= 1
      const gk = grainUniforms({ amount: K.sheet.grain.amount, size: 1, fps: K.sheet.grain.fps, blend: K.sheet.grain.blend }, frame.time, frame.scroll.reduced, 1)
      const a0 = [ab.a0[0], ab.a0[1], ab.a0[2], ab.a0[3] * K.aberration]
      const a1 = [ab.a1[0] * K.aberration, ab.a1[1] * K.aberration, ab.a1[2], ab.a1[3]]
      const flat2 = new Float32Array([pass1Count, gk.seed, ...gk.grain, K.letters.grain, abOn ? 1 : 0, ...a0, ...a1, size.w, size.h])
      if (split.on !== abOn) {
        split.set(abOn)
        snap2 = null
      }
      if (!same(snap2, flat2)) {
        snap2 = flat2
        runPass2(s, abOn, a0, a1, gk.grain, gk.seed, K.letters.grain)
        lastDraws = { pass1: ran1 ? lastDraws.pass1 + 1 : lastDraws.pass1, pass2: lastDraws.pass2 + 1 }
      }
      if (ran1) lastMs = performance.now() - t0
      return true
    },

    stats() {
      // cells the sheet covers at all (pass 1's target): 0 — the frame is exactly the bare void
      let covered: number | null = null
      let opaque: number | null = null
      if (S && !gl.isContextLost() && size.w > 0 && !cleared) {
        const px = new Uint8Array(size.w * size.h * 4)
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.fbo)
        gl.readBuffer(gl.COLOR_ATTACHMENT0)
        gl.readPixels(0, 0, size.w, size.h, gl.RGBA, gl.UNSIGNED_BYTE, px)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        covered = 0
        opaque = 0
        for (let i = 3; i < px.length; i += 4) {
          if (px[i] > 0) covered++
          if (px[i] === 255) opaque++
        }
      }
      return {
        gl: true,
        buffer: [size.w, size.h],
        covered,
        opaque,
        pass1Ms: +lastMs.toFixed(2),
        lastDiff,
        draws: lastDraws,
        split: split.on,
        lost: gl.isContextLost(),
        caps: { holes: MAX_HOLES, photos: MAX_PHOTOS, crosses: MAX_CROSSES },
      }
    },

    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      split.dispose()
      if (S) {
        const s = S
        gl.deleteProgram(s.sheet.p)
        gl.deleteProgram(s.out.p)
        for (const t of [s.colTex, s.matTex, s.atlas, s.photos, s.data]) gl.deleteTexture(t)
        gl.deleteFramebuffer(s.fbo)
        gl.deleteVertexArray(s.vao)
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
  return renderer
}
