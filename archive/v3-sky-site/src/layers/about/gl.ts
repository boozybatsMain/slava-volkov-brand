import * as THREE from 'three'
import { aberrationAt, type Aberration } from '../../core/aberration'
import { cameraLamp, clipMatrix, project3 } from '../../core/about-camera'
import { wordPoses } from '../../core/about-pose'
import { navDock } from '../../core/nav-dock'
import { GLITCH_TAG, GLITCH_VS, glitchFS, hexToVec3, latticeTexture } from '../../core/raster-gl'
import type { Frame, Layout } from '../../core/types'
import { createTitleAberration } from '../title/raster/aberration'
import { POST_TAG } from '../title/raster/shaders'
import { shadowPool, sheenAt, type AboutCore, type AboutState, type WordInst } from './core'
import type { AboutRenderer } from './index'
import { hexRgb, type AboutKnobs, type PhotoKnobs } from './knobs'
import type { PhotoSlot } from './photos'
import { buildWordMesh, cardBox, thinBands, toBufferGeometry, type WordMesh } from './mesh'
import { BLUR_FS, BLUR_VS, CARD_FS, CARD_VS, CONCRETE_FS, CONCRETE_VS, COPY_FS, COPY_VS, SHADE_EMPTY, SHADE_HEAD, SHADOW_FS, SHADOW_TAG, SHADOW_VS } from './shaders'

/**
 * ABOUT — the WebGL renderer: ONE three.js canvas (one WebGL context for all of the about 3D) on the
 * about lattice (core/about-camera.ts → aboutCell: device-snapped cells, canvas = ceil(W / cell) ×
 * ceil(H / cell), `image-rendering: pixelated`, the mount sized to whole cells), antialias off, pixel
 * ratio 1, transparent outside the objects (the veil's void shows through).
 *
 *   words (mesh.ts, black concrete) + cards (mesh.ts → cardBox, the slab's box) ─▶ a nearest target
 *   with depth;  their shadows' footprints ─▶ a mask target ─▶ a gaussian (H, V)
 *   ─▶ the glitch pass (core/raster-gl.ts: inward edge crawl, row slips; the dotted shadows drawn into
 *   the pixels nothing covers — shaders.ts → SHADE_HEAD) ─▶ the page's lens (title/raster/aberration.ts;
 *   about.aberration — 0 now) ─▶ the canvas
 *
 * The camera is core/about-camera.ts → clipMatrix (sheet units → clip; the view is identity), each
 * object's matrixWorld its model (core/about-pose.ts). A frame identical to the last one (camera, turns,
 * reveals, ticks, the dock…) is not redrawn: the canvas keeps showing it.
 *
 * Awake before the pull (sky.ts wakes the layer ABOUT_LEAD early) or on its hidden first update it
 * does the expensive first-time work off screen: every program compiled, every word's buffers and
 * every arrived picture uploaded, the target allocated — one invisible frame (stipple 0) — so the first
 * frame of the pull costs no more than any other.
 *
 * A program that fails to link → the factory throws (index.ts → the 2D fallback); a failing glitch,
 * lens or shadow (footprint / blur) program only switches that pass off. A lost context → hooks.lost
 * (the fallback stands in), a restored one → hooks.restored.
 */

export interface GLHooks {
  lost(): void
  restored(r: AboutRenderer): void
}

/** The WebGL renderer, plus what the factory needs from it. */
export interface GLRenderer extends AboutRenderer {
  /** a picture arrived: upload it now (the frame that first shows it does no work for it) */
  onPhoto(i: number): void
  /** a program that failed to link (not the optional passes): '' — none */
  readonly shaderError: string
}

interface WordEntry {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  shadow: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  src: WordMesh
}

interface CardEntry {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  shadow: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  tex: THREE.Texture | null
  version: number
  geo: string
}

const v3 = () => ({ value: new THREE.Vector3() })

/** An aberration that is off (the lens's canvases are switched off by it). */
const LENS_OFF: Aberration = { on: false, a0: [0, 0, 0, 0], a1: [0, 0, 1, 0], reach: 0 }

export function createGLRenderer(mount: HTMLElement, core: AboutCore, hooks: GLHooks, passes: { glitch: boolean; lens: boolean }): GLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)
  let shaderError = ''
  let glitchOn = passes.glitch
  let shadowsOn = true
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].map((s) => s?.trim()).filter(Boolean).join('\n') || 'link failed'
    const src = gl.getShaderSource(fs) ?? ''
    if (src.includes(GLITCH_TAG)) {
      console.warn('[about] glitch shader failed → the scene goes on without edge crawl and row slips\n' + log)
      glitchOn = false
    } else if (src.includes(SHADOW_TAG)) {
      // the footprint or the blur (BLUR_TAG starts with SHADOW_TAG)
      console.warn('[about] shadow shader failed → the scene goes on without shadows\n' + log)
      shadowsOn = false
    } else if (src.includes(POST_TAG)) {
      console.warn('[about] aberration shader failed → the scene goes on without it\n' + log)
      chroma.disable()
    } else shaderError = `${src.split('\n', 1)[0]}\n${log}`
  }
  const canvas = renderer.domElement
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated', pointerEvents: 'none' })
  canvas.setAttribute('aria-hidden', 'true')
  mount.append(canvas)

  const scene = new THREE.Scene()
  /** the shadows' footprints: drawn alone into the mask target (gl.ts → render) */
  const shadowScene = new THREE.Scene()
  const camera = new THREE.Camera()
  camera.matrixAutoUpdate = false
  camera.matrixWorldAutoUpdate = false

  const blank = new THREE.DataTexture(new Uint8Array([128, 120, 110, 255]), 1, 1)
  blank.colorSpace = THREE.NoColorSpace
  blank.needsUpdate = true

  // ── uniforms shared by every material of a kind (one object, referenced by each material) ──
  const common = {
    uVoid: v3(),
    uLevels: { value: new THREE.Vector2(31, 0.6) },
    /** the nav's labels (each with its dot; core/nav-dock.ts), padded, render px (x0, y0, x1, y1; y up) */
    uDockR: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uDockN: { value: 0 },
  }
  const concreteU = {
    ...common,
    uCam: v3(),
    uFwd: v3(),
    uFpx: { value: 1 },
    uFace0: v3(), uFace1: v3(), uStep0: v3(), uStep1: v3(), uBevel0: v3(), uBevel1: v3(), uWall0: v3(), uWall1: v3(),
    uSeam: v3(),
    uBack: v3(),
    uKey: v3(),
    uBands: { value: 3 },
    uLamp: v3(),
    uGlint: { value: new THREE.Vector4() },
    uGlintColor: v3(),
    uTex: { value: new THREE.Vector4(2, 0.02, 0.1, 0) },
    uAgg: v3(),
    uStone: v3(),
    uHaze: { value: new THREE.Vector4(0, 0, -1, 1) },
    uGrain: { value: new THREE.Vector2() },
    uDockK: v3(),
    uDockInk: v3(),
  }
  const cardU = {
    ...common,
    uBlank: v3(),
    uSide: v3(),
    uEdge: v3(),
    uSeam: { value: new THREE.Vector4() },
    uSheenSteps: { value: 3 },
    uSheenColor: v3(),
    uAffine: { value: 0 },
    uLeak: { value: 0 },
    uDock2: v3(),
    uHaze: { value: new THREE.Vector4(0, 0, -1, 1) },
    uGrain: { value: new THREE.Vector2() },
  }
  const shadowU = { uFade: { value: 1 } }

  // closed solids wound for the display (mesh.ts): back faces never show
  const material = (vs: string, fs: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: vs,
      fragmentShader: fs,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
      transparent: false,
      blending: THREE.NoBlending,
    })

  /** A caster's footprint in the shadow mask: flattened (either way round), no depth, the MAX of all. */
  const shadowMesh = (geo: THREE.BufferGeometry) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...shadowU,
        uLight: v3(),
        uPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
        uGrow: { value: new THREE.Vector2(1, 1) },
        uPresence: { value: 0 },
        uCard: { value: new THREE.Vector2() },
      },
      vertexShader: SHADOW_VS,
      fragmentShader: SHADOW_FS,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })
    return prep(new THREE.Mesh(geo, mat), shadowScene)
  }

  function prep<T extends THREE.Object3D>(o: T, into: THREE.Scene = scene) {
    o.matrixAutoUpdate = false
    o.matrixWorldAutoUpdate = false
    o.frustumCulled = false
    o.visible = false
    into.add(o)
    return o
  }

  // ── words: one mesh (+ its shadow) per word, geometry from mesh.ts (cached there per look) ──
  const words = new Map<string, WordEntry>()
  const geometries = new Map<WordMesh, THREE.BufferGeometry>()
  const geometryOf = (m: WordMesh) => {
    let g = geometries.get(m)
    if (!g) {
      g = toBufferGeometry(m)
      geometries.set(m, g)
    }
    return g
  }
  const wordEntry = (w: WordInst['pose']): WordEntry => {
    const src = buildWordMesh(w.look, w.profile)
    let e = words.get(w.key)
    if (e && e.src === src) return e
    const geo = geometryOf(src)
    if (!e) {
      const mesh = prep(new THREE.Mesh(geo, material(CONCRETE_VS, CONCRETE_FS, { ...concreteU, uScale: { value: 1 }, uStipple: { value: 0 }, uHazeZ: { value: 0 }, uBand: { value: new THREE.Vector4() }, uBandOn: { value: new THREE.Vector2() } })))
      e = { mesh, shadow: shadowMesh(geo), src }
      words.set(w.key, e)
    } else {
      e.mesh.geometry = geo
      e.shadow.geometry = geo
      e.src = src
    }
    return e
  }

  // ── cards: one box (+ shadow) per card; the face cut into cells (the affine swim is per polygon) ──
  const cards: CardEntry[] = []
  const boxes = new Map<string, { g: THREE.BufferGeometry; front: THREE.BufferGeometry }>()
  /** the card box, and its front face alone (the same buffers: what casts the shadow) */
  const boxOf = (nx: number, ny: number) => {
    const key = `${nx}x${ny}`
    let b = boxes.get(key)
    if (!b) {
      const a = cardBox(nx, ny)
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(a.position, 3))
      g.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2))
      g.setAttribute('aFace', new THREE.BufferAttribute(a.face, 1))
      g.setIndex(new THREE.BufferAttribute(a.index, 1))
      const front = new THREE.BufferGeometry()
      front.setAttribute('position', g.getAttribute('position'))
      front.setAttribute('uv', g.getAttribute('uv'))
      front.setIndex(g.getIndex())
      front.setDrawRange(0, nx * ny * 6)
      b = { g, front }
      boxes.set(key, b)
    }
    return { g: b.g, front: b.front, key }
  }
  const cardUniforms = () => ({
    ...cardU,
    uPic: { value: blank as THREE.Texture },
    uTexSize: { value: new THREE.Vector3(1, 1, 0) },
    uLod: { value: 0 },
    uStipple: { value: 0 },
    uHas: { value: 0 },
    uSheen: { value: new THREE.Vector4(0, 0, 1, 0) },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uGrade: { value: new THREE.Vector4(1, 1, 0, 1) },
    uHalftone: { value: new THREE.Vector4() },
    uCells: { value: new THREE.Vector2(1, 1) },
  })
  /** a card that is never shown: the card program is compiled before the pull even if no picture has come yet */
  const probe = prep(new THREE.Mesh(boxOf(1, 1).g, material(CARD_VS, CARD_FS, cardUniforms())))
  const cardEntry = (k: PhotoKnobs, slot: PhotoSlot, K: AboutKnobs): CardEntry => {
    const nx = K.raster.affineCells
    const ny = Math.max(1, Math.round(nx / Math.max(0.1, k.aspect)))
    const { g, front, key } = boxOf(nx, ny)
    let e = cards[k.index]
    if (!e) {
      const mesh = prep(new THREE.Mesh(g, material(CARD_VS, CARD_FS, cardUniforms())))
      e = cards[k.index] = { mesh, shadow: shadowMesh(front), tex: null, version: -1, geo: key }
    } else if (e.geo !== key) {
      e.mesh.geometry = g
      e.shadow.geometry = front
      e.geo = key
    }
    // the picture: a texture per arrival (uploaded on decode, not in the first frame it shows)
    if (e.version !== slot.version) {
      e.tex?.dispose()
      e.tex = latticeTexture(slot.canvas)
      e.version = slot.version
    }
    return e
  }
  /** a picture is uploaded (with its mips) as soon as it is decoded, off the frame that shows it */
  const upload = (i: number) => {
    const slot = core.photos.get(i)
    const k = core.K.photos.items[i]
    if (!slot || !k || renderer.getContext().isContextLost()) return
    const fresh = !cards[i]
    const e = cardEntry(k, slot, core.K)
    if (e.tex) renderer.initTexture(e.tex)
    if (fresh) prime([e.mesh, e.shadow])
  }

  /**
   * A mesh's first draw sets up its material (three: parameters, program lookup, uniform lists) —
   * milliseconds per material. Done here, off the frame, for meshes made after the warm-up (a card
   * whose picture arrived later): one invisible draw (stipple 0) into a scratch target. The next
   * frame's setup() decides what is shown again.
   */
  let scratch: THREE.WebGLRenderTarget | null = null
  function prime(meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]) {
    if (renderer.getContext().isContextLost()) return
    if (!scratch) {
      scratch = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true, stencilBuffer: false })
      scratch.texture.colorSpace = THREE.NoColorSpace
    }
    scene.traverse((o) => (o.visible = o === scene))
    shadowScene.traverse((o) => (o.visible = o === shadowScene))
    for (const m of meshes) {
      m.visible = true
      const u = m.material.uniforms
      if (u.uStipple) u.uStipple.value = 0
      if (u.uPresence) u.uPresence.value = 0
    }
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(scratch)
    renderer.render(scene, camera)
    renderer.render(shadowScene, camera)
    renderer.setRenderTarget(prev)
    for (const m of meshes) m.visible = false
    snap = []
  }

  // ── the passes over the frame: glitch (or a plain copy) → the lens ──
  const screenQuad = new THREE.PlaneGeometry(2, 2)
  const glitchU = {
    uSrc: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTick: { value: 0 },
    uE: { value: new THREE.Vector2() },
    uCrawl: { value: 0 },
    uRow: { value: new THREE.Vector3(0, 0, 14) },
    uTear: { value: new THREE.Vector3() },
    uSpan: { value: new THREE.Vector2() },
  }
  const pass = (vs: string, fs: string, uniforms: Record<string, THREE.IUniform>) => {
    const m = new THREE.Mesh(screenQuad, new THREE.ShaderMaterial({ uniforms, vertexShader: vs, fragmentShader: fs, depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending }))
    m.frustumCulled = false
    const s = new THREE.Scene()
    s.add(m)
    return { scene: s, material: m.material }
  }
  // the dots of the shadows, drawn by the glitch pass (or the copy) into the pixels nothing covers
  const shadeU = {
    uShadow: { value: null as THREE.Texture | null },
    uShade: { value: new THREE.Vector4() },
    uShadowColor: v3(),
  }
  const glitch = pass(GLITCH_VS, glitchFS(SHADE_HEAD, SHADE_EMPTY), { ...glitchU, ...shadeU })
  const copyU = { uSrc: { value: null as THREE.Texture | null }, uRes: glitchU.uRes, ...shadeU }
  const copy = pass(COPY_VS, COPY_FS, copyU)
  // the shadow mask's gaussian, one direction per pass
  const blurU = {
    uSrc: { value: null as THREE.Texture | null },
    uRes: glitchU.uRes,
    uDir: { value: new THREE.Vector2(1, 0) },
    uSigma: { value: 1 },
  }
  const blur = pass(BLUR_VS, BLUR_FS, blurU)
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const chroma = createTitleAberration(renderer, mount)
  if (!passes.lens) chroma.disable()

  const lattice = (depth: boolean) => {
    const t = new THREE.WebGLRenderTarget(Math.max(1, size.w), Math.max(1, size.h), {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: depth,
      stencilBuffer: false,
    })
    t.texture.colorSpace = THREE.NoColorSpace
    return t
  }
  let target: THREE.WebGLRenderTarget | null = null
  const ensureTarget = () => (target ??= lattice(true))
  /** the shadow mask (footprints, then the V blur) and the H blur's half-way target */
  let maskA: THREE.WebGLRenderTarget | null = null
  let maskB: THREE.WebGLRenderTarget | null = null
  /** the shadows of this frame: drawn at all (any caster and density) — set by setup() */
  let shading = false

  const size = { w: 0, h: 0, cell: 1 }
  let lostNow = false
  let warmed = false
  let cleared = true
  /** the last frame's inputs: an identical frame is not redrawn */
  let snap: number[] = []
  let lastMs = 0
  let draws = 0
  let skipped = 0

  const onLost = () => {
    lostNow = true
    target?.dispose()
    target = null
    maskA?.dispose()
    maskB?.dispose()
    maskA = maskB = null
    scratch?.dispose()
    scratch = null
    canvas.style.display = 'none'
    hooks.lost()
  }
  const onRestored = () => {
    lostNow = false
    warmed = false
    snap = []
    canvas.style.display = 'block'
    hooks.restored(self)
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  /** The canvas: the whole stage on the about lattice, rounded UP (the stage clips the overhang). */
  function fit(cell: number, layout: Layout) {
    const w = Math.max(1, Math.ceil(layout.width / cell - 1e-4))
    const h = Math.max(1, Math.ceil(layout.height / cell - 1e-4))
    if (w === size.w && h === size.h && cell === size.cell) return
    mount.style.width = `${w * cell}px`
    mount.style.height = `${h * cell}px`
    size.cell = cell
    snap = []
    warmed = false
    if (w === size.w && h === size.h) return
    size.w = w
    size.h = h
    renderer.setSize(w, h, false)
    chroma.setSize(w, h)
    target?.setSize(w, h)
    maskA?.setSize(w, h)
    maskB?.setSize(w, h)
  }

  /** This frame's uniforms (shared and per object); the object meshes shown. */
  function setup(frame: Frame, st: AboutState) {
    const K = st.K
    const C = K.concrete
    const view = st.view
    const cell = size.cell
    const vw = size.w * cell
    const vh = size.h * cell
    camera.projectionMatrix.fromArray(clipMatrix(view, vw, vh, view.near, st.far))
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()

    hexToVec3((frame.config as unknown as { veil?: { color?: string } }).veil?.color ?? '#e6ddd0', common.uVoid.value)
    common.uLevels.value.set(2 ** K.raster.bits - 1, K.raster.dither)

    // ── concrete ──
    concreteU.uCam.value.set(...view.eye)
    concreteU.uFwd.value.set(...view.fwd)
    concreteU.uFpx.value = view.fpx / cell
    const pair = (p: { dark: string; lit: string }, a: { value: THREE.Vector3 }, b: { value: THREE.Vector3 }) => {
      hexToVec3(p.dark, a.value)
      hexToVec3(p.lit, b.value)
    }
    pair(C.face, concreteU.uFace0, concreteU.uFace1)
    pair(C.step, concreteU.uStep0, concreteU.uStep1)
    pair(C.bevel, concreteU.uBevel0, concreteU.uBevel1)
    pair(C.wall, concreteU.uWall0, concreteU.uWall1)
    hexToVec3(C.seam, concreteU.uSeam.value)
    hexToVec3(C.back, concreteU.uBack.value)
    concreteU.uKey.value.set(...C.light)
    concreteU.uBands.value = C.bands
    concreteU.uLamp.value.set(...cameraLamp(view, C.glint.lamp))
    concreteU.uGlint.value.set(C.glint.amount, Math.cos((C.glint.size * Math.PI) / 180), C.glint.steps, 0)
    hexToVec3(C.glint.color, concreteU.uGlintColor.value)
    concreteU.uTex.value.set(K.raster.texel, C.mottle.size, C.mottle.amount, 0)
    concreteU.uAgg.value.set(C.aggregate.size, C.aggregate.density, C.aggregate.amount)
    hexToVec3(C.aggregate.color, concreteU.uStone.value)
    concreteU.uHaze.value.set(C.haze.amount, C.haze.near, C.haze.far, C.haze.steps)
    concreteU.uGrain.value.set(C.grain, st.grainTick)
    hexToVec3(C.dock.ink, concreteU.uDockInk.value)

    // ── cards ──
    const D = K.cards
    hexToVec3(D.blank, cardU.uBlank.value)
    hexToVec3(D.side, cardU.uSide.value)
    hexToVec3(D.edge, cardU.uEdge.value)
    const seam = hexRgb(D.seam.color)
    cardU.uSeam.value.set(seam[0], seam[1], seam[2], D.seam.width)
    cardU.uSheenSteps.value = D.sheen.steps
    hexToVec3(D.sheen.color, cardU.uSheenColor.value)
    const G = K.photos.grade
    cardU.uAffine.value = Math.min(1, K.raster.affine * st.eMove)
    cardU.uLeak.value = D.leak
    cardU.uHaze.value.set(D.haze.amount, D.haze.near, D.haze.far, D.haze.steps)
    cardU.uGrain.value.set(D.grain, st.grainTick)
    // the nav's labels (published by the nav earlier in this frame; each with its dot, + cards.dock.pad),
    // render px with y up: a soft halo behind each — the cards washed toward the void, the concrete kept
    // from being lighter than the labels' ink; the shadow dots stay as they are
    const dk = navDock.current
    const S = K.shadow
    let nDock = 0
    if (dk) {
      const p = D.dock.pad
      for (const l of dk.labels) {
        if (nDock >= common.uDockR.value.length) break
        common.uDockR.value[nDock++].set((l.x - p) / cell, size.h - (l.y + l.h + p) / cell, (l.x + l.w + p) / cell, size.h - (l.y - p) / cell)
      }
    }
    common.uDockN.value = nDock
    cardU.uDock2.value.set(D.dock.wash, Math.max(1, C.dock.edge), nDock > 0 && D.dock.wash > 0 ? 1 : 0)
    concreteU.uDockK.value.set(C.dock.amount, Math.max(1, C.dock.edge), nDock > 0 && C.dock.amount > 0 ? 1 : 0)
    const tint = hexRgb(G.tint)
    const tl = Math.max(1e-3, 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2])
    const tintMul = tint.map((c) => 1 + (c / tl - 1) * G.tintAmount) as [number, number, number]

    // ── shadows: the footprints' uniforms (per caster below), the dots' (the glitch pass / the copy) ──
    shadowU.uFade.value = S.fade
    const dots = shadowsOn ? S.opacity * st.shadow : 0
    shading = false

    for (const e of words.values()) e.mesh.visible = e.shadow.visible = false
    for (const e of cards) if (e) e.mesh.visible = e.shadow.visible = false

    for (const w of st.words) {
      const e = wordEntry(w.pose)
      e.mesh.matrixWorld.fromArray(w.M)
      e.shadow.matrixWorld.copy(e.mesh.matrixWorld)
      const u = e.mesh.material.uniforms
      u.uScale.value = w.pose.width
      u.uStipple.value = w.reveal
      u.uHazeZ.value = w.pose.z
      // the thin bands as depth fractions (mesh.ts → thinBands): lines of at least a pixel, or their
      // neighbours — for the whole word (core.ts → WordInst.bands)
      const tb = thinBands(w.pose.profile)
      u.uBand.value.set(tb.step, tb.seam, tb.stepMid, tb.seamMid)
      u.uBandOn.value.set(w.bands ? 1 : 0, w.bands ? 1 : 0)
      e.mesh.visible = true
      if (dots > 0 && w.shade > 0) {
        const su = e.shadow.material.uniforms
        su.uPlane.value.set(...w.plane)
        su.uLight.value.set(...w.light)
        su.uGrow.value.set(1, 1)
        su.uPresence.value = w.shade
        su.uCard.value.set(2, 0)
        e.shadow.visible = shading = true
      }
    }
    for (const c of st.cards) {
      const e = cardEntry(c.k, c.slot, K)
      e.mesh.matrixWorld.fromArray(c.M)
      e.shadow.matrixWorld.copy(e.mesh.matrixWorld)
      const u = e.mesh.material.uniforms
      const tex = e.tex
      const img = c.slot.canvas
      u.uPic.value = tex ?? blank
      u.uHas.value = tex ? 1 : 0
      u.uTexSize.value.set(img.width, img.height, Math.floor(Math.log2(Math.max(1, Math.max(img.width, img.height)))))
      u.uLod.value = c.lod
      u.uStipple.value = c.reveal
      u.uTint.value.set(...tintMul)
      // the halftone stretches the picture's own luma range
      u.uHalftone.value.set(c.k.halftone ? 1 : 0, K.photos.halftone, c.slot.lo, c.slot.hi)
      // its own saturation (−1 — the grade's)
      u.uGrade.value.set(c.k.saturation >= 0 ? c.k.saturation : G.saturation, G.contrast, G.black, G.white)
      // the sheen rests at sheen.at and slides as the card crosses the screen (a light that stays put)
      // and as it turns toward the pointer (core.ts → sheenAt)
      const p = project3(view, c.pose.x, c.pose.y, c.pose.z)
      const sh = D.sheen
      const centre = sheenAt(K, c, p ? p[0] : null, frame.layout.width)
      u.uSheen.value.set(sh.amount, centre, Math.max(0.01, sh.width / 2), sh.slant)
      // side blocks of a fixed size on the lattice (3 × 10 render px), like the slab's
      const k = p ? p[2] / cell : 1
      u.uCells.value.set(Math.max(1, Math.round((c.pose.thickness * k) / 3)), Math.max(1, Math.round((c.pose.height * k) / 10)))
      e.mesh.visible = true
      if (dots > 0 && c.shade > 0) {
        const su = e.shadow.material.uniforms
        su.uPlane.value.set(...c.plane)
        su.uLight.value.set(...c.light)
        su.uPresence.value = c.shade
        // the pool: the face grown by the penumbra (shadow.soft × the card's height above its plane) on
        // every side; a superellipse that rounds off toward an ellipse as the penumbra reaches the
        // middle of the face (core.ts → shadowPool, shadowReach)
        // (its height: the picture's centre where the pointer turn has put it — the model's translation)
        const pool = shadowPool(S, c.M[14] - c.plane[3], c.pose.width, c.pose.height)
        su.uGrow.value.set(pool.gx, pool.gy)
        su.uCard.value.set(pool.n, 1)
        e.shadow.visible = shading = true
      }
    }
    // the dots: density, steps, edge — and the gaussian's width, sheet units → render px on the sheet plane
    shadeU.uShade.value.set(dots, S.steps, S.edge, shading ? 1 : 0)
    hexToVec3(S.color, shadeU.uShadowColor.value)
    blurU.uSigma.value = Math.min(8, (S.blur * view.fpx) / Math.max(1e-6, view.h) / cell)

    // ── the glitch pass ──
    const R = K.raster
    glitchU.uRes.value.set(size.w, size.h)
    glitchU.uTick.value = st.tick
    glitchU.uE.value.set(st.e, st.eMove)
    glitchU.uCrawl.value = R.crawl
    glitchU.uRow.value.set(R.rowGlitch, R.rowShift, R.rowRun)
    glitchU.uTear.value.set(0, 0, 0)
    let y0 = Infinity
    let y1 = -Infinity
    for (const o of [...st.words, ...st.cards]) {
      y0 = Math.min(y0, o.box[1])
      y1 = Math.max(y1, o.box[3])
    }
    if (y1 >= y0) glitchU.uSpan.value.set(Math.max(0, size.h - y1 / cell), Math.min(size.h, size.h - y0 / cell))
    else glitchU.uSpan.value.set(0, size.h)
  }

  /** Everything that decides the picture, as numbers: unchanged → the frame is not redrawn. */
  function snapshot(frame: Frame, st: AboutState) {
    const v = st.view
    const out: number[] = [size.w, size.h, size.cell, ...v.eye, ...v.fwd, ...v.right, v.h, v.fpx, st.far, st.shadow, st.tick * (st.e > 0 ? 1 : 0), st.grainTick, st.e, st.eMove, core.version]
    for (const w of st.words) out.push(...w.M, w.reveal, ...w.plane, ...w.light, w.bands ? 1 : 0)
    for (const c of st.cards) out.push(c.k.index, ...c.M, c.reveal, c.lod, c.slot.version, ...c.light)
    for (const w of st.words) out.push(w.shade)
    for (const c of st.cards) out.push(c.shade)
    const dk = navDock.current
    if (dk) out.push(dk.x, dk.y, dk.w, dk.h)
    out.push(frame.layout.width, shading ? 1 : 0)
    return out
  }

  function render(frame: Frame) {
    const t = ensureTarget()
    renderer.setRenderTarget(t)
    renderer.clear()
    renderer.render(scene, camera)
    // ── the shadows: footprints → mask A, gaussian H → mask B, V → mask A (read by the dots) ──
    if (shading) {
      const a = (maskA ??= lattice(false))
      const b = (maskB ??= lattice(false))
      renderer.setRenderTarget(a)
      renderer.clear()
      renderer.render(shadowScene, camera)
      blurU.uSrc.value = a.texture
      blurU.uDir.value.set(1, 0)
      renderer.setRenderTarget(b)
      renderer.render(blur.scene, ortho)
      blurU.uSrc.value = b.texture
      blurU.uDir.value.set(0, 1)
      renderer.setRenderTarget(a)
      renderer.render(blur.scene, ortho)
      shadeU.uShadow.value = a.texture
    } else shadeU.uShadow.value = blank
    renderer.setRenderTarget(null)
    // ── out, through the page's lens (off on ABOUT now: about.aberration 0) ──
    const ab = aberrationAt(frame.config, frame.layout, frame.pointer.energy)
    const k = core.K.aberration
    const lens: Aberration = { ...ab, on: ab.on && k > 0, a0: [ab.a0[0], ab.a0[1], ab.a0[2], ab.a0[3] * k], a1: [ab.a1[0] * k, ab.a1[1] * k, ab.a1[2], ab.a1[3]] }
    const p = glitchOn ? glitch : copy
    if (glitchOn) glitchU.uSrc.value = t.texture
    else copyU.uSrc.value = t.texture
    const view = { width: size.w * size.cell, height: size.h * size.cell }
    if (!(lens.on && chroma.render(p.scene, ortho, lens, view))) renderer.render(p.scene, ortho)
  }

  function clearCanvas() {
    if (cleared) return
    renderer.setRenderTarget(null)
    renderer.clear()
    // the lens's per-channel canvases off too (an aberration that is off only switches them off)
    chroma.render(glitch.scene, ortho, LENS_OFF, { width: size.w * size.cell, height: size.h * size.cell })
    cleared = true
    snap = []
  }

  /**
   * Before the pull: every program compiled and every buffer and arrived picture uploaded, in one
   * invisible frame (every mesh shown at stipple 0) — then the canvas is cleared, nothing presented.
   */
  function warm(frame: Frame, st: AboutState) {
    if (warmed) return
    warmed = true
    const K = st.K
    // every word and every arrived card, at the origin, nothing drawn
    for (const pose of wordPoses(frame.config)) {
      const e = wordEntry(pose)
      e.mesh.visible = e.shadow.visible = true
      e.mesh.material.uniforms.uStipple.value = 0
      e.shadow.material.uniforms.uPresence.value = 0
    }
    for (const k of K.photos.items) {
      const slot = core.photos.get(k.index)
      if (!slot) continue
      upload(k.index)
    }
    for (const e of cards) {
      if (!e) continue
      e.mesh.visible = e.shadow.visible = true
      e.mesh.material.uniforms.uStipple.value = 0
      e.shadow.material.uniforms.uPresence.value = 0
    }
    probe.visible = true
    camera.projectionMatrix.fromArray(clipMatrix(st.view, size.w * size.cell, size.h * size.cell, st.view.near, st.far))
    renderer.compile(scene, camera)
    renderer.compile(shadowScene, camera)
    // the shadow passes too (mask targets, the gaussian, the dots), with nothing in them
    shading = shadowsOn
    shadeU.uShade.value.set(0, 1, 0.5, 0)
    render(frame)
    shading = false
    for (const e of words.values()) e.mesh.visible = e.shadow.visible = false
    for (const e of cards) if (e) e.mesh.visible = e.shadow.visible = false
    probe.visible = false
    cleared = false
    clearCanvas()
  }

  const self: GLRenderer = {
    kind: 'gl',

    get shaderError() {
      return shaderError
    },

    onPhoto: upload,

    resize() {
      snap = []
    },

    draw(frame, st) {
      if (lostNow || renderer.getContext().isContextLost()) return false
      fit(st.cam.cell, frame.layout)
      if (!st.cam.active) {
        warm(frame, st)
        clearCanvas()
        return false
      }
      if (!warmed) warm(frame, st)
      const t0 = performance.now()
      setup(frame, st)
      const now = snapshot(frame, st)
      if (!cleared && now.length === snap.length && now.every((x, i) => x === snap[i])) {
        skipped++
        return true
      }
      snap = now
      cleared = false
      render(frame)
      draws++
      lastMs = performance.now() - t0
      return true
    },

    stats() {
      // cells covered at all (objects and dots) in the last frame drawn: 0 — the frame is the bare void
      let covered: number | null = cleared ? 0 : null
      if (target && !cleared && !lostNow && size.w > 0) {
        const px = new Uint8Array(size.w * size.h * 4)
        renderer.readRenderTargetPixels(target, 0, 0, size.w, size.h, px)
        // the shadows: where the blurred footprint is over the dots' edge (an upper bound of the dots)
        const sh = shading && maskA ? new Uint8Array(size.w * size.h * 4) : null
        if (sh && maskA) renderer.readRenderTargetPixels(maskA, 0, 0, size.w, size.h, sh)
        const edge = Math.floor(core.K.shadow.edge * 255)
        covered = 0
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0 || (sh && sh[i - 3] > edge)) covered++
      }
      return {
        gl: true,
        buffer: [size.w, size.h],
        cell: size.cell,
        covered,
        cleared,
        draws,
        skipped,
        ms: +lastMs.toFixed(2),
        glitch: glitchOn,
        shadows: shadowsOn && shading,
        lost: renderer.getContext().isContextLost(),
        programs: renderer.info.programs?.length,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      }
    },

    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      chroma.dispose()
      target?.dispose()
      maskA?.dispose()
      maskB?.dispose()
      scratch?.dispose()
      for (const e of words.values()) {
        e.mesh.material.dispose()
        e.shadow.material.dispose()
      }
      for (const g of geometries.values()) g.dispose()
      for (const e of cards) {
        if (!e) continue
        e.tex?.dispose()
        e.mesh.material.dispose()
        e.shadow.material.dispose()
      }
      probe.material.dispose()
      for (const b of boxes.values()) {
        b.g.dispose()
        b.front.dispose()
      }
      glitch.material.dispose()
      copy.material.dispose()
      blur.material.dispose()
      screenQuad.dispose()
      blank.dispose()
      renderer.dispose()
      // a context that is already lost has no WEBGL_lose_context (three would warn in the console)
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss()
      canvas.remove()
      mount.style.width = mount.style.height = ''
    },
  }

  return self
}
