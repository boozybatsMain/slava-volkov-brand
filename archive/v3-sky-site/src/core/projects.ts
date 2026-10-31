import { clamp01 } from './ease'
import { num, obj } from './loose'
import type { Frame, ResolvedConfig } from './types'

/**
 * PROJECTS — which project the second screen shows, and the timeline of a switch.
 *
 * One store, two readers: the slab draws the picture transition from `from`, `to`, `dir`, `t`; the
 * project texts swap on `index`. Whoever handles the input (arrows, keys, swipe) calls request().
 * Both layers call step(frame) first thing in update(): the first call of a frame advances the
 * timeline, the others are no-ops — so it does not matter which of the two is mounted or live.
 *
 *   request(±1) ─▶ t: 0 ──────────────▶ 1 (switch.duration seconds; idle again: from === to === index)
 *                       └ index becomes `to` at t ≥ ui.swap.in
 *
 * No queue: a request in the middle of a switch re-targets it — what was arriving becomes the
 * picture to leave (from ← to, to ← next) and the timeline re-enters at switch.reenter, inside the
 * opening "hit" where the glitch hides the swap. Holding an arrow key keeps the screen scrambled and
 * resolves to the last target.
 *
 * Numbers: sky.config.ts → projects.switch / projects.ui.swap.
 */

export interface ProjectsState {
  count: number
  /** What the texts and the link show. */
  index: number
  /** The picture leaving / arriving (equal when idle). */
  from: number
  to: number
  /** 1 — to the next project, −1 — to the previous one. */
  dir: 1 | -1
  /** Progress of the switch, 0…1; 1 = idle. */
  t: number
  /** Held by `?switch=` / `__hero.projects.pin()` (the pair from → to stays as it is, even at t = 1). */
  pinned: boolean
  /** Per project: its picture is ready to show (setLoaded). */
  loaded: boolean[]
}

/** The knobs the store reads, structurally: core does not depend on one page's config type. */
interface Knobs {
  keys: string[]
  /** 'cut' completes at once, anything else runs the timeline */
  mode: string
  duration: number
  reenter: number
  /** where a switch waits for a picture that is not decoded yet: the end of the "evict" phase */
  holdAt: number
  swapIn: number
}

/** Safety nets only; the documented values live in sky.config.ts → projects. */
function read(config: ResolvedConfig | null): Knobs {
  const p = obj((config as unknown as { projects?: unknown } | null)?.projects)
  const sw = obj(p.switch)
  return {
    keys: Object.keys(obj(p.items)),
    mode: typeof sw.mode === 'string' ? sw.mode : 'zfight',
    duration: Math.max(0.05, num(sw.duration, 1.05)),
    reenter: clamp01(num(sw.reenter, 0.07)),
    holdAt: clamp01(num(obj(sw.phases).fight, 0.2)),
    swapIn: clamp01(num(obj(obj(p.ui).swap).in, 0.46)),
  }
}

/**
 * A picture that is not decoded yet holds the timeline at the end of the "evict" phase (the old
 * picture already degraded, the new one not needed on screen yet: projects.switch.phases.fight) —
 * for at most HOLD_MAX seconds, then the switch goes on with whatever the slab can show. That wait
 * is paid once per picture: one that has kept a switch waiting to the end is not waited for again.
 */
const HOLD_MAX = 2.5

const state: ProjectsState = { count: 0, index: 0, from: 0, to: 0, dir: 1, t: 1, pinned: false, loaded: [] }
const listeners = new Set<(s: ProjectsState) => void>()
let knobs = read(null)
let inited = false
let reduced = false
let lastFrame: Frame | null = null
/**
 * per project: nobody waits for its picture any more — setLoaded() has been called (with either
 * result: a failed picture is not waited for), or a switch has already waited HOLD_MAX for it
 */
let settled: boolean[] = []
/** seconds the current switch has spent waiting for its picture */
let held = 0

const wrap = (i: number) => (state.count ? ((i % state.count) + state.count) % state.count : 0)
const emit = () => listeners.forEach((fn) => fn(state))

function setCount(count: number) {
  if (count === state.count) return
  state.count = count
  state.loaded = Array.from({ length: count }, (_, i) => !!state.loaded[i])
  settled = Array.from({ length: count }, (_, i) => !!settled[i])
  state.index = wrap(state.index)
  state.from = wrap(state.from)
  state.to = wrap(state.to)
}

export interface ProjectsStore {
  readonly state: ProjectsState
  init(config: ResolvedConfig): void
  request(dir: 1 | -1): void
  step(frame: Frame): void
  setLoaded(i: number, ok: boolean): void
  pin(t: number | null): void
  onChange(fn: (s: ProjectsState) => void): () => void
}

export const projects: ProjectsStore = {
  state,

  /**
   * Idempotent: every layer that uses the store calls it from its factory. The first call reads the
   * debug params (the hero has already stripped them on a public build):
   *   ?project=2 | ?project=apex   start on this project (zero-based index, or its key in projects.items)
   *   ?dir=-1                      direction of the pinned / next switch
   *   ?switch=0.4                  hold the switch INTO that project at t = 0.4 (from its neighbour against dir)
   */
  init(config: ResolvedConfig) {
    knobs = read(config)
    setCount(knobs.keys.length)
    if (inited) return
    inited = true
    const q = new URLSearchParams(location.search)
    const p = q.get('project')
    if (p !== null && p !== '') {
      const i = knobs.keys.includes(p) ? knobs.keys.indexOf(p) : Number(p)
      if (Number.isFinite(i)) state.index = state.from = state.to = wrap(Math.round(i))
    }
    if (q.has('dir')) state.dir = Number(q.get('dir')) < 0 ? -1 : 1
    if (q.has('switch')) projects.pin(Number(q.get('switch')) || 0)
  },

  /** Go to the next (1) / previous (−1) project; the list wraps. Ignored while pinned. */
  request(dir: 1 | -1) {
    if (state.count < 2 || state.pinned) return
    const switching = state.t < 1
    state.dir = dir < 0 ? -1 : 1
    const next = wrap((switching ? state.to : state.index) + state.dir)
    held = 0
    if (reduced || knobs.mode === 'cut') {
      // no show: the new project is simply there
      state.from = state.to = state.index = next
      state.t = 1
    } else if (switching) {
      state.from = state.to
      state.to = next
      state.t = knobs.reenter
    } else {
      state.from = state.index
      state.to = next
      state.t = 0
    }
    emit()
  },

  /**
   * Advance the timeline. Call it first in update(); only the first call with a given Frame object
   * does anything (the hero makes one Frame per tick — `?freeze` stops frame.time, not the switch).
   */
  step(frame: Frame) {
    if (frame === lastFrame) return
    lastFrame = frame
    knobs = read(frame.config)
    setCount(knobs.keys.length)
    reduced = frame.scroll.reduced
    if (state.pinned) return
    const before = state.index
    if (state.t < 1) {
      let t = state.t + frame.dt / knobs.duration
      if (!settled[state.to] && held < HOLD_MAX && state.t <= knobs.holdAt) {
        held += frame.dt
        t = Math.min(t, knobs.holdAt)
        // Waited in full, once: a stalled file must not cost every later switch to it the same
        // HOLD_MAX seconds of a half-erased screen. (It still shows up if it ever arrives.)
        if (held >= HOLD_MAX) settled[state.to] = true
      }
      state.t = Math.min(1, t)
      if (state.t >= knobs.swapIn) state.index = state.to
    }
    if (state.t >= 1) {
      // idle (also: released from a pin at its end)
      state.index = state.from = state.to
    }
    if (state.index !== before) emit()
  },

  /** The slab reports a picture: decoded (ok) or failed (it shows its placeholder card). Either way nobody waits for it any more. */
  setLoaded(i: number, ok: boolean) {
    if (!(i >= 0 && i < state.count)) return
    state.loaded[i] = ok
    settled[i] = true
  },

  /**
   * Debug: hold the switch at t (0…1) — the pair from → to is kept, and when idle it becomes
   * "into the current project, along `dir`". null releases it (an unfinished switch plays on).
   */
  pin(t: number | null) {
    if (t === null || !Number.isFinite(t)) {
      state.pinned = false
      return
    }
    state.pinned = true
    if (state.from === state.to) state.from = wrap(state.to - state.dir)
    state.t = clamp01(t)
    const index = state.t >= knobs.swapIn ? state.to : state.from
    if (index !== state.index) {
      state.index = index
      emit()
    }
  },

  /** `to` or `index` changed. Returns the unsubscribe. */
  onChange(fn: (s: ProjectsState) => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
