import * as THREE from 'three'
import type { ResolvedConfig } from '../../../core/types'
import type { Meta } from './fallback'
import { titleEdgeY } from './geometry'
import { GLOW_BAKE_VS, GLOW_BLUR_FS, GLOW_FS, GLOW_PREP_FS, GLOW_VS } from './shaders'

/**
 * The light behind the title (title.glow in hero.config.ts): faint rays fanning out from behind the
 * letters, each slowly brightening and fading on its own; optionally a rim and a soft halo.
 *
 * Baked in the render's own texel space from its matte (shaders.ts → GLOW_*), so it follows the
 * exact silhouette the title shows and shrinks towards VOLKOV like the letters. Drawn per frame as
 * one mesh on the title's plane through the title's own warp, `depth` px behind the front faces:
 * at rest it sits exactly around the letters, while the title turns it lags a little behind them.
 * It lives in the title's canvas, on its low-res pixel grid, drawn first (the opaque title covers
 * it inside the letters) and written premultiplied as (light, max(light)) ≈ screen over the sky.
 */

export type TitleGlowParams = ResolvedConfig['title']['glow']

/** Shared with the title material (same uniform objects → always the title's current pose). */
export interface TitleGlowShared {
  uTexSize: { value: THREE.Vector2 }
  uAnchor: { value: THREE.Vector2 }
  uVanish: { value: THREE.Vector2 }
  uPersp: { value: number }
  uScale: { value: number }
  uRecess: { value: number }
  uCamLocal: { value: THREE.Vector3 }
}

/** Bake resolution, bake px per texel (the light is soft; the canvas pixel is ≥ 1.5 texels anyway). */
const BAKE_SCALE = 0.5
/** The bake domain may not reach this far toward the vanishing point (q): the warp clamps at 0.85. */
const MAX_Q = 0.8
/** Softening of the ray fan, sigma in S-heights: letter corners leave no razor-straight streaks. */
const RAY_SOFTEN = 0.012

const _c = new THREE.Color()
const _hex = new WeakMap<THREE.Vector3, string>()
/** '#rrggbb' → raw sRGB 0..1 (like the title: display space); parsed only when it changes */
const toVec3 = (hex: string, out: THREE.Vector3) => {
  if (_hex.get(out) === hex) return out
  _hex.set(out, hex)
  _c.setStyle(hex, THREE.NoColorSpace)
  return out.set(_c.r, _c.g, _c.b)
}

export function createTitleGlow(
  renderer: THREE.WebGLRenderer,
  meta: Meta,
  /** maps.png with linear filtering (R = the matte) */
  maps: THREE.Texture,
  shared: TitleGlowShared,
  /**
   * Another way to put the light on the title (the mesh title, title/mesh): its own vertex shader
   * (it must give GLOW_FS vUv and vT from uv and uRect, like GLOW_VS) and the uniforms it adds.
   */
  place?: { vertexShader: string; uniforms: Record<string, THREE.IUniform> },
) {
  const [ax] = meta.anchor
  const [bx0, by0, bx1, by1] = meta.bbox
  /** height of the "S" in texels: the unit of every glow size */
  const hS = titleEdgeY(meta, 'bottom', ax) - titleEdgeY(meta, 'top', ax)
  const xMax = ax + MAX_Q * (meta.vanish[0] - ax)

  const rect = { value: new THREE.Vector4() }
  const center = { value: new THREE.Vector2() }
  const perspK = { value: 1 }

  // ── bake: fullscreen quad passes into small render targets ──
  const bakeScene = new THREE.Scene()
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const common = { uRect: rect, uAnchor: shared.uAnchor, uVanish: shared.uVanish, uPerspK: perspK }
  const prepMat = new THREE.ShaderMaterial({
    vertexShader: GLOW_BAKE_VS,
    fragmentShader: GLOW_PREP_FS,
    uniforms: {
      ...common,
      uMaps: { value: maps },
      uTexSize: shared.uTexSize,
      uThreshold: { value: 0.5 },
      uCenter: center,
      uRayLen: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const blurMat = new THREE.ShaderMaterial({
    vertexShader: GLOW_BAKE_VS,
    fragmentShader: GLOW_BLUR_FS,
    uniforms: {
      ...common,
      uSrc: { value: null as THREE.Texture | null },
      uSrcSize: { value: new THREE.Vector2() },
      uDir: { value: new THREE.Vector2() },
      uSigma: { value: new THREE.Vector3() },
      uPxPerTexel: { value: BAKE_SCALE },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), prepMat)
  quad.frustumCulled = false
  bakeScene.add(quad)
  const makeTarget = (w: number, h: number) =>
    new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      colorSpace: THREE.NoColorSpace,
    })
  /** the baked light (R rim, G halo, B ray fan); kept between bakes, re-created when the domain changes size */
  let baked: THREE.WebGLRenderTarget | null = null

  const pass = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => {
    quad.material = material
    renderer.setRenderTarget(target)
    renderer.render(bakeScene, bakeCam)
  }

  // ── per frame: the light on the title's plane ──
  const uniforms = {
    uTexSize: shared.uTexSize,
    uAnchor: shared.uAnchor,
    uVanish: shared.uVanish,
    uPersp: shared.uPersp,
    uScale: shared.uScale,
    uRecess: shared.uRecess,
    uCamLocal: shared.uCamLocal,
    uRect: rect,
    uCenter: center,
    uDepth: { value: 0 },
    uGlow: { value: null as THREE.Texture | null },
    uFade: { value: 1 },
    uAmount: { value: 0 },
    uColor: { value: new THREE.Vector3(1, 1, 1) },
    uHaloColor: { value: new THREE.Vector3(1, 1, 1) },
    uCore: { value: 0 },
    uHalo: { value: 0 },
    uRays: { value: 0 },
    uTime: { value: 0 },
    uRayCount: { value: 90 },
    uRaySharp: { value: 1 },
    uRaySpeed: { value: 0 },
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: place?.vertexShader ?? GLOW_VS,
    fragmentShader: GLOW_FS,
    uniforms: place ? { ...uniforms, ...place.uniforms } : uniforms,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    // opaque + normal blending = no blending in three: the premultiplied light is written as is,
    // first thing on the cleared canvas; the opaque title then overwrites it inside the letters
    transparent: false,
  })
  // positions come from the vertex shader (uv over the bake domain); x is denser for the depth curve
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 96, 24), material)
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  mesh.visible = false

  let bakedKey = ''
  /** a glow shader failed to compile (index.ts → onShaderError): the title goes on without the light */
  let broken = false
  // A lost context takes the bake with it. Drop the target now (while lost, three's deletes are
  // no-ops) and do not bake again until the context is back (update): the first bake after the
  // restore starts from a fresh target owned by the new context.
  const onLost = () => {
    baked?.dispose()
    baked = null
    uniforms.uGlow.value = null
    bakedKey = ''
  }
  renderer.domElement.addEventListener('webglcontextlost', onLost)

  const bake = (G: TitleGlowParams, threshold: number) => {
    const sigCore = Math.max(0.5, G.core.radius * hS)
    const sigHalo = Math.max(0.5, G.halo.radius * hS)
    const sigRays = Math.max(0.5, RAY_SOFTEN * hS)
    const rayLen = G.rays.strength > 0 ? Math.max(0, G.rays.length * hS) : 0
    // the light fades to nothing ≈ 3 sigma out; rays end at their length (longer left of the S,
    // where the perspective widens everything a little)
    const reach = Math.max(
      G.core.strength > 0 ? 3 * sigCore : 0,
      G.halo.strength > 0 ? 3 * sigHalo : 0,
      rayLen > 0 ? rayLen * 1.15 + 3 * sigRays : 0,
    )
    const margin = Math.ceil(reach * 1.1 + 8)
    const x0 = bx0 - margin
    const y0 = by0 - margin
    const x1 = Math.min(bx1 + margin, xMax)
    const y1 = by1 + margin
    rect.value.set(x0, y0, x1, y1)
    uniforms.uFade.value = Math.max(2, margin * 0.15)
    perspK.value = THREE.MathUtils.clamp(G.perspective, 0, 1)
    const cx = bx0 + G.rays.center.x * (bx1 - bx0)
    const top = titleEdgeY(meta, 'top', cx)
    center.value.set(cx, top + G.rays.center.y * (titleEdgeY(meta, 'bottom', cx) - top))

    const w = Math.max(2, Math.round((x1 - x0) * BAKE_SCALE))
    const h = Math.max(2, Math.round((y1 - y0) * BAKE_SCALE))
    if (!baked || baked.width !== w || baked.height !== h) {
      baked?.dispose()
      baked = makeTarget(w, h)
    }
    const a = makeTarget(w, h)
    const b = makeTarget(w, h)
    const prevTarget = renderer.getRenderTarget()

    prepMat.uniforms.uThreshold.value = threshold
    prepMat.uniforms.uRayLen.value = rayLen
    pass(prepMat, a)
    blurMat.uniforms.uSigma.value.set(sigCore, sigHalo, sigRays)
    blurMat.uniforms.uSrcSize.value.set(w, h)
    blurMat.uniforms.uSrc.value = a.texture
    blurMat.uniforms.uDir.value.set(1, 0)
    pass(blurMat, b)
    blurMat.uniforms.uSrc.value = b.texture
    blurMat.uniforms.uDir.value.set(0, 1)
    pass(blurMat, baked)

    renderer.setRenderTarget(prevTarget)
    blurMat.uniforms.uSrc.value = null
    a.dispose()
    b.dispose()
    uniforms.uGlow.value = baked.texture
  }

  return {
    mesh,

    /** Knobs → uniforms; re-bakes only when a size / shape knob changed. Call before rendering. */
    update(G: TitleGlowParams, threshold: number, time: number) {
      const on = !broken && G.amount > 0 && G.core.strength + G.halo.strength + G.rays.strength > 0
      mesh.visible = on
      if (!on) return
      const key = [
        threshold,
        G.core.radius,
        G.core.strength > 0,
        G.halo.radius,
        G.halo.strength > 0,
        G.rays.strength > 0 && G.rays.length,
        G.rays.center.x,
        G.rays.center.y,
        G.perspective,
      ].join('|')
      if (key !== bakedKey) {
        // the hero keeps ticking while the context is lost; a bake now would go nowhere
        if (renderer.getContext().isContextLost()) {
          mesh.visible = false
          return
        }
        bake(G, threshold)
        bakedKey = key
        // the bake is where the glow programs compile: one may have just failed
        if (broken) {
          mesh.visible = false
          return
        }
      }
      uniforms.uAmount.value = G.amount
      uniforms.uDepth.value = G.depth
      toVec3(G.color, uniforms.uColor.value)
      toVec3(G.haloColor, uniforms.uHaloColor.value)
      uniforms.uCore.value = G.core.strength
      uniforms.uHalo.value = G.halo.strength
      uniforms.uRays.value = G.rays.strength
      uniforms.uTime.value = time
      uniforms.uRayCount.value = G.rays.count
      uniforms.uRaySharp.value = Math.max(0.1, G.rays.sharpness)
      uniforms.uRaySpeed.value = G.rays.speed
    },

    /** A glow program failed to compile: hide the light for good, keep the title. */
    disable() {
      broken = true
      mesh.visible = false
    },

    dispose() {
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      baked?.dispose()
      quad.geometry.dispose()
      prepMat.dispose()
      blurMat.dispose()
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}
