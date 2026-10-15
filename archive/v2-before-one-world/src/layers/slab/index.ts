import * as THREE from 'three'
import { aberrationAt, type Aberration } from '../../core/aberration'
import { clamp01, remap, smooth } from '../../core/ease'
import { projects } from '../../core/projects'
import { slabPose } from '../../core/slab-pose'
import type { Frame, Layer, LayerContext, LayerFactory, ResolvedConfig } from '../../core/types'
import { createTitleAberration } from '../title/raster/aberration'
import { POST_TAG } from '../title/raster/shaders'
import { createSlabFallback } from './fallback'
import { coverCrop, createSlabPictures } from './pictures'
import { createSlabShadow, shadowBlob } from './shadow'
import { GLITCH_FS, GLITCH_TAG, GLITCH_VS, SLAB_FS, SLAB_VS } from './shaders'
import { createArrival, FaceMode, switchLook, type ArrivalLook, type SwitchLook } from './show'
import { createSlabSolver, publishPose, slabKnobs, slabPixelSize, type SlabKnobs, type SlabSolution } from './solve'

/**
 * SLAB — the project screen hanging in the white void (version 2, second screen).
 *
 * A thick box posed like the reference (config.projects.slab), drawn by the title's «bad render»
 * recipe: its own small three.js canvas at a low internal resolution (the slab is never more than
 * raster.renderWidth render pixels across), magnified by CSS with `image-rendering: pixelated`.
 * Coverage is binary, textures are point-sampled small copies of the project pictures, colour goes
 * through a low-depth dithered framebuffer; in motion the texture swims (affine), the outline
 * crawls and rows slip. Nothing is anti-aliased or smoothed — do not "improve" it.
 *
 *   box ─▶ target ─▶ glitch pass ─▶ the title's aberration pass ─▶ canvas
 *
 * Under it lies the shadow: dots on the same lattice, on a 2D canvas of its own (shadow.ts); it
 * keeps below the texts that lie on the slab's plane (core/slab-pose.ts → slabTexts).
 *
 * The pose is solved on the CPU (solve.ts) and published as core/slab-pose.ts → slabPose every
 * frame and in resize(), so the project texts lie on the face. The slab turns toward the cursor
 * with its own heavy mass, floats, and is pushed by every project switch.
 *
 * Arrival (and its reverse on the way on to ABOUT: the slab unloads and stipples out, then sleeps —
 * sky.ts → isLive) and the switch show («z-fight», the small «scan» alternative, «cut») — show.ts;
 * what the shaders do with their numbers — shaders.ts. Art direction: sky.config.ts → projects.slab
 * / arrive / leave / raster / shadow / switch.
 *
 * No WebGL (or `?nogl=slab`, or the box shader fails to link) → ./fallback: the same pose, the
 * picture as a flat pixelated quad, cut switching. A failing glitch or aberration program only
 * switches that pass off.
 */

const _color = new THREE.Color()
/** '#rrggbb' → raw sRGB 0…1: the whole layer works in display space, like an old renderer. */
function hexToVec3(hex: string, out: THREE.Vector3) {
  _color.setStyle(hex, THREE.NoColorSpace)
  return out.set(_color.r, _color.g, _color.b)
}

/**
 * The unit box of solve.ts. The front face is cut into cells: the affine "swim" is per polygon, as on
 * the consoles it comes from — on one big quad it would be a single fold along the diagonal.
 */
function buildBox(cellsX: number, cellsY: number) {
  const pos: number[] = []
  const uv: number[] = []
  const face: number[] = []
  const index: number[] = []
  const quad = (id: number, nx: number, ny: number, at: (s: number, t: number) => [number, number, number]) => {
    const base = pos.length / 3
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        pos.push(...at(i / nx, j / ny))
        uv.push(i / nx, j / ny)
        face.push(id)
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i
        const c = a + nx + 1
        index.push(a, c, a + 1, a + 1, c, c + 1)
      }
    }
  }
  quad(0, cellsX, cellsY, (s, t) => [s - 0.5, t - 0.5, 0]) // front: the picture
  quad(1, 1, 1, (s, t) => [-0.5, t - 0.5, -s]) // left (s runs front → back)
  quad(2, 1, 1, (s, t) => [0.5, t - 0.5, -s]) // right
  quad(3, 1, 1, (s, t) => [s - 0.5, -0.5, -t]) // top
  quad(4, 1, 1, (s, t) => [s - 0.5, 0.5, -t]) // bottom
  quad(5, 1, 1, (s, t) => [s - 0.5, t - 0.5, -1]) // back
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 1))
  g.setIndex(index)
  return g
}

/**
 * Entry point. No WebGL (no context, `?nogl=slab`, or the box shader fails to link) → the same pose
 * with the picture as a flat pixelated quad (./fallback): the screen never just disappears.
 */
export const createSlabLayer: LayerFactory = async (mount, ctx) => {
  projects.init(ctx.config)
  // dev: ?nogl=slab — the fallback; ?nogl=slab-glitch / slab-lens — as if that pass had failed to compile
  const off = new URLSearchParams(location.search).get('nogl')?.split(',') ?? []
  if (!off.includes('slab')) {
    try {
      return createGLSlab(mount, ctx, { glitch: !off.includes('slab-glitch'), lens: !off.includes('slab-lens') })
    } catch (err) {
      console.warn('[slab] WebGL slab unavailable → flat fallback', err)
    }
  }
  return createSlabFallback(mount, ctx)
}

function createGLSlab(mount: HTMLElement, ctx: LayerContext, passes: { glitch: boolean; lens: boolean }): Layer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)
  // the box program failing to link would leave no slab → createSlabLayer falls back;
  // a failing glitch pass or aberration pass only switches itself off
  let shaderError = ''
  let glitchOn = passes.glitch
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join('\n') || 'link failed'
    const src = gl.getShaderSource(fs) ?? ''
    if (src.includes(GLITCH_TAG)) {
      console.warn('[slab] glitch shader failed → the slab goes on without edge crawl and torn rows\n' + log)
      glitchOn = false
    } else if (src.includes(POST_TAG)) {
      console.warn('[slab] aberration shader failed → the slab goes on without it\n' + log)
      chroma.disable()
    } else shaderError = log
  }
  const canvas = renderer.domElement
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    imageRendering: 'pixelated',
    pointerEvents: 'none',
  })
  canvas.setAttribute('aria-hidden', 'true')
  // the shadow on the floor, under the slab (and under the aberration's mask, which goes right before the canvas)
  const shadow = createSlabShadow()
  mount.append(shadow.canvas, canvas)

  // ── scene: the box; the camera and the box take their matrices from solve.ts ──
  const scene = new THREE.Scene()
  const camera = new THREE.Camera()
  camera.matrixAutoUpdate = false
  camera.matrixWorldAutoUpdate = false

  const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)
  blank.colorSpace = THREE.NoColorSpace
  blank.needsUpdate = true

  const U = {
    uPicA: { value: blank as THREE.Texture },
    uPicB: { value: blank as THREE.Texture },
    uCropA: { value: new THREE.Vector4(0, 0, 1, 1) },
    uCropB: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHas: { value: new THREE.Vector2() },
    uLod: { value: new THREE.Vector2() },
    uZ: { value: new THREE.Vector2(0, 1) },
    uStipple: { value: 0 },
    uTextured: { value: 0 },
    uBlank: { value: new THREE.Vector3() },
    uSide: { value: new THREE.Vector3() },
    uBottom: { value: new THREE.Vector3() },
    uSeam: { value: new THREE.Vector4() },
    uVeil: { value: new THREE.Vector3(1, 1, 1) },
    uHaze: { value: new THREE.Vector2(0, 1) },
    uSheen: { value: new THREE.Vector4(0, 0, 1, 0) },
    uSheenSteps: { value: 3 },
    uLevels: { value: new THREE.Vector2(31, 31) },
    uDither: { value: 0 },
    uAffine: { value: 0 },
    uLeak: { value: new THREE.Vector2() },
    uCells: { value: new THREE.Vector2(1, 1) },
    uMode: { value: 0 },
    uDir: { value: 1 },
    uSweep: { value: 0 },
    uZone: { value: 0.35 },
    uZBits: { value: 14 },
    uTeeth: { value: 0 },
    uRows: { value: 3 },
    uTick: { value: 0 },
    uScan: { value: new THREE.Vector4(0, 0, 16, 4) },
    uCursor: { value: 1 },
  }
  const material = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: SLAB_VS,
    fragmentShader: SLAB_FS,
    // the projection flips y (stage y runs down): winding is not to be trusted, the depth test sorts the faces
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    transparent: false,
  })
  const box = new THREE.Mesh(new THREE.BufferGeometry(), material)
  box.frustumCulled = false
  box.matrixAutoUpdate = false
  scene.add(box)
  let cells = ''
  /** indices of the front face alone: it comes first in buildBox */
  let frontCount = 0

  const screenQuad = new THREE.PlaneGeometry(2, 2)

  // ── glitch pass over the rendered frame ──
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
  const glitchMaterial = new THREE.ShaderMaterial({
    uniforms: glitchU,
    vertexShader: GLITCH_VS,
    fragmentShader: GLITCH_FS,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  })
  const glitchQuad = new THREE.Mesh(screenQuad, glitchMaterial)
  glitchQuad.frustumCulled = false
  const glitchScene = new THREE.Scene()
  glitchScene.add(glitchQuad)
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  // chromatic aberration (post.aberration) and the per-channel compositing over the void: the title's pass, as is
  const chroma = createTitleAberration(renderer, mount)
  if (!passes.lens) chroma.disable()

  let frameTarget: THREE.WebGLRenderTarget | null = null
  const size = { w: 0, h: 0, ps: 1 }
  // a lost context takes the target with it; three restores the rest itself
  const onLost = () => {
    frameTarget?.dispose()
    frameTarget = null
  }
  canvas.addEventListener('webglcontextlost', onLost)

  // ── pictures → textures ──
  // a picture is uploaded (with its mips) as soon as it is decoded: not in the first frame of a switch
  const pictures = createSlabPictures((i) => {
    const t = textureOf(i)
    if (t && !renderer.getContext().isContextLost()) renderer.initTexture(t.tex)
  })
  const textures: ({ tex: THREE.Texture; version: number; aspect: number } | null)[] = []
  const textureOf = (i: number): { tex: THREE.Texture; version: number; aspect: number } | null => {
    const pic = pictures.get(i)
    if (!pic) return null
    let t = textures[i]
    if (!t || t.version !== pic.version) {
      t?.tex.dispose()
      const tex = new THREE.CanvasTexture(pic.canvas)
      tex.colorSpace = THREE.NoColorSpace
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestMipmapNearestFilter
      tex.generateMipmaps = true
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
      tex.anisotropy = 1
      t = textures[i] = { tex, version: pic.version, aspect: pic.canvas.width / pic.canvas.height }
    }
    return t
  }

  const solver = createSlabSolver()
  const arrival = createArrival()
  let config: ResolvedConfig = ctx.config
  /** the switch seen last frame: a new one (or a re-target) pushes the slab */
  let lastSwitch = ''
  let lastT = 1
  // dev: ?rtenergy=0.8 pins the motion energy, as for the title
  const forcedEnergy = Number(new URLSearchParams(location.search).get('rtenergy') ?? NaN)
  /** what the last frame showed (stats()) */
  let shown: { look: SwitchLook; arr: ArrivalLook } | null = null

  /** the pose at rest for the current layout and config (resize()): SlabPose.rest */
  let restSol: SlabSolution = solver.solve(ctx.layout, ctx.config, true)

  /**
   * The canvas is the whole stage on the slab's lattice — rounded UP to whole lattice pixels, so
   * every one of them is exactly `ps` CSS px (a whole number of device pixels, solve.ts). The mount
   * takes that size (the stage clips the sliver that hangs over its right and bottom edges): the
   * aberration's mask canvas fills the mount too and must stay pixel-for-pixel on this one.
   */
  const fit = (sol: SlabSolution, K: SlabKnobs) => {
    const ps = slabPixelSize(sol.w, K)
    const w = Math.max(1, Math.ceil(sol.W / ps - 1e-4))
    const h = Math.max(1, Math.ceil(sol.H / ps - 1e-4))
    if (w === size.w && h === size.h && ps === size.ps) return
    mount.style.width = `${w * ps}px`
    mount.style.height = `${h * ps}px`
    size.ps = ps
    if (w === size.w && h === size.h) return
    size.w = w
    size.h = h
    renderer.setSize(w, h, false)
    chroma.setSize(w, h)
    frameTarget?.setSize(w, h)
  }

  const setPicture = (crop: THREE.Vector4, i: number, K: SlabKnobs) => {
    const t = textureOf(i)
    const item = Object.values(K.items)[i]
    if (t && item) {
      const c = coverCrop(t.aspect, K.slab.aspect, item.focus)
      crop.set(c.x, c.y, c.w, c.h)
    }
    return t
  }

  function draw(frame: Frame, sol: SlabSolution, look: SwitchLook, arr: ArrivalLook) {
    const K = slabKnobs(frame.config)
    const { slab: k, raster: R, switch: sw } = K
    const reduced = frame.scroll.reduced
    // render px per CSS px, and the canvas in CSS px (its top-left corner is the stage's)
    const px = 1 / size.ps
    const view = { width: size.w * size.ps, height: size.h * size.ps }

    camera.projectionMatrix.fromArray(sol.viewProj(view.width, view.height))
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
    box.matrix.fromArray(sol.model)
    box.matrixWorld.copy(box.matrix)
    const key = `${Math.max(1, Math.round(R.affineCells))}|${k.aspect}`
    if (key !== cells) {
      cells = key
      const nx = Math.max(1, Math.round(R.affineCells))
      const ny = Math.max(1, Math.round(nx / Math.max(0.1, k.aspect)))
      box.geometry.dispose()
      box.geometry = buildBox(nx, ny)
      frontCount = nx * ny * 6
    }
    // A sheet with no thickness (slab.thickness 0) is its front face and nothing else: the back face
    // would lie in the picture's own plane and, drawn after it, win the depth test wherever the two
    // round its way; the side faces have no area.
    box.geometry.setDrawRange(0, sol.d > 0 ? Infinity : frontCount)

    // the title's energy formulas; a switch counts as motion (its envelope), so does the scroll (core)
    const energy = Math.max(Number.isFinite(forcedEnergy) ? forcedEnergy : frame.pointer.energy, look.energy)
    const shimmer = reduced ? 0 : 1
    const eMove = smooth(remap(energy, 0.04, 0.6)) * shimmer
    const e = Math.min(2, eMove + R.restShimmer * shimmer)

    // ── the box ──
    const a = setPicture(U.uCropA.value, look.a, K)
    const b = setPicture(U.uCropB.value, look.b, K)
    U.uPicA.value = a?.tex ?? blank
    U.uPicB.value = b?.tex ?? blank
    U.uHas.value.set(a ? 1 : 0, b ? 1 : 0)
    U.uLod.value.set(Math.max(look.lodA, arr.lod), Math.max(look.lodB, arr.lod))
    U.uZ.value.set(sol.depth.near, 1 / Math.max(1e-12, sol.depth.near - sol.depth.far))
    U.uStipple.value = arr.stipple
    U.uTextured.value = arr.textured ? 1 : 0
    hexToVec3(K.arrive.blank, U.uBlank.value)
    hexToVec3(k.side, U.uSide.value)
    hexToVec3(k.bottom, U.uBottom.value)
    _color.setStyle(k.seam, THREE.NoColorSpace)
    U.uSeam.value.set(_color.r, _color.g, _color.b, k.seamWidth)
    hexToVec3((frame.config as unknown as { veil?: { color?: string } }).veil?.color ?? '#ecebea', U.uVeil.value)
    U.uHaze.value.set(k.haze, Math.max(1, Math.round(k.hazeSteps)))
    // the sheen rests at band.at and slides with the turn; while a switch settles it runs across once
    const band = k.sheenBand
    const reach = band.width / 2 + Math.abs(band.slant) / 2
    const rest = band.at + (sol.aim.y / Math.max(1, k.response.maxTurn)) * band.travel
    const run = look.dir > 0 ? 1 + reach - look.sheen * (1 + 2 * reach) : -reach + look.sheen * (1 + 2 * reach)
    U.uSheen.value.set(look.sheen >= 0 ? k.sheen * 2 : k.sheen, look.sheen >= 0 ? run : rest, Math.max(0.01, band.width / 2), band.slant)
    U.uSheenSteps.value = Math.max(1, Math.round(band.steps))
    const levels = (bits: number) => 2 ** Math.min(8, Math.max(1, Math.round(bits))) - 1
    U.uLevels.value.set(levels(look.crushed ? Math.min(sw.bits, R.bits) : R.bits), levels(R.bits))
    U.uDither.value = R.dither
    U.uAffine.value = clamp01(R.affine * eMove)
    U.uLeak.value.set(look.sideFlat ? 0 : k.sideLeak, look.sideB ? 1 : 0)
    // side blocks of a fixed size on the lattice, counted along the left face as it is on screen
    const top = sol.point(-0.5, -0.5, 0)
    const back = sol.point(-0.5, -0.5, -1)
    const foot = sol.point(-0.5, 0.5, 0)
    U.uCells.value.set(
      Math.max(1, Math.round(Math.hypot(back.x - top.x, back.y - top.y) / size.ps / Math.max(1, k.sideBlock.w))),
      Math.max(1, Math.round(Math.hypot(foot.x - top.x, foot.y - top.y) / size.ps / Math.max(1, k.sideBlock.h))),
    )
    U.uMode.value = look.mode
    U.uDir.value = look.dir
    U.uSweep.value = look.sweep
    U.uZone.value = Math.max(0.01, sw.zone)
    U.uZBits.value = Math.max(1, sw.zBits)
    U.uTeeth.value = sw.teeth
    U.uRows.value = Math.max(1, Math.round(sw.rows))
    U.uTick.value = look.tick
    U.uScan.value.set(look.pass, look.cursor, Math.max(1, Math.round(sw.scan.coarse)), Math.max(1, Math.round(sw.scan.fine)))
    U.uCursor.value = sw.scan.cursor

    // ── the shadow: under the slab's centre, on the floor; it breathes with the float and fills in with the stipple ──
    const lost = renderer.getContext().isContextLost()
    shadow.draw(size.w, size.h, size.ps, shadowBlob(sol, K, size.ps, lost ? 0 : arr.stipple))

    // ── the glitch pass ──
    const ys = [-0.5, 0.5].flatMap((x) => [-0.5, 0.5].flatMap((y) => [0, -1].map((z) => sol.point(x, y, z).y)))
    glitchU.uRes.value.set(size.w, size.h)
    glitchU.uTick.value = Math.floor(frame.time * R.shimmerFps)
    glitchU.uE.value.set(e, eMove)
    // while the slab is still a stipple every pixel is an "edge": the crawl would eat it as noise
    glitchU.uCrawl.value = arr.stipple >= 1 ? R.crawl : 0
    glitchU.uRow.value.set(R.rowGlitch, R.rowShift, Math.max(1, R.rowRun))
    if (shimmer && look.tear.rows > 0) glitchU.uTear.value.set(look.tear.rows, look.tear.shift, look.tick)
    else if (shimmer && arr.tear !== null) glitchU.uTear.value.set(K.arrive.tear.rows, K.arrive.tear.shift, arr.tear)
    else glitchU.uTear.value.set(0, 0, 0)
    glitchU.uSpan.value.set((view.height - Math.max(...ys)) * px, (view.height - Math.min(...ys)) * px)

    // ── out, through the page's lens; a switch kicks red and blue apart along its travel ──
    const ab = aberrationAt(frame.config, frame.layout, frame.pointer.energy)
    const lens: Aberration = { ...ab, on: true, a1: [ab.a1[0] + look.split * size.ps, ab.a1[1], ab.a1[2], ab.a1[3]] }
    if (lost) return
    if (glitchOn) {
      if (!frameTarget) {
        frameTarget = new THREE.WebGLRenderTarget(size.w, size.h, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          generateMipmaps: false,
          depthBuffer: true,
          stencilBuffer: false,
        })
        frameTarget.texture.colorSpace = THREE.NoColorSpace
      }
      renderer.setRenderTarget(frameTarget)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
      glitchU.uSrc.value = frameTarget.texture
    }
    // a failed glitch program (just now, or earlier) → the scene goes straight to the lens
    const [s, c] = glitchOn ? ([glitchScene, ortho] as const) : ([scene, camera] as const)
    if (!chroma.render(s, c, lens, view)) renderer.render(s, c)
    // while the aberration composites per channel, its canvases carry the mount's z-index: the shadow follows
    if (shadow.canvas.style.zIndex !== canvas.style.zIndex) shadow.canvas.style.zIndex = canvas.style.zIndex
  }

  const layer: Layer & { stats(): unknown } = {
    /** Debug (__hero.layers.get('slab').stats()). */
    stats() {
      const p = slabPose.current
      const K = slabKnobs(config)
      return {
        gl: true,
        ps: size.ps,
        buffer: [size.w, size.h],
        corners: p?.corners,
        flat: p?.flat,
        arrival: p?.arrival,
        stipple: shown?.arr.stipple,
        textured: shown?.arr.textured,
        lod: shown ? [Math.max(shown.look.lodA, shown.arr.lod), Math.max(shown.look.lodB, shown.arr.lod)] : null,
        load: arrival.load,
        switch: shown ? { mode: Object.keys(FaceMode)[shown.look.mode], a: shown.look.a, b: shown.look.b, sweep: shown.look.sweep, tick: shown.look.tick } : null,
        pictures: pictures.state(),
        mode: K.switch.mode,
        glitch: glitchOn,
        lost: renderer.getContext().isContextLost(),
      }
    },

    resize(l, c) {
      config = c
      const K = slabKnobs(c)
      pictures.sync(K, projects.state.to)
      const sol = solver.solve(l, c)
      restSol = solver.solve(l, c, true)
      fit(sol, K)
      publishPose(sol, restSol)
    },

    update(frame: Frame) {
      projects.step(frame)
      config = frame.config
      const K = slabKnobs(frame.config)

      const st = projects.state
      const look = switchLook(K, st, frame.scroll.reduced)
      const id = st.t < 1 ? `${st.from}>${st.to}` : ''
      if (id && !st.pinned && look.mode === FaceMode.ZFight && (id !== lastSwitch || st.t < lastT - 1e-6)) {
        solver.kick(st.dir, K)
      }
      // every frame, not only during a show: 'cut' and reduced motion have none (t is 1 at once), and
      // the picture the visitor has just asked for must not wait behind the idle preloads there either
      pictures.hurry(st.to)
      lastSwitch = id
      lastT = st.t

      solver.step(frame, st.pinned ? look.swing : null)
      const sol = solver.solve(frame.layout, frame.config)
      fit(sol, K)
      publishPose(sol, restSol)
      const arr = arrival.step(frame, K, !!pictures.get(look.a))
      shown = { look, arr }
      draw(frame, sol, look, arr)
    },

    dispose() {
      slabPose.current = null
      canvas.removeEventListener('webglcontextlost', onLost)
      pictures.dispose()
      chroma.dispose()
      frameTarget?.dispose()
      for (const t of textures) t?.tex.dispose()
      blank.dispose()
      box.geometry.dispose()
      screenQuad.dispose()
      material.dispose()
      glitchMaterial.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
      shadow.dispose()
      mount.style.width = mount.style.height = ''
    },
  }

  // compile + link now (one real frame, nothing visible: the stipple is 0 before the arrival), so a
  // broken program is caught here and not on the visitor's first frame
  layer.resize(ctx.layout, ctx.config)
  {
    const sol = solver.solve(ctx.layout, ctx.config)
    const frame = { time: 0, dt: 0, pointer: { energy: 0 }, scroll: { reduced: false }, layout: ctx.layout, config: ctx.config } as Frame
    const look = switchLook(slabKnobs(ctx.config), { ...projects.state, from: 0, to: 0 }, false)
    draw(frame, sol, look, { stipple: 0, textured: false, lod: 0, tear: null })
  }
  if (shaderError) {
    layer.dispose()
    throw new Error(`[slab] shader failed to link\n${shaderError}`)
  }
  return layer
}
