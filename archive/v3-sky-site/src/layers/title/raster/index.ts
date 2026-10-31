import * as THREE from 'three'
import { aberrationAt } from '../../../core/aberration'
import type { Frame, Layer, LayerContext, LayerFactory, Layout, ResolvedConfig } from '../../../core/types'
import { Follower } from '../../../core/spring'
import { createTitleAberration } from './aberration'
import { ASSET_DIR, createTitleFallback, type Meta } from './fallback'
import { warpTexel } from './geometry'
import { createTitleGlow } from './glow'
import { getRasterTitleParams, renderPixelSize, type RasterTitleParams } from './params'
import { titlePose, type TitlePose } from './pose'
import { GLOW_TAG, POST_TAG, TITLE_FS, TITLE_VS } from './shaders'

/**
 * TITLE — candidate "raster".
 *
 * The client's own render (reference/title-main.jpg) is the asset: keyed off its white
 * background with a hard, sloppy cut (scripts/title-raster/build_assets.py) and drawn on a
 * dense grid in a perspective scene at a deliberately low internal resolution
 * (hero size / render pixel size, nearest-sampled, `image-rendering: pixelated`; the render pixel is
 * title.pixelSize or larger, so the title never exceeds title.raster.renderWidth render px across).
 *
 * Every grid vertex is displaced along its REST view ray by the depth implied by the render
 * itself (baked perspective + extrusion relief), so at rest the screen image is the reference,
 * and as the object turns toward the cursor the faces, walls and the receding "VOLKOV" get real
 * parallax. Highlights slide inside the chrome faces, a small lamp spot travels off the render's
 * own hot spots, bevels catch banded blue-white glints, and the pixel edges become unstable while
 * things move (frame.pointer.energy): the whole frame re-rasterises with a sub-pixel "lens"
 * jitter at a cheap tick rate, contours crawl inward, short runs of rows slip.
 */

const rad = THREE.MathUtils.degToRad
/** Texel (color.png) where the render's strongest blue-white hot spots sit (S top bar / L):
 *  the lamp's rest position. Peak of the blurred hot mask in normals.png (B). */
const LAMP_TEXEL: [number, number] = [214, 72]

const _color = new THREE.Color()
const _hexCache = new WeakMap<THREE.Vector3, string>()
/** '#rrggbb' → raw sRGB 0..1 (the whole layer works in display space, like an old renderer). */
function hexToVec3(hex: string, out: THREE.Vector3) {
  if (_hexCache.get(out) === hex) return out
  _hexCache.set(out, hex)
  _color.setStyle(hex, THREE.NoColorSpace)
  return out.set(_color.r, _color.g, _color.b)
}

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

const hash1 = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

async function loadTexture(loader: THREE.TextureLoader, name: string) {
  const tex = await loader.loadAsync(ASSET_DIR + name)
  tex.colorSpace = THREE.NoColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestMipmapNearestFilter
  tex.generateMipmaps = true
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = 1
  return tex
}

/**
 * Entry point. No WebGL (no context, or the shader fails to link) → the same render as a static,
 * equally pixelated cut-out (./fallback): the main object never just disappears.
 */
export const createLayer: LayerFactory = async (mount, ctx) => {
  try {
    return await createGLTitle(mount, ctx)
  } catch (err) {
    console.warn('[title] WebGL title unavailable → static fallback', err)
    return createTitleFallback(mount, ctx)
  }
}

async function createGLTitle(mount: HTMLElement, ctx: LayerContext): Promise<Layer> {
  const meta: Meta = await fetch(ASSET_DIR + 'meta.json').then((r) => r.json())
  const loader = new THREE.TextureLoader()
  const [colorTex, mapsTex, normalsTex] = await Promise.all(
    ['color.png', 'maps.png', 'normals.png'].map((n) => loadTexture(loader, n)),
  )
  // Smooth copy of the relief for vertex displacement only (the image itself is never filtered).
  const reliefTex = new THREE.Texture(mapsTex.image)
  reliefTex.colorSpace = THREE.NoColorSpace
  reliefTex.minFilter = THREE.LinearFilter
  reliefTex.magFilter = THREE.LinearFilter
  reliefTex.generateMipmaps = false
  reliefTex.needsUpdate = true

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)
  // a program that fails to link would leave an invisible title → createLayer throws instead;
  // a failing glow program (the light behind the letters) only switches the light off, a failing
  // aberration pass only the aberration
  let shaderError = ''
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join('\n') || 'link failed'
    const src = gl.getShaderSource(fs) ?? ''
    if (src.includes(GLOW_TAG)) {
      console.warn('[title] glow shader failed → the title goes on without the light behind it\n' + log)
      glow.disable()
    } else if (src.includes(POST_TAG)) {
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

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(34, 1, 1, 10000)
  const baseProjection = new THREE.Matrix4()
  const aim = new THREE.Group() // turns toward the cursor, about the object's 3D centre
  const body = new THREE.Group() // in-plane rotation + offset so the pivot sits at aim's origin
  aim.rotation.order = 'YXZ'
  scene.add(aim)
  aim.add(body)

  const [tw, th] = meta.size
  const uniforms = {
    uColor: { value: colorTex },
    uMaps: { value: mapsTex },
    uNormals: { value: normalsTex },
    uMapsLin: { value: reliefTex },
    uTexSize: { value: new THREE.Vector2(tw, th) },
    uAnchor: { value: new THREE.Vector2(...meta.anchor) },
    uVanish: { value: new THREE.Vector2(...meta.vanish) },
    uPersp: { value: 1 },
    uScale: { value: 1 },
    uRecess: { value: 0 },
    uRelief: { value: 0 },
    uCamLocal: { value: new THREE.Vector3() },
    uBias: { value: 0 },
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uPointer: { value: new THREE.Vector2() },
    uRot: { value: new THREE.Vector2() },
    uRotZ: { value: 0 },
    uThreshold: { value: 0.5 },
    uFringe: { value: 0 },
    uFringeColor: { value: new THREE.Vector3(1, 1, 1) },
    uFringeWobble: { value: 0 },
    uHighlight: { value: 1 },
    uSlide: { value: 0 },
    uSlideMix: { value: 0 },
    uGlint: { value: 0 },
    uGlintColor: { value: new THREE.Vector3(1, 1, 1) },
    uGlintSharp: { value: 20 },
    uGlintSteps: { value: 0 },
    uLamp: { value: 0 },
    uLampSize: { value: 0.05 },
    uLampTravel: { value: 0 },
    uLampFade: { value: 0 },
    uLampDir: { value: new THREE.Vector3(0, 0, 1) },
    uSideShade: { value: 0 },
    uEnvMix: { value: 0 },
    uEnvDarken: { value: 1 },
    uEnvHorizon: { value: 0 },
    uEnvSky: { value: new THREE.Vector3(1, 1, 1) },
    uEnvFloor: { value: new THREE.Vector3(0, 0, 0) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTanHalf: { value: 0.3 },
    uShimmer: { value: 1 },
    uShimmerFps: { value: 14 },
    uCrawl: { value: 0 },
    uJitter: { value: 0 },
    uRowGlitch: { value: 0 },
    uRowShift: { value: 0 },
    uRowRun: { value: 14 },
    uRestShimmer: { value: 0 },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: TITLE_VS,
    fragmentShader: TITLE_FS,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    transparent: false,
  })

  let geometry: THREE.PlaneGeometry | null = null
  let meshStep = -1
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  mesh.frustumCulled = false // positions are generated in the vertex shader
  body.add(mesh)
  // the light behind the letters (title.glow): same plane and pose, drawn first, under the title
  const glow = createTitleGlow(renderer, meta, reliefTex, uniforms)
  body.add(glow.mesh)
  // chromatic aberration (post.aberration): the finished title through the page's lens
  const chroma = createTitleAberration(renderer, mount)

  const ensureGeometry = (step: number) => {
    step = Math.max(1, Math.min(8, Math.round(step)))
    if (step === meshStep) return
    meshStep = step
    geometry?.dispose()
    geometry = new THREE.PlaneGeometry(1, 1, Math.ceil(tw / step), Math.ceil(th / step))
    mesh.geometry = geometry
  }

  // ── pose: put the "S" anchor exactly on layout.title.{x,y}, span = layout.title.width ──
  /** camera view-projection WITHOUT the lens jitter, and the hero size: for the live pose below */
  const viewProj = new THREE.Matrix4()
  const view = { w: 1, h: 1 }
  /** bumped by every solvePose (resize, pose knobs) */
  let poseRev = 0
  const tmpM = new THREE.Matrix4()
  const camLocal = new THREE.Vector3()
  const _p = new THREE.Vector3()

  const solvePose = (layout: Layout, config: ResolvedConfig, P: RasterTitleParams) => {
    const W = layout.width
    const H = layout.height
    const t = config.title
    const persp = Math.max(0.05, t.perspective)
    const ay = meta.anchor[1]

    // camera: world units = CSS px on the z = 0 plane, y up
    camera.fov = P.fov
    camera.aspect = W / Math.max(1, H)
    const D = H / 2 / Math.tan(rad(P.fov) / 2)
    camera.near = Math.max(1, D * 0.05)
    camera.far = D * 14
    camera.position.set(W / 2, -H / 2, D)
    camera.lookAt(W / 2, -H / 2, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    baseProjection.copy(camera.projectionMatrix)
    viewProj.multiplyMatrices(baseProjection, camera.matrixWorldInverse)
    view.w = W
    view.h = H
    poseRev++
    const tanHalf = Math.tan(rad(P.fov) / 2)
    uniforms.uTanHalf.value = tanHalf

    // texel → rest-plane local (same as the vertex shader), anchor at origin
    const warp = (x: number, y: number) => warpTexel(meta, persp, x, y)
    // texel → CSS px through the CURRENT pose, with the vertex shader's displacement (front faces)
    const project = (x: number, y: number, scale: number) => {
      const c = warp(x, y)
      const kp = 1 + persp * (1 / (1 - c.q) - 1)
      _p.set(c.x * scale, -c.y * scale, 0).sub(camLocal).multiplyScalar(1 + P.recess * (kp - 1)).add(camLocal)
      _p.applyMatrix4(mesh.matrixWorld).project(camera)
      return { x: ((_p.x + 1) / 2) * W, y: ((1 - _p.y) / 2) * H }
    }
    const [bx0, , bx1] = meta.bbox
    const lineY = (l: [number, number], x: number) => l[0] * x + l[1]

    const rz = -rad(layout.title.rotation)
    body.rotation.set(0, 0, rz)
    const target = new THREE.Vector3(layout.title.x, -layout.title.y, 0)

    const place = (pivotLocal: THREE.Vector3, tiltX: number, tiltY: number) => {
      aim.rotation.set(tiltX, tiltY, 0, 'YXZ')
      const rot = new THREE.Quaternion().setFromEuler(aim.rotation)
      const zq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rz)
      body.position.copy(pivotLocal).applyQuaternion(zq).negate()
      // anchor (local origin) world = aim.pos + rot·(Rz·0 + body.pos) → pin it on the target
      aim.position.copy(target).sub(body.position.clone().applyQuaternion(rot))
      aim.updateMatrixWorld(true)
    }

    const baseX = rad(softLimit(t.tilt.x, P.maxTurn))
    const baseY = rad(softLimit(t.tilt.y, P.maxTurn))

    const poseAt = (scale: number) => {
      // 3D centre of the object (texel centre of the title, pushed back by its baked depth)
      const cx = (bx0 + bx1) / 2
      const c = warp(cx, (lineY(meta.lines.top, cx) + lineY(meta.lines.bottom, cx)) / 2)
      const fC = 1 + P.recess * persp * (1 / (1 - c.q) - 1)
      const Pc = new THREE.Vector3(c.x * scale, -c.y * scale, 0)
      // Rest rays are those of the UNTILTED pose: base tilt then reveals parallax like the cursor.
      const pivot = Pc.clone()
      for (let i = 0; i < 4; i++) {
        place(pivot, 0, 0)
        camLocal.copy(camera.position).applyMatrix4(tmpM.copy(mesh.matrixWorld).invert())
        pivot.copy(camLocal).addScaledVector(Pc.clone().sub(camLocal), fC)
      }
      place(pivot, 0, 0)
      camLocal.copy(camera.position).applyMatrix4(tmpM.copy(mesh.matrixWorld).invert())
      uniforms.uCamLocal.value.copy(camLocal)

      // lamp rest direction: the mirror direction seen at the render's hot spot (flat face)
      const s = project(LAMP_TEXEL[0], LAMP_TEXEL[1], scale)
      uniforms.uLampDir.value
        .set(((s.x - W / 2) / (H / 2)) * tanHalf, ((H / 2 - s.y) / (H / 2)) * tanHalf, 1)
        .normalize()

      // final rest pose with the base tilt, anchor pinned
      place(pivot, baseX, baseY)
    }

    // projected span along the title's own (screen-rotated) direction, through the current pose
    const dirX = Math.cos(rad(layout.title.rotation))
    const dirY = Math.sin(rad(layout.title.rotation))
    const measureSpan = (scale: number) => {
      let lo = Infinity
      let hi = -Infinity
      for (const x of [bx0, bx1]) {
        for (const l of [meta.lines.top, meta.lines.bottom]) {
          const p = project(x, lineY(l, x), scale)
          const u = p.x * dirX + p.y * dirY
          lo = Math.min(lo, u)
          hi = Math.max(hi, u)
        }
      }
      return hi - lo
    }

    let scale = layout.title.width / Math.max(1, warp(bx1, ay).x - warp(bx0, ay).x)
    poseAt(scale)
    // base tilt changes the projected length → re-fit so layout.title.width still holds
    if (baseX !== 0 || baseY !== 0) {
      for (let i = 0; i < 3; i++) {
        const m = measureSpan(scale)
        if (!(m > 1)) break
        scale *= layout.title.width / m
        poseAt(scale)
      }
    }

    uniforms.uPersp.value = persp
    uniforms.uScale.value = scale
    uniforms.uRotZ.value = rz
  }

  const applyParams = (P: RasterTitleParams) => {
    uniforms.uRecess.value = P.recess
    uniforms.uRelief.value = P.relief
    uniforms.uBias.value = P.mipBias
    uniforms.uThreshold.value = P.threshold
    uniforms.uFringe.value = P.fringe
    hexToVec3(P.fringeColor, uniforms.uFringeColor.value)
    uniforms.uFringeWobble.value = P.fringeWobble
    uniforms.uSlide.value = P.slide
    uniforms.uSlideMix.value = P.slideMix
    uniforms.uGlint.value = P.glint
    hexToVec3(P.glintColor, uniforms.uGlintColor.value)
    uniforms.uGlintSharp.value = P.glintSharpness
    uniforms.uGlintSteps.value = P.glintSteps
    uniforms.uLamp.value = P.lamp
    uniforms.uLampSize.value = rad(Math.max(0.2, P.lampSize))
    uniforms.uLampTravel.value = P.lampTravel
    uniforms.uLampFade.value = P.lampFade
    uniforms.uSideShade.value = P.sideShade
    uniforms.uEnvMix.value = P.envMix
    uniforms.uEnvDarken.value = P.envDarken
    uniforms.uEnvHorizon.value = P.envHorizon
    hexToVec3(P.envSky, uniforms.uEnvSky.value)
    hexToVec3(P.envFloor, uniforms.uEnvFloor.value)
    uniforms.uShimmerFps.value = P.shimmerFps
    uniforms.uCrawl.value = P.crawl
    uniforms.uJitter.value = P.jitter
    uniforms.uRowGlitch.value = P.rowGlitch
    uniforms.uRowShift.value = P.rowShift
    uniforms.uRowRun.value = Math.max(1, P.rowRun)
    uniforms.uRestShimmer.value = P.restShimmer
  }

  let size = { w: 0, h: 0 }
  // knobs that change the pose itself: re-solve live when they move (tuner)
  const poseKey = (P: RasterTitleParams) => `${P.fov}|${P.recess}|${P.meshStep}|${P.maxTurn}`
  let lastPoseKey = ''
  let lensTick = -1
  const lens = { x: 0, y: 0 }
  // dev: ?rtenergy=0.8 pins pointer.energy → judge the edge instability at a fixed (?pointer=) pose
  const forcedEnergy = Number(new URLSearchParams(location.search).get('rtenergy') ?? NaN)
  // the title's own inertia (title.response.mass; 1 = the shared pointer spring)
  const follow = new Follower()

  // the live pose for layers lying on the title's plane (pose.ts): the vertex shader's front faces
  const _lp = new THREE.Vector3()
  const live: TitlePose & { key: string } = {
    key: '',
    project(x, y) {
      const persp = uniforms.uPersp.value
      const c = warpTexel(meta, persp, x, y)
      const kp = 1 + persp * (1 / (1 - c.q) - 1)
      const cam = uniforms.uCamLocal.value
      const sc = uniforms.uScale.value
      _lp.set(c.x * sc, -c.y * sc, 0).sub(cam).multiplyScalar(1 + uniforms.uRecess.value * (kp - 1)).add(cam)
      _lp.applyMatrix4(mesh.matrixWorld).applyMatrix4(viewProj)
      return { x: ((_lp.x + 1) / 2) * view.w, y: ((1 - _lp.y) / 2) * view.h }
    },
  }

  const layer: Layer = {
    resize(layout, config) {
      const P = getRasterTitleParams(config)
      const ps = renderPixelSize(layout, config)
      const w = Math.max(1, Math.round(layout.width / ps))
      const h = Math.max(1, Math.round(layout.height / ps))
      if (w !== size.w || h !== size.h) {
        renderer.setSize(w, h, false)
        chroma.setSize(w, h)
        size = { w, h }
        uniforms.uRes.value.set(w, h)
      }
      ensureGeometry(P.meshStep)
      applyParams(P)
      solvePose(layout, config, P)
      lastPoseKey = poseKey(P)
      glow.update(config.title.glow, P.threshold, uniforms.uTime.value)
    },

    update(frame: Frame) {
      const t = frame.config.title
      const r = t.response
      const mass = (r as { mass?: number }).mass ?? 1
      const own = follow.step(frame.pointer, frame.dt, frame.config.motion, mass)
      const p = {
        x: mass === 1 ? frame.pointer.x : own.x,
        y: mass === 1 ? frame.pointer.y : own.y,
        energy: Number.isFinite(forcedEnergy) ? forcedEnergy : frame.pointer.energy,
      }
      const P = getRasterTitleParams(frame.config)
      if (poseKey(P) !== lastPoseKey) layer.resize(frame.layout, frame.config)
      applyParams(P)

      // turn toward the cursor: linear in the middle of the screen, softer near the edges,
      // and the total (base tilt + response) never leaves the raster's believable envelope
      const rx = rad(softLimit(t.tilt.x + easeEdge(p.y, P.edgeKnee) * r.tiltX, P.maxTurn))
      const ry = rad(softLimit(t.tilt.y + easeEdge(p.x, P.edgeKnee) * r.tiltY, P.maxTurn))
      aim.rotation.set(rx, ry, 0, 'YXZ')
      uniforms.uRot.value.set(rx, ry)
      uniforms.uPointer.value.set(p.x, p.y)
      uniforms.uHighlight.value = r.highlight
      uniforms.uShimmer.value = r.shimmer
      uniforms.uEnergy.value = p.energy
      uniforms.uTime.value = frame.time
      glow.update(t.glow, P.threshold, frame.time)

      // coherent "lens" jitter: while moving, the whole frame re-rasterises with a sub-pixel
      // offset at the shimmer tick rate → every stair-step crawls together (cheap re-render)
      const eMove = THREE.MathUtils.smoothstep(p.energy, 0.04, 0.6) * r.shimmer
      const tick = Math.floor(frame.time * P.shimmerFps)
      if (tick !== lensTick) {
        lensTick = tick
        lens.x = hash1(tick) * 2 - 1
        lens.y = hash1(tick + 71.3) * 2 - 1
      }
      const amp = P.lensJitter * eMove
      camera.projectionMatrix.copy(baseProjection)
      camera.projectionMatrix.elements[8] += (2 * lens.x * amp) / size.w
      camera.projectionMatrix.elements[9] += (2 * lens.y * amp) / size.h

      // through the lens when post.aberration is on (same pointer energy as the sky's)
      const ab = aberrationAt(frame.config, frame.layout, frame.pointer.energy)
      if (!chroma.render(scene, camera, ab, frame.layout)) renderer.render(scene, camera)
      // render() has refreshed mesh.matrixWorld for this turn → readers of the pose see this frame
      live.key = `${poseRev}|${rx}|${ry}|${uniforms.uRecess.value}`
    },

    dispose() {
      if (titlePose.current === live) titlePose.current = null
      glow.dispose()
      chroma.dispose()
      geometry?.dispose()
      mesh.geometry.dispose()
      material.dispose()
      for (const tex of [colorTex, mapsTex, normalsTex, reliefTex]) tex.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }

  layer.resize(ctx.layout, ctx.config)
  renderer.render(scene, camera) // compiles + links now, so a broken program is caught here
  if (shaderError) {
    layer.dispose()
    throw new Error(`[title] shader failed to link\n${shaderError}`)
  }
  live.key = `${poseRev}|rest`
  titlePose.current = live
  return layer
}
