/**
 * Pose / spacing fitting harness for the mesh title (dev only, not part of the site).
 * Served by Vite at /scripts/title-mesh/fit.html and driven by scripts/title-mesh/fit.mjs.
 *
 * Renders the title silhouette (+ a "dark side" mask) at the reference resolution and
 * compares it with reference/title-main.jpg: score = IoU(silhouette) + wDark·IoU(sides).
 */
import * as THREE from 'three'
import { buildTitleMesh, type TitleMesh } from '../../src/layers/title/mesh/geometry'
import { meshTitleParams, type MeshTitleParams } from '../../src/layers/title/mesh/params'
import { measure, placeBy, poseOf, setProjection } from '../../src/layers/title/mesh/placement'

const W = 640
const H = 214

const canvas = document.createElement('canvas')
canvas.width = W
canvas.height = H
document.body.appendChild(canvas)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
renderer.setClearColor(0x000000, 1)

const mat = new THREE.ShaderMaterial({
  vertexShader: `attribute vec2 aPart; varying float vP; void main(){ vP = aPart.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying float vP; void main(){ float side = step(3.5, vP); gl_FragColor = vec4(vec3(mix(1.0, 0.5, side)), 1.0); }`,
})
const scene = new THREE.Scene()
const camera = new THREE.Camera()
let built: TitleMesh | null = null
let geoKey = ''
const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat)
mesh.matrixAutoUpdate = false
mesh.frustumCulled = false
scene.add(mesh)

// ── reference masks ──────────────────────────────────────────────────────────
let refSil = new Uint8Array(W * H)
let refDark = new Uint8Array(W * H)
let refBox = { x0: 0, x1: 0, y0: 0, y1: 0 }

async function loadReference(url: string) {
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.drawImage(img, 0, 0, W, H)
  const px = g.getImageData(0, 0, W, H).data
  const bgish = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const m = Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])
    bgish[i] = m > 236 ? 1 : 0
  }
  // flood fill background from the border
  const bg = new Uint8Array(W * H)
  const stack: number[] = []
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x)
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1)
  while (stack.length) {
    const i = stack.pop()!
    if (bg[i] || !bgish[i]) continue
    bg[i] = 1
    const x = i % W
    const y = (i / W) | 0
    if (x > 0) stack.push(i - 1)
    if (x < W - 1) stack.push(i + 1)
    if (y > 0) stack.push(i - W)
    if (y < H - 1) stack.push(i + W)
  }
  refSil = new Uint8Array(W * H)
  refDark = new Uint8Array(W * H)
  let x0 = W, x1 = 0, y0 = H, y1 = 0
  for (let i = 0; i < W * H; i++) {
    if (bg[i]) continue
    refSil[i] = 1
    const lum = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11
    refDark[i] = lum < 108 ? 1 : 0
    const x = i % W
    const y = (i / W) | 0
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  refBox = { x0, x1: x1 + 1, y0, y1: y1 + 1 }
  return refBox
}

// ── render one candidate ─────────────────────────────────────────────────────
const M = new THREE.Matrix4()
const buf = new Uint8Array(W * H * 4)

function renderCandidate(p: MeshTitleParams) {
  const k = JSON.stringify(p.geometry)
  if (k !== geoKey) {
    built?.geometry.dispose()
    built = buildTitleMesh(p)
    mesh.geometry = built.geometry
    geoKey = k
  }
  const pose = poseOf(p, { tiltX: 0, tiltY: 0, perspective: 1 })
  M.compose(pose.center, pose.base, new THREE.Vector3(1, 1, 1))
  const ex = measure(M, built!.hull, built!.hullS)
  // align bbox: left edge + width + vertical centre
  const pl = placeBy(ex, ex.umin, (ex.vmin + ex.vmax) / 2, refBox.x0, (refBox.y0 + refBox.y1) / 2, refBox.x1 - refBox.x0, 0)
  mesh.matrix.copy(M)
  setProjection(camera.projectionMatrix, W, H, pl.s, pl.rot, pl.tx, pl.ty, pose.D + 100)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  renderer.render(scene, camera)
  const gl = renderer.getContext()
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
}

function score(wDark: number) {
  let iS = 0, uS = 0, iD = 0, uD = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = buf[((H - 1 - y) * W + x) * 4]
      const mine = r > 60 ? 1 : 0
      const mineD = r > 60 && r < 190 ? 1 : 0
      const i = y * W + x
      const a = refSil[i]
      const d = refDark[i]
      if (mine && a) iS++
      if (mine || a) uS++
      if (mineD && d) iD++
      if (mineD || d) uD++
    }
  }
  const sil = iS / Math.max(1, uS)
  const dark = iD / Math.max(1, uD)
  return { total: sil + wDark * dark, sil, dark }
}

function overlay(): string {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const img = g.createImageData(W, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = buf[((H - 1 - y) * W + x) * 4]
      const i = y * W + x
      const o = i * 4
      // red = reference only, green = mine only, yellow-ish = both; darker = side classes
      const a = refSil[i]
      const m = r > 60 ? 1 : 0
      img.data[o] = a ? (refDark[i] ? 150 : 255) : 0
      img.data[o + 1] = m ? (r < 190 ? 150 : 255) : 0
      img.data[o + 2] = 0
      img.data[o + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

type Path = [keyof MeshTitleParams, string]
interface FitOpts {
  params: Path[]
  steps: number[]
  iters: number
  wDark: number
  random?: number
  start?: Partial<Record<string, number>>
}

function get(p: MeshTitleParams, [a, b]: Path) {
  return (p[a] as Record<string, number>)[b]
}
function set(p: MeshTitleParams, [a, b]: Path, v: number) {
  ;(p[a] as Record<string, number>)[b] = v
}

function run(opts: FitOpts) {
  const p: MeshTitleParams = structuredClone(meshTitleParams)
  if (opts.start) for (const [k, v] of Object.entries(opts.start)) set(p, k.split('.') as Path, v as number)
  const evalP = () => {
    renderCandidate(p)
    return score(opts.wDark)
  }
  let best = evalP()
  const steps = [...opts.steps]
  const log: string[] = [`start ${best.total.toFixed(4)} sil ${best.sil.toFixed(4)} dark ${best.dark.toFixed(4)}`]
  for (let it = 0; it < opts.iters; it++) {
    let improved = false
    opts.params.forEach((path, i) => {
      for (const dir of [1, -1]) {
        const old = get(p, path)
        set(p, path, old + dir * steps[i])
        const sc = evalP()
        if (sc.total > best.total + 1e-5) {
          best = sc
          improved = true
          // keep going in this direction
          for (let k = 0; k < 6; k++) {
            const o2 = get(p, path)
            set(p, path, o2 + dir * steps[i])
            const s2 = evalP()
            if (s2.total > best.total + 1e-5) best = s2
            else {
              set(p, path, o2)
              break
            }
          }
          break
        } else set(p, path, old)
      }
    })
    if (!improved) {
      for (let i = 0; i < steps.length; i++) steps[i] *= 0.5
      if (Math.max(...steps.map((s, i) => s / opts.steps[i])) < 0.02) break
    }
    log.push(`it ${it} ${best.total.toFixed(4)} sil ${best.sil.toFixed(4)} dark ${best.dark.toFixed(4)}`)
  }
  // phase 2: random joint moves (escapes ridges where two params must move together)
  let seed = 1234567
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd())
  const nRand = opts.random ?? 0
  for (let t = 0; t < nRand; t++) {
    const scale = 0.8 * (1 - t / nRand) + 0.1
    const old = opts.params.map((path) => get(p, path))
    opts.params.forEach((path, i) => set(p, path, old[i] + gauss() * opts.steps[i] * scale))
    const sc = evalP()
    if (sc.total > best.total + 1e-5) best = sc
    else opts.params.forEach((path, i) => set(p, path, old[i]))
    if (t % 100 === 99) log.push(`rand ${t + 1} ${best.total.toFixed(4)} sil ${best.sil.toFixed(4)} dark ${best.dark.toFixed(4)}`)
  }

  renderCandidate(p)
  const out: Record<string, number> = {}
  for (const path of opts.params) out[path.join('.')] = +get(p, path).toFixed(4)
  return { best, params: out, log, overlay: overlay() }
}

function evaluate(start: Partial<Record<string, number>>, wDark = 0.5) {
  const p: MeshTitleParams = structuredClone(meshTitleParams)
  for (const [k, v] of Object.entries(start)) set(p, k.split('.') as Path, v as number)
  renderCandidate(p)
  return { score: score(wDark), overlay: overlay() }
}

Object.assign(window, {
  __fit: { loadReference, run, evaluate },
  __fitReady: true,
})
