import { lerp, remap, smooth } from '../../core/ease'
import { bool, num, obj, str, type Loose } from '../../core/loose'
import type { ResolvedConfig, ScrollState } from '../../core/types'

/**
 * Knobs of the layered sky (sky.source = 'layers'), read from `config.sky` with a fallback for
 * every key: the layer must work with any config (an old one, a hand-edited one, the tuner).
 * The documented defaults live in src/sky.config.ts — the values below are only safety nets.
 *
 * The same renderer also draws the VEIL of the second screen (the clouds that rise over the title,
 * the whiteout, the void): its layers are read from `config.veil` in exactly the same shape
 * (block 'veil'), plus the few knobs only the veil has (scroll / solid / afterFog, fog, color).
 */

/** Which block of the config a renderer instance draws: the hero's sky, or the veil over it. */
export type SkyBlock = 'sky' | 'veil'

/** What a layer is, which decides how it is drawn:
 *   plate  — the opaque sky photo, always covers the screen (key `plate`);
 *   moon   — a disc with a phase mask, haze and glow (key `moon`);
 *   clouds — a free-floating picture with transparency (cloudlets);
 *   bank   — a wall of clouds along the bottom: repeated sideways and mirrored downward, so its
 *            sides and bottom can never show, whatever the screen, parallax or drift. */
export type LayerKind = 'plate' | 'moon' | 'clouds' | 'bank'

export interface Grade {
  saturation: number
  brightness: number
  contrast: number
  tint: string
  tintAmount: number
}

/** A layer's share of the shared wind (sky.wind): one clock and one direction for every layer. */
export interface Drift {
  /** Ping-pong half-amplitude, px: x = range · sin(2π t / wind.period) · wind.direction. */
  range: number
  /** true = keeps moving one way (wraps around) at wind.speed × |depth| px/s; false = ping-pong. */
  wrap: boolean
}

/** The one wind of the whole sky (both canvases read the same clock). */
export interface WindKnobs {
  /** Seconds for one full back-and-forth sway of every ping-pong layer. */
  period: number
  /** +1: the sway starts to the right (and wrapped layers travel right); -1: to the left. */
  direction: number
  /** Wrapped layers (drift.wrap): px/s per unit of depth (nearer = faster). */
  speed: number
}

export interface Billow {
  amount: number
  size: number
  speed: number
}

/**
 * A layer's answer to the page scroll: it rises by `rise` % of the screen height while the scroll
 * position (Frame.scroll.pos, in screens) goes from `from` to `to`.
 * rise 0 = the layer does not answer the scroll at all.
 *   sky  — descent.rise.<layer> with the shared descent.from / to / ease (the camera sinks: near
 *          layers rise more than far ones);
 *   veil — the layer's own `scroll` block.
 */
export interface ScrollRise {
  rise: number
  from: number
  to: number
  /** 0 = in step with the scroll (constant speed: what a camera moving down sees), 1 = soft start
   *  and stop (smoothstep); in between — a mix. */
  ease: number
}

export interface LayerKnobs {
  kind: LayerKind
  src: string
  srcTall: string
  x: number
  y: number
  width: number
  anchor: { x: number; y: number }
  opacity: number
  depth: number
  /** Inertia of this layer's parallax (core/spring.ts → Follower): 1 = the shared spring. */
  mass: number
  /** Drawn above the title (by the second, transparent sky canvas). Clouds and banks only. */
  front: boolean
  drift: Drift
  billow: Billow
  feather: number
  seam: number
  flipX: boolean
  grade: Grade
  scroll: ScrollRise
  /** bank: below the picture its last row goes on (a solid wall), instead of the mirrored picture. */
  solid: boolean
  /** veil: drawn after the fog and faded in with it — the layer lives in the void. Clouds and banks only. */
  afterFog: boolean
  // plate
  focus: { x: number; y: number }
  zoom: number
  // moon
  haze: number
  glow: number
  glowSize: number
  glowColor: string
  blend: number
  terminator: number
  terminatorTilt: number
  terminatorSoftness: number
  earthshine: number
}

export interface GrainKnobs {
  amount: number
  size: number
  fps: number
  blend: number
}

/**
 * The veil's whiteout: between scroll positions `from` and `to` everything under the veil — and its
 * own clouds — dissolves into the veil's plate (into `color` where there is no plate). Not one flat
 * cross-fade: the fog thickens in drifting patches and from the bottom up.
 */
export interface FogKnobs {
  from: number
  to: number
  /** `from` under prefers-reduced-motion: nothing travels there, the dissolve is the whole transition. */
  reducedFrom: number
  /** 0 = the same amount everywhere; 1 = the densest patches are opaque before the thinnest ones start. */
  patchy: number
  /** Size of a patch, CSS px. */
  size: number
  /** 0 = the same amount at every height; 1 = the bottom of the screen is opaque before the top starts. */
  lift: number
  /** The patches slide sideways with the wind, px/s (× world.drift). */
  speed: number
}

export interface SkyLayersKnobs {
  renderScale: number
  designAspect: number
  maxTexture: number
  tallBelow: number
  colorTop: string
  colorBottom: string
  fadeIn: number
  grain: GrainKnobs
  wind: WindKnobs
  /** veil: the whiteout. Unused by the sky. */
  fog: FogKnobs
  /** veil: the colour "inside the cloud" (the fog without a plate; the no-WebGL fallback). */
  color: string
  /** Back → front, in the order of the keys in sky.layers / veil.layers. */
  layers: { name: string; k: LayerKnobs }[]
}

const GRADE: Grade = { saturation: 1, brightness: 1, contrast: 1, tint: '#ffffff', tintAmount: 0 }

const BASE: LayerKnobs = {
  kind: 'clouds',
  src: '',
  srcTall: '',
  x: 50,
  y: 50,
  width: 50,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
  depth: 1,
  mass: 1,
  front: false,
  drift: { range: 0, wrap: false },
  billow: { amount: 0, size: 80, speed: 0.2 },
  feather: 0.03,
  seam: 0,
  flipX: false,
  grade: GRADE,
  scroll: { rise: 0, from: 0, to: 1, ease: 1 },
  solid: false,
  afterFog: false,
  focus: { x: 0.5, y: 0.5 },
  zoom: 1,
  haze: 0,
  glow: 0,
  glowSize: 1.5,
  glowColor: '#f4e6cf',
  blend: 0,
  terminator: -1,
  terminatorTilt: 0,
  terminatorSoftness: 0.05,
  earthshine: 0,
}

/** Per-kind safety nets (anchor / feather differ). */
const KIND_BASE: Record<LayerKind, Partial<LayerKnobs>> = {
  plate: { depth: 0.35, feather: 0 },
  moon: { width: 4.7, depth: 0.3, feather: 0 },
  clouds: {},
  bank: { anchor: { x: 0.5, y: 1 }, y: 100, width: 120, feather: 0.05 },
}

const DEFAULTS = {
  renderScale: 0.6,
  designAspect: 1.8,
  maxTexture: 4096,
  tallBelow: 1,
  colorTop: '#3e5876',
  colorBottom: '#a99a98',
  fadeIn: 600,
  grain: { amount: 0.04, size: 1.2, fps: 18, blend: 0.6 } as GrainKnobs,
  wind: { period: 140, direction: 1, speed: 3 } as WindKnobs,
  fog: { from: 0.34, to: 0.6, reducedFrom: 0.34, patchy: 0, size: 600, lift: 0, speed: 0 } as FogKnobs,
  // the warm void (sky.config.ts → veil.color)
  color: '#f1ded0',
}

function kindOf(name: string, raw: Loose): LayerKind {
  if (name === 'plate') return 'plate'
  if (name === 'moon') return 'moon'
  return raw.kind === 'bank' ? 'bank' : 'clouds'
}

/**
 * A layer's rise. `to` never before `from` (two independent sliders in the tuner): crossed, the
 * range would run backwards — the layer fully risen on the hero and sinking as the page goes down.
 * Dragged past each other they meet: the rise becomes a step at `from`.
 */
function riseRange(scroll: Loose, d: ScrollRise): ScrollRise {
  const from = num(scroll.from, d.from)
  return {
    rise: num(scroll.rise, d.rise),
    from,
    to: Math.max(from, num(scroll.to, d.to)),
    ease: Math.min(1, Math.max(0, num(scroll.ease, d.ease))),
  }
}

/** `scroll` is where this layer's rise comes from: its own block (veil) or the shared descent (sky). */
function readLayer(name: string, raw: Loose, scroll: Loose): LayerKnobs {
  const kind = kindOf(name, raw)
  const d: LayerKnobs = { ...BASE, ...KIND_BASE[kind], kind }
  const anchor = obj(raw.anchor)
  const drift = obj(raw.drift)
  const billow = obj(raw.billow)
  const grade = obj(raw.grade)
  const focus = obj(raw.focus)
  const free = kind !== 'plate' && kind !== 'moon'
  return {
    kind,
    src: str(raw.src, d.src),
    srcTall: str(raw.srcTall, d.srcTall),
    x: num(raw.x, d.x),
    y: num(raw.y, d.y),
    width: num(raw.width, d.width),
    anchor: { x: num(anchor.x, d.anchor.x), y: num(anchor.y, d.anchor.y) },
    opacity: num(raw.opacity, d.opacity),
    depth: num(raw.depth, d.depth),
    mass: Math.max(0.05, num(raw.mass, d.mass)),
    // the plate and the moon always stay behind the title
    front: free && bool(raw.front, d.front),
    drift: {
      range: num(drift.range, d.drift.range),
      wrap: bool(drift.wrap, d.drift.wrap),
    },
    billow: {
      amount: num(billow.amount, d.billow.amount),
      size: num(billow.size, d.billow.size),
      speed: num(billow.speed, d.billow.speed),
    },
    feather: num(raw.feather, d.feather),
    seam: num(raw.seam, d.seam),
    flipX: bool(raw.flipX, d.flipX),
    grade: {
      saturation: num(grade.saturation, d.grade.saturation),
      brightness: num(grade.brightness, d.grade.brightness),
      contrast: num(grade.contrast, d.grade.contrast),
      tint: str(grade.tint, d.grade.tint),
      tintAmount: num(grade.tintAmount, d.grade.tintAmount),
    },
    scroll: riseRange(scroll, d.scroll),
    solid: kind === 'bank' && bool(raw.solid, d.solid),
    afterFog: free && bool(raw.afterFog, d.afterFog),
    focus: { x: num(focus.x, d.focus.x), y: num(focus.y, d.focus.y) },
    zoom: num(raw.zoom, d.zoom),
    haze: num(raw.haze, d.haze),
    glow: num(raw.glow, d.glow),
    glowSize: num(raw.glowSize, d.glowSize),
    glowColor: str(raw.glowColor, d.glowColor),
    blend: num(raw.blend, d.blend),
    terminator: num(raw.terminator, d.terminator),
    terminatorTilt: num(raw.terminatorTilt, d.terminatorTilt),
    terminatorSoftness: num(raw.terminatorSoftness, d.terminatorSoftness),
    earthshine: num(raw.earthshine, d.earthshine),
  }
}

export function getSkyLayersKnobs(config: ResolvedConfig, block: SkyBlock = 'sky'): SkyLayersKnobs {
  const root = config as unknown as Loose
  const sky = obj(root[block])
  const grain = obj(sky.grain)
  // ONE wind for every instance (they share its clock): always the sky's
  const wind = obj(obj(root.sky).wind)
  const fog = obj(sky.fog)
  // The fog never starts after it ends (two independent sliders in the tuner): crossed, the range
  // would run backwards and the hero would be whited out at pos 0. Dragged past each other the two
  // meet: the fog becomes a step at `to`.
  const fogTo = num(fog.to, DEFAULTS.fog.to)
  const fogFrom = Math.min(fogTo, num(fog.from, DEFAULTS.fog.from))
  // the sky's layers rise by descent.rise.<name> over the shared descent.from … to
  const descent = obj(root.descent)
  const rises = obj(descent.rise)
  const layers: SkyLayersKnobs['layers'] = []
  let moons = 0
  let plates = 0
  for (const [name, raw] of Object.entries(obj(sky.layers))) {
    const r = obj(raw)
    if (!Object.keys(r).length) continue
    const scroll = block === 'sky' ? { ...descent, rise: rises[name] } : obj(r.scroll)
    const k = readLayer(name, r, scroll)
    // one plate (first, always at the back) and one moon: their uniforms are singular
    if (k.kind === 'plate' && plates++) continue
    if (k.kind === 'moon' && moons++) continue
    if (k.kind === 'plate') layers.unshift({ name, k })
    else layers.push({ name, k })
  }
  return {
    renderScale: num(sky.renderScale, DEFAULTS.renderScale),
    designAspect: num(sky.designAspect, DEFAULTS.designAspect),
    maxTexture: num(sky.maxTexture, DEFAULTS.maxTexture),
    tallBelow: num(sky.tallBelow, DEFAULTS.tallBelow),
    colorTop: str(sky.colorTop, DEFAULTS.colorTop),
    colorBottom: str(sky.colorBottom, DEFAULTS.colorBottom),
    fadeIn: num(sky.fadeIn, DEFAULTS.fadeIn),
    grain: {
      amount: num(grain.amount, DEFAULTS.grain.amount),
      size: num(grain.size, DEFAULTS.grain.size),
      fps: num(grain.fps, DEFAULTS.grain.fps),
      blend: num(grain.blend, DEFAULTS.grain.blend),
    },
    wind: {
      period: Math.max(1, num(wind.period, DEFAULTS.wind.period)),
      direction: num(wind.direction, DEFAULTS.wind.direction) < 0 ? -1 : 1,
      speed: num(wind.speed, DEFAULTS.wind.speed),
    },
    fog: {
      from: fogFrom,
      to: fogTo,
      reducedFrom: Math.min(fogTo, num(fog.reducedFrom, fogFrom)),
      patchy: num(fog.patchy, DEFAULTS.fog.patchy),
      size: num(fog.size, DEFAULTS.fog.size),
      lift: num(fog.lift, DEFAULTS.fog.lift),
      speed: num(fog.speed, DEFAULTS.fog.speed),
    },
    color: str(sky.color, DEFAULTS.color),
    layers,
  }
}

// ── what the scroll does with these knobs: shared by the renderer and by whoever must know where
//    the veil is without drawing it (the nav decides its ink by the cloud wall's height) ──

/** How far the page scroll has lifted a layer, CSS px (H — stage height). Under reduced motion nothing travels. */
export function riseOf(k: LayerKnobs, sc: ScrollState, H: number): number {
  if (k.scroll.rise === 0 || sc.reduced) return 0
  const t = remap(sc.pos, k.scroll.from, k.scroll.to)
  return ((H * k.scroll.rise) / 100) * lerp(t, smooth(t), k.scroll.ease)
}

/** The veil's fog for the whole frame at this scroll position: 0 none … 1 the canvas is opaque. */
export function fogOf(knobs: SkyLayersKnobs, sc: ScrollState): number {
  return smooth(remap(sc.pos, sc.reduced ? knobs.fog.reducedFrom : knobs.fog.from, knobs.fog.to))
}
