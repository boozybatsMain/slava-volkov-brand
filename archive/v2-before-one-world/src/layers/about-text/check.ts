import { aboutOf, toScreen, toSheet, topicCenter, withParallax, wordFont, type AboutCamera } from '../../core/about-camera'
import { turnKnobs } from '../../core/about-pose'
import { bool, num, obj, str } from '../../core/loose'
import type { ResolvedConfig } from '../../core/types'
import { apply3, holeTurnAt, inv3 } from '../about/scene'

/**
 * A composition check for stats() (debug only, never per frame): what each line of a note on screen
 * comes closer than CLEAR px to — the letters of the holes, the photos, the docked nav, another note,
 * the screen edges. Shapes, not bounding boxes:
 *   · a hole: its text drawn in the word's face (× stretchY and the tracking — the hole's own where it
 *     has them, as the finale's lines), turned in depth exactly as the canvas turns it (layers/about/
 *     scene.ts → holeTurnAt: its yaw / pitch + its share of the pointer's turn carried in `ptr`) — the
 *     black inside a T or beside an A's leg is free space;
 *   · a photo: its rotated rectangle, grown on its torn sides by most of the debris reach (the crumbs
 *     thin out towards the reach);
 *   · a cross: the square of its arms;
 * sampled every STEP px around each line's box. Each entry says the gap in px (0: touching or over
 * it). Still approximate: the letters' eroded edges and crumbs reach a few px further than the clean
 * glyph — a flagged pair is a pair to look at, a clean one is clean.
 */

/** x0, y0, x1, y1 — CSS px on screen */
export type Box = [number, number, number, number]

/** Clearance asked of a note at rest: from letters, photos, the dock, other notes and the screen edges, px. */
const CLEAR = 16
/** Sampling step around a line, px. */
const STEP = 2
const DEG = Math.PI / 180
/** photos/MARGIN × 0.98: the debris never flies further than the texture's stored margin (layers/about). */
const REACH_MAX = 0.14 * 0.98
/** The share of the debris reach that still reads as part of the photo. */
const REACH_SEEN = 0.6
/** Glyph raster for the check, px per em. */
const GLYPH_PX = 160

interface Mask {
  a: Uint8Array
  w: number
  h: number
  /** ink box centre, mask px; ink width, mask px */
  cx: number
  cy: number
  inkW: number
}

/** A thing on screen: its screen box (prefilter) and an inside test for a screen point. */
interface Thing {
  name: string
  box: Box
  inside(sx: number, sy: number): boolean
}

const masks = new Map<string, Mask>()

/** `text` in the holes' face, stretched like the holes' atlas (a hole's own stretchY / tracking win): a coverage mask and its ink box. */
function maskOf(config: ResolvedConfig, text: string, own: { stretchY?: unknown; tracking?: unknown }): Mask | null {
  const w = wordFont(config)
  const f = { ...w, tracking: num(own.tracking, w.tracking), stretchY: Math.max(0.2, num(own.stretchY, w.stretchY)) }
  const key = `${f.family}|${f.weight}|${f.tracking}|${f.stretchY}|${text}`
  const hit = masks.get(key)
  if (hit) return hit
  const cv = document.createElement('canvas')
  const c = cv.getContext('2d', { willReadFrequently: true })
  if (!c) return null
  const font = `${f.weight} ${GLYPH_PX}px "${f.family}"`
  c.font = font
  ;(c as unknown as { letterSpacing: string }).letterSpacing = `${f.tracking * GLYPH_PX}px`
  const m = c.measureText(text)
  const pad = 8
  const asc = m.actualBoundingBoxAscent
  const desc = m.actualBoundingBoxDescent
  cv.width = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight + 2 * pad)
  cv.height = Math.ceil((asc + desc) * f.stretchY + 2 * pad)
  c.font = font
  ;(c as unknown as { letterSpacing: string }).letterSpacing = `${f.tracking * GLYPH_PX}px`
  c.setTransform(1, 0, 0, f.stretchY, pad + m.actualBoundingBoxLeft, pad + asc * f.stretchY)
  c.fillStyle = '#fff'
  c.fillText(text, 0, 0)
  const data = c.getImageData(0, 0, cv.width, cv.height).data
  const a = new Uint8Array(cv.width * cv.height)
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3] > 127 ? 1 : 0
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight
  const out = { a, w: cv.width, h: cv.height, cx: pad + inkW / 2, cy: pad + ((asc + desc) * f.stretchY) / 2, inkW }
  masks.set(key, out)
  return out
}

/** Screen box of the rectangle x0…x1, y0…y1 (its own frame, sheet units) centred at sheet point (x, y), rotated. */
function rectBox(cam: AboutCamera, x: number, y: number, r: Box, rotation: number, sway: { x: number; y: number }): Box {
  const c = Math.cos(rotation * DEG)
  const s = Math.sin(rotation * DEG)
  const xs: number[] = []
  const ys: number[] = []
  for (const [dx, dy] of [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]) {
    const [sx, sy] = toScreen(cam, x + c * dx - s * dy, y + s * dx + c * dy)
    xs.push(sx + sway.x)
    ys.push(sy + sway.y)
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Screen point → the element's own frame (sheet units around its centre, unrotated). */
function local(cam: AboutCamera, x: number, y: number, rotation: number, sway: { x: number; y: number }, sx: number, sy: number): [number, number] {
  const [px, py] = toSheet(cam, sx - sway.x, sy - sway.y)
  const c = Math.cos(rotation * DEG)
  const s = Math.sin(rotation * DEG)
  const dx = px - x
  const dy = py - y
  return [c * dx + s * dy, -s * dx + c * dy]
}

/**
 * The pointer as the canvas published it (core/about-sheet.ts → aboutFrame.pointer): the sway, CSS px,
 * and the words' turn toward it, degrees (layers/about/scene.ts → Sway; absent — none).
 */
type Ptr = { x: number; y: number; yaw?: number; pitch?: number }

function thingsOf(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr): Thing[] {
  const about = aboutOf(config)
  const tk = turnKnobs(config)
  const out: Thing[] = []
  for (const [name, v] of Object.entries(obj(about.holes))) {
    const hl = obj(v)
    const text = str(hl.text, '')
    const m = text.trim() ? maskOf(config, text, hl) : null
    if (!m) continue
    const width = num(hl.width, 1)
    const rot = num(hl.rotation, 0)
    const depth = num(hl.depth, 0)
    const sway = { x: ptr.x * (1 + depth), y: ptr.y * (1 + depth) }
    const [x, y] = withParallax(cam, topicCenter(config, str(hl.topic, 'home')), num(hl.x, 0), num(hl.y, 0), depth)
    // sheet units per mask px (the atlas is stretched already: one scale both ways)
    const upp = width / m.inkW
    // the turn in depth, about the ink centre (the canvas's: layers/about/scene.ts → placeHole)
    const T = holeTurnAt({ yaw: num(hl.yaw, 0), pitch: num(hl.pitch, 0), turn: Math.max(0, num(hl.turn, 0)), width }, ptr, tk)
    const F = T && inv3(T)
    // the box: the turned corners of the mask (its own frame, sheet units around the ink centre)
    const ax = -m.cx * upp
    const ay = -m.cy * upp
    const bx = (m.w - m.cx) * upp
    const by = (m.h - m.cy) * upp
    const corners = ([[ax, ay], [bx, ay], [bx, by], [ax, by]] as const).map(([cx, cy]) => (T ? apply3(T, cx, cy) : [cx, cy]))
    const r: Box = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))]
    out.push({
      name: `hole:${name}`,
      box: rectBox(cam, x, y, r, rot, sway),
      inside(sx, sy) {
        const [lx, ly] = local(cam, x, y, rot, sway, sx, sy)
        const [gx, gy] = F ? apply3(F, lx, ly) : [lx, ly]
        const mx = Math.floor(m.cx + gx / upp)
        const my = Math.floor(m.cy + gy / upp)
        return mx >= 0 && my >= 0 && mx < m.w && my < m.h && m.a[my * m.w + mx] === 1
      },
    })
  }
  const edge = obj(obj(about.photos).edge)
  for (const [name, v] of Object.entries(obj(obj(about.photos).items))) {
    const p = obj(v)
    if (!bool(p.show, true)) continue
    const width = num(p.width, 0.2)
    const h = width / Math.max(0.05, num(p.aspect, 1))
    const rot = num(p.rotation, 0)
    const depth = num(p.depth, 0)
    const sway = { x: ptr.x * (1 + depth), y: ptr.y * (1 + depth) }
    const torn = obj(p.torn)
    const sides = str(torn.sides, '')
    const reach = Math.min(REACH_MAX, num(edge.reach, 0.1) * num(torn.amount, 1)) * width * REACH_SEEN
    const grow = (side: string) => (sides.includes(side) ? reach : 0)
    const [x, y] = withParallax(cam, topicCenter(config, str(p.topic, 'home')), num(p.x, 0), num(p.y, 0), depth)
    const r: Box = [-width / 2 - grow('l'), -h / 2 - grow('t'), width / 2 + grow('r'), h / 2 + grow('b')]
    out.push({
      name: `photo:${name}`,
      box: rectBox(cam, x, y, r, rot, sway),
      inside(sx, sy) {
        const [lx, ly] = local(cam, x, y, rot, sway, sx, sy)
        return lx >= r[0] && lx <= r[2] && ly >= r[1] && ly <= r[3]
      },
    })
  }
  // the crosses: a square of their arms (about.crosses.size cells each way)
  const cr = obj(about.crosses)
  const arm = (num(cr.size, 3) + 0.5) * cam.cell
  for (const [name, v] of Object.entries(obj(cr.items))) {
    const p = obj(v)
    const [sx, sy] = toScreen(cam, num(p.x, 0), num(p.y, 0))
    const box: Box = [sx + ptr.x - arm, sy + ptr.y - arm, sx + ptr.x + arm, sy + ptr.y + arm]
    out.push({ name: `cross:${name}`, box, inside: (x, y) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] })
  }
  return out
}

/**
 * The box of a thing's own shape (its letters' ink, not the padded box) within `area` (the screen),
 * sampled every 3 px; null — nothing inside. Only the part on screen is walked: a hole in the pull's
 * close-ups is many screens wide.
 */
function inkOf(t: Thing, area: Box): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const ax0 = Math.max(t.box[0], area[0])
  const ax1 = Math.min(t.box[2], area[2])
  const ay0 = Math.max(t.box[1], area[1])
  const ay1 = Math.min(t.box[3], area[3])
  for (let sy = ay0; sy <= ay1; sy += 3) {
    for (let sx = ax0; sx <= ax1; sx += 3) {
      if (!t.inside(sx, sy)) continue
      x0 = Math.min(x0, sx)
      y0 = Math.min(y0, sy)
      x1 = Math.max(x1, sx)
      y1 = Math.max(y1, sy)
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null
}

/**
 * The screen boxes of the letters (per hole), photos and crosses on screen — debug (stats().things).
 * A hole also gives `ink`: the box of its letters themselves on screen (clipped to it — does a word
 * reach the screen's edge?).
 */
export function thingsAt(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr, view: { W: number; H: number }) {
  const screen: Box = [0, 0, view.W, view.H]
  return thingsOf(config, cam, ptr)
    .filter((t) => meets(t.box, screen))
    .map((t) => {
      const ink = t.name.startsWith('hole:') ? inkOf(t, screen) : null
      return { name: t.name, box: t.box.map((v) => Math.round(v)), ...(ink ? { ink: ink.map((v) => Math.round(v)) } : {}) }
    })
}

/**
 * Which letters / photos / crosses have any of their shape inside `box` (screen CSS px, sampled every
 * STEP px) — debug: is anything parked under the docked nav at a rest key (stats({ box }).inBox)?
 */
export function shapesIn(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr, box: Box) {
  const out: string[] = []
  for (const t of thingsOf(config, cam, ptr)) {
    if (!meets(t.box, box)) continue
    const x0 = Math.max(box[0], t.box[0])
    const x1 = Math.min(box[2], t.box[2])
    const y0 = Math.max(box[1], t.box[1])
    const y1 = Math.min(box[3], t.box[3])
    let hit = false
    for (let sy = y0; sy <= y1 && !hit; sy += STEP) for (let sx = x0; sx <= x1 && !hit; sx += STEP) hit = t.inside(sx, sy)
    if (hit) out.push(t.name)
  }
  return out
}

/** Grid step of the clash check, px. */
const CLASH_STEP = 2

/**
 * Pairs of things on screen — the letters of the holes, the photos, the crosses — whose shapes come
 * closer than CLEAR px to each other (0: touching or over each other), debug (stats().clashes): the
 * photos and the giant letters keep their distance from the words and from each other as the notes do.
 * Only the part on screen counts (a fragment running off an edge is meant to). Shapes on a
 * CLASH_STEP px grid, the distance a 3-4 chamfer (within ≈ 8 % of the true one, ± a step).
 */
export function clashesAt(config: ResolvedConfig, cam: AboutCamera, ptr: Ptr, view: { W: number; H: number }) {
  const S = CLASH_STEP
  const gw = Math.ceil(view.W / S)
  const gh = Math.ceil(view.H / S)
  const screen: Box = [0, 0, view.W, view.H]
  const R = Math.ceil(CLEAR / S) + 1
  // each thing on screen: its cells (grid box gx0…gx1, gy0…gy1 and a mask over it)
  const on = thingsOf(config, cam, ptr)
    .filter((t) => meets(t.box, screen))
    .map((t) => {
      const gx0 = Math.max(0, Math.floor(t.box[0] / S))
      const gy0 = Math.max(0, Math.floor(t.box[1] / S))
      const gx1 = Math.min(gw - 1, Math.ceil(t.box[2] / S))
      const gy1 = Math.min(gh - 1, Math.ceil(t.box[3] / S))
      const w = gx1 - gx0 + 1
      const m = new Uint8Array(Math.max(0, w * (gy1 - gy0 + 1)))
      let any = false
      for (let y = gy0; y <= gy1; y++) {
        for (let x = gx0; x <= gx1; x++) {
          if (!t.inside((x + 0.5) * S, (y + 0.5) * S)) continue
          m[(y - gy0) * w + x - gx0] = 1
          any = true
        }
      }
      return { name: t.name, gx0, gy0, gx1, gy1, w, m, any }
    })
    .filter((t) => t.any)
  const out: Record<string, number> = {}
  for (let i = 0; i < on.length; i++) {
    const b = on[i]
    // the region around b's cells within CLEAR, its 3-4 chamfer distance from b (in thirds of a step)
    const rx0 = Math.max(0, b.gx0 - R)
    const ry0 = Math.max(0, b.gy0 - R)
    const rx1 = Math.min(gw - 1, b.gx1 + R)
    const ry1 = Math.min(gh - 1, b.gy1 + R)
    const rw = rx1 - rx0 + 1
    const rh = ry1 - ry0 + 1
    let d: Int32Array | null = null
    for (let j = 0; j < on.length; j++) {
      if (j === i) continue
      const a = on[j]
      const key = [a.name, b.name].sort().join(' × ')
      if (key in out && j < i) continue
      if (a.gx1 < rx0 || a.gx0 > rx1 || a.gy1 < ry0 || a.gy0 > ry1) continue
      if (!d) {
        const INF = 1 << 28
        d = new Int32Array(rw * rh).fill(INF)
        for (let y = b.gy0; y <= b.gy1; y++) for (let x = b.gx0; x <= b.gx1; x++) if (b.m[(y - b.gy0) * b.w + x - b.gx0]) d[(y - ry0) * rw + x - rx0] = 0
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
      for (let y = Math.max(a.gy0, ry0); y <= Math.min(a.gy1, ry1); y++) {
        for (let x = Math.max(a.gx0, rx0); x <= Math.min(a.gx1, rx1); x++) {
          if (!a.m[(y - a.gy0) * a.w + x - a.gx0]) continue
          best = Math.min(best, d[(y - ry0) * rw + x - rx0])
        }
      }
      // thirds of a step → px; neighbouring cells are one step apart, i.e. a gap of S − S: touching
      const px = Number.isFinite(best) ? Math.max(0, (best / 3 - 1) * S) : Infinity
      if (px < CLEAR) out[key] = Math.round(px)
    }
  }
  return out
}

/** The gap between two boxes, px: the larger of the horizontal and vertical gaps (negative: they overlap). */
const gap = (a: Box, b: Box) => Math.max(b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3])

const meets = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

/** The nearest point of a thing's shape to a line's box, px (0: touching or over it); Infinity past CLEAR. */
function nearest(t: Thing, b: Box, screen: Box): number {
  const g: Box = [b[0] - CLEAR, b[1] - CLEAR, b[2] + CLEAR, b[3] + CLEAR]
  if (!meets(g, t.box)) return Infinity
  let best = Infinity
  const x0 = Math.max(g[0], t.box[0], screen[0])
  const x1 = Math.min(g[2], t.box[2], screen[2])
  const y0 = Math.max(g[1], t.box[1], screen[1])
  const y1 = Math.min(g[3], t.box[3], screen[3])
  for (let sy = y0; sy <= y1; sy += STEP) {
    const dy = Math.max(b[1] - sy, 0, sy - b[3])
    for (let sx = x0; sx <= x1; sx += STEP) {
      const d = Math.hypot(Math.max(b[0] - sx, 0, sx - b[2]), dy)
      if (d < best && t.inside(sx, sy)) best = d
    }
  }
  return best
}

export function overlapsAt(
  config: ResolvedConfig,
  cam: AboutCamera,
  ptr: Ptr,
  notes: { name: string; lines: Box[] }[],
  view: { W: number; H: number; dock: Box },
) {
  const things = thingsOf(config, cam, ptr)
  const out: Record<string, string[]> = {}
  const screen: Box = [0, 0, view.W, view.H]
  for (const n of notes) {
    const near = new Map<string, number>()
    const note = (name: string, d: number) => {
      if (d < CLEAR) near.set(name, Math.min(near.get(name) ?? Infinity, d))
    }
    for (const b of n.lines) {
      if (!meets(b, screen)) continue
      for (const t of things) note(t.name, nearest(t, b, screen))
      for (const o of notes) if (o !== n) for (const ob of o.lines) note(`note:${o.name}`, gap(b, ob))
      note('dock', gap(b, view.dock))
      // partly on screen is fine for a note passing by; flagged so a topic at rest can be checked
      note('edge', Math.min(b[0], b[1], view.W - b[2], view.H - b[3]))
    }
    if (near.size) out[n.name] = [...near].map(([name, d]) => `${name} ${Math.round(d)}px`)
  }
  return out
}
