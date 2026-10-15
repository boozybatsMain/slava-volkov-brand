import type { HeroConfig } from '../hero.config'
import type { Layout, Rect, ResolvedConfig } from './types'

type Plain = Record<string, unknown>

const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep merge for plain objects; arrays and primitives in `over` replace `base`. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : over) as T
  const out: Plain = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge((base as Plain)[k], v)
  return out as T
}

/** Knobs that may not exist in hero.config.ts yet; read with a fallback. */
interface OptionalKnobs {
  /** Width / height below which the vertical (mobile) composition is used. */
  mobileAspect?: number
}
interface OptionalMainKnobs {
  /** Main window proportion, width / height (1 = square). */
  aspect?: number
  /** Lowest point of the main window, % of screen height (the footer line lives below). */
  maxBottom?: number
}
interface ReducedMotion {
  intensity: number
  idle: number
  shimmer: number
  drift: number
}
const REDUCED_DEFAULT: ReducedMotion = { intensity: 0.25, idle: 0, shimmer: 0, drift: 0.2 }

/**
 * The vertical (mobile) composition is used on narrow screens and on any portrait-ish
 * screen (tablets, tall browser windows) — the desktop composition is a landscape one.
 * Landscape phones keep the desktop composition.
 */
export function isMobileViewport(config: Pick<HeroConfig, 'breakpoint'>, width: number, height: number) {
  const aspect = (config as OptionalKnobs).mobileAspect ?? 1
  return width < config.breakpoint || (height > 0 && width / height < aspect)
}

export interface ResolveEnv {
  /** prefers-reduced-motion: reduce */
  reducedMotion?: boolean
}

/**
 * Applies the `mobile` block on narrow / portrait viewports and damps self-motion
 * when the visitor asked the OS for reduced motion (motion.reduced).
 */
export function resolveConfig(
  config: HeroConfig,
  viewportWidth: number,
  viewportHeight: number,
  env: ResolveEnv = {},
): ResolvedConfig {
  const { mobile, ...base } = config
  const merged = isMobileViewport(config, viewportWidth, viewportHeight) ? deepMerge(base, mobile) : base
  const resolved: ResolvedConfig = structuredClone(merged)
  if (env.reducedMotion) {
    const r = { ...REDUCED_DEFAULT, ...(resolved.motion as { reduced?: Partial<ReducedMotion> }).reduced }
    resolved.motion.intensity *= r.intensity
    resolved.motion.idle *= r.idle
    resolved.title.response.shimmer *= r.shimmer
    resolved.title.raster.restShimmer *= r.shimmer
    // the rays behind the title hold still
    resolved.title.glow.rays.speed *= r.shimmer
    resolved.world.drift *= r.drift
  }
  return resolved
}

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

let warnedOverlap = false

/**
 * The brief: exactly two holes that never intersect. If the numbers make them overlap
 * (the evenodd clip would turn the shared part back into paper), the secondary window
 * is pushed out of the main one by the shortest way, preferring positions on screen.
 */
function separate(main: Rect, sec: Rect, width: number, height: number): Rect {
  if (!intersects(main, sec)) {
    warnedOverlap = false
    return sec
  }
  if (!warnedOverlap) {
    console.warn('[hero] cutouts intersect — the brief requires two separate holes; the secondary window is nudged aside')
    warnedOverlap = true
  }
  const gap = Math.max(8, 0.01 * width)
  const moves: Rect[] = [
    { ...sec, x: main.x - gap - sec.w },
    { ...sec, x: main.x + main.w + gap },
    { ...sec, y: main.y - gap - sec.h },
    { ...sec, y: main.y + main.h + gap },
  ]
  const cost = (r: Rect) => Math.abs(r.x - sec.x) + Math.abs(r.y - sec.y)
  const onScreen = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height
  const pool = moves.some(onScreen) ? moves.filter(onScreen) : moves
  return pool.reduce((a, b) => (cost(b) < cost(a) ? b : a))
}

export function computeLayout(cfg: ResolvedConfig, width: number, height: number): Layout {
  const pctW = (v: number) => (v / 100) * width
  const pctH = (v: number) => (v / 100) * height

  const m = cfg.cutouts.main as ResolvedConfig['cutouts']['main'] & OptionalMainKnobs
  const aspect = Math.max(0.05, m.aspect ?? 1)
  const wantW = pctW(m.size)
  const wantH = wantW / aspect
  // Sizes follow the width, positions the height: on wide-for-their-layout screens the
  // window would run into the footer line (or off the screen). Shrink it to stay above
  // maxBottom; the title shrinks with it so SLAVA keeps crossing the window the same way.
  const room = pctH((m.maxBottom ?? 81) - m.y)
  const fit = Math.min(1, Math.max(0.25, room / Math.max(1, wantH)))
  const main = { x: pctW(m.x), y: pctH(m.y), w: wantW * fit, h: wantH * fit }

  const s = cfg.cutouts.secondary
  const secW = pctW(s.width)
  const secondary = separate(
    main,
    { x: pctW(s.x), y: pctH(s.y), w: secW, h: secW / Math.max(0.05, s.aspect) },
    width,
    height,
  )

  const t = cfg.title
  return {
    width,
    height,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    isMobile: isMobileViewport(cfg, width, height),
    cutouts: { main, secondary },
    title: {
      x: main.x + t.anchor.x * main.w,
      y: main.y + t.anchor.y * main.h,
      width: pctW(t.width) * fit,
      rotation: t.rotation,
    },
  }
}

/**
 * Layout for the full-bleed variant (no paper): the "main window" is the whole screen,
 * so title.anchor is in fractions of the screen; there is no secondary window.
 */
export function computeFullscreenLayout(cfg: ResolvedConfig, width: number, height: number): Layout {
  const t = cfg.title
  return {
    width,
    height,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    isMobile: isMobileViewport(cfg, width, height),
    cutouts: {
      main: { x: 0, y: 0, w: width, h: height },
      secondary: { x: 0, y: 0, w: 0, h: 0 },
    },
    title: {
      x: t.anchor.x * width,
      y: t.anchor.y * height,
      width: (t.width / 100) * width,
      rotation: t.rotation,
    },
  }
}
