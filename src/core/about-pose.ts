import { counterOf, DEFAULT_PROFILE, wordOutline, type Counter, type LetterProfile, type TextLook, type WordOutline } from '../layers/about/mesh'
import { clamp, remap, smooth } from './ease'
import { bool, num, obj, str, type Loose } from './loose'
import type { ResolvedConfig } from './types'

/**
 * ABOUT — where the 3D things stand in the one world (sky.config.ts → about.words, about.photos.items,
 * about.letters, about.turn). Pure functions of (config, camera, turns): the canvas, the 2D fallback and
 * the notes' layout check all place things through them, so they all see the same scene.
 *
 * THE POINTER (about.turn) never moves the camera or the sheet: every element turns toward it about its
 * OWN 3D centre, like the projects slab — the words (about.turn), each card (about.turn.cards), each
 * note (about.turn.notes, the notes layer) — each with its own inertia (its mass, seeded per element ±
 * `spread`), all faded out by the zoom (turnFade: none in the pull's close-ups) — but the entry word,
 * whose turn grows with the camera's turn on the pull instead (wordModelOf). The springs live in layers/about/core.ts,
 * which publishes the turns (AboutTurns → core/about-sheet.ts).
 *
 * WORLD = SHEET UNITS (core/about-camera.ts): origin — the centre of the flat word ABOUT, 1 = its flat
 * ink width, x right, y DOWN, z = height TOWARD the camera; z = 0 is the sheet plane (the notes, the
 * shadows). The frame is left-handed; matrices are plain 4×4, COLUMN-MAJOR (three.js Matrix4.fromArray
 * order), mapping an object's own coordinates to sheet units.
 *
 * WORD (about.words.<key>, built by layers/about/mesh.ts in word units: ink width 1, origin at the ink
 * centre, back face z = 0, front z = +depth):
 *   M = P · Rz(rotation) · S(width) · [pivot] R(yaw, pitch) [pivot back]
 *   then the pointer's turn on top, in sheet axes, about the word's 3D centre.
 *   x / y — where the flat ink centre lands (with no yaw / pitch); z — the height of the back plane at
 *   the pivot; the pivot — the ink centre, except for the ENTRY word (about.words.about): the centre of
 *   its A's counter on the back plane (the pull starts inside that counter). Every word stands in its
 *   own pose all the time — the entry word too: the pull's turn is the CAMERA's (core/about-camera.ts:
 *   it starts looking down the A's counter tunnel and turns, in one rotation, to the home view).
 *   Signs as before: yaw + — the right end comes nearer; pitch + — the bottom recedes.
 * CARD (about.photos.items.<key>): the unit box of layers/about/mesh.ts → cardBox (x, y ∈ ±½, z ∈ −1…0,
 *   the picture at z = 0) scaled to width × width / aspect × thickness, turned by yaw / pitch about the
 *   picture's centre, rotated in-plane, the picture's centre at (x, y, z); then its pointer turn on top,
 *   in sheet axes, about the centre of the box (half its thickness behind the picture).
 */

// ── 4×4 matrices (column-major) ────────────────────────────────────────────────────────────────────

export type M4 = Float64Array

const DEG = Math.PI / 180

export function identity4(): M4 {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/** a · b (apply b first). */
export function mul4(a: M4, b: M4): M4 {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return o
}

/** A point through an affine 4×4. */
export function apply4(m: M4, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
}

/** A direction (no translation) through an affine 4×4. */
export function applyDir4(m: M4, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z]
}

/** Inverse of an affine 4×4 (rotation · scale · translation). */
export function invert4(m: M4): M4 {
  // n_rc = m[c * 4 + r]
  const n00 = m[0], n10 = m[1], n20 = m[2]
  const n01 = m[4], n11 = m[5], n21 = m[6]
  const n02 = m[8], n12 = m[9], n22 = m[10]
  // cofactors
  const c00 = n11 * n22 - n12 * n21
  const c01 = -(n10 * n22 - n12 * n20)
  const c02 = n10 * n21 - n11 * n20
  const c10 = -(n01 * n22 - n02 * n21)
  const c11 = n00 * n22 - n02 * n20
  const c12 = -(n00 * n21 - n01 * n20)
  const c20 = n01 * n12 - n02 * n11
  const c21 = -(n00 * n12 - n02 * n10)
  const c22 = n00 * n11 - n01 * n10
  const det = n00 * c00 + n01 * c01 + n02 * c02
  const k = Math.abs(det) > 1e-30 ? 1 / det : 0
  const o = new Float64Array(16)
  // inverse_rc = cofactor_cr / det
  o[0] = c00 * k; o[4] = c10 * k; o[8] = c20 * k
  o[1] = c01 * k; o[5] = c11 * k; o[9] = c21 * k
  o[2] = c02 * k; o[6] = c12 * k; o[10] = c22 * k
  const tx = m[12]
  const ty = m[13]
  const tz = m[14]
  o[12] = -(o[0] * tx + o[4] * ty + o[8] * tz)
  o[13] = -(o[1] * tx + o[5] * ty + o[9] * tz)
  o[14] = -(o[2] * tx + o[6] * ty + o[10] * tz)
  o[15] = 1
  return o
}

function translate4(x: number, y: number, z: number): M4 {
  const m = identity4()
  m[12] = x
  m[13] = y
  m[14] = z
  return m
}

function scale4(x: number, y: number, z: number): M4 {
  const m = identity4()
  m[0] = x
  m[5] = y
  m[10] = z
  return m
}

/** In-plane rotation, degrees, + = clockwise on screen (y down). */
function rotZ4(deg: number): M4 {
  const c = Math.cos(deg * DEG)
  const s = Math.sin(deg * DEG)
  const m = identity4()
  m[0] = c
  m[1] = s
  m[4] = -s
  m[5] = c
  return m
}

/**
 * The turn in depth, R = Ry(yaw) · Rx(pitch) (pitch first), degrees: yaw + — the right end (x > 0)
 * comes nearer (z up); pitch + — the bottom (y > 0) recedes. Returned as a 4×4.
 */
export function turn4(yawDeg: number, pitchDeg: number): M4 {
  const cy = Math.cos(yawDeg * DEG)
  const sy = Math.sin(yawDeg * DEG)
  const cp = Math.cos(pitchDeg * DEG)
  const sp = Math.sin(pitchDeg * DEG)
  // Rx: (x, y, z) → (x, y·cp + z·sp, −y·sp + z·cp);  Ry: (x, y, z) → (x·cy − z·sy, y, x·sy + z·cy)
  const m = identity4()
  // column x = Ry · (1, 0, 0)
  m[0] = cy
  m[1] = 0
  m[2] = sy
  // column y = Ry · (0, cp, −sp)
  m[4] = sp * sy
  m[5] = cp
  m[6] = -sp * cy
  // column z = Ry · (0, sp, cp)
  m[8] = -cp * sy
  m[9] = sp
  m[10] = cp * cy
  return m
}

// ── knobs ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * One element's turn toward the pointer, degrees, already faded by the zoom (turnFade; the entry word's
 * is not — wordModelOf scales it by the camera's turn on the pull): yaw + — its right end comes nearer, pitch + — its
 * bottom recedes (the words' signs). A word's is before its own
 * `turn` share and maxTurn; a card's is final; a note's — the cards' formula, before about.turn.notes.share.
 */
export interface Turn {
  yaw: number
  pitch: number
}

export const NO_TURN: Turn = Object.freeze({ yaw: 0, pitch: 0 })

/**
 * The pointer's turn of every element this frame, by key (published by the about canvas →
 * core/about-sheet.ts aboutFrame.pointer): each element has its own spring (its own mass), so they are
 * not in lockstep. A missing key — no turn.
 */
export interface AboutTurns {
  /** about.words.<key> */
  words: Record<string, Turn>
  /** about.photos.items.<key> */
  cards: Record<string, Turn>
  /** about.notes.<name> */
  notes: Record<string, Turn>
}

export const NO_TURNS: AboutTurns = Object.freeze({ words: {}, cards: {}, notes: {} })

/**
 * The turns move in steps of this many degrees (with hysteresis while live; plain rounding in a pinned
 * frame): ≈ 0.5 px at the ends of ABOUT on 1440 — under a cell, so the steps never show, but a resting
 * pointer (its slow idle float) does not change the picture every frame: each element steps every
 * second or two (with ≈ 25 elements on their own springs, some element steps ≈ 6 times a second at the
 * home framing — the 2D fallback then re-rasterises its geometry, ≈ 6 ms; WebGL redraws on its grain
 * and shimmer ticks anyway).
 */
export const TURN_STEP = 0.2

const aboutOf = (config: ResolvedConfig): Loose => obj((config as unknown as { about?: unknown }).about)

/** about.letters → the letters' cross-section (cap heights); `depth` — a word's own depth wins. */
export function letterProfile(config: ResolvedConfig, depth?: number): LetterProfile {
  const l = obj(aboutOf(config).letters)
  const D = DEFAULT_PROFILE
  return {
    depth: Math.max(0.05, num(depth, num(l.depth, D.depth))),
    chamferOuter: Math.max(0, num(l.chamferOuter, D.chamferOuter)),
    chamferStep: Math.max(0, num(l.chamferStep, D.chamferStep)),
    chamferInner: Math.max(0, num(l.chamferInner, D.chamferInner)),
    seam: Math.max(0, num(l.seam, D.seam)),
    seamAt: num(l.seamAt, D.seamAt),
    curveSegments: clamp(Math.round(num(l.curveSegments, D.curveSegments)), 1, 12),
    crease: num(l.crease, D.crease),
  }
}

export interface WordPose {
  key: string
  look: TextLook
  profile: LetterProfile
  outline: WordOutline
  /** where the flat ink centre lands, sheet units; z — the back plane's height at the pivot */
  x: number
  y: number
  z: number
  /** flat ink width, sheet units */
  width: number
  /** in-plane rotation, degrees (+ clockwise) */
  rotation: number
  /** the turn in depth, degrees (the entry word too: it stands so all the time — the pull turns the camera) */
  yaw: number
  pitch: number
  /** share of the pointer's turn (about.turn) */
  turn: number
  topic: string
  /** the pull starts inside this word's counter (about.words.about); its pointer turn grows with the camera's turn (cam.orbit) */
  entry: boolean
  /** the turn pivot (yaw / pitch about it), word units on the back plane (the entry word: its counter's centre; else 0, 0) */
  pivot: [number, number]
  /** the entry word's counter (back opening, word units), null for the others */
  counter: Counter | null
}

export interface CardPose {
  key: string
  index: number
  /** the picture's centre (front face), sheet units; z — its height above the sheet plane */
  x: number
  y: number
  z: number
  width: number
  height: number
  thickness: number
  rotation: number
  yaw: number
  pitch: number
  topic: string
}

/** The word whose counter the pull starts in. */
export const ENTRY_WORD = 'about'

interface PoseCache {
  words: WordPose[]
  cards: CardPose[]
}
const poseCache = new WeakMap<object, PoseCache>()

function readWords(config: ResolvedConfig): WordPose[] {
  const about = aboutOf(config)
  const word = obj(about.word)
  // about.words (one world); an old config's about.holes is read the same way
  const list = obj(about.words ?? about.holes)
  const out: WordPose[] = []
  for (const [key, v] of Object.entries(list)) {
    const w = obj(v)
    const text = str(w.text, '').trim()
    if (!text) continue
    const look: TextLook = {
      text,
      tracking: num(w.tracking, num(word.tracking, 0)),
      stretchY: Math.max(0.2, num(w.stretchY, num(word.stretchY, 1))),
      condense: Math.max(0.2, num(w.condense, num(word.condense, 1))),
    }
    const profile = letterProfile(config, 'words' in about ? num(w.depth, NaN) : undefined)
    const outline = wordOutline(look, profile)
    const entry = key === ENTRY_WORD
    let counter: Counter | null = null
    if (entry) {
      // the first A, else the first glyph with a counter
      const a = outline.glyphs.find((g) => g.ch === 'A')
      counter = (a && counterOf(look, a.index, profile)) || null
      for (let i = 0; !counter && i < outline.glyphs.length; i++) counter = counterOf(look, i, profile)
    }
    out.push({
      key,
      look,
      profile,
      outline,
      x: num(w.x, 0),
      y: num(w.y, 0),
      z: num(w.z, 0),
      width: Math.max(1e-3, num(w.width, 1)),
      rotation: num(w.rotation, 0),
      yaw: num(w.yaw, 0),
      pitch: num(w.pitch, 0),
      turn: Math.max(0, num(w.turn, 0)),
      topic: str(w.topic, 'home'),
      entry,
      pivot: counter ? [counter.x, counter.y] : [0, 0],
      counter,
    })
  }
  return out
}

function readCards(config: ResolvedConfig): CardPose[] {
  const items = obj(obj(aboutOf(config).photos).items)
  const out: CardPose[] = []
  for (const [key, v] of Object.entries(items)) {
    const p = obj(v)
    if (!bool(p.show, true) || !str(p.src, '')) continue
    const width = Math.max(0.005, num(p.width, 0.2))
    const aspect = Math.max(0.05, num(p.aspect, 1))
    out.push({
      key,
      index: out.length,
      x: num(p.x, 0),
      y: num(p.y, 0),
      z: num(p.z, 0),
      width,
      height: width / aspect,
      thickness: Math.max(1e-4, num(p.thickness, 0.012)),
      rotation: num(p.rotation, 0),
      yaw: num(p.yaw, 0),
      pitch: num(p.pitch, 0),
      topic: str(p.topic, 'home'),
    })
  }
  return out
}

function posesOf(config: ResolvedConfig): PoseCache {
  let c = poseCache.get(config)
  if (!c) {
    c = { words: readWords(config), cards: readCards(config) }
    poseCache.set(config, c)
  }
  return c
}

/** Every drawn word (about.words with text), config order. Cached per config identity. */
export function wordPoses(config: ResolvedConfig): readonly WordPose[] {
  return posesOf(config).words
}

export function wordPose(config: ResolvedConfig, key: string): WordPose | null {
  return posesOf(config).words.find((w) => w.key === key) ?? null
}

/** Every shown photo card (about.photos.items with show and src), config order. Cached per config identity. */
export function cardPoses(config: ResolvedConfig): readonly CardPose[] {
  return posesOf(config).cards
}

export function cardPose(config: ResolvedConfig, key: string): CardPose | null {
  return posesOf(config).cards.find((c) => c.key === key) ?? null
}

// ── the pointer's turn ──────────────────────────────────────────────────────────────────────────────

export type NoteKindName = 'mono' | 'list' | 'hand' | 'count'

/** about.turn read loosely (the words' turn; .cards — the cards'; .notes — the notes'). */
export function turnKnobs(config: ResolvedConfig) {
  const t = obj(aboutOf(config).turn)
  const fade = obj(t.fade)
  const c = obj(t.cards)
  const n = obj(t.notes)
  const share = obj(n.share)
  const spread = (v: unknown, d: number) => clamp(num(v, d), 0, 0.9)
  return {
    tiltX: num(t.tiltX, 5),
    tiltY: num(t.tiltY, 8),
    maxTurn: Math.max(0, num(t.maxTurn, 12)),
    mass: Math.max(0.05, num(t.mass, 1.1)),
    /** each word's mass: mass × (1 ± spread), seeded by its key (the entry word: exactly mass) */
    spread: spread(t.spread, 0.25),
    edgeKnee: clamp(num(t.edgeKnee, 0.7), 0.05, 0.99),
    /** the pointer's turn is full below zoom `full` and gone above zoom `none` (the pull's close-ups) */
    fadeFull: Math.max(0.1, num(fade.full, 1.6)),
    fadeNone: Math.max(0.2, num(fade.none, 4)),
    /** the cards: like the projects slab (projects.slab.response) — tilt, soft limit, mass, spread */
    cards: {
      tiltX: num(c.tiltX, 6),
      tiltY: num(c.tiltY, 10),
      maxTurn: Math.max(0, num(c.maxTurn, 14)),
      mass: Math.max(0.05, num(c.mass, 2.4)),
      spread: spread(c.spread, 0.3),
    },
    /** the notes: a share of the cards' turn per kind of note, their own mass and spread */
    notes: {
      share: {
        mono: clamp(num(share.mono, 0.5), 0, 2),
        list: clamp(num(share.list, 0.5), 0, 2),
        hand: clamp(num(share.hand, 0.8), 0, 2),
        count: clamp(num(share.count, 0.5), 0, 2),
      } as Record<NoteKindName, number>,
      mass: Math.max(0.05, num(n.mass, 1.6)),
      spread: spread(n.spread, 0.3),
    },
  }
}

export type TurnKnobs = ReturnType<typeof turnKnobs>

/** A stable number in −1…1 for a name (FNV-1a): each element's own share of the mass spread. */
export function seeded(name: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // a second mix so neighbouring names do not land next to each other
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return ((h >>> 0) / 0xffffffff) * 2 - 1
}

/** An element's own mass: the base × (1 + spread × its seed) (kind: 'word' | 'card' | 'note'). */
export function massOf(base: number, spread: number, kind: string, key: string) {
  return Math.max(0.05, base * (1 + spread * seeded(`${kind}:${key}`)))
}

/**
 * How much of the pointer's turn the scene takes at this camera: 1 below zoom turn.fade.full, 0 above
 * fade.none (the pull's close-ups — a degree there is half a screen, and the first frame of the pull
 * must stay the bare void), smooth in ln zoom between; 0 under reduced motion. The same for every
 * element (words, cards, notes) — except the ENTRY word (`entry`: 1, 0 under reduced motion): its turn
 * toward the pointer grows with the camera's turn on the pull instead (wordModelOf: × cam.orbit — 0 in
 * the A's tunnel, so the first frame is still the bare void). Faded by the zoom on top of the turn, a
 * pointer resting at the right (the nav, where a click on ABOUT leaves it) sped the turn up by half on
 * 1.54–1.66 and one at the left nearly stalled it there; growing with the camera's turn, the two make
 * one even turn over the whole pull wherever the pointer rests.
 */
export function turnFade(config: ResolvedConfig, cam: { zoom: number; reduced: boolean }, entry = false) {
  if (cam.reduced) return 0
  if (entry) return 1
  const tk = turnKnobs(config)
  const lo = Math.log(Math.min(tk.fadeFull, tk.fadeNone - 1e-3))
  return 1 - smooth(remap(Math.log(Math.max(1e-3, cam.zoom)), lo, Math.log(tk.fadeNone)))
}

/** Linear up to `knee` of the way to the edge, then eases to (1 + knee) / 2 at |p| = 1 (the title's easeEdge). */
export function easeEdge(p: number, knee: number) {
  const a = Math.abs(p)
  if (a <= knee) return p
  const u = Math.min(1, (a - knee) / (1 - knee))
  return Math.sign(p) * (knee + (1 - knee) * (u - u * u / 2))
}

/**
 * A word's pointer turn (degrees, before its share) for a smoothed pointer (−1…1, y down — the word's
 * own spring, layers/about/core.ts): pointer right → yaw − (the right end recedes), pointer down →
 * pitch + (the bottom recedes), like the title. Faded by turnFade (`entry` — the entry word's: not by
 * the zoom, it grows with the camera's turn in wordModelOf).
 */
export function pointerTurn(config: ResolvedConfig, cam: { zoom: number; reduced: boolean }, px: number, py: number, entry = false): Turn {
  const tk = turnKnobs(config)
  const f = turnFade(config, cam, entry)
  return { yaw: f ? -f * tk.tiltY * easeEdge(px, tk.edgeKnee) : 0, pitch: f ? f * tk.tiltX * easeEdge(py, tk.edgeKnee) : 0 }
}

/**
 * A card's pointer turn (degrees, final) for its smoothed pointer: the projects slab's recipe
 * (layers/slab/solve.ts — the edge knee, then the soft limit about.turn.cards.maxTurn) with the same
 * sense as the words (the card's side toward the pointer recedes). Faded by turnFade. A note takes
 * about.turn.notes.share of the same.
 */
export function cardTurn(config: ResolvedConfig, cam: { zoom: number; reduced: boolean }, px: number, py: number): Turn {
  const tk = turnKnobs(config)
  const f = turnFade(config, cam)
  if (!f) return NO_TURN
  const c = tk.cards
  return {
    yaw: -f * softLimit(c.tiltY * easeEdge(px, tk.edgeKnee), c.maxTurn),
    pitch: f * softLimit(c.tiltX * easeEdge(py, tk.edgeKnee), c.maxTurn),
  }
}

/** A raw turn on the TURN_STEP grid (÷ (1 / step): 29 steps of 0.2 come out as 5.8, not 5.800000000000001). */
export function stepped(v: number) {
  return Math.round(v / TURN_STEP) / (1 / TURN_STEP)
}

/**
 * Every element's turn with the pointer RESTING at (px, py) (−1…1, y down: each spring has settled on
 * it — masses only change the way there), on the TURN_STEP grid: what a pinned frame with ?pointer=
 * shows and what the notes' layout check (stats({ pointer })) tests. `intensity` — config.motion's.
 */
export function restTurns(config: ResolvedConfig, cam: { zoom: number; reduced: boolean }, px: number, py: number): AboutTurns {
  const m = config.motion.intensity
  const w = pointerTurn(config, cam, px * m, py * m)
  const we = pointerTurn(config, cam, px * m, py * m, true)
  const c = cardTurn(config, cam, px * m, py * m)
  const q = (t: Turn): Turn => ({ yaw: stepped(t.yaw), pitch: stepped(t.pitch) })
  const out: AboutTurns = { words: {}, cards: {}, notes: {} }
  for (const p of wordPoses(config)) out.words[p.key] = q(p.entry ? we : w)
  for (const p of cardPoses(config)) out.cards[p.key] = q(c)
  for (const name of Object.keys(obj(aboutOf(config).notes))) out.notes[name] = q(c)
  return out
}

/** Identity up to 60 % of `max`, then rolls off smoothly towards `max` (the title's softLimit). */
function softLimit(a: number, max: number) {
  if (max <= 0) return a
  const k = 0.6 * max
  const s = Math.abs(a)
  if (s <= k) return a
  return Math.sign(a) * (k + (max - k) * Math.tanh((s - k) / (max - k)))
}

/** The pointer's part of a turn, giving way as base + it nears `max` (the base itself is kept exactly). */
function pointerPart(base: number, add: number, max: number) {
  if (!add) return 0
  return softLimit(base + add, max) - softLimit(base, max)
}

// ── models ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A word's model matrix this frame (word units → sheet units, column-major): its own pose (every word —
 * the entry word too — stands in it all the time; the pull turns the camera), then `turn` (its own
 * pointer turn, degrees, already faded — see AboutTurns.words) × the word's `turn` share on top, about
 * its 3D centre. The entry word's pointer part × cam.orbit — the camera's turn on the pull (0 in the
 * A's tunnel … 1 landed): it grows with that turn (turnFade). null — no such word.
 */
export function wordModel(config: ResolvedConfig, key: string, cam: { orbit: number }, turn: Turn = NO_TURN): M4 | null {
  const w = wordPose(config, key)
  return w ? wordModelOf(config, w, cam, turn) : null
}

/** The word's own pose (no pointer turn): word units → sheet units. */
function poseModel(w: WordPose): M4 {
  const [px, py] = w.pivot
  // word units → sheet size about the ink centre → its turn in depth about the pivot → in-plane → place
  let M = scale4(w.width, w.width, w.width)
  M = mul4(translate4(-px * w.width, -py * w.width, 0), M)
  M = mul4(turn4(w.yaw, w.pitch), M)
  M = mul4(translate4(px * w.width, py * w.width, 0), M)
  M = mul4(rotZ4(w.rotation), M)
  return mul4(translate4(w.x, w.y, w.z), M)
}

/** wordModel for a pose already in hand. */
export function wordModelOf(config: ResolvedConfig, w: WordPose, cam: { orbit: number }, turn: Turn = NO_TURN): M4 {
  let M = poseModel(w)
  const share = w.turn
  if (share > 0 && (turn.yaw || turn.pitch)) {
    const max = turnKnobs(config).maxTurn
    // the part it takes at its pose; the entry word's × the camera's turn on the pull (0 in the A's
    // tunnel … 1 landed — its pointer turn is not faded by the zoom, turnFade): the camera's turn and
    // the turn toward the pointer grow together, one even turn over the whole pull wherever it rests
    const t = w.entry ? clamp(cam.orbit, 0, 1) : 1
    const yaw = t * pointerPart(w.yaw, share * turn.yaw, max)
    const pitch = t * pointerPart(w.pitch, share * turn.pitch, max)
    if (yaw || pitch) {
      // about the word's 3D centre (the ink centre, half the depth up), in sheet axes
      const [cx, cy, cz] = apply4(M, 0, 0, w.outline.depth / 2)
      M = mul4(translate4(cx, cy, cz), mul4(turn4(yaw, pitch), mul4(translate4(-cx, -cy, -cz), M)))
    }
  }
  return M
}

/**
 * A photo card's model matrix (the unit box of mesh.ts → cardBox → sheet units, column-major): the
 * picture's centre at (x, y, z), turned by yaw / pitch about it, rotated in-plane, scaled to
 * width × height × thickness; then its pointer turn (`turn`, degrees, final — AboutTurns.cards) on top,
 * in sheet axes, about the centre of the box (its own middle: the picture's centre moves a little, the
 * card does not travel). null — no such (shown) card.
 */
export function cardModel(config: ResolvedConfig, key: string, turn: Turn = NO_TURN): M4 | null {
  const c = cardPose(config, key)
  return c ? cardModelOf(c, turn) : null
}

export function cardModelOf(c: CardPose, turn: Turn = NO_TURN): M4 {
  let M = scale4(c.width, c.height, c.thickness)
  M = mul4(turn4(c.yaw, c.pitch), M)
  M = mul4(rotZ4(c.rotation), M)
  M = mul4(translate4(c.x, c.y, c.z), M)
  if (turn.yaw || turn.pitch) {
    // the box's middle: half the thickness behind the picture
    const [cx, cy, cz] = apply4(M, 0, 0, -0.5)
    M = mul4(translate4(cx, cy, cz), mul4(turn4(turn.yaw, turn.pitch), mul4(translate4(-cx, -cy, -cz), M)))
  }
  return M
}

type V3 = [number, number, number]

/** The entry word's counter and its tunnel, in sheet units (see entryCounter). */
export interface EntryCounter {
  /** the back opening (the A's triangle), xyz triples on the word's back plane */
  ring: Float64Array
  /** its centre (largest inscribed circle), on the back plane, and that circle's radius */
  x: number
  y: number
  z: number
  r: number
  /** the back plane's normal toward the front face: the counter tunnel's axis, out of the letter */
  n: V3
  /** the word's own x (along the line) and y (down the letters) axes, unit */
  wx: V3
  wy: V3
  /** the tunnel's length: from the back plane to the front face along n */
  depth: number
}

const entryCache = new WeakMap<object, EntryCounter | null>()

/**
 * The entry word's counter in its own (home) pose — the word stands so all the time; the pull's camera
 * starts inside this tunnel looking down its axis (core/about-camera.ts → entryFit): the ring on the
 * back plane, its centre and inscribed radius, the axis, the word's axes and the tunnel's length. null —
 * no entry word, or it has no counter. Cached per config identity.
 */
export function entryCounter(config: ResolvedConfig): EntryCounter | null {
  if (entryCache.has(config)) return entryCache.get(config) ?? null
  let out: EntryCounter | null = null
  const w = wordPose(config, ENTRY_WORD)
  if (w && w.counter) {
    const M = poseModel(w)
    const src = w.counter.ring
    const ring = new Float64Array((src.length / 2) * 3)
    for (let i = 0, j = 0; i < src.length; i += 2, j += 3) {
      const [x, y, z] = apply4(M, src[i], src[i + 1], 0)
      ring[j] = x
      ring[j + 1] = y
      ring[j + 2] = z
    }
    const [x, y, z] = apply4(M, w.counter.x, w.counter.y, 0)
    const unit = (v: V3): V3 => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / l, v[1] / l, v[2] / l]
    }
    out = {
      ring,
      x,
      y,
      z,
      r: w.counter.r * w.width,
      n: unit(applyDir4(M, 0, 0, 1)),
      wx: unit(applyDir4(M, 1, 0, 0)),
      wy: unit(applyDir4(M, 0, 1, 0)),
      depth: w.outline.depth * w.width,
    }
  }
  entryCache.set(config, out)
  return out
}
