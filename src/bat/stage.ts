// One bat on its own small transparent canvas: renderer, lights, environment, camera.
// Port of the Stage from the mockup's Netopyr bundle, without bloom (a transparent canvas never had it).
// Careful with the GPU: render() draws nothing while the canvas is off screen or the tab is hidden,
// and dispose() gives the WebGL context back.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { BatView, NETOPYR, CLIPS, base, TIME, PXU, type Pose } from '../../brand/mascot/netopyr.js'

const LOOKS = {
  night: { hemi: ['#3a4870', '#16120f', 1.15], key: ['#aebfe8', 1.6, [-0.35, 1, -0.6]], fill: ['#7e90c4', 0.55, [0.3, 0.3, 1]], sheen: [0.035, 0.04, 0.06] },
  studio: { hemi: ['#ececee', '#5e5e62', 1.2], key: ['#ffffff', 2.3, [-0.45, 1, 0.35]], fill: ['#ffffff', 0.9, [0.45, 0.2, 1]], sheen: [0.1, 0.1, 0.1] },
} as const

export type Look = keyof typeof LOOKS

export interface StageOptions {
  look?: Look
  shells?: number
  glow?: number
  fov?: number
  maxPixelRatio?: number
}

export class Stage {
  readonly R: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly cam: THREE.PerspectiveCamera
  readonly bat: BatView
  /** Set by the owner: false skips the GPU work of render(). */
  onScreen = true
  private envRT: THREE.WebGLRenderTarget
  private dist = 420
  private cx = 0
  private cy = 0
  private h = 1
  private lost = false
  private disposed = false
  private view = [0, 0, 1]
  private maxPR: number

  constructor(readonly canvas: HTMLCanvasElement, o: StageOptions = {}) {
    this.maxPR = o.maxPixelRatio ?? 1.5
    const R = (this.R = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'default' }))
    R.toneMapping = THREE.NeutralToneMapping
    R.outputColorSpace = THREE.SRGBColorSpace
    R.setClearColor(0x000000, 0)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)

    const cam = (this.cam = new THREE.PerspectiveCamera(o.fov ?? 28, 1, 4, 8000))
    cam.position.set(0, 0, this.dist)
    cam.lookAt(0, 0, 0)

    const pmg = new THREE.PMREMGenerator(R)
    this.envRT = pmg.fromScene(new RoomEnvironment(), 0.04)
    pmg.dispose()

    const L = LOOKS[o.look ?? 'studio']
    this.scene.add(new THREE.HemisphereLight(L.hemi[0], L.hemi[1], L.hemi[2]))
    for (const d of [L.key, L.fill]) {
      const l = new THREE.DirectionalLight(d[0], d[1])
      const v = d[2]
      const n = Math.hypot(v[0], v[1], v[2])
      l.position.set((v[0] / n) * 1600, (v[1] / n) * 1600, (v[2] / n) * 1600)
      this.scene.add(l)
    }
    const bat = (this.bat = new BatView(NETOPYR, { env: this.envRT.texture, shadow: false, shells: o.shells ?? 10, glow: o.glow ?? 0.4 }))
    this.scene.add(bat.g, bat.fxg)
    try {
      bat.mFur.userData.u.uSheen.value.setRGB(...L.sheen)
    } catch {
      /* older rig without sheen */
    }
  }

  private onLost = (e: Event) => {
    e.preventDefault()
    this.lost = true
  }
  private onRestored = () => {
    this.lost = false
  }

  setSize(w: number, h: number) {
    this.h = h
    this.R.setPixelRatio(Math.min(this.maxPR, window.devicePixelRatio || 1))
    this.R.setSize(w, h, false)
    this.cam.aspect = w / h
    this.cam.updateProjectionMatrix()
  }
  setDist(d: number) {
    this.dist = d
    this.cam.position.set(this.cx, this.cy, d)
    this.cam.lookAt(this.cx, this.cy, 0)
  }
  /** Point the camera at world X,Y (y up): the small canvas rides along with the bat. */
  follow(X: number, Y: number) {
    this.cx = X
    this.cy = Y
    this.cam.position.set(X, Y, this.dist)
    this.cam.lookAt(X, Y, 0)
  }
  /** World units per CSS pixel at the bat's depth. */
  px() {
    return (2 * this.dist * Math.tan((this.cam.fov * Math.PI) / 360)) / this.h
  }
  pose(): Pose {
    return base()
  }
  clip(i: number, t: number, b: Pose) {
    const c = CLIPS[i]
    c.fn(((t % c.dur) + c.dur) % c.dur, b)
    return b
  }
  place(b: Pose, X: number, Y: number, Z = 0) {
    b.x += X
    b.y -= Y
    b.z += Z
    return b
  }
  /** Turn the head toward a point; x, y in −1…1 of the screen, w = how much of the way this frame. */
  look(b: Pose, x: number, y: number, w = 1) {
    const L = NETOPYR.headLim
    const yaw = Math.max(-L[0], Math.min(L[0], -x * 1.1))
    const pitch = Math.max(-L[1], Math.min(L[2], y * 0.9 - 0.4))
    b.hyaw += (yaw - b.hyaw) * w
    b.hpitch += (pitch - b.hpitch) * w
    return b
  }
  /** True when it drew. */
  render(dt: number, b: Pose) {
    if (this.disposed || this.lost || !this.onScreen || document.hidden) return false
    dt = Math.min(dt, 0.1)
    TIME.value += dt
    PXU.value = this.R.getPixelRatio()
    this.bat.pose(b)
    const p = this.cam.position
    const dx = p.x - b.x
    const dy = p.y + b.y
    const dz = p.z - b.z
    const l = Math.hypot(dx, dy, dz) || 1
    this.view[0] = dx / l
    this.view[1] = dy / l
    this.view[2] = dz / l
    this.bat.tick(dt, this.px(), this.view)
    this.R.render(this.scene, this.cam)
    return true
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      const mat = m.material
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose())
    })
    this.envRT.dispose()
    this.R.dispose()
    this.R.forceContextLoss()
  }
}
