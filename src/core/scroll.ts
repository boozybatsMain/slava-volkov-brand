import { clamp, smoother } from './ease'
import { bool, num, obj } from './loose'
import { Spring1 } from './spring'
import type { ResolvedConfig, ScrollState } from './types'

/**
 * SCROLL — where the page is between its screens (version 2).
 *
 * The document scrolls natively: wheel, trackpad, finger, keys, #hash links all stay the browser's
 * (Back / Forward too — only the place they return to is put back from here). The stage itself is fixed; an invisible track of `.scroll-stop` elements only gives the
 * document its length (one stop per screen). Nothing here ever calls preventDefault.
 *
 *   scrollY ──▶ raw (sections) ──▶ goal (px; at most maxSpeed sections/s, capped in sections)
 *                                    └─▶ critically damped spring (px) ──▶ pos (sections) ──▶ every layer
 *
 * An ORDINARY scroll: the page never moves by itself. No snap, no settle — it stops wherever the
 * visitor stops, and the picture is simply a function of where the document is. The spring only
 * takes the steps out of a wheel (a notch arrives as one jump); maxSpeed is a high ceiling that
 * softens instant jumps (End key, a #hash link) and never slows a hand down.
 *
 * The one thing that does move the document is to(): a click on a nav link (or the focus entering
 * another screen) asks for a stop, and the document is walked there frame by frame in its own time
 * (scroll.clickTime, by the length of the way in px, at most scroll.clickMax; the browser's own
 * smooth scroll would flash the whole film by in half a second). That GLIDE never holds the page:
 * the visitor's first input — wheel, press, touch, a key that scrolls (GLIDE_KEYS) — drops it on the
 * spot, and so does any scroll that is not its own (see stepGlide). The document then simply stays
 * where it is, as after any other scroll. Under reduced motion there is no glide (the document is
 * there at once), and a tab that goes out of sight finishes its glide unseen.
 * Everything else — wheel, finger, keys, End / Home, a #hash link — is the browser's own scrolling.
 *
 * With one limit (scroll.gesture, see Gesture): ONE GESTURE TRAVELS AT MOST TO THE NEXT STOP. A swing
 * of the wheel, a finger's fling with its momentum, a held scroll key go on to the next stop in their
 * direction and no further — a fling from the hero rests exactly on projects, never half-way through
 * their leave and never in ABOUT; a new gesture may go on. Nothing is prevented: the browser scrolls
 * as it likes, and step() puts the document back on that stop (an instant scrollTo) BEFORE anything
 * reads it, so the picture never sees the overshoot (the stage is fixed, the track invisible). End /
 * Home, nav clicks, #hash, Back / Forward, a reload's landing and this file's own writes are free.
 *
 * Positions count STOPS, not px: pos 2 is the third stop whatever the lengths. Each way between two
 * stops has its own length (scroll.stops, by the id of the stop it leads to; scroll.travel when not
 * listed), written on the stops as --stop-travel — synchronously, in the constructor, so the first
 * layout already has the real document. The browser's own scroll restoration only knows OFFSETS, and
 * the same offset is another place of the film on another viewport (a phone turned round, a window
 * resized while the page was away) or before the lengths existed: so it is switched off
 * (history.scrollRestoration 'manual') and the place is kept in SECTIONS in history.state (save()).
 * Read back by land() once, at construction (a reload, a Back / Forward that rebuilt the page; a
 * fresh link to a #stop goes exactly to that stop), and by onPopState on a Back / Forward inside
 * the page.
 *
 * Numbers: sky.config.ts → scroll.
 */

export interface ScrollKnobs {
  travel: number
  /**
   * Screens of scroll on the way TO a stop, by that stop's id (scroll.stops); a stop not listed takes
   * `travel`. The way from stop i to stop i+1 is stop i's height, so this lands on stop i.
   */
  stops: Record<string, number>
  maxSpeed: number
  smooth: number
  /**
   * seconds a to() takes over a way of `travel` screens — the hero → projects one (0 — no glide: the
   * document jumps); longer ways by the square root of their length in px (glideSpan)
   */
  clickTime: number
  /** the longest a to() may take, seconds, however long the way (the whole about tour back to the top) */
  clickMax: number
  cover: { at: number; back: number }
  shimmer: number
  shimmerAt: number
  reducedSpeed: number
  /**
   * One gesture travels at most to the next stop (see Gesture). `gap` — ms without input and without
   * the document moving by itself (momentum, the browser's own animated scroll) that end a gesture.
   */
  gesture: { on: boolean; gap: number; stand: Record<string, { before: number; after: number }> }
}

/** Safety nets only (a config without the block); the documented values live in sky.config.ts. */
const DEFAULTS: ScrollKnobs = {
  travel: 0.75,
  stops: {},
  maxSpeed: 3,
  smooth: 12,
  clickTime: 1.1,
  clickMax: 2.2,
  cover: { at: 0.64, back: 0.61 },
  shimmer: 0.7,
  shimmerAt: 1.2,
  reducedSpeed: 4,
  gesture: { on: true, gap: 180, stand: {} },
}

/** scroll.gesture.stand: per stop id, the still stretch around it (sections before / after). */
function standOf(raw: Record<string, unknown>) {
  const out: Record<string, { before: number; after: number }> = {}
  for (const [id, v] of Object.entries(raw)) {
    const b = obj(v)
    out[id] = { before: clamp(num(b.before, 0), 0, 0.95), after: clamp(num(b.after, 0), 0, 0.95) }
  }
  return out
}

/** `config.scroll`, every key with a fallback. */
export function scrollKnobs(config: ResolvedConfig): ScrollKnobs {
  const s = obj((config as unknown as { scroll?: unknown }).scroll)
  const cover = obj(s.cover)
  const gesture = obj(s.gesture)
  const at = num(cover.at, DEFAULTS.cover.at)
  // only real numbers: a stop with a broken value takes travel, like one that is not listed
  const stops: Record<string, number> = {}
  for (const [id, v] of Object.entries(obj(s.stops))) {
    if (typeof v === 'number' && Number.isFinite(v)) stops[id] = Math.max(0.1, v)
  }
  return {
    travel: Math.max(0.1, num(s.travel, DEFAULTS.travel)),
    stops,
    maxSpeed: Math.max(0.01, num(s.maxSpeed, DEFAULTS.maxSpeed)),
    smooth: Math.max(0.5, num(s.smooth, DEFAULTS.smooth)),
    clickTime: Math.max(0, num(s.clickTime, DEFAULTS.clickTime)),
    clickMax: Math.max(0, num(s.clickMax, DEFAULTS.clickMax)),
    // `back` never above `at` (two independent sliders in the tuner): with the pair crossed, a page
    // resting between them would put the hero to sleep and wake it on alternate frames
    cover: { at, back: Math.min(at, num(cover.back, DEFAULTS.cover.back)) },
    shimmer: Math.max(0, num(s.shimmer, DEFAULTS.shimmer)),
    shimmerAt: Math.max(0.01, num(s.shimmerAt, DEFAULTS.shimmerAt)),
    reducedSpeed: Math.max(0.01, num(s.reducedSpeed, DEFAULTS.reducedSpeed)),
    gesture: {
      on: bool(gesture.on, DEFAULTS.gesture.on),
      gap: clamp(num(gesture.gap, DEFAULTS.gesture.gap), 40, 1000),
      stand: standOf(obj(gesture.stand)),
    },
  }
}

/** What `Frame.scroll` is on a page that does not scroll (version 1): the hero, at rest, forever. */
export const FROZEN_SCROLL: ScrollState = Object.freeze({
  count: 1,
  raw: 0,
  pos: 0,
  velocity: 0,
  speed: 0,
  energy: 0,
  section: 0,
  target: 0,
  covered: false,
  pinned: false,
  reduced: false,
  viewH: 0,
  safeH: 0,
})

/** What the layers may do with the scroll (the nav's links, focus moving into another screen, debug). */
export interface ScrollControl {
  readonly state: ScrollState
  /**
   * Go to a stop — by index or by its element id ('projects'). The document glides there in its own
   * time (scroll.clickTime / clickMax, by the way's length in px; at once under reduced motion) and lets go at the
   * visitor's first input: it then rests wherever it was. Asking again for the stop a glide is
   * already heading to changes nothing.
   */
  to(target: number | string): void
  /**
   * A history entry for a stop's '#id', as a plain anchor would give it — for a nav link that glides
   * there (call it, then to()). It only writes history; nothing scrolls here.
   * 1. The entry being LEFT keeps the place exactly as it is now (in sections), not as of the last
   *    save — that one is up to SAVE_EVERY old, and on a quick second click (PROJECTS, then ABOUT
   *    0.1 s later) a Back would land where the first click found the page, not where the second did.
   * 2. The new entry gets the entry's state WITHOUT its place (pushState(history.state) would copy
   *    the old one into it) — instead, the stop it leads to: the glide is only setting off. The
   *    regular save takes over exactly SAVE_EVERY after the push and keeps the real place from then
   *    on; an entry left sooner (Back 0.1 s after the click, then Forward) returns to its stop, at
   *    once, like any other Back / Forward.
   * The address already saying `hash`: no new entry (a plain anchor to the same #id adds none either).
   */
  pushHash(hash: string): void
  /** Index of the stop with this id, −1 if there is none (a nav item without a screen yet). */
  indexOf(id: string): number
  /** Debug: hold `pos` at v sections (null — release). */
  pin(v: number | null): void
}

/** The page's scroll, once the hero has created it (null on a page that does not scroll). */
export const scrollControl: { current: ScrollControl | null } = { current: null }

/**
 * Any of these = the visitor has taken the page in hand: from now on the smoother animates, and a
 * glide in flight lets go. Heard in the capture phase, so no handler on the page can keep one away.
 */
const INPUTS = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const
const HEARD = { passive: true, capture: true } as const
/** The keys that scroll a page, plus Escape: of all keys only these let go of a glide (see onInput). */
const GLIDE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar', 'Escape'])
/**
 * How long after one of GLIDE_KEYS the browser's own animated scroll from it may still be running, s
 * (Chrome: ≈ 0.15 s for PageDown / Space, and for End over the whole 5-screen tour). A glide asked
 * for AFTER such a key does not take that animation's frames for the visitor taking the page back
 * (stepGlide).
 */
const KEY_SCROLL = 0.4

/**
 * Closer than this to its goal (px of document) and slower than REST_PXV (px/s), the spring is home and
 * snaps onto it. In px, not sections: one section may be 0.75 screens and the next 5.4 — 1e-3 of the
 * long one is a 5 px jump of a camera that moves 1:1 with the scroll, the same 1e-3 of the short one
 * half a pixel. Near home a critically damped spring still moves ≈ scroll.smooth px/s for every px it
 * has to go, so it is the velocity bar that ends the motion, with a few hundredths of a px left; the
 * distance bar keeps a spring that has only just set off (v = 0) from snapping across a real gap.
 */
const REST_PX = 0.5
const REST_PXV = 0.5
/** Scroll offsets this close (px) are the same place: fractional stop tops, rounded scrollTo. */
const SAME_PX = 1
/**
 * history.state[STATE_KEY]: the document's place in SECTIONS (save()), read back by land() after a
 * reload or a Back / Forward that rebuilt the page, and by onPopState after one inside it. Written at most every SAVE_EVERY s while the
 * document moves (replaceState is not free, and browsers throttle it), and once more on the way out
 * (onLeave).
 */
const STATE_KEY = 'heroScroll'
const SAVE_EVERY = 0.25

/** state[STATE_KEY] (history.state by default), when it is a usable number. */
function savedRaw(st: unknown = history.state): number | null {
  const v = st && typeof st === 'object' ? (st as Record<string, unknown>)[STATE_KEY] : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * The id the address's #fragment names ('' — none). Never throws: a pasted or shortened link may
 * carry a stray % (#100%, #50%off), which decodeURIComponent rejects — and this runs inside the
 * constructor, where a throw would leave the whole page blank. Such a fragment is simply taken as
 * written (and names no stop: the ids are plain ASCII). `hash` — another '#fragment' than the address's.
 */
function hashId(hash = location.hash) {
  const raw = hash.slice(1)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** How this document was reached: 'navigate' (a link, the address bar), 'reload', 'back_forward', 'prerender'. */
function navigationType() {
  const entry = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined
  return entry?.type ?? 'navigate'
}

/**
 * How long a glide takes, in shares of scroll.clickTime, by the length of its way in px of the
 * document, counted in WAYS — scroll.travel screens, the hero → projects way, which takes exactly
 * clickTime (so the film that clickTime was tuned on keeps its timing). Not in stops: one section
 * may be 0.75 screens and the next 5.4, and a glide timed by stops would cross the about tour 7×
 * faster than the first way. Less than GLIDE_MIN of a way still takes that share: a short hop (the
 * page was stopped most of the way there) must not be a jerk. Past one way the time grows with the
 * square root of the length — three ways are not three times the wait — and never past
 * scroll.clickMax (to()).
 */
const GLIDE_MIN = 0.35
const glideSpan = (ways: number) => (ways > 1 ? Math.sqrt(ways) : Math.max(GLIDE_MIN, ways))

/** A to() in flight: the document is being walked to a stop, one frame at a time. */
interface Glide {
  /** the stop it is heading to */
  stop: number
  /**
   * where it set off, in sections — not px: the stops may move under it (a resize). The walk itself
   * is in px between this place and the stop (stepGlide), as they are now.
   */
  from: number
  /** seconds on the way / the whole trip */
  t: number
  dur: number
  /** when it was asked for (performance.now(), ms): a key pressed before this is not the visitor taking the page back (stepGlide) */
  born: number
  /**
   * The offset its last frame left the document at, as the browser reported it back (rounded,
   * clamped), px. null — nothing written yet, or the stops have moved since.
   */
  wrote: number | null
}

/**
 * ONE GESTURE, AT MOST ONE STAGE ON (scroll.gesture). A gesture is
 * - a swing of the wheel or a trackpad: wheel events less than scroll.gesture.gap apart, its momentum
 *   included (a trackpad's momentum IS wheel events); a change of direction starts a new one, and so
 *   does a new swing that comes on top of a dying momentum (WHEEL_RISE);
 * - a finger: from touchstart while any finger is down, then its momentum — until the document has
 *   stood still for `gap` (a new touchstart is a new gesture);
 * - scroll keys (↑ ↓, PageUp / PageDown, Space): presses less than `gap` apart, plus the browser's own
 *   animated scroll after each; a HELD key's repeats go on with the gesture its first press began,
 *   however long the system's repeat delay (KeyboardEvent.repeat).
 * Free (they end the gesture and are never held): End / Home (⌘↑ / ⌘↓), a press of the mouse
 * (autoscroll, a drag), nav clicks (to()), #hash, Back / Forward, a reload's landing, this file's writes.
 *
 * At its start the gesture takes the stops on either side of the document — the next one in each
 * direction, so on a stop exactly it is the stop above and the stop below — and for the rest of it the
 * document stays between them (hold(), from step(), before anything reads scrollY; and before the next
 * gesture starts). Pressed against one, it stays there while the momentum runs out. The first and the
 * last stop are the document's own ends: no wall there.
 */
interface Gesture {
  kind: 'wheel' | 'touch' | 'key'
  /** +1 down, −1 up; 0 for a finger (it may go either way) */
  dir: number
  /** the key that began it (its repeats go on with it) */
  key: string
  /** the stops it travels between, indices */
  lo: number
  hi: number
  /** its last input / the last frame the document moved by itself (momentum, an animated scroll); ms, performance.now()'s clock */
  input: number
  moved: number
  /** wheel: its speed, px/ms, smoothed (WHEEL_TAU); the highest so far, and the lowest since that */
  lvl: number
  peak: number
  floor: number
}

/** Wheel speed is smoothed over ≈ this many ms: per event and per ms, so coalesced events (two in one) read the same speed. */
const WHEEL_TAU = 40
/**
 * A NEW SWING on top of a dying momentum (macOS: the next flick comes while the last one's momentum
 * events still trickle in, closer than `gap`): the smoothed wheel speed had fallen below WHEEL_TAIL of
 * the gesture's peak and now rises WHEEL_RISE times over that low, by at least WHEEL_RISE_MIN px/ms.
 * A momentum only ever slows down, and a swing that is still speeding up keeps raising its own peak,
 * so neither starts a gesture by itself. Without this a flick made 0.1 s after landing on a stop would
 * be swallowed by the previous one's tail.
 */
const WHEEL_TAIL = 0.25
const WHEEL_RISE = 3
const WHEEL_RISE_MIN = 0.25
/** Wheel deltas in lines / pages (Firefox): px per line. */
const LINE_PX = 40
const DOWN_KEYS = new Set(['ArrowDown', 'PageDown', ' '])
const UP_KEYS = new Set(['ArrowUp', 'PageUp'])
/** Heard for the gestures (capture, passive — never prevented): see Gesture. */
const GESTURE_INPUTS = ['wheel', 'keydown', 'touchstart', 'touchend', 'touchcancel', 'pointerdown'] as const

export class Scroll implements ScrollControl {
  readonly state: ScrollState = { ...FROZEN_SCROLL }

  private readonly stops: HTMLElement[]
  /** 100svh, measured: the height that is visible whatever the browser's bars do */
  private readonly probe: HTMLElement
  /** document offset of every stop's top, px */
  private tops: number[] = [0]
  private dirty = true
  /** the --scroll-travel last written to <html> */
  private travel = NaN
  /** the --stop-travel last written on each stop but the last (undefined — none: it takes travel) */
  private lengths: (number | undefined)[] = []
  /** seconds since save() last looked */
  private sinceSave = 0

  /** the picture's spring and the goal it chases: px of the document (see step) */
  private readonly spring = new Spring1(0)
  private goal = 0
  private pinned: number | null = null
  /** until the later screens' layers are in, the picture does not travel: there is nothing to travel to yet */
  private locked = true
  /** a real input has happened: from now on the smoother animates (before it, pos = raw) */
  private touched = false
  private teleport = true
  /**
   * Where the document was at the last step, in sections; null before the first one (there is no
   * "same place" to keep yet). Not recomputed from scrollY when the stops move: a shrinking
   * document has its scrollY clamped by the browser before anyone here can read it.
   */
  private docRaw: number | null = null
  /** to() in flight (null — the document is nobody's but the visitor's) */
  private glide: Glide | null = null
  /** scroll.clickTime / clickMax as of the last step (to() is called between frames, without a config) */
  private clickTime = DEFAULTS.clickTime
  private clickMax = DEFAULTS.clickMax
  /** the last keydown of GLIDE_KEYS (event time, ms on performance.now()'s clock); −∞ — none yet */
  private keyAt = -Infinity
  /** the gesture in progress (null — none: the scroll is free) and scroll.gesture as of the last step */
  private gesture: Gesture | null = null
  private gestureOn = DEFAULTS.gesture.on
  private gestureGap = DEFAULTS.gesture.gap
  /** scroll.gesture.stand as of the last step */
  private stand: ScrollKnobs['gesture']['stand'] = {}
  /** a key's gesture just over: the same key's repeats (still held) take it up again */
  private lastKey: Gesture | null = null
  /** fingers on the glass, by the last touch event */
  private fingers = 0
  /**
   * scrollY as the last step left it (or this file's own last write since): where a new gesture
   * starts from (begin), and a document found elsewhere at the next step has moved by itself (Gesture.moved)
   */
  private leftY = 0

  /**
   * `config` — the page's config as resolved for this viewport (mobile, ?set.): the stops get their
   * lengths from it right here, before anything (the browser included) measures the document again.
   */
  constructor(track: HTMLElement, config: ResolvedConfig) {
    this.stops = [...track.children].filter((el): el is HTMLElement => el.classList.contains('scroll-stop'))
    this.state.count = Math.max(1, this.stops.length)

    this.probe = document.createElement('div')
    this.probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none;'
    // first, not last: the last stop is styled by :last-child
    track.prepend(this.probe)

    const pinned = new URLSearchParams(location.search).get('scroll')
    if (pinned !== null && Number.isFinite(Number(pinned))) this.pin(Number(pinned))

    this.writeLengths(scrollKnobs(config))
    // The place is this page's to restore, in sections (land(), onPopState): the browser's own
    // restoration puts back an OFFSET — another place of the film on another viewport, and it keeps
    // putting it back until the load is over, over land()'s. (Kept by the history entry: a reload
    // or a Back to this page is 'manual' from its very first moment.)
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    this.land()
    this.leftY = window.scrollY

    for (const type of INPUTS) window.addEventListener(type, this.onInput, HEARD)
    for (const type of GESTURE_INPUTS) window.addEventListener(type, this.onGesture, HEARD)
    window.addEventListener('pageshow', this.onPageShow)
    window.addEventListener('beforeunload', this.onLeave)
    window.addEventListener('pagehide', this.onLeave)
    window.addEventListener('popstate', this.onPopState)
    document.addEventListener('visibilitychange', this.onVisibility)
    // The window's resize event comes before the frame's rAF, the hero's ResizeObserver after it:
    // without this the stops would be one frame stale and the picture would twitch.
    window.addEventListener('resize', this.onResize, { passive: true })
  }

  /** The later screens' layers are in (or took too long): the picture may travel. */
  unlock() {
    this.locked = false
  }

  /**
   * Viewport or config changed. The heights are read now — the hero calls this before it resizes
   * the layers, and they place things inside safeH; the stops are re-measured on the next step.
   */
  resize(viewH: number) {
    this.state.viewH = viewH
    this.state.safeH = this.probe.getBoundingClientRect().height || window.innerHeight
    this.dirty = true
  }

  indexOf(id: string) {
    return this.stops.findIndex((el) => el.id === id)
  }

  to(target: number | string) {
    const i = typeof target === 'string' ? this.indexOf(target) : Math.round(target)
    if (!(i >= 0 && i < this.state.count)) return
    this.touched = true
    // asked for a stop: no gesture holds the way there (a click 0.1 s after a swing)
    this.free()
    // Already on its way there: the glide goes on as it is, not from a standstill again. (One click on
    // a nav link asks twice: the focus it moves into the section asks too. A held Enter asks 30 times a second.)
    if (this.glide?.stop === i) return
    if (this.dirty) this.measure()
    const top = this.tops[i] ?? 0
    const y = window.scrollY
    this.glide = null
    if (Math.abs(y - top) <= 0.5) return
    const dur = this.glideTime(y, top)
    // nothing to play (reduced motion, clickTime 0): the document is simply there
    if (dur <= 0) {
      window.scrollTo({ top, behavior: 'instant' })
      this.leftY = window.scrollY
    }
    else this.glide = { stop: i, from: this.rawAt(y), t: 0, dur, born: performance.now(), wrote: null }
  }

  /** Seconds a glide from offset y to offset top takes: by the way's length in px (glideSpan), in ways of scroll.travel screens. */
  private glideTime(y: number, top: number) {
    if (this.state.reduced) return 0
    const way = Math.max(1, this.travel * (this.state.viewH || window.innerHeight))
    return Math.min(this.clickMax, this.clickTime * glideSpan(Math.abs(top - y) / way))
  }

  pushHash(hash: string) {
    if (!hash.startsWith('#') || location.hash === hash) return
    if (this.dirty) this.measure()
    // 1. the entry being left: where the document is at this very moment
    this.save(this.rawAt(window.scrollY))
    // 2. the new one: the same state, with the stop it leads to for a place (a state that is not a
    //    plain object belongs to someone else and goes over as it is, without one)
    const st: unknown = history.state
    let next = st
    if (st === null || (typeof st === 'object' && !Array.isArray(st))) {
      const own: Record<string, unknown> = { ...(st as object | null) }
      delete own[STATE_KEY]
      const i = this.indexOf(hashId(hash))
      if (i >= 0) own[STATE_KEY] = i
      next = own
    }
    try {
      history.pushState(next, '', hash)
      // the save timer starts over with the new entry: its stop stays its place for a whole SAVE_EVERY
      // (left sooner, it returns to the stop; not sooner or later by the timer's phase)
      this.sinceSave = 0
    } catch {
      // throttled by the browser (Safari): the address stays as it was — the glide goes all the same
    }
  }

  pin(v: number | null) {
    this.pinned = v !== null && Number.isFinite(v) ? v : null
    this.state.pinned = this.pinned !== null
    // released: land where the document is, without a film from the pinned value
    if (this.pinned === null) this.teleport = true
  }

  private onInput = (e: Event) => {
    this.touched = true
    // A key takes the page in hand only if it scrolls it or says "stop" (GLIDE_KEYS). Tab, a lone
    // modifier, Enter (held, it clicks the link 30 times a second), letters and the project block's
    // own ← / → scroll nothing: dropping the glide for them would stop the page half-way without
    // the visitor having asked for it — quick Tabs made it crawl, each one dropping the glide its
    // own focus move had just asked for.
    if (e.type === 'keydown' && !GLIDE_KEYS.has((e as KeyboardEvent).key)) return
    // (the browser may go on animating this key's scroll after a click that comes right behind it: stepGlide)
    if (e.type === 'keydown') this.keyAt = e.timeStamp
    // The visitor has taken the page in hand: the glide lets go on the spot. Nothing is undone and
    // nothing is finished for them — the document stays where this moment found it.
    // (The press that asks for a glide comes before its click, so it never drops its own.)
    this.glide = null
  }

  /** Gestures begin, go on and end here (see Gesture). Nothing is prevented. */
  private onGesture = (e: Event) => {
    if (e.type.startsWith('touch')) this.fingers = (e as TouchEvent).touches.length
    if (!this.gestureOn) return
    // event time (coalesced or queued wheel events keep their real spacing), on performance.now()'s
    // clock like the steps' — or, from a browser that keeps another clock, the time it is heard
    const now = Math.abs(e.timeStamp - performance.now()) < 1000 ? e.timeStamp : performance.now()
    const g = this.gesture
    switch (e.type) {
      case 'wheel': {
        const w = e as WheelEvent
        // a pinch / ctrl+wheel zooms, a sideways wheel scrolls nothing here
        if (w.ctrlKey || w.deltaY === 0) return
        const dir = Math.sign(w.deltaY)
        const px = Math.abs(w.deltaY) * (w.deltaMode === 1 ? LINE_PX : w.deltaMode === 2 ? this.state.viewH || window.innerHeight : 1)
        if (g && g.kind === 'wheel' && g.dir === dir && this.alive(g, now)) {
          const dt = Math.max(4, now - g.input)
          g.input = now
          this.wheelSpeed(g, px, dt)
          if (!(g.floor < WHEEL_TAIL * g.peak && g.lvl > WHEEL_RISE * g.floor && g.lvl - g.floor > WHEEL_RISE_MIN)) return
          // a new swing on top of the old one's momentum: a gesture of its own, already this fast
          const lvl = g.lvl
          const n = this.begin('wheel', dir, '', now)
          n.lvl = n.peak = n.floor = lvl
          return
        }
        // the first event of a swing comes after a pause: its speed counts over a whole `gap`
        this.wheelSpeed(this.begin('wheel', dir, '', now), px, this.gestureGap)
        return
      }
      case 'keydown': {
        const k = e as KeyboardEvent
        const key = k.key
        // End / Home (⌘↓ / ⌘↑ on a Mac): to the end of the document, free
        if (key === 'End' || key === 'Home' || (k.metaKey && (key === 'ArrowUp' || key === 'ArrowDown'))) {
          this.free()
          return
        }
        const dir = DOWN_KEYS.has(key) ? (key === ' ' && k.shiftKey ? -1 : 1) : UP_KEYS.has(key) ? -1 : 0
        if (!dir) return
        if (k.repeat) {
          // held: the repeats go on with the gesture the first press began (the system's repeat
          // delay, ≈ 0.25–1 s, may be longer than that gesture lived)
          if (g?.kind === 'key' && g.key === key) {
            g.input = now
            return
          }
          if (this.lastKey?.key === key) {
            this.gesture = this.lastKey
            this.gesture.input = now
            this.lastKey = null
            return
          }
        } else if (g?.kind === 'key' && g.dir === dir && this.alive(g, now)) {
          // pressed again before the last press is over: the same gesture
          g.input = now
          g.key = key
          return
        }
        this.begin('key', dir, key, now)
        return
      }
      case 'touchstart':
        // a second finger (a pinch) belongs to the same hand
        if (g?.kind === 'touch' && this.fingers > 1) return
        this.begin('touch', 0, '', now)
        return
      case 'touchend':
      case 'touchcancel':
        // the finger is off: from here its momentum, until the document stands still for `gap`
        if (g?.kind === 'touch') g.input = now
        return
      case 'pointerdown':
        // a press of the mouse or a pen (autoscroll, a drag): not a swing — free (a finger's is the touchstart's)
        if ((e as PointerEvent).pointerType !== 'touch') this.free()
        return
    }
  }

  /** One wheel event into the gesture's smoothed speed (px over dt ms), its peak and its low since the peak. */
  private wheelSpeed(g: Gesture, px: number, dt: number) {
    g.lvl += (px / dt - g.lvl) * (1 - Math.exp(-dt / WHEEL_TAU))
    if (g.lvl >= g.peak) g.peak = g.floor = g.lvl
    else g.floor = Math.min(g.floor, g.lvl)
  }

  /** The gesture is still going at `now` (ms): a finger is down, or there was input or motion of its own less than `gap` ago. */
  private alive(g: Gesture, now: number) {
    return this.fingers > 0 || now - Math.max(g.input, g.moved) < this.gestureGap
  }

  /**
   * A new gesture from where the document was at the last frame: between the next stop up and the next
   * stop down (on a stop exactly — the stops on either side of it). Not from scrollY now: the wheel is
   * heard passively, and the browser may have scrolled by this very event before telling us (one wheel
   * event of 3000 px from the hero arrived with scrollY already 3000 — a gesture taken from there
   * would have been free to stay in ABOUT). A gesture it replaces while still going keeps its
   * overshoot of the frame since the last step: the document goes back inside that one first. (One
   * that is already over has had no motion for `gap`: what moved since is this event's own scroll.)
   */
  private begin(kind: Gesture['kind'], dir: number, key: string, now: number): Gesture {
    if (this.dirty) this.measure()
    if (this.gesture && this.alive(this.gesture, now)) this.hold()
    const r = this.standing(this.rawAt(this.leftY))
    const last = this.state.count - 1
    const g: Gesture = {
      kind,
      dir,
      key,
      lo: Math.max(0, Math.ceil(r) - 1),
      hi: Math.min(last, Math.floor(r) + 1),
      input: now,
      moved: -Infinity,
      lvl: 0,
      peak: 0,
      floor: 0,
    }
    this.gesture = g
    this.lastKey = null
    return g
  }

  /**
   * A start inside a stop's still stretch (scroll.gesture.stand: where the picture does not move — the
   * projects screen arrived but not yet leaving, ABOUT finished) counts as ON that stop: the gesture may
   * go on to the next one. Without this a swing from there would end at the very stop the screen
   * already shows, and nothing on screen would change.
   */
  private standing(r: number) {
    for (let i = 0; i < this.stops.length; i++) {
      const b = this.stand[this.stops[i].id]
      if (b && r >= i - b.before && r <= i + b.after) return i
    }
    return r
  }

  /** No gesture: the scroll is free (End / Home, a click, Back / Forward, the knob switched off). */
  private free() {
    this.gesture = null
    this.lastKey = null
  }

  /**
   * The document back between the gesture's stops, at once (it may have gone past one since the last
   * step). The first and the last stop are the document's own ends — no wall there. Within SAME_PX of
   * a stop is ON it already (rawAt): nothing to write.
   */
  private hold() {
    const g = this.gesture
    if (!g) return
    const lo = g.lo > 0 ? (this.tops[g.lo] ?? -Infinity) : -Infinity
    const hi = g.hi < this.state.count - 1 ? (this.tops[g.hi] ?? Infinity) : Infinity
    const y = window.scrollY
    if (y < lo - SAME_PX || y > hi + SAME_PX) window.scrollTo({ top: clamp(y, lo, hi), behavior: 'instant' })
  }

  /**
   * Once per frame, before anything reads scrollY: the gesture holds the document between its stops,
   * notes whether the document moved by itself since the last frame (momentum, the browser's animated
   * scroll — these keep a gesture going), and ends once `gap` has passed without input or motion and no
   * finger is down — after one last hold, so its overshoot never reaches the picture.
   */
  private stepGesture(k: ScrollKnobs['gesture']) {
    this.gestureOn = k.on
    this.gestureGap = k.gap
    this.stand = k.stand
    const g = this.gesture
    if (g && !k.on) this.free()
    else if (g) {
      const now = performance.now()
      if (Math.abs(window.scrollY - this.leftY) > 0.5) g.moved = now
      this.hold()
      if (!this.alive(g, now)) {
        this.gesture = null
        // a key still held may take it up again with its repeats
        this.lastKey = g.kind === 'key' ? g : null
      }
    }
    this.leftY = window.scrollY
  }

  private onResize = () => {
    this.dirty = true
  }

  /** Back from the bfcache: the browser restores the scroll offset — land there, do not replay the film. */
  private onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted) return
    this.teleport = true
    this.glide = null
    this.free()
    this.fingers = 0
  }

  /**
   * Back / Forward inside the page (a nav link pushed the entry), or a #fragment link. On a
   * traversal the browser no longer puts back an offset of its own (scrollRestoration 'manual'): the
   * entry's place is put back, in sections — whatever the viewport has done meanwhile — and the
   * picture is simply there, like a page restored from the bfcache, no film. (The nav's entries
   * always have one: pushHash gives the new entry its stop and the one it leaves its exact place.)
   * An entry without one (pushed by someone else) goes to the stop its #hash names, and one without
   * either is left where it is.
   * A #fragment link lands here too, with no state in the EVENT (history.state may still hold the
   * entry's: the same #hash again replaces the entry) — it goes the stop way: the browser scrolls to
   * the element itself, to the same offset, and the picture follows at maxSpeed as after any other
   * jump, so no teleport for that one.
   */
  private onPopState = (e: PopStateEvent) => {
    // Back / Forward, a #hash: wherever they take the document, no gesture holds it
    this.free()
    if (this.dirty) this.measure()
    const saved = savedRaw(e.state)
    const i = saved === null ? this.indexOf(hashId()) : -1
    if (saved === null && i < 0) return
    this.glide = null
    const top = saved !== null ? this.topAt(clamp(saved, 0, this.state.count - 1)) : (this.tops[i] ?? 0)
    if (saved !== null) this.teleport = true
    if (Math.abs(window.scrollY - top) > SAME_PX) window.scrollTo({ top, behavior: 'instant' })
    this.leftY = window.scrollY
  }

  /**
   * Leaving (a reload, a link, Back, the tab closing): the place as it is now, not as of the last
   * save. On beforeunload — Chrome drops a replaceState made on pagehide (the entry keeps the last
   * save: a reload 0.1 s after a flick reopened 0.25 s back) — and on pagehide too, for the browsers
   * that send no beforeunload (iOS Safari). (Neither keeps the page out of the bfcache; unload would.)
   */
  private onLeave = () => {
    if (this.dirty) this.measure()
    this.save(this.rawAt(window.scrollY))
  }

  /**
   * Keeps `raw` (sections) in history.state[STATE_KEY], next to whatever else the entry holds (a new
   * entry from pushHash starts with its stop there; from the next save on it is the real place).
   * Sections, not px: the lengths may be different when it is read back (another viewport, a phone
   * turned round).
   * A state that is not a plain object belongs to someone else and is left alone.
   */
  private save(raw: number) {
    const st: unknown = history.state
    if (st !== null && (typeof st !== 'object' || Array.isArray(st))) return
    if (savedRaw() === raw) return
    try {
      history.replaceState({ ...(st as object | null), [STATE_KEY]: raw }, '')
    } catch {
      // throttled by the browser (Safari counts the calls per half minute) — the next save catches up
    }
  }

  /**
   * One-shot, from the constructor (the lengths are written): put the document where this page must
   * open — before the first frame, and before the hero decides from scrollY whether the page opened
   * away from the top (hero.ts → eager).
   * - A reload, or a Back / Forward that rebuilt the page (not the bfcache: that one keeps everything):
   *   where it was left, from history.state — in sections, so a resized window or a turned phone opens
   *   on the same place of the film, not at the same pixel. (The browser's own offset restoration is
   *   off: scrollRestoration 'manual'.)
   * - A fresh navigation to a stop's #id: exactly on that stop. The browser may have scrolled to the
   *   element on the fallback lengths too (#about 1.5 screens down instead of 2.15: pos ≈ 1.54, half-way
   *   through the pull-back). (Chrome happens to scroll after this script; nothing promises it.)
   * Nothing to do when the page opens at the top, or where the browser already put it.
   */
  private land() {
    const type = navigationType()
    let at: number | null
    if (type === 'reload' || type === 'back_forward') at = savedRaw()
    else {
      const i = location.hash.length > 1 ? this.indexOf(hashId()) : -1
      at = i >= 0 ? i : null
    }
    if (at === null) return
    this.measure()
    const top = this.topAt(clamp(at, 0, this.state.count - 1))
    if (Math.abs(window.scrollY - top) > SAME_PX) window.scrollTo({ top, behavior: 'instant' })
    this.leftY = window.scrollY
  }

  /**
   * The document's length: --scroll-travel on <html> (scroll.travel), and on each stop but the last
   * --stop-travel when scroll.stops lists the NEXT stop (the way from stop i to stop i+1 is stop i's
   * height; styles.css → .scroll-stop). Called every step (tuner, ?set., a resize that crossed into the
   * mobile config): it writes only what changed and then marks the stops for re-measuring — measure()
   * keeps the page at the same place of the film.
   */
  private writeLengths(k: ScrollKnobs) {
    let changed = false
    if (k.travel !== this.travel) {
      this.travel = k.travel
      document.documentElement.style.setProperty('--scroll-travel', String(k.travel))
      changed = true
    }
    for (let i = 0; i < this.stops.length - 1; i++) {
      const own = k.stops[this.stops[i + 1].id]
      if (own === this.lengths[i] && i < this.lengths.length) continue
      this.lengths[i] = own
      if (own === undefined) this.stops[i].style.removeProperty('--stop-travel')
      else this.stops[i].style.setProperty('--stop-travel', String(own))
      changed = true
    }
    if (changed) this.dirty = true
  }

  /**
   * The tab went out of sight with a glide in flight (frames stop there): the click is honoured at
   * once, unseen — the document is at its stop. Coming back to a page that starts moving by itself
   * would be exactly what this scroll never does.
   */
  private onVisibility = () => {
    const g = this.glide
    if (!g || !document.hidden) return
    this.glide = null
    this.teleport = true
    if (this.dirty) this.measure()
    window.scrollTo({ top: this.tops[g.stop] ?? 0, behavior: 'instant' })
    this.leftY = window.scrollY
  }

  /** Document offset → sections (piecewise linear between the stops' tops). */
  private rawAt(y: number) {
    const t = this.tops
    const last = t.length - 1
    if (last < 1 || y <= t[0]) return 0
    for (let i = 0; i < last; i++) {
      if (y >= t[i + 1] - SAME_PX) {
        if (y <= t[i + 1] + SAME_PX || i === last - 1) return i + 1
        continue
      }
      if (y - t[i] <= SAME_PX) return i
      return i + (y - t[i]) / Math.max(1, t[i + 1] - t[i])
    }
    return last
  }

  /**
   * Document offset → sections, exactly: the same line as rawAt, without its SAME_PX rounding onto the
   * stops — for the picture's spring (in px), which must not jump the last pixel before a stop.
   */
  private rawOfPx(y: number) {
    const t = this.tops
    const last = t.length - 1
    if (last < 1 || y <= t[0]) return 0
    for (let i = 0; i < last; i++) if (y < t[i + 1]) return i + (y - t[i]) / Math.max(1, t[i + 1] - t[i])
    return last
  }

  /** Sections → document offset (the inverse of rawAt). */
  private topAt(raw: number) {
    const t = this.tops
    const i = clamp(Math.floor(raw), 0, Math.max(0, t.length - 2))
    return t[i] + (raw - i) * ((t[i + 1] ?? t[i]) - t[i])
  }

  /** Length of the section `raw` lies in (from stop floor(raw) to the next), px — ≥ 1. */
  private sectionPx(raw: number) {
    const t = this.tops
    const i = clamp(Math.floor(raw), 0, Math.max(0, t.length - 2))
    return Math.max(1, (t[i + 1] ?? t[i]) - t[i])
  }

  private measure() {
    this.dirty = false
    const y = window.scrollY
    const before = this.tops
    // the picture's spring and its goal count px of the document as it was: their places in sections,
    // to carry them over to the new lengths (and the spring's speed with its section's)
    const springRaw = this.rawOfPx(this.spring.x)
    const goalRaw = this.rawOfPx(this.goal)
    const springSection = this.sectionPx(springRaw)
    this.tops = this.stops.length ? this.stops.map((el) => el.getBoundingClientRect().top + y) : [0]
    // The stops moved under the page (window resized, travel changed): stay at the same place of
    // the film, not at the same pixel — the second screen must not half-leave on a resize.
    // Only then: a phone's URL bar sliding away also fires a resize, in the middle of a finger's
    // scroll, and the stops (in lvh) stay where they are — the document must be left alone.
    const moved = before.length !== this.tops.length || before.some((t, i) => Math.abs(t - this.tops[i]) > SAME_PX)
    if (moved && this.docRaw !== null) {
      const top = this.topAt(this.docRaw)
      if (Math.abs(y - top) > SAME_PX) window.scrollTo({ top, behavior: 'instant' })
      this.leftY = window.scrollY
    }
    if (moved) {
      const v = (this.spring.v * this.sectionPx(springRaw)) / springSection
      this.spring.set(this.topAt(springRaw))
      this.spring.v = v
      this.goal = this.topAt(goalRaw)
    }
    // a glide in flight goes on to its stop, wherever that is now (it counts in sections); the
    // offset it left the document at means nothing any more
    if (moved && this.glide) this.glide.wrote = null
  }

  /**
   * One frame of a to() in flight: the document is put where the glide is now. The picture follows
   * through the same goal → spring as any other scroll, so nothing on screen knows the difference.
   *
   * It never holds the page. Inputs drop it at once (onInput). And whatever else moves the document —
   * a finger that was already down, Back / Forward, a #hash, another script, an input no event told
   * us about — shows up here as an offset that is not the one the last frame left: then the
   * document is theirs, and the glide is over without another write.
   * One exception: the browser's own animated scroll from a key pressed just BEFORE the glide was
   * asked for (PageDown, then a click on ABOUT 40 ms later). It runs on for ≈ 0.15 s whatever we
   * write (an instant scrollTo does not stop it, and writing over it every frame would only shake the
   * page), and it is not the visitor taking the page back: the click came after the key. While it
   * may still be running (KEY_SCROLL after that key) the glide sets off again from wherever it has
   * taken the document — its first steps hardly move, so it simply begins once the animation is over.
   */
  private stepGlide(dt: number, reduced: boolean) {
    const g = this.glide
    if (!g) return
    if (g.wrote !== null && Math.abs(window.scrollY - g.wrote) > SAME_PX) {
      const keyScroll = this.keyAt < g.born && performance.now() - this.keyAt < KEY_SCROLL * 1000
      if (!keyScroll) {
        this.glide = null
        return
      }
      const y = window.scrollY
      g.from = this.rawAt(y)
      g.t = 0
      // (0 only if reduced motion or clickTime 0 came in meanwhile: then the plain jump, just below)
      g.dur = Math.max(1e-3, this.glideTime(y, this.tops[g.stop] ?? 0))
      g.wrote = null
    }
    g.t += dt
    // (reduced motion switched on in mid-flight: there at once)
    const u = reduced ? 1 : clamp(g.t / g.dur, 0, 1)
    // In px, not sections: the document moves evenly over its length, so the 5.4-screen tour gets
    // its share of the time instead of the share of one section of three.
    const a = this.topAt(g.from)
    const b = this.tops[g.stop] ?? 0
    window.scrollTo({ top: a + (b - a) * smoother(u), behavior: 'instant' })
    g.wrote = window.scrollY
    if (u >= 1) this.glide = null
  }

  /** Once per frame, after the pointer. Reads `config.scroll` every time (tuner, ?set.). */
  step(dt: number, config: ResolvedConfig, reduced: boolean) {
    const k = scrollKnobs(config)
    this.writeLengths(k)
    if (this.dirty) this.measure()
    this.clickTime = k.clickTime
    this.clickMax = k.clickMax
    this.stepGlide(dt, reduced)
    // before docRaw below: a gesture's overshoot past its stop never reaches the picture
    this.stepGesture(k.gesture)

    const s = this.state
    const max = s.count - 1
    const pinned = this.pinned !== null
    s.reduced = reduced
    this.docRaw = this.rawAt(window.scrollY)
    // the document's place (not the pinned one) for a reload; a page at rest writes nothing
    this.sinceSave += dt
    if (this.sinceSave >= SAVE_EVERY) {
      this.sinceSave = 0
      this.save(this.docRaw)
    }
    s.raw = clamp(this.pinned ?? this.docRaw, 0, max)
    s.target = clamp(Math.round(s.raw), 0, max)
    // The picture's goal → spring run in PX of the document, not in sections. Inside one section that
    // is the same motion; across a stop it is not: the sections have their own lengths (0.75, 1.4, 5.4
    // screens), and a spring in sections, still lagging in the long one while the document already
    // runs through the short one at 4× the sections a second, rushed the picture through the long
    // one's last stretch (a click from the end of the tour to PROJECTS: 9 screens/s at ABOUT home).
    const want = this.topAt(s.raw)
    const before = this.spring.x
    /** the spring is exactly on the document's place: pos is raw itself (not raw → px → raw, in floats) */
    let there = false
    let v = 0

    if (this.teleport || pinned || !this.touched) {
      // No film to play: the page simply IS where the document is (a reload on the second screen,
      // #projects, a restored scroll, a pinned debug value) — also while locked.
      this.teleport = false
      this.goal = want
      this.spring.set(want)
      there = true
    } else {
      // locked: the visitor scrolled before the next screen could draw — the picture waits for it.
      // maxSpeed / reducedSpeed count sections a second, so the cap is taken IN SECTIONS and only then
      // turned into px (topAt): a step that crosses a stop spends each part at its own section's
      // length. Sized in px by the section the goal started in, a step up from a long section (the
      // 5.4-screen tour) was spent in the short one above it — one frame of 2–4× the speed at the stop.
      const rate = this.locked ? 0 : reduced ? k.reducedSpeed : k.maxSpeed
      const gr = this.rawOfPx(this.goal)
      const lim = rate * dt
      this.goal = Math.abs(s.raw - gr) <= lim ? want : this.topAt(gr + Math.sign(s.raw - gr) * lim)
      if (reduced) {
        this.spring.set(this.goal)
        v = dt > 0 ? (this.goal - before) / dt : 0
        there = this.goal === want
      } else {
        this.spring.step(this.goal, dt, k.smooth)
        // home: stop exactly ON the place, so every layer gets a clean 0 / 1 and can go quiet
        if (this.goal === want && Math.abs(want - this.spring.x) < REST_PX && Math.abs(this.spring.v) < REST_PXV) {
          this.spring.set(want)
          there = true
        }
        v = this.spring.v
      }
    }
    s.pos = there ? s.raw : clamp(this.rawOfPx(this.spring.x), 0, max)
    // the same motion in sections, and in screens: a hand moving at one screen a second reads 1 in every section
    s.velocity = v / this.sectionPx(s.pos)
    s.speed = s.viewH > 0 ? v / s.viewH : 0

    // Like pointer.energy: rises fast, lingers a moment after the motion stops.
    const target = Math.min(1, Math.abs(s.velocity) / k.shimmerAt)
    s.energy += (target - s.energy) * (target > s.energy ? 1 - Math.exp(-dt * 12) : 1 - Math.exp(-dt * 3))
    if (target === 0 && s.energy < 1e-4) s.energy = 0

    s.section = clamp(Math.round(s.pos), 0, max)
    // Hysteresis, so a hand resting right at the threshold does not flip the hero on and off.
    // Pinned (screenshots): a pure function of pos — a scrub must not depend on the order of its steps.
    if (pinned || !s.covered) s.covered = s.pos >= k.cover.at
    else if (s.pos < k.cover.back) s.covered = false
  }

  dispose() {
    for (const type of INPUTS) window.removeEventListener(type, this.onInput, HEARD)
    for (const type of GESTURE_INPUTS) window.removeEventListener(type, this.onGesture, HEARD)
    this.glide = null
    this.free()
    window.removeEventListener('pageshow', this.onPageShow)
    window.removeEventListener('beforeunload', this.onLeave)
    window.removeEventListener('pagehide', this.onLeave)
    window.removeEventListener('popstate', this.onPopState)
    if ('scrollRestoration' in history) history.scrollRestoration = 'auto'
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('resize', this.onResize)
    this.probe.remove()
  }
}
