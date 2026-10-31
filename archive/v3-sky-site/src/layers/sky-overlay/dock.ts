import { clamp01, lerp, remap, smoother } from '../../core/ease'
import type { Pt } from '../../core/quad'

/**
 * THE ROD — how the nav strip of the hero becomes the vertical progress nav. Pure geometry: screen
 * px in, screen quads out; the layer (index.ts) measures the strip, calls solveRod() and writes the
 * transforms.
 *
 * The strip is treated as ONE straight rod with a head (the start of the lead line, at the «S») and
 * a tail (the end of the last line). Everything on it is laid out along the rod as a chain, counted
 * from the tail:
 *
 *   tail ── segment ─ [slot: word → dot] ─ segment ─ [slot] ─ segment ─ [slot] ─ segment ── head
 *
 * Two movements, both functions of the morph position M (0 strip … 1 dock):
 *   reel  (a, per piece, staggered from the tail): every segment shrinks to its docked length, every
 *         word to its docked size — the rod reels in along itself toward its tail. The chain is a sum
 *         of lengths, so pieces can neither overlap nor drift apart, whatever the stagger does;
 *   stand (b, one for the rod): the tail travels to its docked place and the rod turns about it to
 *         vertical. The words keep to the horizon instead (like flags on a pole being raised): each
 *         leaves the line on the label side early in the stand-up — one after another, from the tail —
 *         its near end staying by the rod, and levels out as the rod turns.
 *         A slot keeps the word's width while the word still lies in the line; once the word is clear
 *         of it, the slot closes around the dot that is born there, and the rod is whole again.
 *
 * A turning line is rebuilt from centre / angle / length (a corner lerp would shorten it half-way);
 * what the perspective of the title's plane adds to the flat shapes — keystone, a hair of bend — is
 * carried along as a residual that fades out with the reel, so M → 0 is exactly the strip. The lean
 * of the letters is part of the shape itself (a parallelogram) and straightens with the baseline:
 * the verticals go from their slant on the plane straight to upright, never swinging past it.
 */

export type Quad = [Pt, Pt, Pt, Pt]

export const dir = (angle: number): Pt => ({ x: Math.cos(angle), y: Math.sin(angle) })

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** Parallelogram TL, TR, BR, BL from its centre, baseline vector (left → right) and side vector (top → bottom). */
export function para(c: Pt, e1: Pt, e2: Pt): Quad {
  const ax = e1.x / 2
  const ay = e1.y / 2
  const bx = e2.x / 2
  const by = e2.y / 2
  return [
    { x: c.x - ax - bx, y: c.y - ay - by },
    { x: c.x + ax - bx, y: c.y + ay - by },
    { x: c.x + ax + bx, y: c.y + ay + by },
    { x: c.x - ax + bx, y: c.y - ay + by },
  ]
}

/** A piece of the strip as it lies on the hero's rod this frame (measured from its live quad). */
export interface Lying {
  /** its centre: distance from the rod's tail end, along the rod, px */
  t: number
  /** length along the rod, px */
  len: number
  /** length and screen angle of its side edges (top → bottom): the letters' height and lean */
  side: number
  nu: number
  /** live quad − the model's parallelogram at M = 0: keystone, a hair of offset from the rod */
  res: Quad
}

/**
 * Measures a live quad (TL, TR, BR, BL) against the rod: `tail` — the rod's tail end, `u` — its unit
 * direction (head → tail). The model's shape at M = 0 is the parallelogram centred ON the rod, its
 * baseline ALONG the rod; whatever the quad differs by goes to `res`.
 */
export function lying(q: Quad, tail: Pt, u: Pt): Lying {
  const mL = mid(q[0], q[3])
  const mR = mid(q[1], q[2])
  const mT = mid(q[0], q[1])
  const mB = mid(q[3], q[2])
  const c = mid(mL, mR)
  const t = (tail.x - c.x) * u.x + (tail.y - c.y) * u.y
  const len = (mR.x - mL.x) * u.x + (mR.y - mL.y) * u.y
  const e2 = { x: mB.x - mT.x, y: mB.y - mT.y }
  const model = para({ x: tail.x - u.x * t, y: tail.y - u.y * t }, { x: u.x * len, y: u.y * len }, e2)
  return {
    t,
    len,
    side: Math.hypot(e2.x, e2.y),
    nu: Math.atan2(e2.y, e2.x),
    res: q.map((p, i) => ({ x: p.x - model[i].x, y: p.y - model[i].y })) as Quad,
  }
}

export interface RodSeg {
  from: Lying
  /** docked: length and line width, px */
  len: number
  width: number
}

export interface RodWord {
  from: Lying
  /** docked: visible length and em height of the label, px; the centre of its visible box */
  len: number
  size: number
  at: Pt
  /** line ↔ word gap once the word has its docked size but still lies in the line, px */
  gap: number
}

export interface RodDock {
  /** the docked rod's tail (bottom) end; the rod stands straight up from it */
  tail: Pt
  /** dot diameter and the gap between a dot and the line, px */
  dot: number
  gap: number
  /** labels to the right (1) or to the left (−1) of the line */
  side: 1 | -1
}

export interface RodTiming {
  /** morph position, 0 strip … 1 dock */
  M: number
  /** share of M the reel takes; where the stand-up starts; delay per piece (counted from the tail) */
  reel: number
  stand: number
  stagger: number
  /** share of the stand-up a word takes to leave the line */
  lift: number
}

export interface Rod {
  /** stand-up progress (eased), 0…1 */
  b: number
  /** the rod now: tail end, direction (head → tail) angle and unit vector, label-side normal */
  tail: Pt
  angle: number
  u: Pt
  n: Pt
  /** head → tail, like the DOM. `near`: distance of the segment's tail-side end from the rod's tail */
  segs: { quad: Quad; near: number; len: number; width: number }[]
  words: {
    quad: Quad
    /** the slot's centre on the rod: where the word lay, where its dot sits */
    anchor: Pt
    /** dot diameter now, px (0 until the word has left the line) */
    dot: number
    /** the word's own reel progress; its length and em height now, px */
    a: number
    len: number
    size: number
  }[]
}

/** The line may slide under a word once the word's near corner is this far off it, px. */
const CLEAR = 4
/** …and has closed around the dot by the time the word has covered this share of the rest of its way out. */
const CLOSE = 0.85

const turn = (p: Pt, cos: number, sin: number, k: number): Pt => ({ x: (p.x * cos - p.y * sin) * k, y: (p.x * sin + p.y * cos) * k })

/** quad + its residual, turned by the piece's own rotation since M = 0 and faded by `k` */
function withResidual(q: Quad, res: Quad, by: number, k: number): Quad {
  if (k <= 0) return q
  const cos = Math.cos(by)
  const sin = Math.sin(by)
  return q.map((p, i) => {
    const r = turn(res[i], cos, sin, k)
    return { x: p.x + r.x, y: p.y + r.y }
  }) as Quad
}

/**
 * The rod at morph position t.M. `tail0` / `angle0` — the hero rod this frame (tail end, direction
 * head → tail); `segs` (n + 1) and `words` (n) in head → tail order.
 */
export function solveRod(tail0: Pt, angle0: number, segs: RodSeg[], words: RodWord[], dock: RodDock, t: RodTiming): Rod {
  const n = words.length
  const maxRank = 2 * n
  // the last piece must still have room to finish inside the reel
  const lag = Math.max(0, Math.min(t.stagger, 0.9 / Math.max(1, maxRank)))
  const reel = Math.max(1e-3, t.reel)
  const aOf = (rank: number) => smoother(clamp01((t.M / reel - lag * rank) / (1 - lag * maxRank)))
  const b = smoother(remap(t.M, t.stand, 1))

  const angle = angle0 + (Math.PI / 2 - angle0) * b
  const u = dir(angle)
  const nrm = { x: u.y * dock.side, y: -u.x * dock.side }
  const tail = { x: lerp(tail0.x, dock.tail.x, b), y: lerp(tail0.y, dock.tail.y, b) }
  const at = (s: number): Pt => ({ x: tail.x - u.x * s, y: tail.y - u.y * s })

  // ── the docked chain (from the tail): where each dot ends up ──
  const slot1 = dock.dot / 2 + dock.gap
  const anchor1: number[] = []
  let x1 = 0
  for (let i = n; i >= 0; i--) {
    x1 += segs[i].len
    if (i > 0) {
      anchor1[i - 1] = x1 + slot1
      x1 += 2 * slot1
    }
  }

  // ── words: size by the reel, lift and levelling by the stand-up; the slot follows the word ──
  // a word keeps to the horizon while the rod turns: its baseline goes angle0 → 0, the rod angle0 → 90°
  const theta = angle0 * (1 - b)
  const psi = angle - theta
  const sinP = Math.abs(Math.sin(psi))
  const cosP = Math.abs(Math.cos(psi))
  const wordOut = words.map((w, j) => {
    const rank = 2 * (n - j) - 1
    const a = aOf(rank)
    // off the line early in the stand-up, one word after another from the tail: the line then closes
    // under it and the rod is whole again (a line with dots) long before it is upright
    const from = t.stand + lag * rank * reel
    const lift = smoother(remap(t.M, from, from + (1 - t.stand) * Math.max(0.05, t.lift)))
    const len = lerp(w.from.len, w.len, a)
    const size = lerp(w.from.side, w.size, a)
    // docked: how far the label's near end stands off the line, and its (pixel-snapping) shift along it
    const anchorY = dock.tail.y - anchor1[j]
    const off1 = (w.at.x - dock.tail.x) * dock.side - w.len / 2
    const along1 = w.at.y - anchorY
    // how far the word's near corner has cleared the line → how far its slot may close
    const clear = lift * off1 - (size / 2) * cosP
    const c0 = Math.min(CLEAR, off1 / 2)
    const e = off1 > 1 ? remap(clear, c0, c0 + (off1 - c0) * CLOSE) : b
    return { a, len, size, off: (len / 2) * sinP + lift * off1, along: along1 * b, close: smoother(e), dot: dock.dot * smoother(remap(e, 0, 0.75)) }
  })

  // ── the chain now (from the tail): seg n, slot n − 1, seg n − 1, …, slot 0, seg 0 ──
  const aSeg = segs.map((_, i) => aOf(2 * (n - i)))
  const segLen = segs.map((s, i) => lerp(s.from.len, s.len, aSeg[i]))
  const segNear: number[] = []
  const anchor: number[] = []
  let x = lerp(segs[n].from.t - segs[n].from.len / 2, 0, aSeg[n])
  for (let i = n; i >= 0; i--) {
    segNear[i] = x
    x += segLen[i]
    if (i === 0) break
    const j = i - 1
    const w = words[j]
    const o = wordOut[j]
    // the hero's own gaps on either side of the word (the perspective makes them a hair unequal)
    const gapNear = w.from.t - w.from.len / 2 - (segs[i].from.t + segs[i].from.len / 2)
    const gapFar = segs[j].from.t - segs[j].from.len / 2 - (w.from.t + w.from.len / 2)
    const half = (gap0: number) => lerp(lerp(w.from.len / 2 + gap0, w.len / 2 + w.gap, o.a), slot1, o.close)
    const near = half(gapNear)
    anchor[j] = x + near
    x += near + half(gapFar)
  }

  const turned = angle - angle0
  return {
    b,
    tail,
    angle,
    u,
    n: nrm,
    segs: segs.map((s, i) => {
      const a = aSeg[i]
      const len = segLen[i]
      // the end caps square up with the reel (at M = 0 they lean like the letters)
      const lean = (s.from.nu - angle0 - Math.PI / 2) * (1 - a)
      const width = lerp(s.from.side, s.width, a)
      const q = para(at(segNear[i] + len / 2), { x: u.x * len, y: u.y * len }, dirScaled(angle + Math.PI / 2 + lean, width))
      return { quad: withResidual(q, s.from.res, turned, (1 - a) * (1 - a)), near: segNear[i], len, width }
    }),
    words: words.map((w, j) => {
      const o = wordOut[j]
      const p = at(anchor[j])
      const c = { x: p.x + nrm.x * o.off + u.x * o.along, y: p.y + nrm.y * o.off + u.y * o.along }
      // the letters' lean goes with the baseline: verticals travel straight to upright, no swing back
      const nu = w.from.nu + (Math.PI / 2 - w.from.nu) * b
      const q = para(c, dirScaled(theta, o.len), dirScaled(nu, o.size))
      return { quad: withResidual(q, w.from.res, theta - angle0, (1 - o.a) * (1 - o.a)), anchor: p, dot: o.dot, a: o.a, len: o.len, size: o.size }
    }),
  }
}

function dirScaled(angle: number, k: number): Pt {
  return { x: Math.cos(angle) * k, y: Math.sin(angle) * k }
}
