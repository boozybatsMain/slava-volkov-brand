import { aboutOf } from '../../core/about-camera'
import { turnKnobs } from '../../core/about-pose'
import { bool, num, obj, str, type Loose } from '../../core/loose'
import type { ResolvedConfig } from '../../core/types'

/**
 * ABOUT — the canvas's look knobs (sky.config.ts → about), read once per config identity into plain
 * typed objects. Loose reads with a fallback each (core/loose.ts): the layer must survive an old
 * config, a hand-edited one, the tuner. WHERE things stand (words, cards, the camera) is not here:
 * core/about-pose.ts and core/about-camera.ts read that, for the canvas, the fallback and the notes.
 */

export interface PhotoKnobs {
  key: string
  /** order among the shown cards (= core/about-pose.ts → CardPose.index; the reveal stagger) */
  index: number
  src: string
  crop: { x: number; y: number; w: number }
  /** the card's face: width / height */
  aspect: number
  halftone: boolean
  /** −1 — the global one (photos.grade.saturation) */
  saturation: number
  topic: string
  alt: string
}

export type V3 = [number, number, number]

/** A colour in the dark (turned away from the light) and in the lit (facing it) band. */
export interface Shade {
  dark: string
  lit: string
}

export interface HazeKnobs {
  /** how far toward the void at most, 0…1 */
  amount: number
  /** height (sheet units, z) at and above which there is none; at and below `far` — all of it */
  near: number
  far: number
  steps: number
}

export interface AboutKnobs {
  pull: { from: number; to: number }
  reveal: {
    photos: { from: number; to: number; stagger: number; steps: number }
    /** word — the tour's words reveal by the TOP of their screen box, taken this share of the visible height lower */
    enter: { from: number; to: number; word: number; lodAt: number; lodStep: number }
  }
  raster: {
    /** the concrete's texel at its LOD, render px (lattice cells) */
    texel: number
    bits: number
    dither: number
    shimmerFps: number
    crawl: number
    rowGlitch: number
    rowShift: number
    rowRun: number
    restShimmer: number
    affine: number
    affineCells: number
    grainFps: number
  }
  concrete: {
    /** per band of the profile: its colour turned away from the key light → facing it */
    face: Shade
    step: Shade
    bevel: Shade
    wall: Shade
    seam: string
    back: string
    /** toward the key light (sheet axes: x right, y down, z toward the camera), normalised */
    light: V3
    bands: number
    /** lamp — where the glint's point lamp hangs from the camera, in camera heights (x right, y down, z up) */
    glint: { color: string; amount: number; size: number; steps: number; lamp: V3 }
    mottle: { size: number; amount: number }
    aggregate: { size: number; density: number; amount: number; color: string }
    haze: HazeKnobs
    grain: number
    /** under the nav's dock (core/nav-dock.ts) the concrete is no lighter than `ink` (× `amount`): its labels stay legible; the rect is the cards' (cards.dock.pad) */
    dock: { ink: string; amount: number; edge: number }
  }
  cards: {
    side: string
    edge: string
    blank: string
    seam: { color: string; width: number }
    leak: number
    /** travel — as the card crosses the screen; turn — as it turns toward the pointer (at its maxTurn) */
    sheen: { amount: number; color: string; at: number; width: number; slant: number; steps: number; travel: number; turn: number }
    haze: HazeKnobs
    grain: number
    /** under the nav's dock (core/nav-dock.ts) the picture is washed toward the void: amount, pad (CSS px) */
    dock: { wash: number; pad: number }
  }
  shadow: {
    opacity: number
    color: string
    /** toward the light, normalised (z > 0) */
    light: V3
    /** the height (sheet units) seen from which, in the middle of the frame, the lamp is exactly toward `light` (core.ts → shadowLamp) */
    lampAt: number
    /** density lost per sheet unit of height */
    fade: number
    /** a word's shadow falls on its own back plane this far behind it, sheet units */
    gap: number
    /** a card's penumbra per sheet unit of its height (its shadow thins out toward the edges) */
    soft: number
    /** a low card's pool: superellipse exponent (2 — an ellipse … 8 — almost its rectangle); high cards go toward 2 */
    round: number
    /** the gaussian every footprint is softened by, sheet units (σ) */
    blur: number
    /** the softened footprint's weight (0…1) where the dots begin: higher — smaller, lighter shadows */
    edge: number
    /** a card's shadow is whole while at least this share of the card is in the frame, and thins out with it below */
    share: number
    steps: number
    /** shadows are full below zoom `full`, none above `none` (the pull's close-ups) */
    zoomFull: number
    zoomNone: number
  }
  photos: {
    texWidth: number
    grade: { saturation: number; contrast: number; black: number; white: number; tint: string; tintAmount: number }
    halftone: number
    items: PhotoKnobs[]
  }
  /** every element's turn toward the pointer (words; .cards; .notes) — core/about-pose.ts → turnKnobs */
  turn: ReturnType<typeof turnKnobs>
  aberration: number
}

let cacheFor: ResolvedConfig | null = null
let cache: AboutKnobs | null = null

/** The about knobs of this config (cached per config identity: frame.config is new on every refresh). */
export function aboutKnobs(config: ResolvedConfig): AboutKnobs {
  if (cache && cacheFor === config) return cache
  cacheFor = config
  cache = read(aboutOf(config), config)
  return cache
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

function dir(v: unknown, d: V3, up = false): V3 {
  const o = obj(v)
  let x = num(o.x, d[0])
  let y = num(o.y, d[1])
  let z = num(o.z, d[2])
  if (up && z < 0.05) z = 0.05
  const l = Math.hypot(x, y, z) || 1
  x /= l
  y /= l
  z /= l
  return [x, y, z]
}

function shade(v: unknown, dark: string, lit: string): Shade {
  if (typeof v === 'string') return { dark: v, lit: v }
  const o = obj(v)
  return { dark: str(o.dark, dark), lit: str(o.lit, lit) }
}

function haze(v: unknown, d: HazeKnobs): HazeKnobs {
  const h = obj(v)
  const near = num(h.near, d.near)
  return {
    amount: clamp(num(h.amount, d.amount), 0, 1),
    near,
    far: Math.min(near - 1e-3, num(h.far, d.far)),
    steps: Math.max(1, Math.round(num(h.steps, d.steps))),
  }
}

function read(a: Loose, config: ResolvedConfig): AboutKnobs {
  const pull = obj(a.pull)
  const rv = obj(a.reveal)
  const rp = obj(rv.photos)
  const re = obj(rv.enter)
  const rel = obj(re.lod)
  const r = obj(a.raster)
  const c = obj(a.concrete)
  const cg = obj(c.glint)
  const cm = obj(c.mottle)
  const ca = obj(c.aggregate)
  const k = obj(a.cards)
  const ks = obj(k.seam)
  const kh = obj(k.sheen)
  const kd = obj(k.dock)
  const s = obj(a.shadow)
  const sz = obj(s.zoom)
  const ph = obj(a.photos)
  const pg = obj(ph.grade)

  const items: PhotoKnobs[] = []
  for (const [key, v] of Object.entries(obj(ph.items))) {
    const p = obj(v)
    // the same filter as core/about-pose.ts → cardPoses: the indices line up
    if (!bool(p.show, true)) continue
    const src = str(p.src, '')
    if (!src) continue
    const cr = obj(p.crop)
    items.push({
      key,
      index: items.length,
      src,
      crop: { x: num(cr.x, 0.5), y: num(cr.y, 0.5), w: clamp(num(cr.w, 1), 0.02, 1) },
      aspect: Math.max(0.05, num(p.aspect, 1)),
      halftone: str(p.style, 'photo') === 'halftone',
      saturation: num(p.saturation, -1),
      topic: str(p.topic, 'home'),
      alt: str(p.alt, ''),
    })
  }

  return {
    pull: { from: num(pull.from, 1.24), to: num(pull.to, 1.92) },
    reveal: {
      photos: { from: num(rp.from, 1.72), to: num(rp.to, 1.87), stagger: num(rp.stagger, 0.012), steps: Math.max(1, Math.round(num(rp.steps, 4))) },
      enter: { from: num(re.from, 1.2), to: num(re.to, 0.97), word: num(re.word, 0.12), lodAt: num(rel.at, 0.15), lodStep: Math.max(0.01, num(rel.step, 0.12)) },
    },
    raster: {
      texel: Math.max(0.5, num(r.texel, 2)),
      bits: clamp(Math.round(num(r.bits, 5)), 1, 8),
      dither: Math.max(0, num(r.dither, 0.6)),
      shimmerFps: Math.max(1, num(r.shimmerFps, 14)),
      crawl: clamp(num(r.crawl, 0.2), 0, 1),
      rowGlitch: Math.max(0, num(r.rowGlitch, 0.0006)),
      rowShift: Math.max(0, num(r.rowShift, 2)),
      rowRun: Math.max(1, num(r.rowRun, 14)),
      restShimmer: Math.max(0, num(r.restShimmer, 0.015)),
      affine: clamp(num(r.affine, 0.35), 0, 1),
      affineCells: clamp(Math.round(num(r.affineCells, 6)), 1, 32),
      grainFps: Math.max(0, num(r.grainFps, 18)),
    },
    concrete: {
      face: shade(c.face, '#252321', '#312e2b'),
      step: shade(c.step, '#1e1c1a', '#2a2825'),
      bevel: shade(c.bevel, '#2a2724', '#5a5550'),
      wall: shade(c.wall, '#141312', '#1f1d1b'),
      seam: str(c.seam, '#0f0e0d'),
      back: str(c.back, '#141312'),
      light: dir(c.light, [-0.45, -0.6, 0.66]),
      bands: Math.max(1, Math.round(num(c.bands, 3))),
      glint: {
        color: str(cg.color, '#e9dfd0'),
        amount: clamp(num(cg.amount, 0.8), 0, 1),
        size: clamp(num(cg.size, 9), 0.2, 60),
        steps: Math.max(1, Math.round(num(cg.steps, 3))),
        lamp: ((l) => [num(l.x, -0.9), num(l.y, -1.1), num(l.z, 0.4)] as V3)(obj(cg.lamp)),
      },
      mottle: { size: Math.max(1e-4, num(cm.size, 0.018)), amount: Math.max(0, num(cm.amount, 0.12)) },
      aggregate: {
        size: Math.max(1e-4, num(ca.size, 0.004)),
        density: clamp(num(ca.density, 0.08), 0, 1),
        amount: clamp(num(ca.amount, 0.35), 0, 1),
        color: str(ca.color, '#625c54'),
      },
      haze: haze(c.haze, { amount: 0.35, near: 0, far: -0.3, steps: 3 }),
      grain: Math.max(0, num(c.grain, 0.02)),
      dock: { ink: str(obj(c.dock).ink, '#222020'), amount: clamp(num(obj(c.dock).amount, 1), 0, 1), edge: Math.max(1, num(obj(c.dock).edge, 6)) },
    },
    cards: {
      side: str(k.side, '#8a8178'),
      edge: str(k.edge, '#b0a596'),
      blank: str(k.blank, '#9e9488'),
      seam: { color: str(ks.color, '#4a433c'), width: Math.max(0, num(ks.width, 1)) },
      leak: clamp(num(k.leak, 0.35), 0, 1),
      sheen: {
        amount: clamp(num(kh.amount, 0.05), 0, 1),
        color: str(kh.color, '#f4ede2'),
        at: num(kh.at, 0.3),
        width: Math.max(0.01, num(kh.width, 0.34)),
        slant: num(kh.slant, 0.5),
        steps: Math.max(1, Math.round(num(kh.steps, 3))),
        travel: num(kh.travel, 0.5),
        turn: num(kh.turn, 0.5),
      },
      haze: haze(k.haze, { amount: 0.45, near: 0.3, far: -0.1, steps: 4 }),
      grain: Math.max(0, num(k.grain, 0.01)),
      dock: { wash: clamp(num(kd.wash, 0.85), 0, 1), pad: Math.max(0, num(kd.pad, 8)) },
    },
    shadow: {
      opacity: clamp(num(s.opacity, 0.38), 0, 1),
      color: str(s.color, '#a39789'),
      light: dir(s.light, [-0.22, -0.3, 1], true),
      lampAt: Math.max(0, num(s.lampAt, 0.25)),
      fade: Math.max(0, num(s.fade, 1)),
      gap: Math.max(0, num(s.gap, 0.02)),
      soft: Math.max(0, num(s.soft, 0.15)),
      round: clamp(num(s.round, 5), 2, 16),
      blur: Math.max(0, num(s.blur, 0.006)),
      edge: clamp(num(s.edge, 0.28), 0, 0.95),
      share: clamp(num(s.share, 0.35), 0.01, 1),
      steps: Math.max(1, Math.round(num(s.steps, 4))),
      zoomFull: Math.max(0.1, num(sz.full, 1.6)),
      zoomNone: Math.max(0.2, num(sz.none, 4)),
    },
    photos: {
      texWidth: clamp(Math.round(num(ph.texWidth, 384)), 32, 1024),
      grade: {
        saturation: num(pg.saturation, 0.45),
        contrast: num(pg.contrast, 1.1),
        black: num(pg.black, 0.1),
        white: num(pg.white, 0.9),
        tint: str(pg.tint, '#ecdacc'),
        tintAmount: clamp(num(pg.tintAmount, 0.5), 0, 1),
      },
      halftone: clamp(Math.round(num(ph.halftone, 4)), 2, 8),
      items,
    },
    turn: turnKnobs(config),
    aberration: Math.max(0, num(a.aberration, 0)),
  }
}

/** '#rrggbb' (or '#rgb') → display-space 0…1 (the whole layer works in sRGB, like an old renderer). */
export function hexRgb(hex: string): V3 {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('')
  const n = parseInt(h.slice(0, 6), 16)
  if (!Number.isFinite(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
