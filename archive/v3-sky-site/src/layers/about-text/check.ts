import { depthOf, project3, unproject, type AboutCamera } from '../../core/about-camera'
import { apply4, cardModelOf, cardPoses, wordModelOf, wordPoses, type AboutTurns } from '../../core/about-pose'
import type { ResolvedConfig } from '../../core/types'
import { cardShadowPlane, lightFrom, onPlane, shadowLamp, shadowPool, shadowShare, wordShadowPlane, type Plane } from '../about/core'
import { aboutKnobs, type V3 } from '../about/knobs'
import { buildWordMesh } from '../about/mesh'

/**
 * A composition check for stats() (debug only, never per frame): the one world's things on screen as
 * the canvas draws them — the same 3D geometry, camera and turns toward the pointer (core/about-pose.ts →
 * wordModel / cardModel with each element's own turn, core/about-camera.ts → project3, layers/about/core.ts
 * → the shadow planes) —
 * rasterised on the CPU into a grid of STEP px:
 *   · word:<key> — the projected MESH of the extruded word (layers/about/mesh.ts → buildWordMesh: the
 *     front cap, the bevel, the walls, the back cap; turned in depth, toward the pointer, swung during
 *     the pull) — its true silhouette: the void inside a counter or beside an A's leg is free space;
 *   · card:<key> — the projected card box (its picture face and whichever sides show; turned toward the
 *     pointer about its own middle);
 *   · shadow:<key> — the dotted shadow of a word or a card: the mesh / the picture face flattened onto
 *     its shadow plane along its own light (core.ts → shadowLamp, lightFrom) and projected (the whole footprint, also where the
 *     caster itself stands over it; none while the shadows are faded out — the pull's close-ups — or
 *     where its dots would be too thin to show). Text over dots is a legibility clash like text over a
 *     card: the same CLEAR.
 * Near-clipped against the camera (things the camera flies past during the pull).
 * What a note's line comes closer than CLEAR px to (overlapsAt), pairs of solid things closer than
 * CLEAR to each other (clashesAt — words and cards; shadows only overlap the void), what has any of its
 * shape inside a box (shapesIn — e.g. under the docked nav).
 */

/** x0, y0, x1, y1 — CSS px on screen */
export type Box = [number, number, number, number]

/** Clearance asked of a note at rest: from words, cards, shadows, the dock, other notes and the screen edges, px. */
export const CLEAR = 16
/** Raster step of the check, CSS px (the about canvas's cell is ≈ 1.5–2 px). */
const STEP = 2
/** The raster covers the screen and this much around it, px (a thing just off the edge can still be within CLEAR of a note). */
const PAD = CLEAR + 2 * STEP

/**
 * The pointer as the canvas published it (core/about-sheet.ts → aboutFrame.pointer): every element's
 * turn toward it, degrees (core/about-pose.ts → AboutTurns; a resting pointer — restTurns). The camera
 * itself never moves with the pointer.
 */
export type Ptr = AboutTurns

export type Kind = 'word' | 'card' | 'shadow'

/** A thing on screen: its covered cells (a mask over its own part of the grid) and their box. */
interface Thing {
  name: string
  kind: Kind
  /** height of its pivot / picture centre above the sheet plane, sheet units */
  z: number
  /** grid box of its mask (cells), and the mask */
  gx0: number
  gy0: number
  w: number
  h: number
  m: Uint8Array
  /** covered box, CSS px (null — nothing in the raster) */
  box: Box | null
}

interface Grid {
  /** screen px of cell (0, 0)'s corner */
  ox: number
  oy: number
  gw: number
  gh: number
}

const gridOf = (W: number, H: number): Grid => ({ ox: -PAD, oy: -PAD, gw: Math.ceil((W + 2 * PAD) / STEP), gh: Math.ceil((H + 2 * PAD) / STEP) })

/** A float field over part of the grid (cells gx0…, gy0…; w × h). */
interface Field {
  gx0: number
  gy0: number
  w: number
  h: number
  f: Float32Array
}

/**
 * Collects screen triangles with a weight per vertex (0…1; a solid — 1), then rasterises them: a cell
 * whose centre is inside a triangle takes the triangle's weight there (screen-linear), the MAX over
 * the triangles (as the GPU's shadow mask, MaxEquation). `pad` cells of margin around the triangles'
 * box (room for a blur).
 */
class Raster {
  private tris: number[] = []
  private x0 = Infinity
  private y0 = Infinity
  private x1 = -Infinity
  private y1 = -Infinity
  constructor(private g: Grid) {}

  tri(ax: number, ay: number, aw: number, bx: number, by: number, bw: number, cx: number, cy: number, cw: number) {
    this.tris.push(ax, ay, aw, bx, by, bw, cx, cy, cw)
    this.x0 = Math.min(this.x0, ax, bx, cx)
    this.y0 = Math.min(this.y0, ay, by, cy)
    this.x1 = Math.max(this.x1, ax, bx, cx)
    this.y1 = Math.max(this.y1, ay, by, cy)
  }

  /** A convex polygon (screen px and weight: x, y, w, …) as a fan. */
  poly(p: number[]) {
    for (let i = 3; i + 5 < p.length; i += 3) this.tri(p[0], p[1], p[2], p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5])
  }

  /** The field (null — nothing within the grid). `at(px, py)` — the weight of a covered cell, instead of the vertices'. */
  fill(pad = 0, at?: (px: number, py: number) => number): Field | null {
    const g = this.g
    const cell = (v: number, o: number) => Math.floor((v - o) / STEP)
    const gx0 = Math.max(0, cell(this.x0, g.ox) - pad)
    const gy0 = Math.max(0, cell(this.y0, g.oy) - pad)
    const gx1 = Math.min(g.gw - 1, cell(this.x1, g.ox) + pad)
    const gy1 = Math.min(g.gh - 1, cell(this.y1, g.oy) + pad)
    if (!(gx1 >= gx0 && gy1 >= gy0)) return null
    const w = gx1 - gx0 + 1
    const h = gy1 - gy0 + 1
    const f = new Float32Array(w * h)
    const t = this.tris
    for (let i = 0; i < t.length; i += 9) {
      const ax = t[i], ay = t[i + 1], aw = t[i + 2], bx = t[i + 3], by = t[i + 4], bw = t[i + 5], cx = t[i + 6], cy = t[i + 7], cw = t[i + 8]
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (Math.abs(area) < 1e-9) continue
      const ia = 1 / area
      const i0 = Math.max(gx0, cell(Math.min(ax, bx, cx), g.ox))
      const i1 = Math.min(gx1, cell(Math.max(ax, bx, cx), g.ox))
      const j0 = Math.max(gy0, cell(Math.min(ay, by, cy), g.oy))
      const j1 = Math.min(gy1, cell(Math.max(ay, by, cy), g.oy))
      for (let j = j0; j <= j1; j++) {
        const py = g.oy + (j + 0.5) * STEP
        for (let k = i0; k <= i1; k++) {
          const px = g.ox + (k + 0.5) * STEP
          // barycentric weights (all ≥ 0 inside, whichever the winding)
          const la = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * ia
          if (la < 0) continue
          const lb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * ia
          if (lb < 0) continue
          const lc = 1 - la - lb
          if (lc < 0) continue
          const q = (j - gy0) * w + k - gx0
          const v = at ? at(px, py) : la * aw + lb * bw + lc * cw
          if (v > f[q]) f[q] = v
        }
      }
    }
    return { gx0, gy0, w, h, f }
  }
}

/** A thing from a field: its cells above `min`. null — none. */
function thingOf(name: string, kind: Kind, z: number, fd: Field | null, g: Grid, min = 0): Thing | null {
  if (!fd) return null
  const { gx0, gy0, w, h, f } = fd
  const m = new Uint8Array(w * h)
  let bx0 = Infinity
  let by0 = Infinity
  let bx1 = -Infinity
  let by1 = -Infinity
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      if (!(f[j * w + i] > min)) continue
      m[j * w + i] = 1
      bx0 = Math.min(bx0, i)
      bx1 = Math.max(bx1, i)
      by0 = Math.min(by0, j)
      by1 = Math.max(by1, j)
    }
  if (!Number.isFinite(bx0)) return null
  const box: Box = [g.ox + (gx0 + bx0) * STEP, g.oy + (gy0 + by0) * STEP, g.ox + (gx0 + bx1 + 1) * STEP, g.oy + (gy0 + by1 + 1) * STEP]
  return { name, kind, z, gx0, gy0, w, h, m, box }
}

/** The GPU's shadow blur (shaders.ts → BLUR_FS): a separable gaussian, σ and radius in cells, normalised over the taps. */
function blur(fd: Field, sigma: number, radius: number) {
  if (!(sigma > 0) || radius < 1) return
  const { w, h, f } = fd
  const k: number[] = []
  let ks = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp((-0.5 * i * i) / (sigma * sigma))
    k.push(v)
    ks += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= ks
  const tmp = new Float32Array(w * h)
  // clamp-to-edge, like texelFetch with a clamped index
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let acc = 0
      for (let t = -radius; t <= radius; t++) acc += k[t + radius] * f[j * w + Math.min(w - 1, Math.max(0, i + t))]
      tmp[j * w + i] = acc
    }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let acc = 0
      for (let t = -radius; t <= radius; t++) acc += k[t + radius] * tmp[Math.min(h - 1, Math.max(0, j + t)) * w + i]
      f[j * w + i] = acc
    }
}

/**
 * World triangles → screen triangles through the camera, near-clipped (a triangle partly behind the
 * near plane is cut at it, Sutherland–Hodgman against one plane). `xyz` — world positions, 9 per
 * triangle; `wt` — a weight per vertex (none — 1).
 */
function projectTris(view: AboutCamera, xyz: Float64Array, r: Raster, wt?: Float64Array) {
  // in front of the near plane: the distance along the view (the camera may be turned on the pull)
  const lim = view.near * 1.001
  const out: number[] = []
  const W = (v: number) => (wt ? wt[v] : 1)
  const P = (x: number, y: number, z: number, w: number) => {
    const p = project3(view, x, y, z)
    if (p) out.push(p[0], p[1], w)
  }
  const ds = [0, 0, 0]
  for (let i = 0; i < xyz.length; i += 9) {
    for (let v = 0; v < 3; v++) ds[v] = depthOf(view, xyz[i + 3 * v], xyz[i + 3 * v + 1], xyz[i + 3 * v + 2])
    const vi = i / 3
    if (ds[0] >= lim && ds[1] >= lim && ds[2] >= lim) {
      const a = project3(view, xyz[i], xyz[i + 1], xyz[i + 2])
      const b = project3(view, xyz[i + 3], xyz[i + 4], xyz[i + 5])
      const c = project3(view, xyz[i + 6], xyz[i + 7], xyz[i + 8])
      if (a && b && c) r.tri(a[0], a[1], W(vi), b[0], b[1], W(vi + 1), c[0], c[1], W(vi + 2))
      continue
    }
    if (ds[0] < lim && ds[1] < lim && ds[2] < lim) continue
    // clip: keep the part in front of the near plane
    out.length = 0
    for (let v = 0; v < 3; v++) {
      const j = i + v * 3
      const k = i + ((v + 1) % 3) * 3
      const pin = ds[v] >= lim
      const qin = ds[(v + 1) % 3] >= lim
      if (pin) P(xyz[j], xyz[j + 1], xyz[j + 2], W(vi + v))
      if (pin !== qin) {
        // a hair inside, so project3 keeps the cut point
        const t = (lim * 1.0001 - ds[v]) / (ds[(v + 1) % 3] - ds[v])
        P(xyz[j] + (xyz[k] - xyz[j]) * t, xyz[j + 1] + (xyz[k + 1] - xyz[j + 1]) * t, xyz[j + 2] + (xyz[k + 2] - xyz[j + 2]) * t, W(vi + v) + (W(vi + ((v + 1) % 3)) - W(vi + v)) * t)
      }
    }
    if (out.length >= 9) r.poly(out)
  }
}

/** The eight corners of the unit card box (mesh.ts → cardBox: x, y ∈ ±½, z ∈ −1…0) and its six faces (corner indices). */
const BOX_FACES = [
  [0, 1, 3, 2], // front z = 0
  [4, 5, 7, 6], // back z = −1
  [0, 2, 6, 4], // left
  [1, 3, 7, 5], // right
  [0, 1, 5, 4], // top
  [2, 3, 7, 6], // bottom
]
const corner = (i: number): V3 => [i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? -1 : 0]

interface Scene {
  key: string
  things: Thing[]
  grid: Grid
}

/** What the check sees of the screen: its size (W × the visible height H), the stage's height (the canvas) and the nav's dock. */
export interface View {
  W: number
  H: number
  /** the about canvas's stage height (layout.height; ≥ H) — the cards' "share in the frame" */
  stageH?: number
  /** the docked nav column, CSS px (a note keeps CLEAR from it) */
  dock?: Box | null
}

let last: Scene | null = null
let lastConfig: ResolvedConfig | null = null

/** layers/about/core.ts → stipple (the 4-step reveals): 0, then 1/steps as soon as it starts, …, 1 at its end. */
const stipple = (k: number, steps: number) => (k <= 0 ? 0 : k >= 1 ? 1 : Math.min(steps, Math.floor(k * (steps - 1)) + 1) / steps)

/**
 * Everything of the world on (or just around) the screen, rasterised. Cached for the last call's
 * inputs. The shadows follow the GL frame's recipe (gl.ts, shaders.ts → SHADOW_FS / SHADE_HEAD,
 * core.ts → shadowPool): every caster's footprint is a weight — its SHAPE (a word: 1 over its
 * flattened mesh; a card: the "pool", a superellipse 1 − r² over its picture face grown by its
 * penumbra) × the height fade (1 − shadow.fade × the casting point's height) — blurred by a gaussian
 * of shadow.blur sheet units (on the sheet plane, ≤ 8 render px); a dot where the blurred weight
 * passes shadow.edge AND its density — the density step × the caster's presence (a card leaving the
 * frame takes its shadow with it: shadow.share) — beats the Bayer's first threshold (1/32).
 */
function sceneOf(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr, view: View): Scene {
  const key = [cam.cx, cam.cy, cam.zoom, cam.roll, cam.orbit, cam.h, ...cam.eye, ...cam.fwd, cam.dissolve, JSON.stringify(ptr.words), JSON.stringify(ptr.cards), view.W, view.H, view.stageH].join('|')
  if (last && lastConfig === config && last.key === key) return last
  const grid = gridOf(view.W, view.H)
  const things: Thing[] = []
  last = { key, things, grid }
  lastConfig = config
  if (!cam.active) return last
  const K = aboutKnobs(config)
  const S = K.shadow
  const v = cam
  const steps = K.reveal.photos.steps
  // the dots' density at the core (gl.ts: opacity × the zoom share × the dissolve)
  const dots = S.opacity * shadowShare(S, cam)
  // the lamp each caster's light aims from (core.ts → shadowLamp: a point at the camera)
  const lamp: V3 = shadowLamp(S, v)
  // the blur: shadow.blur sheet units on the sheet plane → render px (≤ 8) → the check's cells
  const cellPx = cam.cell
  const sigmaPx = Math.min(8, (S.blur * v.fpx) / Math.max(1e-6, v.h) / cellPx) * cellPx
  const radiusPx = Math.min(16, Math.ceil(2 * (sigmaPx / cellPx))) * cellPx
  const sigma = sigmaPx / STEP
  const radius = Math.max(0, Math.round(radiusPx / STEP))
  // the dots after the blur (shaders.ts → SHADE_HEAD): shape > edge and dense enough
  const shadowThing = (name: string, z: number, F: Field | null, presence: number) => {
    if (!F || !(dots * presence > 0)) return null
    blur(F, sigma, radius)
    const out = new Float32Array(F.f.length)
    for (let j = 0; j < F.h; j++)
      for (let i = 0; i < F.w; i++) {
        const q = j * F.w + i
        const sx = F.f[q]
        if (!(sx > S.edge)) continue
        const shape = (sx - S.edge) / Math.max(1e-3, 1 - S.edge)
        const d = ((dots * Math.ceil(shape * S.steps - 1e-3)) / S.steps) * presence
        if (d > 1 / 32) out[q] = 1
      }
    return thingOf(name, 'shadow', z, { ...F, f: out }, grid)
  }
  const shadows = dots > 0

  for (const pose of wordPoses(config)) {
    const M = wordModelOf(config, pose, cam, ptr.words[pose.key])
    const mesh = buildWordMesh(pose.look, pose.profile)
    const n = mesh.count
    const src = mesh.position
    const xyz = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      const [x, y, z] = apply4(M, src[i * 3], src[i * 3 + 1], src[i * 3 + 2])
      xyz[i * 3] = x
      xyz[i * 3 + 1] = y
      xyz[i * 3 + 2] = z
    }
    const r = new Raster(grid)
    projectTris(v, xyz, r)
    const t = thingOf(`word:${pose.key}`, 'word', pose.z, r.fill(), grid)
    if (t) things.push(t)
    if (!shadows) continue
    // its shadow: the whole mesh flattened onto its own back plane (shadow.gap behind it); shape 1 ×
    // the fade by each vertex's height above that plane
    const P = wordShadowPlane(M, S.gap)
    const mid = apply4(M, 0, 0, pose.outline.depth / 2)
    const L = lightFrom(lamp, mid[0], mid[1], mid[2])
    const flat = new Float64Array(n * 3)
    const fade = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2]
      const lift = Math.max(0, x * P[0] + y * P[1] + z * P[2] - P[3])
      fade[i] = Math.min(1, Math.max(0, 1 - S.fade * lift))
      const q = onPlane(L, P, x, y, z)
      flat[i * 3] = q[0]
      flat[i * 3 + 1] = q[1]
      flat[i * 3 + 2] = q[2]
    }
    const rs = new Raster(grid)
    projectTris(v, flat, rs, fade)
    const ts = shadowThing(`shadow:${pose.key}`, pose.z, rs.fill(radius + 1), 1)
    if (ts) things.push(ts)
  }

  const stageH = view.stageH ?? view.H
  for (const pose of cardPoses(config)) {
    const M = cardModelOf(pose, ptr.cards[pose.key])
    const c = Array.from({ length: 8 }, (_, i) => apply4(M, ...corner(i)))
    const xyz = new Float64Array(BOX_FACES.length * 2 * 9)
    let o = 0
    for (const f of BOX_FACES) {
      for (const tri of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) for (const k of tri) for (let a = 0; a < 3; a++) xyz[o++] = c[k][a]
    }
    const r = new Raster(grid)
    projectTris(v, xyz, r)
    const t = thingOf(`card:${pose.key}`, 'card', pose.z, r.fill(), grid)
    if (t) things.push(t)
    if (!shadows) continue
    // its presence: the share of its box in the frame (core.ts: shareOnStage / shadow.share, stippled)
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    for (const q of c) {
      const p = project3(v, q[0], q[1], q[2])
      if (!p) continue
      bx0 = Math.min(bx0, p[0])
      by0 = Math.min(by0, p[1])
      bx1 = Math.max(bx1, p[0])
      by1 = Math.max(by1, p[1])
    }
    if (!(bx1 > bx0)) continue
    const area = Math.max(1e-6, (bx1 - bx0) * (by1 - by0))
    const share = (Math.max(0, Math.min(view.W, bx1) - Math.max(0, bx0)) * Math.max(0, Math.min(stageH, by1) - Math.max(0, by0))) / area
    const presence = stipple(Math.min(1, share / S.share), steps)
    if (!(presence > 0)) continue
    // the pool (core.ts → shadowPool): the picture face grown by the penumbra on every side, flattened
    // onto the sheet plane under the card; its shape a superellipse 1 − r² over the grown face
    const P: Plane = cardShadowPlane(M)
    // (its height: the picture's centre where the pointer turn has put it — core.ts, gl.ts)
    const pool = shadowPool(S, M[14] - P[3], pose.width, pose.height)
    const face = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([u, w]) => apply4(M, u * pool.gx, w * pool.gy, 0))
    const lift = face.map((q) => Math.max(0, q[0] * P[0] + q[1] * P[1] + q[2] * P[2] - P[3]))
    const L = lightFrom(lamp, M[12], M[13], M[14])
    const fl = face.map((q) => onPlane(L, P, q[0], q[1], q[2]))
    // uv over the grown face ↔ the point on the (horizontal) shadow plane: affine
    const ex = [fl[1][0] - fl[0][0], fl[1][1] - fl[0][1]]
    const ey = [fl[3][0] - fl[0][0], fl[3][1] - fl[0][1]]
    const det = ex[0] * ey[1] - ex[1] * ey[0]
    if (Math.abs(det) < 1e-12) continue
    const uvAt = (px: number, py: number): [number, number] | null => {
      const q = unproject(v, px, py, P[3])
      if (!q) return null
      const dx = q[0] - fl[0][0]
      const dy = q[1] - fl[0][1]
      const u = (dx * ey[1] - dy * ey[0]) / det
      const w = (ex[0] * dy - ex[1] * dx) / det
      return u < 0 || u > 1 || w < 0 || w > 1 ? null : [u, w]
    }
    const shapeAt = (uv: [number, number] | null) => {
      if (!uv) return 0
      const ux = Math.abs(uv[0] - 0.5) * 2
      const uy = Math.abs(uv[1] - 0.5) * 2
      const r = Math.pow(Math.pow(ux, pool.n) + Math.pow(uy, pool.n), 1 / pool.n)
      return Math.min(1, Math.max(0, 1 - r * r))
    }
    const fadeAt = (uv: [number, number]) => Math.min(1, Math.max(0, 1 - S.fade * (lift[0] + (lift[1] - lift[0]) * uv[0] + (lift[3] - lift[0]) * uv[1])))
    const pts = fl.map((q) => project3(v, q[0], q[1], q[2]))
    if (pts.some((q) => !q)) continue
    const rs = new Raster(grid)
    rs.poly(pts.flatMap((q) => [q![0], q![1], 1]))
    const F = rs.fill(radius + 1, (px, py) => {
      const uv = uvAt(px, py)
      return uv ? shapeAt(uv) * fadeAt(uv) : 0
    })
    const ts = shadowThing(`shadow:${pose.key}`, pose.z, F, presence)
    if (ts) things.push(ts)
  }
  return last
}

const meets = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

/**
 * The things on screen — debug (stats().things): name, its covered box on screen (CSS px, the part
 * within the screen + a margin) and its height z (sheet units: the depth plan of the frame).
 */
export function thingsAt(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr, view: View) {
  const screen: Box = [0, 0, view.W, view.H]
  return sceneOf(config, cam, ptr, view)
    .things.filter((t) => t.box && meets(t.box, screen))
    .map((t) => ({ name: t.name, box: t.box!.map((v) => Math.round(v)), z: +t.z.toFixed(3) }))
}

/**
 * Which things (words, cards, shadows) have any of their shape inside `box` (screen CSS px, cell
 * centres) — debug: is anything parked under the docked nav at a rest key (stats().underDock /
 * stats({ box }).inBox)?
 */
export function shapesIn(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr, box: Box, view: View) {
  const sc = sceneOf(config, cam, ptr, view)
  const g = sc.grid
  const out: string[] = []
  for (const t of sc.things) {
    if (!t.box || !meets(t.box, box)) continue
    let hit = false
    const i0 = Math.max(0, Math.ceil((box[0] - g.ox) / STEP - 0.5) - t.gx0)
    const i1 = Math.min(t.w - 1, Math.floor((box[2] - g.ox) / STEP - 0.5) - t.gx0)
    const j0 = Math.max(0, Math.ceil((box[1] - g.oy) / STEP - 0.5) - t.gy0)
    const j1 = Math.min(t.h - 1, Math.floor((box[3] - g.oy) / STEP - 0.5) - t.gy0)
    for (let j = j0; j <= j1 && !hit; j++) for (let i = i0; i <= i1 && !hit; i++) hit = t.m[j * t.w + i] === 1
    if (hit) out.push(t.name)
  }
  return out
}

/**
 * Pairs of SOLID things on screen — words and cards — whose shapes come closer than CLEAR px to each
 * other (0: touching or over each other), debug (stats().clashes): the cards and the giant letters keep
 * their distance from the words and from each other as the notes do. Only the part on screen counts
 * (a fragment running off an edge is meant to). Shadows are left out: they fall only on the void (a
 * card's shadow is not drawn over another card or a letter). The distance is a 3-4 chamfer on the
 * STEP px grid (within ≈ 8 % of the true one, ± a step).
 */
export function clashesAt(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr, view: View) {
  const sc = sceneOf(config, cam, ptr, view)
  const g = sc.grid
  // on screen only: clip each solid's mask to the screen's cells
  const sx0 = Math.ceil(-g.ox / STEP)
  const sy0 = Math.ceil(-g.oy / STEP)
  const sx1 = Math.floor((view.W - g.ox) / STEP) - 1
  const sy1 = Math.floor((view.H - g.oy) / STEP) - 1
  const on = sc.things.filter((t) => t.kind !== 'shadow' && t.box && meets(t.box, [0, 0, view.W, view.H]))
  const R = Math.ceil(CLEAR / STEP) + 1
  const out: Record<string, number> = {}
  const cellOn = (t: Thing, x: number, y: number) => x >= sx0 && x <= sx1 && y >= sy0 && y <= sy1 && t.m[(y - t.gy0) * t.w + x - t.gx0] === 1
  for (let i = 0; i < on.length; i++) {
    const b = on[i]
    const bx1 = b.gx0 + b.w - 1
    const by1 = b.gy0 + b.h - 1
    const rx0 = Math.max(sx0, b.gx0 - R)
    const ry0 = Math.max(sy0, b.gy0 - R)
    const rx1 = Math.min(sx1, bx1 + R)
    const ry1 = Math.min(sy1, by1 + R)
    if (rx1 < rx0 || ry1 < ry0) continue
    const rw = rx1 - rx0 + 1
    const rh = ry1 - ry0 + 1
    let d: Int32Array | null = null
    for (let j = i + 1; j < on.length; j++) {
      const a = on[j]
      if (a.gx0 + a.w - 1 < rx0 || a.gx0 > rx1 || a.gy0 + a.h - 1 < ry0 || a.gy0 > ry1) continue
      if (!d) {
        const INF = 1 << 28
        d = new Int32Array(rw * rh).fill(INF)
        for (let y = Math.max(b.gy0, ry0); y <= Math.min(by1, ry1); y++)
          for (let x = Math.max(b.gx0, rx0); x <= Math.min(bx1, rx1); x++) if (cellOn(b, x, y)) d[(y - ry0) * rw + x - rx0] = 0
        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            const k = y * rw + x
            let v = d[k]
            if (x > 0) v = Math.min(v, d[k - 1] + 3)
            if (y > 0) {
              v = Math.min(v, d[k - rw] + 3)
              if (x > 0) v = Math.min(v, d[k - rw - 1] + 4)
              if (x < rw - 1) v = Math.min(v, d[k - rw + 1] + 4)
            }
            d[k] = v
          }
        }
        for (let y = rh - 1; y >= 0; y--) {
          for (let x = rw - 1; x >= 0; x--) {
            const k = y * rw + x
            let v = d[k]
            if (x < rw - 1) v = Math.min(v, d[k + 1] + 3)
            if (y < rh - 1) {
              v = Math.min(v, d[k + rw] + 3)
              if (x < rw - 1) v = Math.min(v, d[k + rw + 1] + 4)
              if (x > 0) v = Math.min(v, d[k + rw - 1] + 4)
            }
            d[k] = v
          }
        }
      }
      let best = Infinity
      const ay1 = a.gy0 + a.h - 1
      const ax1 = a.gx0 + a.w - 1
      for (let y = Math.max(a.gy0, ry0); y <= Math.min(ay1, ry1); y++)
        for (let x = Math.max(a.gx0, rx0); x <= Math.min(ax1, rx1); x++) if (cellOn(a, x, y)) best = Math.min(best, d[(y - ry0) * rw + x - rx0])
      // thirds of a step → px; neighbouring cells are one step apart, i.e. a gap of S − S: touching
      const px = Number.isFinite(best) ? Math.max(0, (best / 3 - 1) * STEP) : Infinity
      if (px < CLEAR) out[[a.name, b.name].sort().join(' × ')] = Math.round(px)
    }
  }
  return out
}

/** The gap between two boxes, px: the larger of the horizontal and vertical gaps (negative: they overlap). */
const gap = (a: Box, b: Box) => Math.max(b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3])

/** The nearest covered cell of a thing to a line's box, px (0: touching or over it); Infinity past CLEAR. */
function nearest(t: Thing, g: Grid, b: Box): number {
  if (!t.box) return Infinity
  const q: Box = [b[0] - CLEAR, b[1] - CLEAR, b[2] + CLEAR, b[3] + CLEAR]
  if (!meets(q, t.box)) return Infinity
  let best = Infinity
  const i0 = Math.max(0, Math.floor((q[0] - g.ox) / STEP) - t.gx0)
  const i1 = Math.min(t.w - 1, Math.floor((q[2] - g.ox) / STEP) - t.gx0)
  const j0 = Math.max(0, Math.floor((q[1] - g.oy) / STEP) - t.gy0)
  const j1 = Math.min(t.h - 1, Math.floor((q[3] - g.oy) / STEP) - t.gy0)
  for (let j = j0; j <= j1; j++) {
    // the cell's nearest point to the box
    const cy0 = g.oy + (t.gy0 + j) * STEP
    const dy = Math.max(b[1] - (cy0 + STEP), 0, cy0 - b[3])
    if (dy >= best) continue
    for (let i = i0; i <= i1; i++) {
      if (t.m[j * t.w + i] !== 1) continue
      const cx0 = g.ox + (t.gx0 + i) * STEP
      const d = Math.hypot(Math.max(b[0] - (cx0 + STEP), 0, cx0 - b[2]), dy)
      if (d < best) best = d
    }
  }
  return best
}

/**
 * What each line of each note comes closer than CLEAR px to: things (word: / card: / shadow:), other
 * notes (note:), the docked nav column (dock) and the screen edges (edge — a note passing by is partly
 * off screen by design; at a rest key it must not be). 'name Npx' per note, only notes with any.
 */
export function overlapsAt(
  config: ResolvedConfig,
  cam: AboutCamera,
  ptr: Ptr,
  notes: { name: string; lines: Box[] }[],
  view: View & { dock: Box },
) {
  const sc = sceneOf(config, cam, ptr, view)
  const out: Record<string, string[]> = {}
  const screen: Box = [0, 0, view.W, view.H]
  for (const n of notes) {
    const near = new Map<string, number>()
    const note = (name: string, d: number) => {
      if (d < CLEAR) near.set(name, Math.min(near.get(name) ?? Infinity, d))
    }
    for (const b of n.lines) {
      if (!meets(b, screen)) continue
      for (const t of sc.things) note(t.name, nearest(t, sc.grid, b))
      for (const o of notes) if (o !== n) for (const ob of o.lines) note(`note:${o.name}`, Math.max(0, gap(b, ob)))
      note('dock', Math.max(0, gap(b, view.dock)))
      note('edge', Math.max(0, Math.min(b[0], b[1], view.W - b[2], view.H - b[3])))
    }
    if (near.size) out[n.name] = [...near].map(([name, d]) => `${name} ${Math.round(d)}px`)
  }
  return out
}

/** Colours of the debug outline (drawOutline), by kind. */
const INK: Record<Kind | 'note' | 'dock', string> = { word: '#e0302a', card: '#2a64e0', shadow: '#e08a1a', note: '#18a050', dock: '#9b30d0' }

/**
 * Debug: the check's own picture of the frame, drawn over the page (a fixed canvas, pointer-events
 * none) — the outline of every thing's covered cells (word red, card blue, shadow orange), each note
 * line's box (green) and the dock (violet), to compare with the render by eye. Returns the canvas.
 */
export function drawOutline(
  config: ResolvedConfig,
  cam: AboutCamera,
  ptr: Ptr,
  notes: { name: string; lines: Box[] }[],
  view: View & { dock: Box },
  canvas: HTMLCanvasElement,
) {
  const sc = sceneOf(config, cam, ptr, view)
  const g = sc.grid
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(view.W * dpr)
  canvas.height = Math.round(view.H * dpr)
  Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: `${view.W}px`, height: `${view.H}px`, pointerEvents: 'none', zIndex: '2147483647' })
  const c = canvas.getContext('2d')!
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, view.W, view.H)
  for (const t of sc.things) {
    c.fillStyle = INK[t.kind]
    for (let j = 0; j < t.h; j++)
      for (let i = 0; i < t.w; i++) {
        if (t.m[j * t.w + i] !== 1) continue
        // a cell on the boundary of the mask
        const edge = i === 0 || j === 0 || i === t.w - 1 || j === t.h - 1 || !t.m[j * t.w + i - 1] || !t.m[j * t.w + i + 1] || !t.m[(j - 1) * t.w + i] || !t.m[(j + 1) * t.w + i]
        if (edge) c.fillRect(g.ox + (t.gx0 + i) * STEP, g.oy + (t.gy0 + j) * STEP, STEP, STEP)
      }
  }
  c.lineWidth = 1
  c.strokeStyle = INK.note
  for (const n of notes) for (const b of n.lines) c.strokeRect(b[0] + 0.5, b[1] + 0.5, b[2] - b[0] - 1, b[3] - b[1] - 1)
  c.strokeStyle = INK.dock
  const d = view.dock
  c.strokeRect(d[0] + 0.5, d[1] + 0.5, d[2] - d[0] - 1, d[3] - d[1] - 1)
  return canvas
}
