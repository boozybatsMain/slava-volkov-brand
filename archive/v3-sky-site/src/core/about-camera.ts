import { clamp, clamp01, lerp, remap, smoother } from './ease'
import { apply4, entryCounter, type M4 } from './about-pose'
import { fitInConvex } from '../layers/about/mesh'
import { num, obj, type Loose } from './loose'
import type { Layout, ResolvedConfig, ScrollState } from './types'

/**
 * ABOUT — the camera of the one world (version 2, third screen; numbers: sky.config.ts → about).
 *
 * A PURE function of (config, layout, scroll): every reader computes the very same camera in the same
 * frame, whatever order it updates in — the canvas (layers/about), the DOM notes (layers/about-text),
 * the nav (sky-overlay, which updates BEFORE them: under reduced motion it waits for the dissolve).
 * The pointer never moves it: the elements turn toward the pointer about their own centres
 * (core/about-pose.ts → AboutTurns), the camera and the sheet stay where the scroll put them.
 *
 * WORLD = SHEET UNITS: origin — the centre of the flat word ABOUT, 1 = its flat ink width, x right,
 * y DOWN, z = height TOWARD the camera. z = 0 is the SHEET PLANE: the notes, the shadows.
 * CAMERA: a pinhole at `eye` with its own axes — `right` (the screen's x), `down` (the screen's y) and
 * `fwd` (where it looks); fpx = (visibleH / 2) / tan(about.camera.fov / 2) (CSS px). A point P is on
 * screen at
 *   S(P) = (right · (P − eye), down · (P − eye)) · fpx / d + (W / 2, visibleH / 2),  d = fwd · (P − eye)
 * — project3; d < near: behind the camera (null). For a GPU: clipMatrix (sheet units → clip space).
 * At HOME and on the TOUR it looks straight down −z, rolled by `roll`, from height h = F / zoom over
 * (cx, cy) (F = fpx / U, U — px per unit at zoom 1): on the sheet plane that is exactly the 2D map
 * R(roll) · (p − c) · U · zoom + o (toScreen / toSheet), so everything laid out on the sheet keeps its
 * place.
 *
 * Two moves, both functions of pos:
 *   PULL (about.pull.from → to): the word ABOUT stands in its own pose all the time; the camera starts
 *     INSIDE the counter of its A, looking straight down the counter's tunnel (along the word's turned
 *     normal), so close (start zoom z0, computed per screen) that the whole screen rectangle, mapped onto
 *     the back plane, lies inside the counter (× pull.margin) — the first frame is the bare void. It
 *     backs out straight along the tunnel's axis (no turn while inside — the camera never gets into a
 *     letter) and, once out, turns to the home view (straight down at tour.keys.home) in ONE rotation
 *     about one axis — a quaternion slerp from the start orientation (the word's normal, rolled by
 *     pull.roll) to the home one, at a near-constant angular speed in pos with soft ends
 *     (about.pull.orbit) — until the landing (pull.to). Its position follows that turn: the point it
 *     started over (E, in the counter) slides from the frame's centre to its home spot at the same pace
 *     as the turn, at the distance of the pull's zoom tempo (about.pull.keys: a monotone cubic in ln
 *     zoom) — so the move never adds a counter-turn of its own (a sideways drift faster than the turn
 *     read as the word turning one way, then the other).
 *   TOUR (pos 2 → 3): a non-uniform Catmull-Rom curve through about.tour.keys (zig-zag), zoom and
 *     roll on the same curve (zoom in log space), each segment's progress eased by tour.dwell (the
 *     speed through a key stays continuous). Starts and ends at rest.
 * Reduced motion: no pull (the scene dissolves in at the home framing over about.pull.reduced —
 * `dissolve`, orbit 1), the tour is a straight line through the keys (their zoom kept), no roll.
 */

export type V3 = [number, number, number]

/**
 * The centre of the A's counter (sheet units, on the entry word's back plane, the word in its own pose)
 * and the radius of the largest circle inside the counter there.
 */
export interface AboutEntry {
  x: number
  y: number
  r: number
}

export interface TourKey {
  name: string
  at: number
  x: number
  y: number
  zoom: number
  roll: number
}

export interface AboutCamera {
  /** the about scene is in the picture at all (pos past pull.from) */
  active: boolean
  /** sheet point at the centre of the visible frame (the camera stands right above it) */
  cx: number
  cy: number
  zoom: number
  /** radians, + = clockwise on screen */
  roll: number
  /** px per sheet unit at zoom 1 ON THE SHEET PLANE (z = 0); `scale` = U · zoom */
  U: number
  scale: number
  /** screen point the camera centre lands on, CSS px (W / 2, visibleH / 2) */
  ox: number
  oy: number
  /** pull progress 0…1 (raw, not eased); 1 from pull.to on */
  pull: number
  /** the pull's start zoom (computed per screen: the screen inside the A's counter) */
  z0: number
  /** tour progress 0…1 (pos 2 → 3) */
  tour: number
  /** float index into the tour keys: 0 home … n − 1 end (between keys while travelling) */
  key: number
  /** reduced motion: how far the scene has dissolved in (about.pull.reduced), 0…1 in 4 stipple steps (1 when not reduced) */
  dissolve: number
  /** one raster cell, CSS px (device-snapped) — see aboutCell */
  cell: number
  /** the visible height used for the framing, CSS px */
  viewH: number
  reduced: boolean
  /** focal length, CSS px: (visibleH / 2) / tan(about.camera.fov / 2) */
  fpx: number
  /** the camera's distance at zoom 1, sheet units (= fpx / U); h = F / zoom */
  F: number
  /**
   * the camera's distance to the point it looks at (cx, cy — the frame's centre), sheet units: at home
   * and on the tour its height above the sheet plane; px per unit there = fpx / h = U · zoom
   */
  h: number
  /** near / far clipping distances along the view (near = about.camera.near × h) */
  near: number
  far: number
  /** where the camera is, sheet units */
  eye: V3
  /** its axes, unit vectors in sheet units: the screen's x, the screen's y (down), the view direction */
  right: V3
  down: V3
  fwd: V3
  /** how far the view is turned from straight down (−z), radians: 0 at home and on the tour */
  tilt: number
  /**
   * the camera's turn on the pull, 0…1: 0 — looking down the A's counter tunnel (inside it and while it
   * backs out), 1 — the home view (from the landing on, the tour, reduced motion). The entry word's
   * pointer turn grows with it (core/about-pose.ts → wordModelOf).
   */
  orbit: number
  /**
   * the sheet's x / y / z axes carried along by that turn (unit vectors; the identity at home and on the
   * tour): what hangs off the camera (the concrete's glint lamp, cameraLamp) turns with it
   */
  carry: [V3, V3, V3]
  /** the pos at which the backing camera leaves the counter's tunnel (passes the A's front face) on this screen — it never turns before it */
  exit: number
}

const DEG = Math.PI / 180

/** about.* read loosely (core never depends on one page's config type). */
export function aboutOf(config: ResolvedConfig): Loose {
  return obj((config as unknown as { about?: unknown }).about)
}

/** The visible height the framing is computed for: 100svh (controls and texts stay inside it). */
export function viewHeight(layout: Layout, scroll: ScrollState) {
  return scroll.safeH > 0 ? Math.min(scroll.safeH, layout.height) : layout.height
}

/** px per sheet unit at zoom 1. */
export function aboutUnit(config: ResolvedConfig, layout: Layout, viewH: number) {
  const w = obj(aboutOf(config).word)
  const base = Math.min(layout.width, Math.max(0.1, num(w.aspect, 1.6)) * viewH)
  return Math.max(1, (num(w.width, 62) / 100) * base)
}

/**
 * One raster cell of the about sheet, CSS px: max(pixelSize, W / renderWidth), rounded to whole
 * device pixels (as the slab's lattice: regular patterns must not band).
 */
export function aboutCell(config: ResolvedConfig, layout: Layout) {
  const r = obj(aboutOf(config).raster)
  const dpr = window.devicePixelRatio || 1
  const css = Math.max(0.25, num(r.pixelSize, 1.5), layout.width / Math.max(50, num(r.renderWidth, 760)))
  return Math.max(1, Math.round(css * dpr)) / dpr
}

/**
 * The centre of the entry word's counter (the A of ABOUT, about.words.about) — in the word's own pose,
 * sheet units — and the radius of the largest circle inside it. Computed from the baked
 * outline (layers/about/mesh.ts); a config without such a word falls back to about.pull.entry.
 */
export function aboutEntry(config: ResolvedConfig): AboutEntry {
  const c = entryCounter(config)
  if (c) return { x: c.x, y: c.y, r: Math.max(1e-4, c.r) }
  const e = obj(obj(aboutOf(config).pull).entry)
  return { x: num(e.x, -0.396), y: num(e.y, 0.005), r: Math.max(1e-3, num(e.r, 0.016)) }
}

/** The tour keys, sorted by `at`. Always at least one (a config without keys gets the origin). */
export function tourKeys(config: ResolvedConfig): TourKey[] {
  const keys = obj(obj(aboutOf(config).tour).keys)
  const out: TourKey[] = Object.entries(keys).map(([name, v]) => {
    const k = obj(v)
    return { name, at: clamp01(num(k.at, 0)), x: num(k.x, 0), y: num(k.y, 0), zoom: Math.max(0.05, num(k.zoom, 1)), roll: num(k.roll, 0) }
  })
  out.sort((a, b) => a.at - b.at)
  return out.length ? out : [{ name: 'home', at: 0, x: 0, y: 0, zoom: 1, roll: 0 }]
}

/** Centre of the tour key a thing belongs to (its `topic`) — the frame its place is composed for. */
export function topicCenter(config: ResolvedConfig, topic: string): { x: number; y: number } {
  const k = obj(obj(obj(aboutOf(config).tour).keys)[topic])
  if (!('x' in k)) {
    const first = tourKeys(config)[0]
    return { x: first.x, y: first.y }
  }
  return { x: num(k.x, 0), y: num(k.y, 0) }
}

// ── interpolation ──────────────────────────────────────────────────────────────────────────────

/** Fritsch–Carlson slopes of a monotone cubic through (xs, ys). */
function pchipSlopes(xs: number[], ys: number[]) {
  const n = xs.length
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]))
  const m = new Array<number>(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue
    const h0 = xs[i] - xs[i - 1]
    const h1 = xs[i + 1] - xs[i]
    const w1 = 2 * h1 + h0
    const w2 = h1 + 2 * h0
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
  }
  // ends at rest: the pull starts from a standing camera and lands on the home framing
  return m
}

/** Cubic Hermite on [x0, x1] with values y0 / y1 and slopes m0 / m1 (per unit of x). */
function hermite(x0: number, x1: number, y0: number, y1: number, m0: number, m1: number, u: number) {
  const h = x1 - x0
  const u2 = u * u
  const u3 = u2 * u
  return (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * h * m1
}

function segmentOf(xs: number[], x: number) {
  let i = 0
  while (i < xs.length - 2 && x >= xs[i + 1]) i++
  return i
}

/** Non-uniform Catmull-Rom slopes (per unit of `at`): ends at rest. */
function catmullSlopes(ts: number[], ys: number[]) {
  const n = ts.length
  const m = new Array<number>(n).fill(0)
  for (let i = 1; i < n - 1; i++) m[i] = (ys[i + 1] - ys[i - 1]) / Math.max(1e-9, ts[i + 1] - ts[i - 1])
  return m
}

// ── the camera ─────────────────────────────────────────────────────────────────────────────────

/** Camera on the tour at progress t (0…1). */
function tourAt(keys: TourKey[], t: number, dwell: number, reduced: boolean) {
  const n = keys.length
  const last = keys[n - 1]
  // reduced motion keeps every key's framing (its zoom: the finale is composed for 0.9) and drops
  // only the roll and the curve
  const at = (k: TourKey, key: number) => ({ x: k.x, y: k.y, zoom: k.zoom, roll: reduced ? 0 : k.roll * DEG, key })
  if (n === 1 || t <= keys[0].at) return at(keys[0], 0)
  if (t >= last.at) return at(last, n - 1)
  const ts = keys.map((k) => k.at)
  const i = segmentOf(ts, t)
  const u0 = remap(t, ts[i], ts[i + 1])
  if (reduced) {
    const a = keys[i]
    const b = keys[i + 1]
    return { x: lerp(a.x, b.x, u0), y: lerp(a.y, b.y, u0), zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), u0)), roll: 0, key: i + u0 }
  }
  // dwell slows the camera near every key; the speed through a key stays continuous (the eased
  // progress has the same slope, 1 − dwell, at both ends of every segment)
  const u = lerp(u0, smoother(u0), clamp(dwell, 0, 0.85))
  const curve = (ys: number[]) => {
    const m = catmullSlopes(ts, ys)
    return hermite(ts[i], ts[i + 1], ys[i], ys[i + 1], m[i], m[i + 1], u)
  }
  return {
    x: curve(keys.map((k) => k.x)),
    y: curve(keys.map((k) => k.y)),
    zoom: Math.exp(curve(keys.map((k) => Math.log(k.zoom)))),
    roll: curve(keys.map((k) => k.roll)) * DEG,
    key: i + u0,
  }
}

// ── the lens ───────────────────────────────────────────────────────────────────────────────────────

/** Below the sheet plane the far plane reaches this far (sheet units): every object lies above it. */
const FAR_BELOW = 4

/** about.camera: vertical field of view (degrees) and the near plane (share of the camera's height). */
export function cameraKnobs(config: ResolvedConfig) {
  const c = obj(aboutOf(config).camera)
  return { fov: clamp(num(c.fov, 34), 5, 120), near: clamp(num(c.near, 0.01), 1e-4, 0.5) }
}

/** Focal length, CSS px, for this visible height. */
export function focalPx(config: ResolvedConfig, viewH: number) {
  return viewH / 2 / Math.tan((cameraKnobs(config).fov * DEG) / 2)
}

// ── 3D helpers ─────────────────────────────────────────────────────────────────────────────────────

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** A camera's axes: the screen's x, the screen's y (down), the view direction. */
interface Axes {
  right: V3
  down: V3
  fwd: V3
}

/** Looking straight down −z, rolled by `roll` (radians, + clockwise on screen): the home / tour camera. */
function topDown(roll: number): Axes {
  const c = Math.cos(roll)
  const s = Math.sin(roll)
  return { right: [c, -s, 0], down: [s, c, 0], fwd: [0, 0, -1] }
}

type Quat = [number, number, number, number]

/**
 * Axes → unit quaternion (x, y, z, w) of the proper rotation whose rows are right, down, −fwd (the
 * screen's x, its y and the direction toward the viewer: right-handed, det +1).
 */
function quatOf(a: Axes): Quat {
  const m00 = a.right[0], m01 = a.right[1], m02 = a.right[2]
  const m10 = a.down[0], m11 = a.down[1], m12 = a.down[2]
  const m20 = -a.fwd[0], m21 = -a.fwd[1], m22 = -a.fwd[2]
  const tr = m00 + m11 + m22
  let q: Quat
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1)
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

function axesOf(q: Quat): Axes {
  const [x, y, z, w] = q
  return {
    right: [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    down: [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    fwd: [-2 * (x * z - y * w), -2 * (y * z + x * w), -(1 - 2 * (x * x + y * y))],
  }
}

/** The turn from q0 to q1 taken u of the way: one rotation about one axis at a constant angular speed in u. */
function slerp(q0: Quat, q1: Quat, u: number): Quat {
  let d = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]
  const b: Quat = d < 0 ? [-q1[0], -q1[1], -q1[2], -q1[3]] : q1
  d = Math.abs(d)
  let k0 = 1 - u
  let k1 = u
  if (d < 0.9999995) {
    const th = Math.acos(Math.min(1, d))
    const s = Math.sin(th)
    k0 = Math.sin((1 - u) * th) / s
    k1 = Math.sin(u * th) / s
  }
  const q: Quat = [q0[0] * k0 + b[0] * k1, q0[1] * k0 + b[1] * k1, q0[2] * k0 + b[2] * k1, q0[3] * k0 + b[3] * k1]
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

/** The whole angle between two orientations, radians. */
function angleOf(q0: Quat, q1: Quat) {
  const d = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3])
  return 2 * Math.acos(Math.min(1, d))
}

const IDENTITY_CARRY: [V3, V3, V3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

/**
 * The sheet's axes carried by the turn from `home` to `now` (columns of nowᵀ · home, rows = right,
 * down, −fwd): what hangs off the home camera hangs the same way off this one.
 */
function carryOf(now: Axes, home: Axes): [V3, V3, V3] {
  const N = [now.right, now.down, [-now.fwd[0], -now.fwd[1], -now.fwd[2]] as V3]
  const H = [home.right, home.down, [-home.fwd[0], -home.fwd[1], -home.fwd[2]] as V3]
  // (Nᵀ H) e_j = Σ_i N_i · H_ij
  const col = (j: number): V3 => [0, 1, 2].reduce<V3>((acc, i) => [acc[0] + N[i][0] * H[i][j], acc[1] + N[i][1] * H[i][j], acc[2] + N[i][2] * H[i][j]], [0, 0, 0])
  return [col(0), col(1), col(2)]
}

// ── the pull's first frame ─────────────────────────────────────────────────────────────────────────

/** Where the pull starts and how close, for one screen. */
export interface EntryFit {
  /** E: the point the camera starts over — on the counter's back plane, inside the counter — sheet units */
  x: number
  y: number
  /**
   * the counter's centre height (its back plane there) and the tunnel's top (the front face) as the zoom
   * counts them: inside the tunnel F / zoom − plane = the camera's distance from the back plane along the
   * axis (the zoom tempo of the old straight rise, unchanged)
   */
  plane: number
  top: number
  /** the start zoom (× margin, clamped to [1, pull.max]) */
  z0: number
  /** the zoom at which the backing camera passes the front face (≤ z0): until then it backs straight out along the axis */
  zFace: number
  /** sheet units per screen px on that plane at which the screen rectangle exactly fits the counter */
  k: number
  /** false — pull.max clamped z0 (the first frame is not the bare void) or there is no counter */
  fits: boolean
  /** E in 3D */
  E: V3
  /** the camera's axes at the start: looking down the counter tunnel (fwd = −the word's normal), the word's own x at (word rotation + pull.roll) on screen */
  start: Axes
}

const fitCache = new WeakMap<object, Map<string, EntryFit>>()

/**
 * The pull's start for this screen. The camera looks straight down the entry word's counter tunnel (the
 * word stands in its own pose; the camera's axes: −the word's normal, and the word's own x axis at
 * (its rotation + pull.roll) on screen — as the first frames were when the word itself started face-on),
 * so the counter is a flat polygon on the back plane facing the camera; the frustum is widest there
 * (the walls run straight along the view, the front bevel only widens the opening). The largest view of
 * that plane in which the WHOLE stage rectangle (W × layout.height around the camera centre (W / 2,
 * visibleH / 2)) still lies inside the counter — the first frame shows nothing but the void; z0 is that
 * zoom × pull.margin. Pure, cached per (config, screen).
 */
export function entryFit(config: ResolvedConfig, layout: Layout, viewH: number): EntryFit {
  const W = Math.max(1, layout.width)
  const H = Math.max(1, layout.height)
  const pull = obj(aboutOf(config).pull)
  const key = `${W}|${H}|${viewH}`
  let byScreen = fitCache.get(config)
  if (!byScreen) {
    byScreen = new Map()
    fitCache.set(config, byScreen)
  }
  const hit = byScreen.get(key)
  if (hit) return hit
  const U = aboutUnit(config, layout, viewH)
  const fpx = focalPx(config, viewH)
  const F = fpx / U
  const margin = Math.max(0.5, num(pull.margin, 1.02))
  const max = Math.max(1, num(pull.max, 150))
  const ox = W / 2
  const oy = viewH / 2
  // the stage corners around the camera centre, screen px (the camera's own axes)
  const vs: number[] = []
  for (const [sx, sy] of [[0, 0], [W, 0], [W, H], [0, H]]) vs.push(sx - ox, sy - oy)
  const counter = entryCounter(config)
  const words = obj(aboutOf(config).words)
  const rot = num(obj(words.about).rotation, 0)
  const roll = (rot + num(pull.roll, 0)) * DEG
  let out: EntryFit
  // the start axes: the word's x at `roll` on screen — wx = cos · right + sin · down
  const axes = counter
    ? {
        right: unit3([Math.cos(roll) * counter.wx[0] - Math.sin(roll) * counter.wy[0], Math.cos(roll) * counter.wx[1] - Math.sin(roll) * counter.wy[1], Math.cos(roll) * counter.wx[2] - Math.sin(roll) * counter.wy[2]]),
        down: unit3([Math.sin(roll) * counter.wx[0] + Math.cos(roll) * counter.wy[0], Math.sin(roll) * counter.wx[1] + Math.cos(roll) * counter.wy[1], Math.sin(roll) * counter.wx[2] + Math.cos(roll) * counter.wy[2]]),
        fwd: [-counter.n[0], -counter.n[1], -counter.n[2]] as V3,
      }
    : null
  // the counter on its back plane in the start view's own 2D axes
  let fit: { k: number; x: number; y: number } | null = null
  if (counter && axes) {
    const ring = new Float64Array((counter.ring.length / 3) * 2)
    for (let i = 0, j = 0; i < counter.ring.length; i += 3, j += 2) {
      const d: V3 = [counter.ring[i] - counter.x, counter.ring[i + 1] - counter.y, counter.ring[i + 2] - counter.z]
      ring[j] = dot3(d, axes.right)
      ring[j + 1] = dot3(d, axes.down)
    }
    fit = fitInConvex(ring, vs)
  }
  if (counter && axes && fit && fit.k > 0) {
    const E: V3 = [
      counter.x + axes.right[0] * fit.x + axes.down[0] * fit.y,
      counter.y + axes.right[1] * fit.x + axes.down[1] * fit.y,
      counter.z + axes.right[2] * fit.x + axes.down[2] * fit.y,
    ]
    // fpx / D px per unit on the back plane = margin / k  →  D = fpx · k / margin; F / zoom = plane + D
    const plane = counter.z
    const h = plane + (fpx * fit.k) / margin
    const z = F / Math.max(1e-6, h)
    const z0 = clamp(z, 1, max)
    const top = plane + counter.depth
    const zFace = clamp(F / Math.max(1e-6, top), 1, z0)
    out = { x: E[0], y: E[1], plane, top, z0, zFace, k: fit.k, fits: z <= max && z >= 1, E, start: axes }
  } else {
    // no counter: straight down over a circle of about.pull.entry's radius around its point (the old rule)
    const e = aboutEntry(config)
    const halfDiag = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy))
    const z = (halfDiag / (e.r * U)) * margin
    const z0 = clamp(z, 1, max)
    out = { x: e.x, y: e.y, plane: 0, top: 0, z0, zFace: z0, k: e.r / halfDiag, fits: false, E: [e.x, e.y, 0], start: topDown(num(pull.roll, 0) * DEG) }
  }
  byScreen.set(key, out)
  return out
}

/**
 * Linear progress u (0…1) with soft ends: the speed rises over the first `e` of the way and falls over
 * the last `e` (half-cosine ramps), constant between — e 0: constant speed with a hard start and stop;
 * e 0.5: an S curve with no constant middle. The peak speed is 1 / (1 − e) of the average.
 */
export function easeEnds(u: number, e: number) {
  if (u <= 0) return 0
  if (u >= 1) return 1
  if (e <= 1e-4) return u
  const v = 1 / (1 - e)
  const ramp = (x: number) => v * (x / 2 - (e / (2 * Math.PI)) * Math.sin((Math.PI * x) / e))
  if (u < e) return ramp(u)
  if (u > 1 - e) return 1 - ramp(1 - u)
  return v * (e / 2 + (u - e))
}

/**
 * The camera's turn at this pos (0 looking down the counter tunnel … 1 the home view):
 * about.pull.orbit {from, to, ease} — from / to in pos (to: the pull's landing), easeEnds(ease) between:
 * a near-constant angular speed with soft ends. Never before `floor` — the pos at which the backing
 * camera has left the counter's tunnel (a camera turning inside it would swing into the letter): where
 * the tunnel ends later, the turn starts there.
 */
function orbitAt(pull: Loose, pos: number, floor: number, to: number) {
  const o = obj(pull.orbit)
  const a = Math.max(num(o.from, 1.45), floor)
  const b = Math.max(a + 0.01, num(o.to, to))
  return easeEnds(remap(pos, a, b), clamp(num(o.ease, 0.3), 0, 0.5))
}

/**
 * How far E has slid from the frame's centre to its home spot when the camera has turned u of the way
 * (about.pull.orbit.lead): 1 — in step with the turn (u): E's view turns at the turn's own even pace; > 1
 * — ahead of it (1 − (1 − u)^lead: the frame comes over the word's middle sooner, but the camera then
 * drifts back over the word near the landing — the far letters turn back a little); < 1 — behind it
 * (u^(1 / lead): every letter turns one way only, but E's own turn is uneven — faster mid-pull, done
 * before the landing).
 */
function slideAt(pull: Loose, u: number) {
  const lead = clamp(num(obj(pull.orbit).lead, 1), 0.5, 2)
  return lead >= 1 ? 1 - Math.pow(1 - clamp01(u), lead) : Math.pow(clamp01(u), 1 / lead)
}

/** The pull for one screen: its zoom as a function of pos, the tunnel's exit, and the two ends of the turn. */
interface PullPlan {
  zoomAt(pos: number): number
  exit: number
  /** the start and home orientations, and the whole angle between them (radians) */
  q0: Quat
  q1: Quat
  home: Axes
  angle: number
  /** E's place in the home view, in the camera's tangent units (screen offset / fpx) */
  qx: number
  qy: number
}

const planCache = new WeakMap<object, Map<string, PullPlan>>()

/**
 * The pull's plan for one screen: the zoom schedule (about.pull.keys → a monotone cubic in ln zoom from
 * z0 at pull.from to the home zoom at pull.to), `exit` — where the zoom passes the counter's front face
 * (entryFit.zFace): the camera has left the tunnel — and the turn's two ends: the start orientation
 * (down the tunnel) and the home one (straight down, tour.keys.home's roll), plus where the home view
 * shows E. Pure, cached per (config, screen).
 */
function pullPlan(config: ResolvedConfig, layout: Layout, viewH: number, fit: EntryFit, F: number): PullPlan {
  const key = `${layout.width}|${layout.height}|${viewH}|${fit.z0}|${fit.zFace}|${F}`
  let byScreen = planCache.get(config)
  if (!byScreen) {
    byScreen = new Map()
    planCache.set(config, byScreen)
  }
  const hit = byScreen.get(key)
  if (hit) return hit
  const pull = obj(aboutOf(config).pull)
  const home = tourKeys(config)[0]
  const from = num(pull.from, 1.24)
  const to = Math.max(from + 1e-3, num(pull.to, 1.92))
  const z0 = fit.z0
  const shots = [{ at: from, zoom: z0 }]
  for (const v of Object.values(obj(pull.keys))) {
    const k = obj(v)
    const at = num(k.at, NaN)
    if (!(at > from && at < to)) continue
    // `start` > 0: the zoom as a share of the start zoom z0 — which differs per screen (≈ 50 … 90), so
    // a shot near the start ("the A's walls just entering") reads the same everywhere. An explicit
    // `zoom` wins — and an override cannot delete a key, so `start` works only on shots whose base
    // config does not set `zoom`.
    const share = num(k.start, 0)
    const zoom = 'zoom' in k ? num(k.zoom, 1) : share > 0 ? z0 * share : 1
    shots.push({ at, zoom: clamp(zoom, home.zoom, z0) })
  }
  shots.push({ at: to, zoom: home.zoom })
  shots.sort((a, b) => a.at - b.at)
  // keep the schedule monotone (a shot out of order must not make the camera go back and forth)
  for (let k = 1; k < shots.length; k++) shots[k].zoom = Math.min(shots[k].zoom, shots[k - 1].zoom)
  const xs = shots.map((q) => q.at)
  const lz = shots.map((q) => Math.log(q.zoom))
  const m = pchipSlopes(xs, lz)
  const zoomAt = (pos: number) => {
    const p = clamp(pos, from, to)
    const i = segmentOf(xs, p)
    const u = remap(p, xs[i], xs[i + 1])
    return Math.exp(hermite(xs[i], xs[i + 1], lz[i], lz[i + 1], m[i], m[i + 1], u))
  }
  // the zoom only falls: bisect for the pos where it passes the front face
  const zFace = Math.min(fit.zFace, z0)
  let lo = from
  let hi = to
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (zoomAt(mid) >= zFace) lo = mid
    else hi = mid
  }
  const ax1 = topDown(home.roll * DEG)
  const q0 = quatOf(fit.start)
  const q1 = quatOf(ax1)
  // E in the home view (the camera over home.x / home.y at h = F / home.zoom)
  const hh = F / home.zoom
  const d: V3 = [fit.E[0] - home.x, fit.E[1] - home.y, fit.E[2] - hh]
  const D = Math.max(1e-6, dot3(d, ax1.fwd))
  const out: PullPlan = { zoomAt, exit: hi, q0, q1, home: ax1, angle: angleOf(q0, q1), qx: dot3(d, ax1.right) / D, qy: dot3(d, ax1.down) / D }
  byScreen.set(key, out)
  return out
}

/**
 * The camera at this scroll position (`pos` overrides scroll.pos — for probes and tests). Snapped: the
 * camera's translation moves the sheet in whole raster cells.
 */
export function aboutCameraAt(config: ResolvedConfig, layout: Layout, scroll: ScrollState, pos = scroll.pos): AboutCamera {
  const about = aboutOf(config)
  const pull = obj(about.pull)
  const tour = obj(about.tour)
  const reduced = scroll.reduced
  const W = Math.max(1, layout.width)
  const viewH = Math.max(1, viewHeight(layout, scroll))
  const U = aboutUnit(config, layout, viewH)
  const ox = W / 2
  const oy = viewH / 2
  const cell = aboutCell(config, layout)
  const keys = tourKeys(config)
  const home = keys[0]
  const from = num(pull.from, 1.24)
  const to = Math.max(from + 1e-3, num(pull.to, 1.92))
  const fit = entryFit(config, layout, viewH)
  const fpx = focalPx(config, viewH)
  const F = fpx / U
  const plan = pullPlan(config, layout, viewH, fit, F)
  const z0 = fit.z0
  const nearShare = cameraKnobs(config).near

  const base = { U, ox, oy, cell, viewH, reduced, z0, pull: remap(pos, from, to), tour: clamp01(pos - 2), fpx, F, exit: plan.exit }
  const lens = (zoom: number) => {
    const h = F / zoom
    return { h, near: h * nearShare, far: h + FAR_BELOW }
  }
  /** straight down over (x, y), rolled (home, the tour, reduced motion, the landing) */
  const straight = (x: number, y: number, zoom: number, roll: number, rest: { key: number; dissolve: number; active: boolean }) => {
    const L = lens(zoom)
    const ax = topDown(roll)
    return snapped({ ...base, ...L, ...ax, ...rest, cx: x, cy: y, zoom, roll, scale: U * zoom, eye: [x, y, L.h] as V3, tilt: 0, orbit: 1, carry: IDENTITY_CARRY })
  }

  // ── the tour (and, under reduced motion, everything from the dissolve's start on) ──
  // Reduced motion: no pull — the scene dissolves in at the home framing over about.pull.reduced
  // (from — where the slab is cut, so no rest lands on a bare void; to — fully there).
  const rd = obj(pull.reduced)
  const rFrom = num(rd.from, from)
  const rTo = Math.max(rFrom + 1e-3, num(rd.to, lerp(from, to, 0.4)))
  if (pos >= 2 || (reduced && pos >= rFrom)) {
    const t = tourAt(keys, base.tour, num(tour.dwell, 0.4), reduced)
    const dissolve = reduced ? stepped(remap(pos, rFrom, rTo), 4) : 1
    return straight(t.x, t.y, t.zoom, t.roll, { key: t.key, dissolve, active: true })
  }

  // ── the pull-back: one camera, one turn ──
  // The zoom follows its schedule (pullPlan: the shots' `at` / `zoom`, monotone cubic in ln zoom):
  // F / zoom − the plane = the camera's distance from E along the view (the plane: the counter's centre
  // height at the start — the old rise's tempo — moving to E's own height by the turn, where the home
  // view has E at F / home.zoom − E.z). The camera turns from the
  // tunnel's axis to the home view by one slerp (u: about.pull.orbit, not before the tunnel's exit);
  // E slides from the frame's centre to its home spot by the same u — its place in the view's own
  // tangent units — so the camera's sideways move is exactly what keeps E there: no drift of its own
  // that would turn the word the other way on screen.
  const zoom = plan.zoomAt(pos)
  const u = pos >= to ? 1 : orbitAt(pull, pos, plan.exit, to)
  if (u >= 1) return straight(home.x, home.y, zoom, home.roll * DEG, { key: 0, dissolve: 1, active: pos >= from })
  const q = slerp(plan.q0, plan.q1, u)
  const ax = axesOf(q)
  const L = lens(zoom)
  const D = Math.max(1e-6, L.h - (fit.plane + u * (fit.E[2] - fit.plane)))
  const g = slideAt(pull, u)
  const a = g * plan.qx
  const b = g * plan.qy
  // E = eye + D · (a · right + b · down + fwd)
  const eye: V3 = [
    fit.E[0] - D * (a * ax.right[0] + b * ax.down[0] + ax.fwd[0]),
    fit.E[1] - D * (a * ax.right[1] + b * ax.down[1] + ax.fwd[1]),
    fit.E[2] - D * (a * ax.right[2] + b * ax.down[2] + ax.fwd[2]),
  ]
  // the frame's centre: on the view's axis at the zoom's distance
  const cx = eye[0] + ax.fwd[0] * L.h
  const cy = eye[1] + ax.fwd[1] * L.h
  const roll = Math.atan2(-ax.right[1], ax.right[0])
  const tilt = Math.acos(clamp(-ax.fwd[2], -1, 1))
  return snapped({ ...base, ...L, ...ax, active: pos >= from, cx, cy, zoom, roll, key: 0, dissolve: 1, scale: U * zoom, eye, tilt, orbit: u, carry: carryOf(ax, plan.home) })
}

/** Quantise k (0…1) into `steps` stipple steps (0, 1/steps, …, 1). */
function stepped(k: number, steps: number) {
  return k <= 0 ? 0 : Math.min(steps, Math.floor(k * steps) + 1) / steps
}

/**
 * Snap the camera's translation to whole raster cells: a pan moves everything on the sheet in whole
 * pixels of the render, so static pictures do not shimmer (the slab moves in render pixels too). The
 * reference is the sheet's origin seen at the frame centre's distance (h): for a camera looking
 * straight down every point of the sheet plane is there, so the whole sheet lands on the lattice.
 */
function snapped(cam: AboutCamera) {
  const step = cam.cell
  // px per unit at the frame centre's distance (fpx / h = U · zoom)
  const k = cam.scale
  const d: V3 = [-cam.eye[0], -cam.eye[1], -cam.eye[2]]
  const px = dot3(cam.right, d) * k + cam.ox
  const py = dot3(cam.down, d) * k + cam.oy
  const ex = Math.round(px / step) * step - px
  const ey = Math.round(py / step) * step - py
  // moving the origin by (ex, ey) on screen = moving the camera by −(right · ex + down · ey) / k
  const mx = (cam.right[0] * ex + cam.down[0] * ey) / k
  const my = (cam.right[1] * ex + cam.down[1] * ey) / k
  const mz = (cam.right[2] * ex + cam.down[2] * ey) / k
  cam.eye = [cam.eye[0] - mx, cam.eye[1] - my, cam.eye[2] - mz]
  cam.cx -= mx
  cam.cy -= my
  return cam
}

/** The distance of a world point in front of the camera, along its view (< near — behind it). */
export function depthOf(cam: AboutCamera, x: number, y: number, z: number) {
  return cam.fwd[0] * (x - cam.eye[0]) + cam.fwd[1] * (y - cam.eye[1]) + cam.fwd[2] * (z - cam.eye[2])
}

/**
 * A world point (sheet units, z toward the camera) on screen: [x, y] CSS px and px per sheet unit at
 * its distance (fpx / d: the local scale, e.g. for a note's font at that height). null — behind the
 * near plane. For a camera looking straight down, on z = 0 it is exactly toScreen.
 */
export function project3(cam: AboutCamera, x: number, y: number, z: number): [number, number, number] | null {
  const dx = x - cam.eye[0]
  const dy = y - cam.eye[1]
  const dz = z - cam.eye[2]
  const d = cam.fwd[0] * dx + cam.fwd[1] * dy + cam.fwd[2] * dz
  if (!(d >= cam.near)) return null
  const k = cam.fpx / d
  const r = cam.right
  const w = cam.down
  return [(r[0] * dx + r[1] * dy + r[2] * dz) * k + cam.ox, (w[0] * dx + w[1] * dy + w[2] * dz) * k + cam.oy, k]
}

/** project3 of a point given in an object's own coordinates (its model matrix: core/about-pose.ts). */
export function projectModel(cam: AboutCamera, M: M4, x: number, y: number, z: number): [number, number, number] | null {
  const [wx, wy, wz] = apply4(M, x, y, z)
  return project3(cam, wx, wy, wz)
}

/**
 * Screen (CSS px) → the world point at height z under it (a ray from the camera through the pixel,
 * met with the plane z). null — the plane is not in front of the camera there.
 */
export function unproject(cam: AboutCamera, sx: number, sy: number, z = 0): [number, number] | null {
  const a = (sx - cam.ox) / cam.fpx
  const b = (sy - cam.oy) / cam.fpx
  const dx = cam.right[0] * a + cam.down[0] * b + cam.fwd[0]
  const dy = cam.right[1] * a + cam.down[1] * b + cam.fwd[1]
  const dz = cam.right[2] * a + cam.down[2] * b + cam.fwd[2]
  if (!(Math.abs(dz) > 1e-12)) return null
  const t = (z - cam.eye[2]) / dz
  if (!(t > 0)) return null
  return [cam.eye[0] + t * dx, cam.eye[1] + t * dy]
}

/** Sheet point → screen, CSS px (project3 on the sheet plane; behind the camera — the 2D map of its target). */
export function toScreen(cam: AboutCamera, x: number, y: number): [number, number] {
  const p = project3(cam, x, y, 0)
  if (p) return [p[0], p[1]]
  const c = Math.cos(cam.roll)
  const s = Math.sin(cam.roll)
  const dx = (x - cam.cx) * cam.scale
  const dy = (y - cam.cy) * cam.scale
  return [c * dx - s * dy + cam.ox, s * dx + c * dy + cam.oy]
}

/** Screen (CSS px) → sheet point (unproject onto the sheet plane; off it — the 2D map of its target). */
export function toSheet(cam: AboutCamera, sx: number, sy: number): [number, number] {
  const p = unproject(cam, sx, sy, 0)
  if (p) return p
  const c = Math.cos(cam.roll)
  const s = Math.sin(cam.roll)
  const dx = sx - cam.ox
  const dy = sy - cam.oy
  return [cam.cx + (c * dx + s * dy) / cam.scale, cam.cy + (-s * dx + c * dy) / cam.scale]
}

/**
 * Where something hung off the camera is, sheet units: `offset` in the sheet's axes as the home camera
 * carries them (turned with the camera on the pull: AboutCamera.carry) × the frame's distance h, from
 * the eye — the concrete's glint lamp (about.concrete.glint.lamp).
 */
export function cameraLamp(cam: AboutCamera, offset: readonly number[]): V3 {
  const [a, b, c] = cam.carry
  const h = cam.h
  return [
    cam.eye[0] + (a[0] * offset[0] + b[0] * offset[1] + c[0] * offset[2]) * h,
    cam.eye[1] + (a[1] * offset[0] + b[1] * offset[1] + c[1] * offset[2]) * h,
    cam.eye[2] + (a[2] * offset[0] + b[2] * offset[1] + c[2] * offset[2]) * h,
  ]
}

/**
 * Sheet units → clip space for a GPU (column-major 4×4; three.js: camera.projectionMatrix.fromArray(m),
 * projectionMatrixInverse = its inverse, and an identity view: camera.matrixWorld / matrixWorldInverse
 * left at identity, the object's matrixWorld = its model matrix). The canvas covers the CSS rectangle
 * [0, vw] × [0, vh] from the stage's top-left (the about lattice: whole cells, it may overhang). NDC
 * x / y are exactly project3's pixels; depth runs near → far (OpenGL −1…1). The y flip lives here: a
 * triangle wound counter-clockwise on the display (layers/about/mesh.ts) is a front face.
 */
export function clipMatrix(cam: AboutCamera, vw: number, vh: number, near = cam.near, far = cam.far): M4 {
  const kx = (2 * cam.fpx) / vw
  const ky = (2 * cam.fpx) / vh
  const ax = (2 * cam.ox) / vw - 1
  const ay = (2 * cam.oy) / vh - 1
  const A = (far + near) / (far - near)
  const B = (-2 * far * near) / (far - near)
  const { right: r, down: w, fwd: f, eye: e } = cam
  // rows acting on (x, y, z, 1); with X = right · (P − eye), Y = down · (P − eye), d = fwd · (P − eye):
  //   clip.x =  kx X + ax d,  clip.y = −ky Y − ay d,  clip.z = A d + B,  clip.w = d
  const row = (v: V3, c: number): number[] => [v[0], v[1], v[2], c - dot3(v, e)]
  const r0 = row([kx * r[0] + ax * f[0], kx * r[1] + ax * f[1], kx * r[2] + ax * f[2]], 0)
  const r1 = row([-ky * w[0] - ay * f[0], -ky * w[1] - ay * f[1], -ky * w[2] - ay * f[2]], 0)
  const r2 = row([A * f[0], A * f[1], A * f[2]], B)
  const r3 = row(f, 0)
  const m = new Float64Array(16)
  for (let col = 0; col < 4; col++) {
    m[col * 4] = r0[col]
    m[col * 4 + 1] = r1[col]
    m[col * 4 + 2] = r2[col]
    m[col * 4 + 3] = r3[col]
  }
  return m
}
