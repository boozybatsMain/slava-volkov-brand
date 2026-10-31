import { aboutOf } from '../../core/about-camera'
import { bool, num, obj, str, type Loose } from '../../core/loose'
import type { ResolvedConfig } from '../../core/types'

/**
 * about.text / about.notes (+ the photos' alt texts and the reveal thresholds) read loosely: the
 * layer survives any config — the tuner, a hand-edited one, a mobile override that names only a few
 * keys. Every read names its fallback (= the desktop numbers of sky.config.ts).
 */

export type NoteKind = 'mono' | 'list' | 'hand' | 'count'
export type Align = 'left' | 'right'

export interface NoteSpec {
  name: string
  kind: NoteKind
  /** the lines exactly as written (no wrapping) */
  lines: string[]
  /** sheet units: the top-left corner (align 'left') or the top-right one (align 'right') */
  x: number
  y: number
  /**
   * height above the sheet plane, sheet units (core/about-camera.ts → project3): 0 — on the sheet,
   * > 0 — floating a little toward the camera (a handwritten note), so it moves and grows with the
   * camera exactly as a card at that height does
   */
  z: number
  size: number
  /** degrees */
  rotation: number
  align: Align
  dash: boolean
  topic: string
  /** how a screen reader says it, when the lines are not one sentence (a signature); '' — the lines joined by spaces */
  sr: string
}

export interface Face {
  size: number
  tracking: number
  leading: number
  opacity: number
}

export interface PhotoAlt {
  name: string
  alt: string
  topic: string
}

/** A word of the world (about.words: text + topic) — the finale's THAT'S ALL FOR NOW is only there. */
export interface WordText {
  text: string
  topic: string
}

export interface TextKnobs {
  unit: number
  min: number
  max: number
  /** the smallest font on screen at zoom 1, px */
  floor: number
  /** share of the camera roll the notes' type turns with (0 — level lines, 1 — with the sheet) */
  roll: number
  ink: string
  mono: Face
  list: Face
  hand: Face & { jitter: number }
  count: Face
  dash: { length: number; width: number; gap: number; opacity: number }
  reveal: { stagger: number; duration: number; steps: number; out: number }
  dock: number
  notes: NoteSpec[]
  photos: PhotoAlt[]
  /** the words' texts in config order (for the screen-reader copy) */
  words: WordText[]
  /** about.pull.from: nothing of the notes shows before it */
  pullFrom: number
  /** about.reveal.notes: the home notes type in past `from`, out below `back` */
  notesFrom: number
  notesBack: number
  /** about.reveal.enter.at: a tour note types in once its top has risen above this share of the visible height */
  enterAt: number
}

const KINDS: NoteKind[] = ['mono', 'list', 'hand', 'count']

function face(v: unknown, d: Face): Face {
  const f = obj(v)
  return {
    size: Math.max(1, num(f.size, d.size)),
    tracking: num(f.tracking, d.tracking),
    leading: Math.max(0.5, num(f.leading, d.leading)),
    opacity: Math.min(1, Math.max(0, num(f.opacity, d.opacity))),
  }
}

function note(name: string, v: unknown): NoteSpec | null {
  const n = obj(v)
  const text = str(n.text, '')
  if (!text.trim()) return null
  const kind = str(n.kind, 'mono') as NoteKind
  return {
    name,
    kind: KINDS.includes(kind) ? kind : 'mono',
    lines: text.split('\n'),
    x: num(n.x, 0),
    y: num(n.y, 0),
    z: num(n.z, 0),
    size: Math.max(0.05, num(n.size, 1)),
    rotation: num(n.rotation, 0),
    align: str(n.align, 'left') === 'right' ? 'right' : 'left',
    dash: bool(n.dash, false),
    topic: str(n.topic, 'home'),
    sr: str(n.sr, '').trim(),
  }
}

export function readKnobs(config: ResolvedConfig): TextKnobs {
  const about = aboutOf(config)
  const t = obj(about.text)
  const reveal = obj(about.reveal)
  const r = obj(t.reveal)
  const dash = obj(t.dash)
  const hand = obj(t.hand)
  const notes = Object.entries(obj(about.notes))
    .map(([name, v]) => note(name, v))
    .filter((n): n is NoteSpec => !!n)
  const photos = Object.entries(obj(obj(about.photos).items)).flatMap(([name, v]): PhotoAlt[] => {
    const p = obj(v)
    const alt = str(p.alt, '').trim()
    return bool(p.show, true) && alt ? [{ name, alt, topic: str(p.topic, 'home') }] : []
  })
  const words = Object.values(obj(about.words)).flatMap((v): WordText[] => {
    const hl = obj(v)
    const text = str(hl.text, '').replace(/\s+/g, ' ').trim()
    return text ? [{ text, topic: str(hl.topic, 'home') }] : []
  })
  const notesK = obj(reveal.notes)
  const from = num(notesK.from, 1.87)
  return {
    unit: Math.max(1, num(t.unit, 893)),
    min: Math.max(0.05, num(t.min, 0.66)),
    max: Math.max(0.05, num(t.max, 1.35)),
    floor: Math.max(0, num(t.floor, 10)),
    roll: num(t.roll, 0),
    ink: str(t.ink, '#1e1c1a'),
    mono: face(t.mono, { size: 23, tracking: 0.14, leading: 1.65, opacity: 1 }),
    list: face(t.list, { size: 23, tracking: 0.14, leading: 1.65, opacity: 1 }),
    hand: { ...face(hand, { size: 27, tracking: 0.02, leading: 1.18, opacity: 0.9 }), jitter: Math.max(0, num(hand.jitter, 0.8)) },
    count: face(t.count, { size: 13, tracking: 0.12, leading: 1.4, opacity: 0.88 }),
    dash: {
      length: Math.max(0, num(dash.length, 20)),
      width: Math.max(0, num(dash.width, 1)),
      gap: Math.max(0, num(dash.gap, 14)),
      opacity: Math.min(1, Math.max(0, num(dash.opacity, 0.6))),
    },
    reveal: {
      stagger: Math.max(0, num(r.stagger, 70)),
      duration: Math.max(0, num(r.duration, 170)),
      steps: Math.max(1, Math.round(num(r.steps, 4))),
      out: Math.max(0.1, num(r.out, 2)),
    },
    dock: Math.min(1, Math.max(0, num(t.dock, 0.15))),
    notes,
    photos,
    words,
    pullFrom: num(obj(about.pull).from, 1.24),
    notesFrom: from,
    notesBack: Math.min(from, num(notesK.back, from - 0.04)),
    enterAt: Math.min(1, Math.max(0.05, num(obj(reveal.enter).at, 0.94))),
  }
}

/** The face of a note kind. */
export const faceOf = (k: TextKnobs, kind: NoteKind): Face => (kind === 'hand' ? k.hand : k[kind])

/** clamp(U / unit, min, max): the notes' size share at this sheet unit. */
export const fitOf = (k: TextKnobs, U: number) => Math.min(k.max, Math.max(k.min, U / k.unit))

/**
 * A note's font px at zoom 1 for this size share: its face × its own size × fit, never so small that
 * at rest on its topic (× `zr` — its scale there: the topic's zoom × its height's) it shows under
 * text.floor px — a topic framed wider than zoom 1 (the finale, 0.9) raises it accordingly.
 */
export const sizeOf = (k: TextKnobs, note: NoteSpec, fit: number, zr = 1) => Math.max(k.floor / Math.min(1, Math.max(0.05, zr)), faceOf(k, note.kind).size * note.size * fit)

/** overlay.nav.dock (the nav's docked column) read loosely — only for the stand-in rectangle. */
export function dockKnobs(config: ResolvedConfig): Loose {
  return obj(obj(obj((config as unknown as { overlay?: unknown }).overlay).nav).dock)
}
