import type { HeroConfig } from '../hero.config'

/** Config with the `mobile` overrides already applied for the current viewport. */
export type ResolvedConfig = Omit<HeroConfig, 'mobile'>

/** Rectangle in CSS px, relative to the hero's top-left corner. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  /** Hero size in CSS px. */
  width: number
  height: number
  /** window.devicePixelRatio (capped). */
  dpr: number
  isMobile: boolean
  cutouts: {
    main: Rect
    secondary: Rect
  }
  title: {
    /** Anchor point (CSS px): left edge of the "S", vertical middle of the letter. */
    x: number
    y: number
    /** Visual span of the whole title, CSS px. */
    width: number
    /** In-plane rotation, degrees (+ = clockwise). */
    rotation: number
  }
}

/**
 * Smoothed pointer. Coordinates are normalized to the hero:
 *   x: -1 (left edge) … +1 (right edge)
 *   y: -1 (top edge)  … +1 (bottom edge)   ← screen convention, y grows downward
 * Values are already multiplied by `motion.intensity` and include idle sway.
 */
export interface PointerState {
  /** Spring-smoothed position (use this for orientation / parallax). */
  x: number
  y: number
  /** Spring velocity, units per second. */
  vx: number
  vy: number
  /** 0…1 — how much things are moving right now (decays to 0 at rest). Drives shimmer/glitch. */
  energy: number
  /** Raw, unsmoothed pointer target (no intensity applied). */
  rawX: number
  rawY: number
  /**
   * What the shared spring chases this frame: raw pointer + idle sway, × motion.intensity.
   * Layers with their own mass chase this too (see core/spring.ts → Follower).
   */
  targetX: number
  targetY: number
  /** True while a real pointer is over the page. */
  active: boolean
}

/**
 * Where the page is between its screens (version 2: one stop per screen — 0 hero, 1 projects, 2 about,
 * 3 the end of the about tour). Positions are in SECTIONS (stops), not px: the way between two stops
 * may be any number of screens long (sky.config.ts → scroll.stops; 0.75 to projects, 5.4 through the
 * about tour), pos 2.5 is half-way along the third way whatever its length. Pages without a scroll
 * track (version 1) get core/scroll.ts → FROZEN_SCROLL: everything 0, forever.
 */
export interface ScrollState {
  /** Number of stops (screens). */
  count: number
  /** Unsmoothed position: the document's scroll (or the pinned debug value), in sections. */
  raw: number
  /** Smoothed position — what layers animate from. */
  pos: number
  /**
   * Speed of `pos`, sections per second (signed: + = going down). The same hand reads 7× smaller in
   * the about tour than in the hero's section — for "how fast does it look" use `speed`.
   */
  velocity: number
  /**
   * Speed of `pos` in px, as screens (viewH) per second (signed: + = going down) — the same for the
   * same hand in a short section and a long one. 0 at rest, when pinned and when nothing scrolls.
   */
  speed: number
  /**
   * 0…1 — how fast the page is travelling right now (decays to 0 at rest), like pointer.energy. Made
   * from `velocity` (sections/s, scroll.shimmerAt): the hero's shimmer is tuned on it — unchanged.
   */
  energy: number
  /** round(pos): the screen the picture is at. */
  section: number
  /** round(raw): the screen the document is heading to. */
  target: number
  /** The hero is fully behind the veil (scroll.cover, with hysteresis): its layers may sleep. */
  covered: boolean
  /** Pinned by `?scroll=` / `__hero.scroll.pin()` (repeatable screenshots). */
  pinned: boolean
  /** prefers-reduced-motion: no travel, `pos` follows the goal without a spring. */
  reduced: boolean
  /** Stage height (100lvh), CSS px. */
  viewH: number
  /** The always-visible height (100svh), CSS px: controls must stay inside it. */
  safeH: number
}

export interface Frame {
  /** Seconds since start (frozen when `?freeze=<t>` is set). */
  time: number
  /** Seconds since previous frame (clamped). */
  dt: number
  pointer: PointerState
  scroll: ScrollState
  layout: Layout
  config: ResolvedConfig
}

export interface Layer {
  /** Called on start, on viewport resize and when config changes (tuner). */
  resize(layout: Layout, config: ResolvedConfig): void
  /** Called every animation frame — unless the page says the layer is not live (HeroOptions.isLive). */
  update(frame: Frame): void
  dispose(): void
}

export interface LayerContext {
  layout: Layout
  config: ResolvedConfig
}

export type LayerFactory = (mount: HTMLElement, ctx: LayerContext) => Layer | Promise<Layer>
