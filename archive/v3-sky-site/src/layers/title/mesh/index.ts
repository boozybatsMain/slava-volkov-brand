import * as THREE from 'three'
import { aberrationAt } from '../../../core/aberration'
import { Follower } from '../../../core/spring'
import type { Frame, Layer, LayerContext, LayerFactory, Layout, ResolvedConfig } from '../../../core/types'
import { createTitleAberration } from '../raster/aberration'
import { ASSET_DIR, createTitleFallback, type Meta } from '../raster/fallback'
import { titleRestMap } from '../raster/geometry'
import { createTitleGlow } from '../raster/glow'
import { getRasterTitleParams, renderPixelSize } from '../raster/params'
import { titlePose, type TitlePose } from '../raster/pose'
import { GLOW_TAG, POST_TAG as ABERRATION_TAG } from '../raster/shaders'
import { buildTitleMesh, type TitleGeometryParams, type TitleMesh } from './geometry'
import { chainFit, restCentre, restMatrix, setProjection, type ImageFit } from './pose'
import { DEPTH_FS, DEPTH_VS, GLOW_MESH_VS, POST_FS, POST_VS, TITLE_FS, TITLE_VS } from './shaders'

/**
 * TITLE — the "mesh" mode (hero.config.ts → title.mode): SLAVA VOLKOV as real extruded letters.
 *
 * Russo One emboldened to the weight of the client's render, extruded with the stepped double bevel
 * of a late-90s logo tool (geometry.ts), standing where the render's camera saw it (pose.ts — fitted by
 * scripts/title-mesh/fit.mjs) and put on screen exactly where the raster title puts the render
 * (raster/geometry.ts → titleRestMap): the nav and the tagline find their anchors, the light behind
 * the letters (raster/glow.ts) its silhouette, and switching modes moves nothing.
 *
 * Per frame: the solid turns toward the cursor (title.response, softly limited by title.mesh.maxTurn)
 * about its centre, in screen axes like the raster title → a low-res target (the raster's pixel size:
 * raster/params.ts → renderPixelSize), nearest, no AA → the post pass (fringe, crawl, row slips;
 * shaders.ts) over the glow → the canvas, through the page's lens when post.aberration is on.
 * Colour: shaders.ts (the client's render projected from the rest pose + its chrome learned as an
 * environment, for what the render does not show).
 * Without WebGL (or a shader that fails to link): the raster title's static fallback.
 */

const DEG = Math.PI / 180
/** The render's chrome as environments, learned by scripts/title-mesh/fit.mjs --env. */
const ENV_URL = `${import.meta.env.BASE_URL}assets/title-mesh/env.png`
/** The paint keeps this far (texels) from the render's cut, then fades in over PAINT_FEATHER (buildPaint). */
const PAINT_INSET = 3
const PAINT_FEATHER = 6

// the raster title's response curves (raster/index.ts), so both modes turn alike
/** Linear up to `knee`, then eases (C¹) to (1 + knee) / 2 at |p| = 1, flat beyond. */
function easeEdge(p: number, knee: number) {
  const k = THREE.MathUtils.clamp(knee, 0.05, 1)
  const a = Math.abs(p)
  if (k >= 1 || a <= k) return p
  const u = Math.min(1, (a - k) / (1 - k))
  return Math.sign(p) * (k + (1 - k) * (u - (u * u) / 2))
}
/** Identity up to 60 % of `max`, then rolls off smoothly towards `max` (never reaches it). */
function softLimit(a: number, max: number) {
  if (max <= 0) return a
  const k = 0.6 * max
  const s = Math.abs(a)
  if (s <= k) return a
  return Math.sign(a) * (k + (max - k) * Math.tanh((s - k) / (max - k)))
}

export type MeshTitleParams = ResolvedConfig['title']['mesh']

const _c = new THREE.Color()
const hexToVec3 = (hex: string, out: THREE.Vector3) => {
  _c.setStyle(hex, THREE.NoColorSpace)
  return out.set(_c.r, _c.g, _c.b)
}

async function loadTexture(loader: THREE.TextureLoader, name: string, mips: boolean) {
  const tex = await loader.loadAsync(ASSET_DIR + name)
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = mips ? THREE.NearestMipmapNearestFilter : THREE.NearestFilter
  tex.generateMipmaps = mips
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

/**
 * Texel (x, y, 1, 0) → the object point (homogeneous) that the rest camera saw there on the object's
 * plane z = zPlane: the texel's ray through the inverse image fit, cut with that plane, back into the
 * object frame. The glow is drawn with it; the live pose for the overlay projects through it.
 */
function texelToObject(fit: ImageFit, restM: THREE.Matrix4, zPlane: number, out: THREE.Matrix4) {
  const r = fit.rotation * DEG
  const c = Math.cos(r)
  const s = Math.sin(r)
  const k = fit.scale
  const bx = fit.x
  const by = fit.y
  // camera-space ray direction d = (u, −v, −1) = A · (tx, ty, 1), (u, v) = fit⁻¹(t)
  const A = [
    [c / k, s / k, -(c * bx + s * by) / k],
    [s / k, -c / k, (-s * bx + c * by) / k],
    [0, 0, -1],
  ]
  const e = restM.elements
  // plane normal (object +z) and a point of the plane, camera space
  const n = new THREE.Vector3(e[8], e[9], e[10]).normalize()
  const p0 = new THREE.Vector3(0, 0, zPlane).applyMatrix4(restM)
  const c0 = n.dot(p0)
  // X_cam (homogeneous) = [c0 · A ; nᵀ A] · (tx, ty, 1)
  const H: number[][] = [0, 1, 2].map((i) => A[i].map((a) => c0 * a))
  H.push([0, 1, 2].map((j) => n.x * A[0][j] + n.y * A[1][j] + n.z * A[2][j]))
  const inv = restM.clone().invert().elements // column-major
  const rows: number[][] = []
  for (let i = 0; i < 4; i++) {
    rows.push([0, 1, 2].map((j) => inv[i] * H[0][j] + inv[4 + i] * H[1][j] + inv[8 + i] * H[2][j] + inv[12 + i] * H[3][j]))
  }
  // keep w > 0 in front of the camera: a negative w would put the glow's vertices "behind" it (clipped)
  if (rows[3][0] * fit.x + rows[3][1] * fit.y + rows[3][2] < 0) for (const row of rows) for (let j = 0; j < 3; j++) row[j] = -row[j]
  return out.set(
    rows[0][0], rows[0][1], rows[0][2], 0,
    rows[1][0], rows[1][1], rows[1][2], 0,
    rows[2][0], rows[2][1], rows[2][2], 0,
    rows[3][0], rows[3][1], rows[3][2], 0,
  )
}

/**
 * Entry point. No WebGL (no context, or a program fails to link) → the raster title's static
 * fallback: the main object never just disappears.
 */
export const createLayer: LayerFactory = async (mount, ctx) => {
  try {
    return await createMeshTitle(mount, ctx)
  } catch (err) {
    console.warn('[title] mesh title unavailable → static fallback', err)
    return createTitleFallback(mount, ctx)
  }
}

async function createMeshTitle(mount: HTMLElement, ctx: LayerContext): Promise<Layer> {
  const meta: Meta = await fetch(ASSET_DIR + 'meta.json').then((r) => r.json())
  const loader = new THREE.TextureLoader()
  const [colorTex, mapsTex, envTex] = await Promise.all([
    loadTexture(loader, 'color.png', false),
    loadTexture(loader, 'maps.png', false),
    loader.loadAsync(ENV_URL),
  ])
  // the render's chrome as environments (shaders.ts → envAt): smooth, wraps around in longitude
  envTex.colorSpace = THREE.NoColorSpace
  envTex.minFilter = envTex.magFilter = THREE.LinearFilter
  envTex.generateMipmaps = false
  envTex.wrapS = THREE.RepeatWrapping
  envTex.wrapT = THREE.ClampToEdgeWrapping
  // the paint: filled by buildPaint (raw bytes: no canvas premultiplication eating the colour of alpha-0 texels)
  const paintTex = new THREE.DataTexture(new Uint8Array(4), 1, 1)
  paintTex.colorSpace = THREE.NoColorSpace
  paintTex.magFilter = THREE.NearestFilter
  paintTex.minFilter = THREE.NearestMipmapNearestFilter
  paintTex.generateMipmaps = true
  paintTex.wrapS = paintTex.wrapT = THREE.ClampToEdgeWrapping
  let paintThreshold = -1
  // the glow bakes from a linear copy of the matte (raster/glow.ts)
  const mapsLin = new THREE.Texture(mapsTex.image)
  mapsLin.colorSpace = THREE.NoColorSpace
  mapsLin.minFilter = mapsLin.magFilter = THREE.LinearFilter
  mapsLin.generateMipmaps = false
  mapsLin.needsUpdate = true
  const [tw, th] = meta.size

  /**
   * The paint: color.png, its alpha = how much of it the solid may wear there. Only DEEP inside the
   * render's cut: 0 within PAINT_INSET texels of it (the light halo of the white key, the cut itself),
   * rising to 1 over PAINT_FEATHER more. Near the render's edges and past them the solid wears its own
   * chrome: the render's edges never land on the wrong surface (no white dotted lines inside the
   * letters, no smeared strips where the solid is a little wider than the render).
   * The colour of the texels it may not use is the nearest usable one (so the mips stay clean).
   */
  const buildPaint = (threshold: number) => {
    if (threshold === paintThreshold) return
    paintThreshold = threshold
    const read = (img: CanvasImageSource) => {
      const c = document.createElement('canvas')
      c.width = tw
      c.height = th
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.drawImage(img, 0, 0)
      return g.getImageData(0, 0, tw, th).data
    }
    const col = read(colorTex.image as CanvasImageSource)
    const m = read(mapsTex.image as CanvasImageSource)
    const n = tw * th
    const neighbours = (i: number) => {
      const x = i % tw
      const y = (i / tw) | 0
      return [x > 0 ? i - 1 : -1, x < tw - 1 ? i + 1 : -1, y > 0 ? i - tw : -1, y < th - 1 ? i + tw : -1]
    }
    // depth inside the cut: steps to the nearest texel outside it (0 outside)
    const depth = new Uint16Array(n).fill(65535)
    let queue: number[] = []
    for (let i = 0; i < n; i++)
      if (m[i * 4] < threshold * 255) {
        depth[i] = 0
        queue.push(i)
      }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]
      for (const j of neighbours(i)) {
        if (j < 0 || depth[j] <= depth[i] + 1) continue
        depth[j] = depth[i] + 1
        queue.push(j)
      }
    }
    // colour source: itself if usable, else the nearest usable texel
    const from = new Int32Array(n).fill(-1)
    queue = []
    for (let i = 0; i < n; i++)
      if (depth[i] > PAINT_INSET) {
        from[i] = i
        queue.push(i)
      }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]
      for (const j of neighbours(i)) {
        if (j < 0 || from[j] >= 0) continue
        from[j] = from[i]
        queue.push(j)
      }
    }
    const data = new Uint8Array(n * 4)
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        const i = y * tw + x
        const o = ((th - 1 - y) * tw + x) * 4 // bottom-up: uv as for the image textures
        const src = from[i] >= 0 ? from[i] : i
        data[o] = col[src * 4]
        data[o + 1] = col[src * 4 + 1]
        data[o + 2] = col[src * 4 + 2]
        data[o + 3] = Math.round(THREE.MathUtils.clamp((depth[i] - PAINT_INSET) / PAINT_FEATHER, 0, 1) * 255)
      }
    paintTex.image = { data, width: tw, height: th }
    paintTex.needsUpdate = true
  }

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)
  let shaderError = ''
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join('\n') || 'link failed'
    const src = (gl.getShaderSource(fs) ?? '') + (gl.getShaderSource(vs) ?? '')
    if (src.includes(GLOW_TAG)) {
      console.warn('[title] glow shader failed → the title goes on without the light behind it\n' + log)
      glow.disable()
    } else if (src.includes(ABERRATION_TAG)) {
      console.warn('[title] aberration shader failed → the title goes on without it\n' + log)
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
  mount.appendChild(canvas)

  const targetOpts = {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
  }
  /** the title at render resolution, before the post pass */
  const frame = new THREE.WebGLRenderTarget(1, 1, targetOpts)
  frame.texture.colorSpace = THREE.NoColorSpace
  /** what the rest camera saw, texel space: depth of the nearest surface */
  const restDepth = new THREE.WebGLRenderTarget(tw, th, targetOpts)
  restDepth.texture.colorSpace = THREE.NoColorSpace

  const camera = new THREE.Camera() // the projection is set by hand (pose.ts → setProjection)
  const restCamera = new THREE.Camera()

  const uniforms = {
    uRestMV: { value: new THREE.Matrix4() },
    uRestN: { value: new THREE.Matrix3() },
    uTexel: { value: new THREE.Matrix3() },
    uBulge: { value: 0 },
    uPaint: { value: paintTex },
    uRestDepth: { value: restDepth.texture },
    uTexSize: { value: new THREE.Vector2(tw, th) },
    uDepthRange: { value: new THREE.Vector2(1, 2) },
    uBias: { value: 0 },
    uPaintMix: { value: 1 },
    uEnvMix: { value: 0 },
    uEnvDarken: { value: 1 },
    uEnv: { value: envTex },
    uEnvSize: { value: new THREE.Vector2((envTex.image as HTMLImageElement).width, (envTex.image as HTMLImageElement).height) },
    uWobble: { value: 0 },
    uBevelLight: { value: 0 },
    uSeamShade: { value: 1 },
    uContrast: { value: 1 },
    uKey: { value: new THREE.Vector3(0, 0, 1) },
  }
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: TITLE_VS, fragmentShader: TITLE_FS, side: THREE.DoubleSide })
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: { uDepthRange: uniforms.uDepthRange },
    vertexShader: DEPTH_VS,
    fragmentShader: DEPTH_FS,
    side: THREE.DoubleSide,
  })

  const scene = new THREE.Scene()
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  mesh.matrixAutoUpdate = false
  mesh.frustumCulled = false
  scene.add(mesh)
  const depthScene = new THREE.Scene()
  const depthMesh = new THREE.Mesh(mesh.geometry, depthMaterial)
  depthMesh.matrixAutoUpdate = false
  depthMesh.frustumCulled = false
  depthScene.add(depthMesh)

  // the canvas: the light behind the letters first, then the finished title over it
  const composite = new THREE.Scene()
  const texelToObj = { value: new THREE.Matrix4() }
  const glow = createTitleGlow(
    renderer,
    meta,
    mapsLin,
    {
      uTexSize: uniforms.uTexSize,
      uAnchor: { value: new THREE.Vector2(...meta.anchor) },
      uVanish: { value: new THREE.Vector2(...meta.vanish) },
      uPersp: { value: 1 },
      uScale: { value: 1 },
      uRecess: { value: 0 },
      uCamLocal: { value: new THREE.Vector3() },
    },
    { vertexShader: GLOW_MESH_VS, uniforms: { uTexelToObj: texelToObj } },
  )
  glow.mesh.matrixAutoUpdate = false
  composite.add(glow.mesh)
  const postUniforms = {
    uSrc: { value: frame.texture },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTick: { value: 0 },
    uE: { value: new THREE.Vector2() },
    uCrawl: { value: 0 },
    uRow: { value: new THREE.Vector3() },
    uFringe: { value: 0 },
    uFringeColor: { value: new THREE.Vector3(1, 1, 1) },
    uFringeWobble: { value: 0 },
  }
  const postMaterial = new THREE.ShaderMaterial({
    uniforms: postUniforms,
    vertexShader: POST_VS,
    fragmentShader: POST_FS,
    depthTest: false,
    depthWrite: false,
  })
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial)
  postQuad.frustumCulled = false
  postQuad.renderOrder = 1
  composite.add(postQuad)
  const chroma = createTitleAberration(renderer, mount)

  // ── geometry, rest pose, screen placement ──────────────────────────────────────────────────────
  let built: TitleMesh | null = null
  let geoKey = ''
  let restKey = ''
  let restDirty = true
  const pivot = new THREE.Vector3()
  const restM = new THREE.Matrix4()
  const centre = new THREE.Vector3()
  /** texel → object, on the front plane (the overlay's live pose) */
  const frontMap = new THREE.Matrix4()
  let near = 1
  let far = 100
  let screenFit: ImageFit = { scale: 1, rotation: 0, x: 0, y: 0 }
  const view = { w: 1, h: 1 }
  let poseRev = 0

  const ensureGeometry = (L: TitleGeometryParams) => {
    const key = JSON.stringify(L)
    if (key === geoKey && built) return
    const next = buildTitleMesh(L)
    built?.geometry.dispose()
    built = next
    mesh.geometry = built.geometry
    depthMesh.geometry = built.geometry
    built.bounds.getCenter(pivot)
    geoKey = key
    restKey = ''
  }

  const ensureRest = (M: MeshTitleParams) => {
    const key = geoKey + JSON.stringify(M.pose) + JSON.stringify(M.fit)
    if (key === restKey) return
    restKey = key
    restMatrix(M.pose, pivot, restM)
    restCentre(M.pose, centre)
    uniforms.uRestMV.value.copy(restM)
    uniforms.uRestN.value.getNormalMatrix(restM)
    const r = M.fit.rotation * DEG
    const c = Math.cos(r)
    const s = Math.sin(r)
    const k = M.fit.scale
    uniforms.uTexel.value.set(k * c, -k * s, M.fit.x, k * s, k * c, M.fit.y, 0, 0, 1)
    const radius = built!.bounds.getSize(new THREE.Vector3()).length() * 0.6
    near = Math.max(0.05, M.pose.distance - radius)
    far = M.pose.distance + radius
    uniforms.uDepthRange.value.set(near, far)
    texelToObject(M.fit, restM, 0, frontMap)
    // the light sits half-way into the letters: while the solid turns it lags a little behind the faces
    texelToObject(M.fit, restM, -M.letters.depth * 0.5, texelToObj.value)
    restDirty = true
    poseRev++
  }

  /** The rest camera's depth map (texel space): which surface it saw where. Redrawn after any change. */
  const drawRestDepth = (M: MeshTitleParams) => {
    depthMesh.matrix.copy(restM)
    depthMesh.matrixWorldNeedsUpdate = true
    setProjection(restCamera.projectionMatrix, tw, th, M.fit, near * 0.5, far * 1.5)
    restCamera.projectionMatrixInverse.copy(restCamera.projectionMatrix).invert()
    const prevTarget = renderer.getRenderTarget()
    const prevClear = renderer.getClearColor(new THREE.Color())
    const prevAlpha = renderer.getClearAlpha()
    renderer.setRenderTarget(restDepth)
    renderer.setClearColor(0xff0000, 1) // = the far end
    renderer.clear()
    renderer.render(depthScene, restCamera)
    renderer.setClearColor(prevClear, prevAlpha)
    renderer.setRenderTarget(prevTarget)
    restDirty = false
  }

  const solveScreen = (layout: Layout) => {
    const map = titleRestMap(meta, layout, 1)
    const o = map.toScreen(0, 0)
    // texel → screen is a similarity at title.perspective 1 (raster/geometry.ts → warpTexel)
    screenFit = chainFit(params.fit, { scale: map.scale, rotation: layout.title.rotation, x: o.x, y: o.y })
    view.w = layout.width
    view.h = layout.height
    poseRev++
  }

  let params: MeshTitleParams = ctx.config.title.mesh
  const applyParams = (config: ResolvedConfig) => {
    const M = config.title.mesh
    const R = getRasterTitleParams(config)
    const C = M.chrome
    uniforms.uBulge.value = C.bulge
    uniforms.uBias.value = R.mipBias
    buildPaint(R.threshold)
    uniforms.uPaintMix.value = M.paint
    uniforms.uEnvMix.value = M.envMix
    uniforms.uEnvDarken.value = M.envDarken
    uniforms.uWobble.value = C.wobble
    uniforms.uBevelLight.value = C.bevelLight
    uniforms.uSeamShade.value = C.seamShade
    uniforms.uContrast.value = C.contrast
    uniforms.uKey.value.set(C.key.x, C.key.y, C.key.z).normalize()
    postUniforms.uCrawl.value = R.crawl
    postUniforms.uRow.value.set(R.rowGlitch, R.rowShift, Math.max(1, R.rowRun))
    postUniforms.uFringe.value = R.fringe
    hexToVec3(R.fringeColor, postUniforms.uFringeColor.value)
    postUniforms.uFringeWobble.value = R.fringeWobble
  }

  // ── the turn ───────────────────────────────────────────────────────────────────────────────────
  const follow = new Follower()
  const forcedEnergy = Number(new URLSearchParams(location.search).get('rtenergy') ?? NaN)
  const qTurn = new THREE.Quaternion()
  const qRoll = new THREE.Quaternion()
  const zAxis = new THREE.Vector3(0, 0, 1)
  const eTurn = new THREE.Euler()
  const mTurn = new THREE.Matrix4()
  const mT = new THREE.Matrix4()
  let rx = 0
  let ry = 0

  /** Object → camera now: about the solid's centre, in SCREEN axes (the image is rolled by screenFit.rotation). */
  const placeMesh = (tiltX: number, tiltY: number) => {
    const theta = screenFit.rotation * DEG
    eTurn.set(tiltX, tiltY, 0, 'YXZ')
    qTurn.setFromEuler(eTurn)
    // R_cam = Rz(θ) · Q · Rz(−θ)
    qRoll.setFromAxisAngle(zAxis, theta)
    qTurn.premultiply(qRoll).multiply(qRoll.clone().invert())
    mTurn.makeRotationFromQuaternion(qTurn)
    mesh.matrix
      .makeTranslation(centre.x, centre.y, centre.z)
      .multiply(mTurn)
      .multiply(mT.makeTranslation(-centre.x, -centre.y, -centre.z))
      .multiply(restM)
    mesh.matrixWorldNeedsUpdate = true
    glow.mesh.matrix.copy(mesh.matrix)
    glow.mesh.matrixWorldNeedsUpdate = true
  }

  const setCamera = () => {
    setProjection(camera.projectionMatrix, view.w, view.h, screenFit, near, far)
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  }

  // ── the live pose for the layers on the title's plane (raster/pose.ts) ─────────────────────────
  const _h = new THREE.Vector4()
  const _p = new THREE.Vector3()
  const live: TitlePose & { key: string } = {
    key: '',
    project(x, y) {
      _h.set(x, y, 1, 0).applyMatrix4(frontMap)
      _p.set(_h.x / _h.w, _h.y / _h.w, _h.z / _h.w).applyMatrix4(mesh.matrix).applyMatrix4(camera.projectionMatrix)
      return { x: ((_p.x + 1) / 2) * view.w, y: ((1 - _p.y) / 2) * view.h }
    },
  }

  let size = { w: 0, h: 0 }

  const layer: Layer = {
    resize(layout, config) {
      params = config.title.mesh
      ensureGeometry(params.letters)
      ensureRest(params)
      const ps = renderPixelSize(layout, config)
      const w = Math.max(1, Math.round(layout.width / ps))
      const h = Math.max(1, Math.round(layout.height / ps))
      if (w !== size.w || h !== size.h) {
        renderer.setSize(w, h, false)
        frame.setSize(w, h)
        chroma.setSize(w, h)
        postUniforms.uRes.value.set(w, h)
        size = { w, h }
      }
      applyParams(config)
      solveScreen(layout)
      placeMesh(rx, ry)
      setCamera()
      glow.update(config.title.glow, getRasterTitleParams(config).threshold, 0)
    },

    update(f: Frame) {
      const t = f.config.title
      const r = t.response
      const R = getRasterTitleParams(f.config)
      params = t.mesh
      ensureGeometry(params.letters)
      const before = restKey
      ensureRest(params)
      if (restKey !== before) solveScreen(f.layout)
      if (restDirty) drawRestDepth(params)
      applyParams(f.config)

      const mass = (r as { mass?: number }).mass ?? 1
      const own = follow.step(f.pointer, f.dt, f.config.motion, mass)
      const p = {
        x: mass === 1 ? f.pointer.x : own.x,
        y: mass === 1 ? f.pointer.y : own.y,
        energy: Number.isFinite(forcedEnergy) ? forcedEnergy : f.pointer.energy,
      }
      rx = softLimit(t.tilt.x + easeEdge(p.y, R.edgeKnee) * r.tiltX * params.turn, params.maxTurn) * DEG
      ry = softLimit(t.tilt.y + easeEdge(p.x, R.edgeKnee) * r.tiltY * params.turn, params.maxTurn) * DEG
      placeMesh(rx, ry)
      setCamera()

      // the edges: unstable while moving (the raster title's formulas)
      const eMove = THREE.MathUtils.smoothstep(p.energy, 0.04, 0.6) * r.shimmer
      postUniforms.uTick.value = Math.floor(f.time * R.shimmerFps) % 4096
      postUniforms.uE.value.set(Math.min(2, eMove + R.restShimmer), eMove)
      glow.update(t.glow, R.threshold, f.time)

      renderer.setRenderTarget(frame)
      renderer.clear()
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
      const ab = aberrationAt(f.config, f.layout, f.pointer.energy)
      if (!chroma.render(composite, camera, ab, f.layout)) renderer.render(composite, camera)
      live.key = `${poseRev}|${rx}|${ry}`
    },

    dispose() {
      if (titlePose.current === live) titlePose.current = null
      canvas.removeEventListener('webglcontextrestored', onRestored)
      glow.dispose()
      chroma.dispose()
      built?.geometry.dispose()
      material.dispose()
      depthMaterial.dispose()
      postMaterial.dispose()
      postQuad.geometry.dispose()
      frame.dispose()
      restDepth.dispose()
      for (const tex of [paintTex, colorTex, mapsTex, mapsLin, envTex]) tex.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }

  // a restored context lost the rest depth map with everything else
  const onRestored = () => {
    restDirty = true
  }
  canvas.addEventListener('webglcontextrestored', onRestored)

  layer.resize(ctx.layout, ctx.config)
  drawRestDepth(params)
  renderer.setRenderTarget(frame)
  renderer.render(scene, camera) // compiles + links now, so a broken program is caught here
  renderer.setRenderTarget(null)
  renderer.render(composite, camera)
  if (shaderError) {
    layer.dispose()
    throw new Error(`[title] mesh shader failed to link\n${shaderError}`)
  }
  live.key = `${poseRev}|rest`
  titlePose.current = live
  return layer
}
