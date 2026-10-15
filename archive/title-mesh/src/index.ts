import * as THREE from 'three'
import type { Frame, Layer, LayerFactory, Layout, ResolvedConfig } from '../../../core/types'
import { buildTitleMesh, type TitleMesh } from './geometry'
import { getMeshTitleParams, type MeshTitleParams } from './params'
import { createPostMaterial, createTitleMaterial, hexToVec3 } from './shaders'
import { measure, placeBy, poseOf, setProjection, type Placement } from './placement'

/**
 * Title, "mesh" candidate: real extruded geometry rendered deliberately low-fi.
 *
 * Pipeline: letters → low-res render target (antialias off, nearest) → post pass
 * (key-out fringe, unstable edges while moving, RGB555 + Bayer dither) → canvas
 * of the same low res, stretched to the hero with `image-rendering: pixelated`.
 *
 * Placement: the camera is a fixed perspective "lens" looking at the title; the
 * resulting picture is then moved / scaled / rotated in the image plane (baked into
 * the projection matrix) so that the measured left edge of the "S" at its vertical
 * middle lands exactly on layout.title.{x,y} and the whole title spans layout.title.width.
 */

const DEG = Math.PI / 180

type Fit = Placement

/** Dev convenience: ?mesh.material.horizon=12&mesh.pose.yaw=40 overrides params in memory. */
function applyUrlOverrides(p: MeshTitleParams) {
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (!k.startsWith('mesh.')) continue
    const path = k.split('.').slice(1)
    let o = p as unknown as Record<string, unknown>
    for (let i = 0; i < path.length - 1; i++) o = (o?.[path[i]] ?? undefined) as Record<string, unknown>
    const key = path[path.length - 1]
    if (!o || !(key in o)) continue
    o[key] = typeof o[key] === 'number' ? Number(v) : typeof o[key] === 'string' && !v.startsWith('#') ? '#' + v : v
  }
}

export const createLayer: LayerFactory = (mount, ctx) => {
  const canvas = document.createElement('canvas')
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;image-rendering:pixelated;'
  mount.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)

  const target = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0,
  })

  const scene = new THREE.Scene()
  const camera = new THREE.Camera()
  const material = createTitleMaterial()
  material.uniforms.uDebug.value = { parts: 1, refl: 2 }[new URLSearchParams(location.search).get('meshdebug') ?? ''] ?? 0
  let params: MeshTitleParams = getMeshTitleParams(ctx.config)
  applyUrlOverrides(params)
  let built: TitleMesh = buildTitleMesh(params)
  let geoKey = JSON.stringify(params.geometry)
  const mesh = new THREE.Mesh(built.geometry, material)
  mesh.matrixAutoUpdate = false
  mesh.frustumCulled = false
  scene.add(mesh)

  const post = createPostMaterial(target.texture)
  const triGeo = new THREE.BufferGeometry()
  triGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  const tri = new THREE.Mesh(triGeo, post)
  tri.frustumCulled = false
  const postScene = new THREE.Scene()
  postScene.add(tri)

  let layout: Layout = ctx.layout
  let config: ResolvedConfig = ctx.config
  let fit: Fit | null = null
  let fitKey = ''
  let rw = 0
  let rh = 0

  // ── fitting the picture to layout.title ────────────────────────────────────
  const tmpM = new THREE.Matrix4()

  function computeFit(): Fit {
    const t = config.title
    const pose = poseOf(params, { tiltX: t.tilt.x, tiltY: t.tilt.y, perspective: t.perspective })
    tmpM.compose(pose.center, pose.base, new THREE.Vector3(1, 1, 1))
    const ex = measure(tmpM, built.hull, built.hullS)
    const pl = placeBy(ex, ex.sLeft, ex.sMid, layout.title.x, layout.title.y, layout.title.width, layout.title.rotation)
    return { ...pl, D: pose.D, center: pose.center, base: pose.base }
  }

  function applyProjection(f: Fit, jx: number, jy: number) {
    setProjection(camera.projectionMatrix, layout.width, layout.height, f.s, f.rot, f.tx + jx, f.ty + jy, f.D + 100)
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  }

  function ensureFit() {
    const t = config.title
    const key = [
      layout.width, layout.height, layout.title.x, layout.title.y, layout.title.width, layout.title.rotation,
      t.tilt.x, t.tilt.y, t.perspective, JSON.stringify(params.pose), geoKey,
    ].join('|')
    if (key !== fitKey || !fit) {
      fit = computeFit()
      fitKey = key
    }
    return fit
  }

  function ensureGeometry() {
    const k = JSON.stringify(params.geometry)
    if (k === geoKey) return
    geoKey = k
    const next = buildTitleMesh(params)
    built.geometry.dispose()
    built = next
    mesh.geometry = built.geometry
    fit = null
  }

  function ensureSize() {
    const px = Math.max(0.5, config.title.pixelSize)
    const w = Math.max(1, Math.round(layout.width / px))
    const h = Math.max(1, Math.round(layout.height / px))
    if (w === rw && h === rh) return
    rw = w
    rh = h
    renderer.setSize(w, h, false)
    target.setSize(w, h)
    post.uniforms.uRes.value.set(w, h)
  }

  // ── per-frame state ────────────────────────────────────────────────────────
  const qPointer = new THREE.Quaternion()
  const ePointer = new THREE.Euler(0, 0, 0, 'YXZ')
  const one = new THREE.Vector3(1, 1, 1)
  const pivot = new THREE.Vector3()
  const mBase = new THREE.Matrix4()
  const mTurn = new THREE.Matrix4()
  const mPivot = new THREE.Matrix4()
  const qView = new THREE.Quaternion()
  const qTmp = new THREE.Quaternion()
  const mTmp = new THREE.Matrix4()
  const u = material.uniforms

  function render(frame: Frame) {
    const p = frame.pointer
    const t = frame.config.title
    const r = params.render
    const m = params.material

    const f = ensureFit()

    // The object turns slightly toward the cursor (pointer is already spring-smoothed).
    // Rotation is about the object's OWN axes (letter vertical → follows x, baseline → follows y)
    // through a pivot near the S, so the S stays in its window and VOLKOV does the turning.
    ePointer.set(p.y * t.response.tiltX * DEG, p.x * t.response.tiltY * DEG, 0, 'YXZ')
    qPointer.setFromEuler(ePointer)
    const b = built.bounds
    pivot.set(b.min.x + (b.max.x - b.min.x) * params.pose.pivot, 0, 0)
    mBase.compose(f.center, f.base, one)
    mTurn.makeRotationFromQuaternion(qPointer)
    mesh.matrix
      .copy(mBase)
      .multiply(mPivot.makeTranslation(pivot.x, pivot.y, pivot.z))
      .multiply(mTurn)
      .multiply(mPivot.makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    mesh.matrixWorldNeedsUpdate = true

    // cheap renderer cadence: randomness changes at tickRate, not every frame
    const tick = Math.floor(frame.time * Math.max(1, r.tickRate))
    const e = Math.min(1, p.energy) * t.response.shimmer
    // sub-pixel lens jitter while moving → stair-steps crawl along the edges
    const amp = r.jitter * Math.min(1, e) * (config.title.pixelSize || 1)
    const hx = Math.sin(tick * 12.9898) * 43758.5453
    const hy = Math.sin(tick * 78.233) * 12345.6789
    const jx = amp > 0.05 ? (hx - Math.floor(hx) - 0.5) * 2 * amp : 0
    const jy = amp > 0.05 ? (hy - Math.floor(hy) - 0.5) * 2 * amp : 0
    applyProjection(f, jx, jy)

    // material
    hexToVec3(m.face, u.uFace.value)
    hexToVec3(m.side, u.uSide.value)
    hexToVec3(m.sky, u.uSky.value)
    hexToVec3(m.glint, u.uGlint.value)
    hexToVec3(m.ground, u.uGround.value)
    u.uReflect.value = m.reflect
    u.uSideReflect.value = m.sideReflect
    u.uMatte.value = m.matte
    u.uBlotch.value = m.blotch
    u.uWarp.value = m.warp
    u.uSpec.value = m.specular
    u.uHorizon.value = m.horizon * DEG
    u.uBulge.value = m.bulge
    u.uContrast.value = m.contrast
    u.uBevelLight.value = m.bevelLight
    u.uLamp.value = m.lamp
    // highlight = 0 → reflections stay glued to the letters (env counter-rotates with the turn);
    // 1 → physically correct sliding; >0 also adds an extra env drift for livelier glints
    const hl = Math.max(0, t.response.highlight)
    qView.copy(f.base).multiply(qPointer).multiply(qTmp.copy(f.base).invert()) // turn, in view space
    qTmp.identity().slerp(qView.invert(), Math.min(1, Math.max(0, 1 - hl)))
    u.uEnvRot.value.setFromMatrix4(mTmp.makeRotationFromQuaternion(qTmp))
    const hs = m.envShift * hl
    u.uEnvShift.value.set(-p.x * hs, p.y * hs * 0.6)

    // post
    const pu = post.uniforms
    pu.uTick.value = tick % 4096
    pu.uE.value = e
    pu.uFringe.value = r.fringe
    pu.uLevels.value = Math.pow(2, Math.max(1, Math.min(8, Math.round(r.colorBits)))) - 1
    pu.uDither.value = r.dither
    pu.uGlitch.value = r.glitch
    pu.uFlicker.value = r.edgeFlicker

    renderer.setRenderTarget(target)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    renderer.clear()
    renderer.render(postScene, camera)
  }

  // ── optional live panel for this layer's own params: ?title=mesh&meshtune ──
  let gui: { destroy(): void } | null = null
  let disposed = false
  if (new URLSearchParams(location.search).has('meshtune')) {
    import('lil-gui').then(({ default: GUI }) => {
      if (disposed) return
      const g = new GUI({ title: 'Title · mesh' })
      g.domElement.style.zIndex = '1001'
      g.domElement.style.left = '0'
      g.domElement.style.right = 'auto'
      // slider ranges = the ranges documented in params.ts
      const R: Record<string, [number, number]> = {
        depth: [0.1, 1], bevelOuter: [0, 0.06], bevelStep: [0, 0.05], bevelInner: [0, 0.06], seam: [0, 0.02],
        seamAt: [0, 1], curveSegments: [1, 8], crease: [0, 90], condense: [0.7, 1.3], tracking: [-0.2, 0.2],
        bend: [-20, 30], wordSpace: [0, 1.5], yaw: [0, 70], pitch: [-30, 30], roll: [-15, 15], distance: [3, 20],
        shiftX: [-1, 1], shiftY: [-1, 1], pivot: [0, 1], horizon: [-10, 25], bulge: [0, 1], bevelLight: [0, 1],
        contrast: [0.8, 1.5], reflect: [0, 1], sideReflect: [0, 1], matte: [0, 1], blotch: [0, 1.5], warp: [0, 1],
        lamp: [0, 2], specular: [0, 2], envShift: [0, 1.5], colorBits: [3, 8], dither: [0, 1], fringe: [0, 1],
        jitter: [0, 1.5], glitch: [0, 2], edgeFlicker: [0, 1], tickRate: [6, 60],
      }
      const add = (folder: InstanceType<typeof GUI>, obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number') (R[k] ? folder.add(obj, k, R[k][0], R[k][1]) : folder.add(obj, k))
          else if (typeof v === 'string' && v.startsWith('#')) folder.addColor(obj, k)
          else if (typeof v === 'object' && v) add(folder.addFolder(k), v as Record<string, unknown>)
        }
      }
      add(g, params as unknown as Record<string, unknown>)
      g.add({ copy: () => console.log(JSON.stringify(params, null, 2)) }, 'copy').name('Log params')
      gui = g
    })
  }

  return {
    resize(nextLayout: Layout, nextConfig: ResolvedConfig) {
      layout = nextLayout
      config = nextConfig
      params = getMeshTitleParams(config)
      ensureGeometry()
      ensureSize()
      fit = null
    },
    update(frame: Frame) {
      layout = frame.layout
      config = frame.config
      params = getMeshTitleParams(config)
      ensureGeometry()
      ensureSize()
      render(frame)
    },
    dispose() {
      disposed = true
      gui?.destroy()
      built.geometry.dispose()
      triGeo.dispose()
      material.dispose()
      post.dispose()
      target.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  } satisfies Layer
}
