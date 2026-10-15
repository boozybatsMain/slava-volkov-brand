import { aboutOf } from '../../core/about-camera'
import { turnKnobs } from '../../core/about-pose'
import { num, obj, str, bool, type Loose } from '../../core/loose'
import type { ResolvedConfig } from '../../core/types'

/**
 * ABOUT — every knob of the canvas (sky.config.ts → about), read once per config identity into plain
 * typed objects. Loose reads with a fallback each (core/loose.ts): the layer must survive an old
 * config, a hand-edited one, the tuner. The WebGL renderer and the 2D fallback read the same object,
 * so they cannot disagree about a hole or a photo.
 */

export interface HoleKnobs {
  key: string
  text: string
  x: number
  y: number
  /** ink width, sheet units */
  width: number
  /** degrees, + clockwise */
  rotation: number
  /**
   * The line turned in depth (core/about-pose.ts), degrees: yaw — about the vertical (+ the right end
   * nearer), pitch — about the horizontal (+ the bottom recedes)
   */
  yaw: number
  pitch: number
  /** the share of the pointer's turn (about.turn) this line takes: 1 — all of it, 0 — none */
  turn: number
  /** the letters' own vertical stretch and tracking (em): the hole's value, else about.word's */
  stretchY: number
  tracking: number
  rough: number
  mottle: number
  slip: number
  depth: number
  topic: string
}

export interface PhotoKnobs {
  key: string
  /** order among the shown photos (the array layer, the reveal stagger) */
  index: number
  src: string
  crop: { x: number; y: number; w: number }
  x: number
  y: number
  width: number
  aspect: number
  rotation: number
  tilt: number
  /** torn sides as bits: l 1, r 2, t 4, b 8 */
  torn: number
  tornAmount: number
  halftone: boolean
  /** −1 — the global one */
  saturation: number
  depth: number
  topic: string
  alt: string
}

export interface CrossKnobs {
  key: string
  x: number
  y: number
  topic: string
}

export interface AboutKnobs {
  pull: { from: number; to: number }
  reveal: {
    photos: { from: number; to: number; stagger: number; steps: number }
    enter: { from: number; to: number; lodAt: number; lodStep: number }
  }
  word: { family: string; weight: number; tracking: number; stretchY: number }
  sheet: { color: string; grain: { amount: number; fps: number; blend: number } }
  raster: { block: number; lodMax: number; lodBack: number; lodFade: number; crawlFps: number; bits: number; dither: number }
  letters: {
    band: number
    chunk: number
    chunkAmount: number
    cell: number
    cellAmount: number
    wobble: number
    maxPx: number
    home: number
    wash: { color: string; amount: number }
    /** home — the share of the blotches at the home framing (all of them close up: letters.texture.full) */
    patches: { size: number; amount: number; cover: number; home: number }
    /** the close-up photocopy grit: fine dark specks in clusters + a few vertical toner bars (0 — none) */
    grit: number
    specks: number
    scratches: { amount: number; length: number }
    grain: number
    texture: { none: number; full: number }
  }
  holes: HoleKnobs[]
  photos: {
    texWidth: number
    edge: { chunk: number; small: number; band: number; missing: number; debris: number; reach: number; shift: number }
    grade: { saturation: number; contrast: number; black: number; white: number; tint: string; tintAmount: number }
    halftone: number
    /** photo brightness under the nav dock (1 — untouched) */
    dock: number
    items: PhotoKnobs[]
  }
  crosses: { size: number; color: string; opacity: number; twinkle: number; items: CrossKnobs[] }
  response: { mass: number; depth: number }
  /**
   * The words' turn (about.turn): the perspective (camera distance, widths of the line), the pointer's
   * turn at the screen's edge (tiltX — nod, tiltY — swing, degrees), the soft limit of the whole turn,
   * the spring's mass, the zoom fade (full below fadeFull, none above fadeNone) and the edge knee
   */
  turn: { perspective: number; tiltX: number; tiltY: number; maxTurn: number; mass: number; fadeFull: number; fadeNone: number; edgeKnee: number }
  aberration: number
}

const SIDES: Record<string, number> = { l: 1, r: 2, t: 4, b: 8 }

/** 'lb' → 1 | 8. */
export function tornBits(sides: string) {
  let bits = 0
  for (const ch of sides.toLowerCase()) bits |= SIDES[ch] ?? 0
  return bits
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

function read(a: Loose, config: ResolvedConfig): AboutKnobs {
  const pull = obj(a.pull)
  const rv = obj(a.reveal)
  const rp = obj(rv.photos)
  const re = obj(rv.enter)
  const rel = obj(re.lod)
  const w = obj(a.word)
  const sh = obj(a.sheet)
  const sg = obj(sh.grain)
  const r = obj(a.raster)
  const rl = obj(r.lod)
  const l = obj(a.letters)
  const ph = obj(a.photos)
  const pe = obj(ph.edge)
  const pg = obj(ph.grade)
  const cr = obj(a.crosses)
  const rs = obj(a.response)

  const wordTracking = num(w.tracking, -0.02)
  const wordStretch = Math.max(0.2, num(w.stretchY, 1.15))
  const holes: HoleKnobs[] = []
  for (const [key, v] of Object.entries(obj(a.holes))) {
    const h = obj(v)
    const text = str(h.text, '').trim()
    if (!text) continue
    holes.push({
      key,
      text,
      x: num(h.x, 0),
      y: num(h.y, 0),
      width: Math.max(0.01, num(h.width, 1)),
      rotation: num(h.rotation, 0),
      // not clamped: the camera turns the entry point by the same raw numbers (core/about-pose → holeTurn)
      yaw: num(h.yaw, 0),
      pitch: num(h.pitch, 0),
      turn: Math.max(0, num(h.turn, 0)),
      stretchY: Math.max(0.2, num(h.stretchY, wordStretch)),
      tracking: num(h.tracking, wordTracking),
      rough: Math.max(0, num(h.rough, 1)),
      mottle: Math.max(0, num(h.mottle, 1)),
      slip: Math.min(1, Math.max(0, num(h.slip, 0))),
      depth: num(h.depth, 0),
      topic: str(h.topic, 'home'),
    })
  }

  const items: PhotoKnobs[] = []
  for (const [key, v] of Object.entries(obj(ph.items))) {
    const p = obj(v)
    if (!bool(p.show, true)) continue
    const src = str(p.src, '')
    if (!src) continue
    const c = obj(p.crop)
    const t = obj(p.torn)
    items.push({
      key,
      index: items.length,
      src,
      crop: { x: num(c.x, 0.5), y: num(c.y, 0.5), w: Math.min(1, Math.max(0.02, num(c.w, 1))) },
      x: num(p.x, 0),
      y: num(p.y, 0),
      width: Math.max(0.005, num(p.width, 0.2)),
      aspect: Math.max(0.1, num(p.aspect, 1)),
      rotation: num(p.rotation, 0),
      tilt: Math.min(0.5, Math.max(-0.5, num(p.tilt, 0))),
      torn: tornBits(str(t.sides, '')),
      tornAmount: Math.max(0, num(t.amount, 1)),
      halftone: str(p.style, 'photo') === 'halftone',
      saturation: num(p.saturation, -1),
      depth: num(p.depth, 0),
      topic: str(p.topic, 'home'),
      alt: str(p.alt, ''),
    })
  }

  const crosses: CrossKnobs[] = []
  for (const [key, v] of Object.entries(obj(cr.items))) {
    const c = obj(v)
    crosses.push({ key, x: num(c.x, 0), y: num(c.y, 0), topic: str(c.topic, 'home') })
  }

  const wash = obj(l.wash)
  const patches = obj(l.patches)
  const scratches = obj(l.scratches)
  const texture = obj(l.texture)
  return {
    pull: { from: num(pull.from, 1.16), to: num(pull.to, 1.92) },
    reveal: {
      photos: { from: num(rp.from, 1.7), to: num(rp.to, 1.9), stagger: num(rp.stagger, 0.012), steps: Math.max(1, Math.round(num(rp.steps, 4))) },
      enter: { from: num(re.from, 1.05), to: num(re.to, 0.8), lodAt: num(rel.at, 0.4), lodStep: Math.max(0.01, num(rel.step, 0.12)) },
    },
    word: {
      family: str(w.font, 'Geist Variable'),
      weight: num(w.weight, 900),
      tracking: wordTracking,
      stretchY: wordStretch,
    },
    sheet: {
      color: str(sh.color, '#0c0c0f'),
      grain: { amount: Math.max(0, num(sg.amount, 0.03)), fps: Math.max(0, num(sg.fps, 18)), blend: num(sg.blend, 0.2) },
    },
    raster: {
      block: Math.max(1, Math.round(num(r.block, 2))),
      lodMax: Math.max(1.05, num(rl.max, 4)),
      lodBack: Math.min(0.99, Math.max(0.3, num(rl.back, 0.85))),
      lodFade: Math.min(1, Math.max(0, num(rl.fade, 0.16))),
      crawlFps: Math.max(0, num(r.crawlFps, 10)),
      bits: Math.min(8, Math.max(1, Math.round(num(r.bits, 5)))),
      dither: Math.max(0, num(r.dither, 0.6)),
    },
    letters: {
      band: Math.max(0, num(l.band, 0.014)),
      chunk: Math.max(1e-4, num(l.chunk, 0.011)),
      chunkAmount: Math.max(0, num(l.chunkAmount, 0.38)),
      cell: Math.max(1e-4, num(l.cell, 0.0042)),
      cellAmount: Math.max(0, num(l.cellAmount, 0.45)),
      wobble: Math.max(0, num(l.wobble, 0.003)),
      maxPx: Math.max(2, num(l.maxPx, 40)),
      home: Math.min(1, Math.max(0, num(l.home, 0.4))),
      wash: { color: str(wash.color, '#f1f1ef'), amount: Math.min(1, Math.max(0, num(wash.amount, 0.6))) },
      patches: {
        size: Math.max(1e-4, num(patches.size, 0.03)),
        amount: Math.max(0, num(patches.amount, 0.18)),
        cover: Math.max(0, num(patches.cover, 0.25)),
        home: Math.min(1, Math.max(0, num(patches.home, 1))),
      },
      grit: Math.min(1, Math.max(0, num(l.grit, 0))),
      specks: Math.max(0, num(l.specks, 0.012)),
      scratches: { amount: Math.max(0, num(scratches.amount, 0.15)), length: Math.max(1, num(scratches.length, 12)) },
      grain: Math.max(0, num(l.grain, 0.03)),
      texture: { none: Math.max(1, num(texture.none, 16)), full: Math.max(1, num(texture.full, 6)) },
    },
    holes,
    photos: {
      texWidth: Math.min(1024, Math.max(32, Math.round(num(ph.texWidth, 384)))),
      edge: {
        chunk: Math.max(0.005, num(pe.chunk, 0.1)),
        small: Math.max(0.002, num(pe.small, 0.025)),
        band: Math.max(0, num(pe.band, 0.12)),
        missing: Math.max(0, num(pe.missing, 0.35)),
        debris: Math.max(0, num(pe.debris, 0.25)),
        reach: Math.min(0.4, Math.max(0, num(pe.reach, 0.1))),
        shift: Math.max(0, num(pe.shift, 0.12)),
      },
      grade: {
        saturation: num(pg.saturation, 0.08),
        contrast: num(pg.contrast, 1.2),
        black: num(pg.black, 0.12),
        white: num(pg.white, 0.88),
        tint: str(pg.tint, '#c8d4e6'),
        tintAmount: Math.min(1, Math.max(0, num(pg.tintAmount, 0.35))),
      },
      halftone: Math.min(8, Math.max(2, Math.round(num(ph.halftone, 4)))),
      dock: Math.min(1, Math.max(0, num(ph.dock, 0.35))),
      items,
    },
    crosses: {
      size: Math.max(0, Math.round(num(cr.size, 3))),
      color: str(cr.color, '#d8d6d0'),
      opacity: Math.min(1, Math.max(0, num(cr.opacity, 0.7))),
      twinkle: Math.min(1, Math.max(0, num(cr.twinkle, 0.25))),
      items: crosses,
    },
    response: { mass: Math.max(0.05, num(rs.mass, 1.8)), depth: num(rs.depth, 0.6) },
    turn: { ...turnKnobs(config), edgeKnee: Math.min(1, Math.max(0.05, num(obj(a.turn).edgeKnee, 0.7))) },
    aberration: Math.max(0, num(a.aberration, 0.5)),
  }
}

/** '#rrggbb' (or '#rgb') → display-space 0…1 (the whole layer works in sRGB, like an old renderer). */
export function hexRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  if (!Number.isFinite(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
