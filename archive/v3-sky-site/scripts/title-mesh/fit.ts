/**
 * Fitting stand for the mesh title (dev only, not part of the site): served by Vite at
 * /scripts/title-mesh/fit.html and driven by scripts/title-mesh/fit.mjs.
 *
 * Renders the mesh at the render's texel resolution (public/assets/title-raster, the cropped
 * reference/title-main.jpg) and scores it against the render:
 *   sil  — IoU of the silhouettes (the mesh's vs the render's matte, maps.png R);
 *   edge — how well the mesh's FRONT outlines (the face cap, and cap + bevel) lie on the render's
 *          own edges: the mean of the render's luminance gradient (Sobel, normalised) under them. The
 *          faces cannot be keyed by colour (dark reflections on them, light patches on the walls),
 *          but the bevel lines are the strongest edges of the render.
 * score = sil + wEdge · edge. The image-plane fit (scale / offset) is re-aligned for every candidate
 * (bounding boxes), so a pose change is judged by its shape, not by where it lands; `adj` refines it.
 */
import * as THREE from 'three'
import { buildTitleMesh, type TitleGeometryParams, type TitleMesh } from '../../src/layers/title/mesh/geometry'
import { restMatrix, setProjection, type ImageFit, type MeshPose } from '../../src/layers/title/mesh/pose'

export interface FitParams {
  geometry: TitleGeometryParams
  pose: MeshPose
  /** rotation is searched; scale / x / y are the result of the alignment (written out at the end) */
  fit: ImageFit
  /** refinement of the alignment: scale factor, offset in texels */
  adj?: { scale: number; x: number; y: number }
}

const ASSETS = '/assets/title-raster/'

const meta = await fetch(ASSETS + 'meta.json').then((r) => r.json())
const [W, H] = meta.size as [number, number]

const canvas = document.createElement('canvas')
document.body.appendChild(canvas)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
renderer.setClearColor(0x000000, 1)
const gl = renderer.getContext()

const material = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    attribute vec2 aPart;
    varying float vPart;
    void main() {
      vPart = aPart.x;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying float vPart;
    void main() {
      // R: silhouette, G: front (cap + bevel bands), B: the cap alone
      gl_FragColor = vec4(1.0, vPart < 3.5 ? 1.0 : 0.0, vPart < 0.5 ? 1.0 : 0.0, 1.0);
    }`,
  side: THREE.DoubleSide,
})
/** Rest camera-space normal (faces pillowed like the layer's TITLE_VS) and the part, for learnEnv. */
const normalMaterial = new THREE.ShaderMaterial({
  uniforms: { uBulge: { value: 0.35 } },
  vertexShader: /* glsl */ `
    attribute vec2 aPart;
    attribute vec2 aLocal;
    uniform float uBulge;
    varying vec3 vN;
    varying float vPart;
    void main() {
      vec3 n = normal;
      if (aPart.x < 0.5) n = normalize(n + vec3(aLocal * uBulge, 0.0));
      vN = normalize(normalMatrix * n);
      vPart = aPart.x;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vN;
    varying float vPart;
    void main() {
      gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, (floor(vPart + 0.5) + 0.5) / 8.0);
    }`,
  side: THREE.DoubleSide,
})
const scene = new THREE.Scene()
const camera = new THREE.Camera()
const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
mesh.matrixAutoUpdate = false
mesh.frustumCulled = false
scene.add(mesh)

let built: TitleMesh | null = null
let geoKey = ''
const pivot = new THREE.Vector3()

function ensureGeometry(g: TitleGeometryParams) {
  const key = JSON.stringify(g)
  if (key === geoKey && built) return built
  built?.geometry.dispose()
  built = buildTitleMesh(g)
  built.bounds.getCenter(pivot)
  mesh.geometry = built.geometry
  geoKey = key
  return built
}

// ── the render ────────────────────────────────────────────────────────────────────────────────────
async function imageData(name: string) {
  const img = new Image()
  img.src = ASSETS + name
  await img.decode()
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0)
  return g.getImageData(0, 0, W, H).data
}
const maps = await imageData('maps.png')
const color = await imageData('color.png')
const refSil = new Uint8Array(W * H)
const refGrad = new Float32Array(W * H)
let refBox = { x0: W, y0: H, x1: 0, y1: 0 }

function makeReference(silThr = 0.42, blur = 1) {
  refBox = { x0: W, y0: H, x1: 0, y1: 0 }
  for (let i = 0; i < W * H; i++) {
    const s = maps[i * 4] / 255 > silThr ? 1 : 0
    refSil[i] = s
    if (s) {
      const x = i % W
      const y = (i / W) | 0
      refBox.x0 = Math.min(refBox.x0, x)
      refBox.y0 = Math.min(refBox.y0, y)
      refBox.x1 = Math.max(refBox.x1, x + 1)
      refBox.y1 = Math.max(refBox.y1, y + 1)
    }
  }
  // luminance gradient (Sobel), a box blur of radius `blur` so a near miss still counts (wide — a wide
  // basin for a coarse first pass), normalised by its 97th percentile
  const lum = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) lum[i] = 0.299 * color[i * 4] + 0.587 * color[i * 4 + 1] + 0.114 * color[i * 4 + 2]
  const g = new Float32Array(W * H)
  const L = (x: number, y: number) => lum[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const gx = L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1)
      const gy = L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1)
      g[y * W + x] = Math.hypot(gx, gy)
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let dy = -blur; dy <= blur; dy++) for (let dx = -blur; dx <= blur; dx++) s += g[Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))]
      refGrad[y * W + x] = s / ((2 * blur + 1) * (2 * blur + 1))
    }
  const sorted = Array.from(refGrad).filter((_, i) => refSil[i]).sort((a, b) => a - b)
  const p97 = sorted[Math.floor(sorted.length * 0.97)] || 1
  for (let i = 0; i < W * H; i++) refGrad[i] = Math.min(1, refGrad[i] / p97)
  return refBox
}
makeReference()

// ── render + compare ──────────────────────────────────────────────────────────────────────────────
const px = new Uint8Array(W * H * 4)
const mineSil = new Uint8Array(W * H)
const mineFace = new Uint8Array(W * H)
const mineCap = new Uint8Array(W * H)
const restM = new THREE.Matrix4()
const _v = new THREE.Vector3()

/** The image-plane fit that puts the mesh's projected bounding box onto the render's, then `adj`. */
function aligned(p: FitParams): ImageFit {
  const b = ensureGeometry(p.geometry)
  restMatrix(p.pose, pivot, restM)
  const pos = b.geometry.getAttribute('position') as THREE.BufferAttribute
  const r = (p.fit.rotation * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (let i = 0; i < pos.count; i += 3) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(restM)
    const u = _v.x / -_v.z
    const w = -_v.y / -_v.z
    const x = c * u - s * w
    const y = s * u + c * w
    if (x < u0) u0 = x
    if (x > u1) u1 = x
    if (y < v0) v0 = y
    if (y > v1) v1 = y
  }
  const a = p.adj ?? { scale: 1, x: 0, y: 0 }
  const k = ((refBox.x1 - refBox.x0) / (u1 - u0)) * a.scale
  // centre on centre (then the offset)
  const cx = (refBox.x0 + refBox.x1) / 2
  const cy = (refBox.y0 + refBox.y1) / 2
  return { scale: k, rotation: p.fit.rotation, x: cx - (k * (u0 + u1)) / 2 + a.x, y: cy - (k * (v0 + v1)) / 2 + a.y }
}

function renderMasks(p: FitParams) {
  ensureGeometry(p.geometry)
  const f = aligned(p)
  restMatrix(p.pose, pivot, mesh.matrix)
  mesh.matrixWorldNeedsUpdate = true
  setProjection(camera.projectionMatrix, W, H, f, 0.05, p.pose.distance * 4 + 20)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  renderer.render(scene, camera)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px)
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W // readPixels is bottom-up
    for (let x = 0; x < W; x++) {
      const k = (src + x) * 4
      const i = y * W + x
      mineSil[i] = px[k] > 127 ? 1 : 0
      mineFace[i] = px[k + 1] > 127 ? 1 : 0
      mineCap[i] = px[k + 2] > 127 ? 1 : 0
    }
  }
  return f
}

function iou(a: Uint8Array, b: Uint8Array) {
  let inter = 0
  let uni = 0
  for (let i = 0; i < a.length; i++) {
    inter += a[i] & b[i]
    uni += a[i] | b[i]
  }
  return uni ? inter / uni : 0
}

const isEdge = (m: Uint8Array, i: number) => {
  if (!m[i]) return false
  const x = i % W
  const y = (i / W) | 0
  return x === 0 || y === 0 || x === W - 1 || y === H - 1 || !m[i - 1] || !m[i + 1] || !m[i - W] || !m[i + W]
}

/** Mean render gradient under the front outlines that are NOT the silhouette's (those the IoU judges). */
function edgeScore() {
  let s = 0
  let n = 0
  for (let i = 0; i < W * H; i++) {
    if (!(isEdge(mineFace, i) || isEdge(mineCap, i)) || isEdge(mineSil, i)) continue
    s += refGrad[i]
    n++
  }
  return n ? s / n : 0
}

function evaluate(p: FitParams, wEdge = 0.5) {
  renderMasks(p)
  const sil = iou(refSil, mineSil)
  const edge = edgeScore()
  return { score: sil + wEdge * edge, sil, edge }
}

/** Overlay: red — the render's silhouette only, green — the mesh's only, yellow — both. */
function overlay(p: FitParams) {
  renderMasks(p)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const img = g.createImageData(W, H)
  for (let i = 0; i < W * H; i++) {
    const lum = (color[i * 4] + color[i * 4 + 1] + color[i * 4 + 2]) / 3
    img.data[i * 4] = refSil[i] ? 255 : lum * 0.25
    img.data[i * 4 + 1] = mineSil[i] ? 255 : lum * 0.25
    img.data[i * 4 + 2] = lum * 0.25
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

/**
 * The render itself with the mesh's outlines drawn over it (zoom × nearest): red — the front (cap +
 * bevel) outline, yellow — the cap, cyan — the silhouette. The way to judge weight and pose by eye.
 */
function outline(p: FitParams, zoom = 2) {
  renderMasks(p)
  const c = document.createElement('canvas')
  c.width = W * zoom
  c.height = H * zoom
  const g = c.getContext('2d')!
  const img = g.createImageData(W * zoom, H * zoom)
  for (let i = 0; i < W * H; i++) {
    let r = color[i * 4]
    let gg = color[i * 4 + 1]
    let b = color[i * 4 + 2]
    if (isEdge(mineSil, i)) [r, gg, b] = [0, 220, 255]
    if (isEdge(mineCap, i)) [r, gg, b] = [255, 230, 0]
    if (isEdge(mineFace, i)) [r, gg, b] = [255, 0, 0]
    const x = i % W
    const y = (i / W) | 0
    for (let dy = 0; dy < zoom; dy++)
      for (let dx = 0; dx < zoom; dx++) {
        const k = ((y * zoom + dy) * W * zoom + x * zoom + dx) * 4
        img.data[k] = r
        img.data[k + 1] = gg
        img.data[k + 2] = b
        img.data[k + 3] = 255
      }
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

/** The render's gradient (what `edge` reads), for a look. */
function gradientImage() {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const img = g.createImageData(W, H)
  for (let i = 0; i < W * H; i++) {
    const v = refGrad[i] * 255
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}

const get = (p: FitParams, path: string) => path.split('.').reduce((o: any, k) => o[k], p) as number
const set = (p: FitParams, path: string, v: number) => {
  const ks = path.split('.')
  const o = ks.slice(0, -1).reduce((o: any, k) => o[k], p)
  o[ks[ks.length - 1]] = v
}
const clone = (p: FitParams): FitParams => JSON.parse(JSON.stringify(p))

/** Pattern search: each parameter ± its step, best move kept; a sweep without gain halves the steps. */
function run(o: { start: FitParams; names: string[]; steps: number[]; iters: number; wEdge: number }) {
  let best = clone(o.start)
  best.adj ??= { scale: 1, x: 0, y: 0 }
  let bestS = evaluate(best, o.wEdge)
  const steps = [...o.steps]
  const log: string[] = [`start ${bestS.score.toFixed(4)} sil ${bestS.sil.toFixed(4)} edge ${bestS.edge.toFixed(4)}`]
  for (let it = 0; it < o.iters; it++) {
    let moved = false
    for (let i = 0; i < o.names.length; i++) {
      for (const dir of [1, -1]) {
        const cand = clone(best)
        set(cand, o.names[i], get(cand, o.names[i]) + dir * steps[i])
        const s = evaluate(cand, o.wEdge)
        if (s.score > bestS.score + 1e-6) {
          best = cand
          bestS = s
          moved = true
          break
        }
      }
    }
    if (!moved) for (let i = 0; i < steps.length; i++) steps[i] *= 0.5
    log.push(`#${it} ${bestS.score.toFixed(4)} sil ${bestS.sil.toFixed(4)} edge ${bestS.edge.toFixed(4)}${moved ? '' : ' (steps / 2)'}`)
  }
  return { best: finish(best), score: bestS, log }
}

/**
 * (1+1) evolution strategy: all parameters jump together (Gaussian, each × its step × sigma), a better
 * candidate is kept; sigma follows the 1/5 success rule. Gets out of the ridges coordinate search
 * sticks in (depth ⟷ yaw ⟷ shift all move the same walls).
 */
function es(o: { start: FitParams; names: string[]; steps: number[]; evals: number; wEdge: number; seed?: number }) {
  let best = clone(o.start)
  best.adj ??= { scale: 1, x: 0, y: 0 }
  let bestS = evaluate(best, o.wEdge)
  let seed = o.seed ?? 1
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd())
  let sigma = 1
  let wins = 0
  const log: string[] = [`start ${bestS.score.toFixed(4)} sil ${bestS.sil.toFixed(4)} edge ${bestS.edge.toFixed(4)}`]
  for (let e = 1; e <= o.evals; e++) {
    const cand = clone(best)
    for (let i = 0; i < o.names.length; i++) set(cand, o.names[i], get(cand, o.names[i]) + gauss() * o.steps[i] * sigma)
    const s = evaluate(cand, o.wEdge)
    if (s.score > bestS.score) {
      best = cand
      bestS = s
      wins++
    }
    if (e % 20 === 0) {
      sigma = Math.min(3, Math.max(0.02, wins / 20 > 0.2 ? sigma * 1.5 : sigma / 1.5))
      wins = 0
    }
    if (e % 200 === 0) log.push(`${e} ${bestS.score.toFixed(4)} sil ${bestS.sil.toFixed(4)} edge ${bestS.edge.toFixed(4)} sigma ${sigma.toFixed(3)}`)
  }
  return { best: finish(best), score: bestS, log }
}

/** The params with the alignment written into `fit` (what the layer reads; `adj` kept for the next run). */
function finish(p: FitParams): FitParams {
  const q = clone(p)
  q.fit = aligned(p)
  return q
}

/**
 * The render's chrome as an environment: every texel where the solid and the render agree (≥ 2 texels
 * inside the cut) gives the render's colour to the direction its surface reflects there (rest camera
 * space, the solid's own normals). Two equirect maps of w × h — top: faces and bevels, bottom: walls —
 * lightly blurred, the directions the render never shows filled smoothly from around them (a pyramid
 * guess, then relaxed). The layer looks its chrome
 * up there (public/assets/title-mesh/env.png).
 */
function learnEnv(p: FitParams, w = 128, h = 64, bulge = 0.35) {
  const f = renderMasks(p)
  mesh.material = normalMaterial
  normalMaterial.uniforms.uBulge.value = bulge
  renderer.render(scene, camera)
  const nb = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, nb)
  mesh.material = material
  const r = (f.rotation * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const sum = [new Float64Array(w * h * 3), new Float64Array(w * h * 3)]
  const cnt = [new Float64Array(w * h), new Float64Array(w * h)]
  const deep = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || !refSil[yy * W + xx] || !mineSil[yy * W + xx]) return false
      }
    return true
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!deep(x, y)) continue
      const k = ((H - 1 - y) * W + x) * 4
      const part = Math.floor(nb[k + 3] / 32)
      const set = part <= 3 ? 0 : 1
      if (part > 5) continue
      const n = new THREE.Vector3(nb[k] / 127.5 - 1, nb[k + 1] / 127.5 - 1, nb[k + 2] / 127.5 - 1).normalize()
      // the view ray through this texel: texel → image (u, v) → camera direction (u, −v, −1)
      const tx = (x + 0.5 - f.x) / f.scale
      const ty = (y + 0.5 - f.y) / f.scale
      const u = c * tx + s * ty
      const v = -s * tx + c * ty
      const I = new THREE.Vector3(u, -v, -1).normalize()
      const R = I.clone().sub(n.clone().multiplyScalar(2 * n.dot(I)))
      const lon = Math.atan2(R.x, R.z)
      const lat = Math.asin(THREE.MathUtils.clamp(R.y, -1, 1))
      const ex = Math.min(w - 1, Math.floor((lon / (2 * Math.PI) + 0.5) * w))
      const ey = Math.min(h - 1, Math.floor((0.5 - lat / Math.PI) * h))
      const e = ey * w + ex
      sum[set][e * 3] += color[i * 4]
      sum[set][e * 3 + 1] += color[i * 4 + 1]
      sum[set][e * 3 + 2] += color[i * 4 + 2]
      cnt[set][e]++
    }
  const out = document.createElement('canvas')
  out.width = w
  out.height = h * 2
  const g = out.getContext('2d')!
  const img = g.createImageData(w, h * 2)
  const coverage: number[] = []
  for (const set of [0, 1]) {
    // a light blur of the sums (3×3, wraps in longitude), then push-pull for the empty bins
    const bs = new Float64Array(w * h * 3)
    const bc = new Float64Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy
            if (yy < 0 || yy >= h) continue
            const xx = (x + dx + w) % w
            const wgt = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1
            const j = yy * w + xx
            bc[y * w + x] += cnt[set][j] * wgt
            for (let ch = 0; ch < 3; ch++) bs[(y * w + x) * 3 + ch] += sum[set][j * 3 + ch] * wgt
          }
      }
    coverage.push(bc.filter((v) => v > 0).length / (w * h))
    // pyramid of (sum, count)
    const levels: { s: Float64Array; c: Float64Array; w: number; h: number }[] = [{ s: bs, c: bc, w, h }]
    while (levels[levels.length - 1].w > 1 && levels[levels.length - 1].h > 1) {
      const L = levels[levels.length - 1]
      const nw = Math.max(1, L.w >> 1)
      const nh = Math.max(1, L.h >> 1)
      const ns = new Float64Array(nw * nh * 3)
      const nc = new Float64Array(nw * nh)
      for (let y = 0; y < L.h; y++)
        for (let x = 0; x < L.w; x++) {
          const j = Math.min(nh - 1, y >> 1) * nw + Math.min(nw - 1, x >> 1)
          nc[j] += L.c[y * L.w + x]
          for (let ch = 0; ch < 3; ch++) ns[j * 3 + ch] += L.s[(y * L.w + x) * 3 + ch]
        }
      levels.push({ s: ns, c: nc, w: nw, h: nh })
    }
    // the colour of a bin: its own if it has samples, else the nearest coarser level that has
    const colorAt = (x: number, y: number) => {
      for (let l = 0; l < levels.length; l++) {
        const L = levels[l]
        const lx = Math.min(L.w - 1, x >> l)
        const ly = Math.min(L.h - 1, y >> l)
        const j = ly * L.w + lx
        if (L.c[j] > 0) return [L.s[j * 3] / L.c[j], L.s[j * 3 + 1] / L.c[j], L.s[j * 3 + 2] / L.c[j]]
      }
      return [128, 128, 128]
    }
    // start the holes from the pyramid, then relax them (Jacobi, longitude wraps): smooth, not blocky
    const known = new Uint8Array(w * h)
    const cur = new Float64Array(w * h * 3)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const j = y * w + x
        known[j] = bc[j] > 0 ? 1 : 0
        const col = colorAt(x, y)
        for (let ch = 0; ch < 3; ch++) cur[j * 3 + ch] = col[ch]
      }
    const nxt = new Float64Array(cur)
    for (let it = 0; it < 400; it++) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const j = y * w + x
          if (known[j]) continue
          const nb = [y * w + ((x + 1) % w), y * w + ((x - 1 + w) % w), Math.max(0, y - 1) * w + x, Math.min(h - 1, y + 1) * w + x]
          for (let ch = 0; ch < 3; ch++) nxt[j * 3 + ch] = (cur[nb[0] * 3 + ch] + cur[nb[1] * 3 + ch] + cur[nb[2] * 3 + ch] + cur[nb[3] * 3 + ch]) / 4
        }
      cur.set(nxt)
    }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const j = y * w + x
        const k = ((set * h + y) * w + x) * 4
        img.data[k] = cur[j * 3]
        img.data[k + 1] = cur[j * 3 + 1]
        img.data[k + 2] = cur[j * 3 + 2]
        img.data[k + 3] = 255
      }
  }
  g.putImageData(img, 0, 0)
  return { png: out.toDataURL('image/png'), coverage }
}

/** Top and bottom of both silhouettes in the given texel columns: [x, refTop, refBottom, mineTop, mineBottom]. */
function columns(p: FitParams, xs: number[]) {
  renderMasks(p)
  return xs.map((x) => {
    const span = (m: Uint8Array) => {
      let t = -1
      let b = -1
      for (let y = 0; y < H; y++)
        if (m[y * W + x]) {
          if (t < 0) t = y
          b = y
        }
      return [t, b]
    }
    return [x, ...span(refSil), ...span(mineSil)]
  })
}

Object.assign(window, {
  __fit: { evaluate, overlay, outline, run, es, finish, learnEnv, columns, makeReference, gradientImage, refBox: () => refBox },
  __fitReady: true,
})
