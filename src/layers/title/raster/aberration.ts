import * as THREE from 'three'
import type { Aberration } from '../../../core/aberration'
import { createChannelSplit } from '../../../core/channel-split'
import { POST_FS, POST_VS } from './shaders'

/**
 * Chromatic aberration of the title (post.aberration in hero.config.ts; the lens — core/aberration.ts).
 *
 * The title canvas is transparent over the sky, and an aberrated edge has different coverage per
 * channel, so while the aberration is on the title is composited per channel (core/channel-split.ts:
 * a multiply mask + this canvas as plus-lighter light). With the sky and the front clouds shifting
 * their own channels by the same d(p), the page shows the aberrated composite.
 *
 * Per frame: the scene → a target of the canvas size; POST_FS → the canvas as the mask, copied into
 * the mask canvas (small: the title's low-res grid); POST_FS again → the canvas as the light.
 * Off → exactly the old path: one canvas, plain compositing, no target, no extra passes.
 */
export function createTitleAberration(renderer: THREE.WebGLRenderer, mount: HTMLElement) {
  const canvas = renderer.domElement
  const split = createChannelSplit(mount, canvas)

  const uniforms = {
    uSrc: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uView: { value: new THREE.Vector2(1, 1) },
    uAb0: { value: new THREE.Vector4() },
    uAb1: { value: new THREE.Vector4() },
    uMask: { value: 0 },
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: POST_VS,
    fragmentShader: POST_FS,
    uniforms,
    depthTest: false,
    depthWrite: false,
    transparent: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  let target: THREE.WebGLRenderTarget | null = null
  const size = { w: 1, h: 1 }
  /** the post shader failed (index.ts → onShaderError): the title goes on without the aberration */
  let broken = false

  // a lost context takes the target with it (three's deletes are no-ops then): make a new one after
  const onLost = () => {
    target?.dispose()
    target = null
    split.clear()
  }
  canvas.addEventListener('webglcontextlost', onLost)

  const setOn = (next: boolean) => {
    split.set(next && !broken)
    if (!split.on && target) {
      target.dispose()
      target = null
    }
  }

  return {
    /** Canvas size, render px (the renderer's own size). */
    setSize(w: number, h: number) {
      size.w = w
      size.h = h
      target?.setSize(w, h)
    },

    /**
     * Draws `scene` through this frame's lens, or returns false when the aberration is off (the
     * caller then renders as usual). Switching on / off happens here, in the frame that draws it.
     */
    render(sceneIn: THREE.Scene, cam: THREE.Camera, ab: Aberration, view: { width: number; height: number }) {
      setOn(ab.on)
      if (!split.on) return false
      if (renderer.getContext().isContextLost()) return true
      if (!target) {
        target = new THREE.WebGLRenderTarget(size.w, size.h, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          generateMipmaps: false,
          depthBuffer: true,
          stencilBuffer: false,
        })
        target.texture.colorSpace = THREE.NoColorSpace
      }
      renderer.setRenderTarget(target)
      renderer.render(sceneIn, cam)
      renderer.setRenderTarget(null)

      uniforms.uSrc.value = target.texture
      uniforms.uRes.value.set(size.w, size.h)
      uniforms.uView.value.set(view.width, view.height)
      uniforms.uAb0.value.fromArray(ab.a0)
      uniforms.uAb1.value.fromArray(ab.a1)
      uniforms.uMask.value = 1
      renderer.render(scene, camera)
      if (broken) {
        // the post program just failed to link: this very frame goes out the old way
        setOn(false)
        return false
      }
      split.copy()
      uniforms.uMask.value = 0
      renderer.render(scene, camera)
      return true
    },

    disable() {
      broken = true
    },

    dispose() {
      split.dispose()
      canvas.removeEventListener('webglcontextlost', onLost)
      target?.dispose()
      quad.geometry.dispose()
      material.dispose()
    },
  }
}
