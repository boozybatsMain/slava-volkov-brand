import { clamp01, remap } from '../../core/ease'
import type { ProjectsState } from '../../core/projects'
import type { Frame } from '../../core/types'
import type { SlabKnobs } from './solve'

/**
 * SLAB — the two shows, as plain numbers for whoever draws (the WebGL slab, the flat fallback):
 *
 *   ARRIVAL  the slab "loads" like a model in an old game — a stippled silhouette that fills in with
 *            the scroll, an untextured box, then the texture popping in from a coarse mip to the
 *            full one, with one burst of torn rows; on the way on to ABOUT (pos > 1) the same
 *            film plays backwards and the slab "unloads" (projects.leave);
 *   SWITCH  the picture change, a pure function of the store's progress `t` (core/projects.ts), so
 *            a pinned / scrubbed switch shows exactly what the live one does at that moment.
 *
 * No three.js and no drawing here.
 */

// ── arrival ──────────────────────────────────────────────────────────────────────────────────

export interface ArrivalLook {
  /** Coverage of the slab, 0…1, in whole steps (an ordered stipple, never a fade). */
  stipple: number
  /** false — the untextured box (arrive.blank). */
  textured: boolean
  /** Mip level the picture shows at (whole steps down to 0). */
  lod: number
  /** A burst of torn rows right now: seed of its bands; null — none. */
  tear: number | null
}

/**
 * The mip levels of the pop-in, coarse → full: `start`, every second level below it, 0
 * (5 → 3 → 1 → 0: each step doubles the detail twice — a visible pop, not a blur).
 */
function lodSteps(start: number) {
  const out: number[] = []
  for (let l = Math.max(0, Math.round(start)); l > 0; l -= 2) out.push(l)
  out.push(0)
  return out
}

/**
 * Coverage of the slab at `pos`, in whole stipple steps: the arrival fills in 1/n … n/n over
 * arrive.from → arrive.stipple.to; the leave (projects.leave, on the way on to ABOUT) is the same
 * film backwards — (n−1)/n at leave.stipple.from … nothing at leave.to. The smaller of the two:
 * they never overlap (the leave starts above 1, where the arrival is long solid).
 */
function stippleAt(pos: number, K: SlabKnobs) {
  const a = K.arrive
  const L = K.leave
  const nIn = Math.max(1, Math.round(a.stipple.steps))
  const nOut = Math.max(1, Math.round(L.stipple.steps))
  // 1/n as it appears … the last step (solid) exactly at stipple.to
  const inn = pos < a.from ? 0 : Math.min(nIn, Math.floor(remap(pos, a.from, a.stipple.to) * (nIn - 1)) + 1) / nIn
  // one step gone at leave.stipple.from … the last one exactly at leave.to
  const out = pos < L.stipple.from ? 1 : 1 - Math.min(nOut, Math.floor(remap(pos, L.stipple.from, L.to) * (nOut - 1)) + 1) / nOut
  return Math.min(inn, out)
}

/**
 * The page counts as AT REST once the picture has moved slower than REST_SPEED (screens/s — under a
 * pixel from home on the scroll's spring) for REST_TIME s: the same test as the projects' texts
 * (layers/projects/index.ts), so picture and texts come back together. Never while pinned.
 * (When the scroll counts as stopped — a detection threshold, not a knob of the pult.)
 */
const REST_SPEED = 0.01
const REST_TIME = 0.25

/**
 * Scrubbed by the scroll: the stipple (and, in solve.ts, the travel). Timed, because a visitor may
 * stop anywhere and a half-loaded texture frozen on screen would look broken: once the scroll passes
 * arrive.lod.from the pop-in plays by the clock, and it un-plays when the scroll falls back under
 * arrive.lod.back.
 *
 * The leave (pos > 1, projects.leave) runs the same machine backwards: past leave.lod.from the
 * picture un-plays on the same clock (full → coarse mips → the grey box), and comes back while the
 * page moves only once the scroll is under leave.lod.back again — at rest (REST_SPEED for REST_TIME)
 * anywhere under leave.lod.from; the grey box then stipples out with the scroll. On the way back
 * from ABOUT the slab stipples in untextured and the picture pops in exactly as on arrival (with its
 * burst of torn rows) — the reset below makes sure of it.
 */
export function createArrival() {
  /** progress of the timed pop-in: 0 — untextured … 1 — the full picture */
  let load = 0
  let on = false
  let tearLeft = 0
  let tearSeed = 0
  let started = false
  /** s the picture has stood still (see REST_SPEED) */
  let still = 0

  return {
    /**
     * `ready` — the current picture is decoded. On the very first frame whatever should be on screen
     * by now simply is (a page opened on the second screen replays nothing) — and so it is while
     * the scroll is pinned (`?scroll=`, a scrubbed sheet): a screenshot must not depend on when it
     * was taken, as with the project texts.
     */
    step(frame: Frame, K: SlabKnobs, ready: boolean): ArrivalLook {
      const first = !started || frame.scroll.pinned
      started = true
      const a = K.arrive
      const L = K.leave
      const { pos, reduced } = frame.scroll
      still = !frame.scroll.pinned && Math.abs(frame.scroll.speed) < REST_SPEED ? still + frame.dt : 0
      if (reduced) {
        // No staging: the finished slab is simply there — from the point where its picture would
        // have come in, not from arrive.from: that is where the MESH begins, over the last of the
        // clouds, and a whole slab popping in there would sit on a title that is still fading.
        // It goes the same way: all at once, where the leave's stipple would begin.
        load = ready ? 1 : 0
        const there = pos >= Math.max(a.from, a.lod.from) && pos < L.stipple.from
        return { stipple: there ? 1 : 0, textured: ready, lod: 0, tear: null }
      }
      const stipple = stippleAt(pos, K)

      if (stipple === 0) {
        // Nothing of the slab is on screen, and the layer falls asleep just past this — below the
        // arrival, above the leave (sky.ts → isLive; its last update comes through here). The
        // pop-in must not keep its place for the way back: an ordinary scroll is quicker than the
        // un-play, and the next arrival would begin as a textured mesh that un-loads to grey and
        // loads again.
        load = 0
        on = false
        tearLeft = 0
      } else if (first) {
        // a pinned position (and the very first frame) shows what belongs to it, whichever way it
        // was reached: no hysteresis — the picture is on between arrive.lod.from and leave.lod.from
        on = pos >= a.lod.from && pos < L.lod.from
      } else {
        // Live, with a gap at both ends against a trembling hand: on from arrive.lod.from, off
        // again under arrive.lod.back; off from leave.lod.from, on again under leave.lod.back — or,
        // once the page is at rest, anywhere under leave.lod.from: the wheel coming up from ABOUT
        // rests at 1.095 or 1.016 (100 px notches at 1440×900), inside the gap, and a still slab must
        // not stay a grey box for good because of the way it was reached (as the projects' texts).
        const lo = on ? Math.min(a.lod.back, a.lod.from) : a.lod.from
        const hi = on || still >= REST_TIME ? L.lod.from : Math.min(L.lod.back, L.lod.from)
        on = pos >= lo && pos < hi
      }
      const lods = lodSteps(a.lod.start)
      const target = on && ready ? 1 : 0
      const before = Math.floor(load * lods.length + 1e-6)
      if (first) load = target
      else {
        const dur = lods.length * Math.max(0.01, a.lod.step)
        load = clamp01(load + (target ? frame.dt : -frame.dt) / dur)
      }
      // 0 — untextured, 1 … n — lods[stage − 1]
      const stage = Math.min(lods.length, Math.floor(load * lods.length + 1e-6))
      // the burst: as the last coarse level gives way (going forward only)
      if (!first && target && stage > before && stage === lods.length - 1 && a.tear.rows > 0) {
        tearLeft = Math.max(1, a.tear.ticks) / K.raster.shimmerFps
        tearSeed = Math.floor(frame.time * 60) % 997
      }
      const tearing = tearLeft > 0
      tearLeft = Math.max(0, tearLeft - frame.dt)
      return {
        stipple,
        textured: stage > 0,
        lod: stage > 0 ? lods[stage - 1] : lods[0],
        tear: tearing ? tearSeed + Math.floor(tearLeft * K.raster.shimmerFps) : null,
      }
    },

    /** Debug (stats()). */
    get load() {
      return load
    },
  }
}

// ── switch ───────────────────────────────────────────────────────────────────────────────────

/**
 * How the face is drawn this frame: One — a single picture (A); ZFight — B breaks through A in depth
 * terraces; Scan — a render cursor leaves B behind, one mosaic stage finer per pass.
 */
export const FaceMode = { One: 0, ZFight: 1, Scan: 2 } as const
export type FaceMode = (typeof FaceMode)[keyof typeof FaceMode]

export interface SwitchLook {
  mode: FaceMode
  /** The pictures: leaving, arriving (project indices; equal when idle). */
  a: number
  b: number
  dir: 1 | -1
  /** The switch's own clock in shimmer ticks: everything that re-rolls does so on it. */
  tick: number
  /** z-fight: how far the fight zone has swept, 0…1 (dips a little during «lock»: last slivers). */
  sweep: number
  /** Mip level of A and of B. */
  lodA: number
  lodB: number
  /** The face's colour depth is dropped to switch.bits. */
  crushed: boolean
  /** R / B split, render px, signed along the travel. */
  split: number
  /** Torn rows: bands and their largest shift (render px); rows 0 — none. */
  tear: { rows: number; shift: number }
  /** 0…1: how "in trouble" the renderer is (edge crawl and row slips ride on it, like on pointer.energy). */
  energy: number
  /** The side face: which picture leaks into it, and the one tick it goes flat. */
  sideB: boolean
  sideFlat: boolean
  /** The sheen's extra sweep across the face while the picture settles, 0…1; −1 — none. */
  sheen: number
  /** The swing as a function of the progress, degrees — for a pinned switch (live it is a spring). */
  swing: number
  /** scan: the pass (0…2) and the cursor's place on it (0…1 along the travel). */
  pass: number
  cursor: number
}

const IDLE: Omit<SwitchLook, 'a' | 'b' | 'dir'> = {
  mode: FaceMode.One, tick: 0, sweep: 0, lodA: 0, lodB: 0, crushed: false, split: 0,
  tear: { rows: 0, shift: 0 }, energy: 0, sideB: false, sideFlat: false, sheen: -1, swing: 0, pass: 0, cursor: 0,
}

/**
 * The R / B kick at tick k: it opens at switch.split and falls to nothing over switch.splitTicks
 * ticks, in whole render pixels (split 3 over 4 ticks: 3, 2, 2, 1, then nothing).
 */
const splitAt = (split: number, k: number, ticks: number) => (k < ticks ? Math.round(split * (1 - k / (ticks + 1))) : 0)

/**
 * The switch at progress `t` (ProjectsState). Phases, in shares of switch.duration (switch.phases):
 *   0 … evict       «hit»   — the slab is pushed, a few bands of rows tear, R and B part;
 *   evict … fight   «evict» — the old picture loses its texture detail and colour depth;
 *   fight … lock    «fight» — the terraces sweep across, the new picture sharpens behind them;
 *   lock … settle   «lock»  — the new picture pops to full detail, last slivers of the old one blink;
 *   settle … 1      «settle»— one stray row, the sheen runs across once.
 */
export function switchLook(K: SlabKnobs, s: ProjectsState, reduced: boolean): SwitchLook {
  const base = { a: s.from, b: s.to, dir: s.dir }
  if (s.from === s.to) return { ...IDLE, ...base }
  const sw = K.switch
  const t = clamp01(s.t)
  // 'cut' (and reduced motion) never run a timeline — only a pinned one can be seen half-way
  if (sw.mode === 'cut' || reduced) return { ...IDLE, ...base, a: t >= 0.5 ? s.to : s.from }
  if (t >= 1) return { ...IDLE, ...base, a: s.to }

  const fps = K.raster.shimmerFps
  const seconds = t * sw.duration
  const k = Math.floor(seconds * fps + 1e-4)
  // a different roll for every switch, the same one for the same pinned frame
  const tick = k + 17 * (s.from + 1) + 131 * (s.to + 1)

  if (sw.mode === 'scan') {
    const p = Math.min(2.9999, t * 3)
    return {
      ...IDLE, ...base, mode: FaceMode.Scan, tick, pass: Math.floor(p), cursor: p - Math.floor(p),
      energy: 0.35, sideB: t > 0.5,
    }
  }

  const ph = sw.phases
  // Everything discrete happens ON a tick, like every re-roll: a phase begins with the first tick
  // whose middle lies past its mark (so the pop of «lock» and its kick are one and the same frame).
  const ticks = sw.duration * fps
  const tc = Math.min(1, (k + 0.5) / ticks)
  const firstTick = (at: number) => Math.ceil(at * ticks - 0.5)
  // the front itself sweeps smoothly
  const fight = remap(t, ph.fight, ph.lock)
  const locking = tc >= ph.lock && tc < ph.settle
  // «lock»: the sweep falls a few percent short on every other tick → slivers of A blink at the trailing edge
  const sweep = locking && k % 2 === 0 ? 1 - sw.slivers : tc >= ph.lock ? 1 : fight
  const lod = Math.max(0, Math.round(sw.lod))
  // B sharpens behind the fight: whole mip steps from switch.lod down to 1, the last ones late
  // (from switch.sharpenAt of the fight on)
  const stepsB = Math.max(1, lod)
  const fought = remap(tc, ph.fight, ph.lock)
  const late = Math.min(0.99, Math.max(0, sw.sharpenAt))
  const stageB = fought < late ? 0 : Math.min(stepsB - 1, 1 + Math.floor(((fought - late) / (1 - late)) * (stepsB - 1)))
  // the push and its heavy return, as the spring in solve.ts draws it: peak `swing` at swingTime
  const x = seconds / Math.max(0.03, sw.swingTime)
  // the side face sits at the picture's left edge — the leading edge when going back, the last one otherwise
  const sideAt = s.dir < 0 ? ph.fight : ph.lock
  return {
    ...base,
    mode: FaceMode.ZFight,
    tick,
    sweep,
    lodA: tc < ph.evict ? 0 : tc < (ph.evict + ph.fight) / 2 ? Math.min(2, lod) : lod,
    lodB: tc >= ph.lock ? 0 : Math.max(lod > 0 ? 1 : 0, lod - stageB),
    crushed: tc >= ph.evict && tc < ph.lock,
    // …and one small kick back as the new picture locks in: it lands with a thud
    split: s.dir * (k === firstTick(ph.lock) ? -Math.round(sw.split / 3) : splitAt(sw.split, k, Math.max(0, Math.round(sw.splitTicks)))),
    tear:
      k < Math.round(sw.tearTicks)
        ? { rows: sw.tearRows, shift: sw.tearShift }
        : k === firstTick((ph.settle + 1) / 2) && sw.tearRows > 0
          ? { rows: 1, shift: 1 }
          : { rows: 0, shift: 0 },
    energy: t < ph.lock ? 1 : 1 - remap(t, ph.lock, 1),
    sideB: tc >= sideAt,
    sideFlat: k === firstTick(sideAt),
    sheen: t >= ph.settle ? remap(t, ph.settle, 1) : -1,
    swing: s.dir * sw.swing * x * Math.exp(1 - x),
    pass: 0,
    cursor: 0,
  }
}
