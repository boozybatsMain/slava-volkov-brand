import { clamp, clamp01, lerp, remap, smoother } from './ease'
import { applyM3, holeTurn, minStretch } from './about-pose'
import { num, obj, str, type Loose } from './loose'
import type { Layout, ResolvedConfig, ScrollState } from './types'

/**
 * ABOUT — the camera over the black sheet (version 2, third screen; numbers: sky.config.ts → about).
 *
 * A PURE function of (config, layout, scroll): every reader computes the very same camera in the same
 * frame, whatever order it updates in — the canvas (layers/about), the DOM notes (layers/about-text),
 * the nav (sky-overlay, which updates BEFORE them: under reduced motion it waits for the sheet's
 * dissolve). The pointer's sway is not part of it: the about layer publishes that (core/about-sheet.ts
 * → aboutFrame).
 *
 * Sheet units: origin = centre of the word ABOUT, 1 = its width, y down. A sheet point p is on screen at
 *   S(p) = R(roll) · (p − c) · U · zoom + (W / 2, visibleH / 2)
 * U — px per unit at zoom 1 (about.word.width % of min(W, aspect × visibleH)); visibleH = 100svh.
 *
 * Two moves, both functions of pos:
 *   PULL (about.pull.from → to): from inside the A (about.pull.entry, its deepest point, through the
 *     word's 3D turn) the camera pulls straight back: a spiral similarity from the start view (entry
 *     point at the centre, computed start zoom z0 — the whole screen inside the stroke × margin —
 *     roll pull.roll) to the home framing (tour.keys.home). Every sheet point travels straight to one
 *     fixed screen spot; only the PACE is art-directed — about.pull.keys give the zoom at a few pos
 *     (monotone cubic in ln zoom, no overshoot, no kink).
 *   TOUR (pos 2 → 3): a non-uniform Catmull-Rom curve through about.tour.keys (zig-zag), zoom and
 *     roll on the same curve (zoom in log space), each segment's progress eased by tour.dwell (the
 *     speed through a key stays continuous). Starts and ends at rest.
 * Reduced motion: no pull (the sheet dissolves in at the home framing over about.pull.reduced —
 * `dissolve`), the tour is a straight line through the keys (their zoom kept), no roll.
 */

/** The A's deepest point (about.pull.entry): sheet units, r — distance to its nearest edge. */
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
  /** the sheet is in the picture at all (pos past pull.from) */
  active: boolean
  /** sheet point at the centre of the visible frame */
  cx: number
  cy: number
  zoom: number
  /** radians, + = clockwise on screen */
  roll: number
  /** px per sheet unit at zoom 1; `scale` = U · zoom */
  U: number
  scale: number
  /** screen point the camera centre lands on, CSS px (W / 2, visibleH / 2) */
  ox: number
  oy: number
  /** pull progress 0…1 (raw, not eased); 1 from pull.to on */
  pull: number
  /** the pull's start zoom (computed), for the zoom-driven ramps (letters.texture, LOD) */
  z0: number
  /** tour progress 0…1 (pos 2 → 3) */
  tour: number
  /** float index into the tour keys: 0 home … n − 1 end (between keys while travelling) */
  key: number
  /** reduced motion: how far the sheet has dissolved in (about.pull.reduced), 0…1 in 4 stipple steps (1 when not reduced) */
  dissolve: number
  /** one raster cell, CSS px (device-snapped) — see aboutCell */
  cell: number
  /** the visible height used for the framing, CSS px */
  viewH: number
  reduced: boolean
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
 * The A's deepest point on the sheet. about.pull.entry is measured on the FLAT word (its own frame:
 * sheet units from the word's centre, from the glyph's distance field); the word is turned in depth
 * (about.holes.about.yaw / pitch — core/about-pose.ts), so the point and its radius go through that
 * turn (the base turn: the pointer's share is faded out in the pull's close-ups).
 */
export function aboutEntry(config: ResolvedConfig): AboutEntry {
  const e = obj(obj(aboutOf(config).pull).entry)
  const x = num(e.x, -0.407)
  const y = num(e.y, -0.083)
  const r = Math.max(1e-3, num(e.r, 0.031))
  const h = obj(obj(aboutOf(config).holes).about)
  const T = holeTurn(config, 'about')
  // the word's place and in-plane rotation (ABOUT stays at the origin, but read them anyway)
  const hx = num(h.x, 0)
  const hy = num(h.y, 0)
  const rot = num(h.rotation, 0) * DEG
  const [tx, ty] = T ? applyM3(T, x, y) : [x, y]
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return { x: hx + c * tx - s * ty, y: hy + s * tx + c * ty, r: T ? r * minStretch(T, x, y) : r }
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

/** Centre of the tour key a thing belongs to (its `topic`) — where its parallax is zero. */
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

/** The pull's start zoom: the whole screen inside the stroke at the entry point, × margin. */
function startZoom(about: Loose, e: AboutEntry, U: number, W: number, viewH: number) {
  const pull = obj(about.pull)
  const letters = obj(about.letters)
  const halfDiag = Math.hypot(W, viewH) / 2
  const margin = Math.max(0.5, num(pull.margin, 1.02))
  const max = Math.max(1, num(pull.max, 60))
  // the eroded edge reaches in by at most maxPx on screen at this zoom (letters.maxPx) + the wobble
  const maxPx = Math.max(0, num(letters.maxPx, 40))
  let z = (halfDiag / (e.r * U)) * margin
  for (let k = 0; k < 2; k++) {
    const r = Math.max(e.r * 0.25, e.r - (2 * maxPx) / (U * z))
    z = (halfDiag / (r * U)) * margin
  }
  return clamp(z, 1, max)
}

/**
 * The camera at this scroll position (`pos` overrides scroll.pos — for probes and tests). Snapped: the
 * camera's translation moves in whole raster cells.
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
  const from = num(pull.from, 1.16)
  const to = Math.max(from + 1e-3, num(pull.to, 1.92))
  const e = aboutEntry(config)
  const z0 = startZoom(about, e, U, W, viewH)

  const base = { U, ox, oy, cell, viewH, reduced, z0, pull: remap(pos, from, to), tour: clamp01(pos - 2) }

  // ── the tour (and, under reduced motion, everything from the dissolve's start on) ──
  // Reduced motion: no pull — the sheet dissolves in at the home framing over about.pull.reduced
  // (from — where the slab is cut, so no rest lands on a bare void; to — fully there).
  const rd = obj(pull.reduced)
  const rFrom = num(rd.from, from)
  const rTo = Math.max(rFrom + 1e-3, num(rd.to, lerp(from, to, 0.4)))
  if (pos >= 2 || (reduced && pos >= rFrom)) {
    const t = tourAt(keys, base.tour, num(tour.dwell, 0.4), reduced)
    const dissolve = reduced ? stepped(remap(pos, rFrom, rTo), 4) : 1
    return snapped({ ...base, active: true, cx: t.x, cy: t.y, zoom: t.zoom, roll: t.roll, key: t.key, dissolve, scale: U * t.zoom })
  }

  // ── the pull-back: one straight zoom ──
  // The zoom follows its schedule (the shots' `at` / `zoom`, monotone cubic in ln zoom). Where the camera
  // is follows from the zoom alone: the start view (the entry point at the centre, zoom z0, roll
  // pull.roll) and the home view are two similarities of the sheet; the move between them is the
  // spiral similarity that blends their scale-and-rotation geometrically about the one sheet point
  // both views put on the same screen spot. Every point of the sheet travels straight towards that
  // spot (on a gentle log spiral if the roll changes) — the most direct pull-back there is, the same
  // way out and back, never a zig-zag.
  const shots = [{ at: from, zoom: z0 }]
  for (const v of Object.values(obj(pull.keys))) {
    const k = obj(v)
    const at = num(k.at, NaN)
    if (!(at > from && at < to)) continue
    // `start` > 0: the zoom as a share of the start zoom z0 — which differs per screen (≈ 28 … 44), so a
    // shot near the start ("black just entering the corners") reads the same everywhere. An explicit
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
  const p = clamp(pos, from, to)
  const i = segmentOf(xs, p)
  const u = remap(p, xs[i], xs[i + 1])
  const lz = shots.map((q) => Math.log(q.zoom))
  const m = pchipSlopes(xs, lz)
  const zoom = Math.exp(hermite(xs[i], xs[i + 1], lz[i], lz[i + 1], m[i], m[i + 1], u))
  // blend parameter: how far the zoom has gone from z0 to the home zoom, in ln
  const span = Math.log(home.zoom / z0)
  const t = Math.abs(span) > 1e-6 ? clamp01(Math.log(zoom / z0) / span) : 1
  // the two views as complex similarities s = a · p + b (a = U · zoom · e^(i roll))
  const r0 = num(pull.roll, 0) * DEG
  const r1 = home.roll * DEG
  const a0 = cpolar(U * z0, r0)
  const a1 = cpolar(U * home.zoom, r1)
  const o: C = [ox, oy]
  const b0 = csub(o, cmul(a0, [e.x, e.y]))
  const b1 = csub(o, cmul(a1, [home.x, home.y]))
  // the fixed point F: a0 F + b0 = a1 F + b1, and where both views put it
  const den = csub(a0, a1)
  const F = Math.hypot(den[0], den[1]) > 1e-9 ? cdiv(csub(b1, b0), den) : ([e.x, e.y] as C)
  const Fs = cadd(cmul(a0, F), b0)
  // a(t): scale geometric, angle linear
  const at = cpolar(U * zoom, r0 + (r1 - r0) * t)
  // the camera centre: the sheet point the blended view puts at o
  const cxy = cadd(F, cdiv(csub(o, Fs), at))
  const roll = r0 + (r1 - r0) * t
  return snapped({ ...base, active: pos >= from, cx: cxy[0], cy: cxy[1], zoom, roll, key: 0, dissolve: 1, scale: U * zoom })
}

type C = [number, number]
const cpolar = (r: number, a: number): C => [r * Math.cos(a), r * Math.sin(a)]
const cadd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]]
const csub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]]
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
const cdiv = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1]
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]
}

/** Quantise k (0…1) into `steps` stipple steps (0, 1/steps, …, 1). */
function stepped(k: number, steps: number) {
  return k <= 0 ? 0 : Math.min(steps, Math.floor(k * steps) + 1) / steps
}

/**
 * Snap the camera's translation to whole raster cells: a pan moves everything on the sheet in whole
 * pixels of the render, so static pictures do not shimmer (the slab moves in render pixels too).
 */
function snapped(cam: AboutCamera) {
  const step = cam.cell
  const c = Math.cos(cam.roll)
  const s = Math.sin(cam.roll)
  // screen position of the sheet origin
  const dx = -cam.cx * cam.scale
  const dy = -cam.cy * cam.scale
  const px = c * dx - s * dy + cam.ox
  const py = s * dx + c * dy + cam.oy
  const ex = Math.round(px / step) * step - px
  const ey = Math.round(py / step) * step - py
  // moving the origin by (ex, ey) on screen = moving the camera by −R⁻¹ · e / scale
  cam.cx -= (c * ex + s * ey) / cam.scale
  cam.cy -= (-s * ex + c * ey) / cam.scale
  return cam
}

/** Sheet point → screen, CSS px. */
export function toScreen(cam: AboutCamera, x: number, y: number): [number, number] {
  const c = Math.cos(cam.roll)
  const s = Math.sin(cam.roll)
  const dx = (x - cam.cx) * cam.scale
  const dy = (y - cam.cy) * cam.scale
  return [c * dx - s * dy + cam.ox, s * dx + c * dy + cam.oy]
}

/** Screen (CSS px) → sheet point. */
export function toSheet(cam: AboutCamera, sx: number, sy: number): [number, number] {
  const c = Math.cos(cam.roll)
  const s = Math.sin(cam.roll)
  const dx = sx - cam.ox
  const dy = sy - cam.oy
  return [cam.cx + (c * dx + s * dy) / cam.scale, cam.cy + (-s * dx + c * dy) / cam.scale]
}

/**
 * Where a thing that belongs to `topic` with parallax `depth` is drawn: its own place, moved by
 * (topic centre − camera) · depth — exactly where it was put when the camera is at its topic.
 */
export function withParallax(cam: AboutCamera, center: { x: number; y: number }, x: number, y: number, depth: number): [number, number] {
  if (!depth) return [x, y]
  return [x + (center.x - cam.cx) * depth, y + (center.y - cam.cy) * depth]
}

/** Font of the holes' letters (about.word). */
export function wordFont(config: ResolvedConfig) {
  const w = obj(aboutOf(config).word)
  return {
    family: str(w.font, 'Geist Variable'),
    weight: num(w.weight, 900),
    tracking: num(w.tracking, -0.02),
    stretchY: Math.max(0.2, num(w.stretchY, 1.15)),
  }
}
