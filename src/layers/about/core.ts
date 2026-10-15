import { aboutCameraAt, aboutOf, depthOf, project3, tourKeys, viewHeight, type AboutCamera } from '../../core/about-camera'
import {
  apply4,
  applyDir4,
  cardModelOf,
  cardPoses,
  cardTurn,
  massOf,
  NO_TURN,
  pointerTurn,
  stepped,
  TURN_STEP,
  turnFade,
  wordModelOf,
  wordPoses,
  type AboutTurns,
  type CardPose,
  type M4,
  type Turn,
  type WordPose,
} from '../../core/about-pose'
import { aboutFrame } from '../../core/about-sheet'
import { clamp01, remap, smooth } from '../../core/ease'
import { num, obj } from '../../core/loose'
import { Follower } from '../../core/spring'
import type { Frame, Layout, ResolvedConfig } from '../../core/types'
import { aboutKnobs, type AboutKnobs, type PhotoKnobs, type V3 } from './knobs'
import { thinBands } from './mesh'
import { createAboutPhotos, type PhotoSlot } from './photos'

/**
 * ABOUT — what the one world shows this frame, as numbers for whoever draws it (the WebGL renderer in
 * gl.ts or the 2D fallback). Pure geometry comes from core/about-camera.ts (the camera: a pure function
 * of the scroll) and core/about-pose.ts (where every word and card stands: model matrices); this adds
 * what has memory or a clock:
 *   · the pointer: it never moves the camera or the sheet — EVERY element turns toward it about its own
 *     3D centre, like the projects slab: each word (about.turn), each card (about.turn.cards), each note
 *     (about.turn.notes — turned by the notes layer, the springs are here so the check and the notes
 *     see what the canvas draws); each with its OWN spring (core/spring.ts → Follower; its mass seeded
 *     per element ± spread: they never move in lockstep), the title's edge knee, quantised to TURN_STEP
 *     with hysteresis. Faded out by the camera's zoom (turnFade: none in the pull's close-ups — the
 *     first frame stays the bare void; the entry word's grows with the camera's turn on the pull instead,
 *     so the two make one even turn), none under reduced motion; a pinned frame with no live pointer
 *     (?scroll= + ?pointer=) stands every spring on the pointer: a pure function of pos and the pointer;
 *   · which words and cards touch the screen (culled on the CPU through their 3D boxes and their
 *     shadows), how far revealed: the cards around ABOUT stipple in by pos (reveal.photos), everything
 *     further down the tour as it comes up into the frame (reveal.enter); the cards' load clocks, their
 *     timed LOD pop-in and the finish on rest (a pinned scroll is a pure function of pos: no clock, no
 *     memory; so is the first step after a renderer swap or a sleep — resetPhotos);
 *   · the motion energy of the glitch pass, the shimmer / grain ticks, the shadows' zoom fade;
 *   · the photos (photos.ts).
 */

/** At most this many of each in one frame. */
export const MAX_WORDS = 12
export const MAX_CARDS = 14

/** The load clock of a card that has just arrived: its stipple steps take this long, s. */
const LOAD_TIME = 0.32
/**
 * The scroll counts as resting once its speed has stayed under REST_SPEED (screens/s) this long, s:
 * then every card on screen that has begun its reveal finishes it (stipple and LOD) on the load clock.
 */
const REST_AFTER = 0.25
const REST_SPEED = 0.01
/** A pinned pos this close to a tour stop counts as resting on it (the stops' frames: everything begun is finished). */
const REST_KEY = 0.011
/** The tour cards' pop-in: coarsest mip level it starts from (5 → 3 → 1 → 0, like the slab's picture). */
const POP_START = 5
/** The turns' step (core/about-pose.ts; kept here for the old importers). */
export { TURN_STEP }
/**
 * A word's thin bands become lines once its bevel (both chamfers) is this many render px across on
 * screen (at its centre), and drop back below BANDS_OFF; a fresh or pinned frame — the middle.
 */
const BANDS_ON = 5
const BANDS_OFF = 4

/** A value quantised to `step`, kept until the raw one has moved 0.6 step away (no flicker on a boundary). */
function stepTo(raw: number, cur: number, step: number) {
  // ÷ (1 / step), not × step: 29 steps of 0.2 come out as 5.8, not 5.800000000000001
  return Math.abs(raw - cur) > 0.6 * step ? Math.round(raw / step) / (1 / step) : cur
}

/** Quantise k (0…1) into `steps` stipple steps: 0, then 1/steps as soon as it starts, …, 1 at its end. */
export function stipple(k: number, steps: number) {
  if (k <= 0) return 0
  if (k >= 1) return 1
  return Math.min(steps, Math.floor(k * (steps - 1)) + 1) / steps
}

/** x0, y0, x1, y1 — CSS px on the stage */
export type Box = [number, number, number, number]

export interface WordInst {
  pose: WordPose
  /** word units → sheet units */
  M: M4
  /**
   * stipple coverage 0…1 in steps: by where the TOP of its own screen box is (reveal.enter.word), and
   * finished on rest (as the cards) — a fragment never rests half-dotted
   */
  reveal: number
  /** screen box of the solid and its shadow, CSS px */
  box: Box
  /** the plane its shadow falls on: n · p = d (n unit, sheet units) — a word's own back plane, a little behind it */
  plane: Plane
  /** its shadow's share, 0…1: its reveal (a shadow never shows more of itself than its caster) */
  shade: number
  /** its turn toward the pointer this frame (AboutTurns.words; before its share) */
  turn: Turn
  /** its shadow's light: parallel, from the lamp toward its middle (lightFrom) */
  light: V3
  /**
   * its thin bands (the step between the chamfers, the seam groove) drawn as lines of at least a pixel
   * (true) or as their neighbours: its bevel is wide enough on screen (BANDS_ON / BANDS_OFF render px,
   * with hysteresis — one decision for the whole word, never per pixel: no flickering stitches)
   */
  bands: boolean
}

export interface CardInst {
  pose: CardPose
  k: PhotoKnobs
  /** the unit card box (layers/about/mesh.ts → cardBox) → sheet units */
  M: M4
  slot: PhotoSlot
  reveal: number
  /** mip level shown (tour pop-in), whole */
  lod: number
  box: Box
  /** the plane its shadow falls on: the sheet plane under it (or its lowest point, if that is lower) */
  plane: Plane
  /** its shadow's light: parallel, from the lamp toward the middle of its face (lightFrom) */
  light: V3
  /**
   * its shadow's share, 0…1: its reveal × how much of the card is in the frame (about.shadow.share, in
   * the reveal's steps) — a card leaving the frame takes its shadow with it
   */
  shade: number
  /** its turn toward the pointer this frame, degrees (AboutTurns.cards — in M already; the sheen slides with it) */
  turn: Turn
}

export interface AboutState {
  K: AboutKnobs
  /** this frame's camera (core/about-camera.ts), as published */
  cam: AboutCamera
  /** the camera the scene is drawn with — the same object as cam (the pointer no longer shifts it) */
  view: AboutCamera
  /** every element's turn toward the pointer this frame (published: core/about-sheet.ts) */
  turns: AboutTurns
  words: WordInst[]
  cards: CardInst[]
  /** shadows' share at this zoom (about.shadow.zoom), 0…1, × the reduced-motion dissolve */
  shadow: number
  /** the shadows' lamp this frame (shadowLamp: a point at the camera, each caster's light aims from it), sheet units */
  lamp: V3
  /** the glitch pass's energies (the title's formulas) and ticks */
  e: number
  eMove: number
  tick: number
  grainTick: number
  /** depth range of what is drawn: the far plane's distance along the view, sheet units */
  far: number
}

/** Per card: the tour cards' pop-in clock, and the finish on rest. */
interface Pop {
  load: number
  on: boolean
  /** resting on it (and it has begun): it finishes its reveal and LOD; kept while the page moves on */
  held: boolean
  /** the finish's own clock, 0…1 (rises while held, falls back after) */
  hold: number
}

function lodSteps(start: number) {
  const out: number[] = []
  for (let l = Math.max(0, Math.round(start)); l > 0; l -= 2) out.push(l)
  out.push(0)
  return out
}

/** A plane n · p = d (n unit), sheet units. */
export type Plane = [number, number, number, number]

/**
 * The shadows' lamp: a POINT at the camera, hung off it toward about.shadow.light (its x / y over its
 * z, in SCREEN axes — the camera's own right / down, its roll and its turn on the pull undone — × (the
 * frame's distance h − shadow.lampAt): seen from a thing at height lampAt in the middle of the frame
 * the light comes exactly from `light` at home and on the tour). It travels with the camera. Each caster is lit by a parallel light aimed from
 * the lamp at its own middle (lightFrom): so every shadow on screen falls the same way — down-right of
 * its caster, wherever the caster stands in the frame — and keeps the size a parallel light gives it.
 * (One fixed light DIRECTION for all, cast with this camera's perspective, threw the shadows of things
 * near the frame's edges toward its middle — the parallax of a card's height beat the light's own
 * offset: the light seemed to come from the screen's centre. Only a lamp at the camera puts
 * every caster's middle the same way from its shadow on screen: (lamp → centre) × (1 / (h − z) −
 * 1 / (h − z_plane)) × the focal length; a point lamp casting the whole shape would also magnify a
 * high card's shadow by h / (h − z) — hence one parallel light per caster.) `view` — the camera drawn
 * with. Shared with the 2D fallback and the notes' check.
 */
export function shadowLamp(S: AboutKnobs['shadow'], view: Pick<AboutCamera, 'eye' | 'right' | 'down' | 'h'>): V3 {
  const k = Math.max(0.05 * view.h, view.h - S.lampAt) / Math.max(0.05, S.light[2])
  const lx = S.light[0] * k
  const ly = S.light[1] * k
  // screen x / y → sheet: along the camera's own axes (looking straight down: R(−roll) · screen, at its height)
  const { eye: e, right: r, down: d } = view
  return [e[0] + r[0] * lx + d[0] * ly, e[1] + r[1] * lx + d[1] * ly, e[2] + r[2] * lx + d[2] * ly]
}

/** A caster's own parallel light: toward the lamp (shadowLamp) from its middle (x, y, z), normalised. */
export function lightFrom(lamp: V3, x: number, y: number, z: number): V3 {
  const dx = lamp[0] - x
  const dy = lamp[1] - y
  const dz = Math.max(0.05, lamp[2] - z)
  const l = Math.hypot(dx, dy, dz) || 1
  return [dx / l, dy / l, dz / l]
}

/** Where a world point lands on a shadow plane along the light L (toward the light; lightFrom). */
export function onPlane(L: V3, P: Plane, x: number, y: number, z: number): [number, number, number] {
  const h = Math.max(0, x * P[0] + y * P[1] + z * P[2] - P[3])
  const t = h / Math.max(0.05, L[0] * P[0] + L[1] * P[1] + L[2] * P[2])
  return [x - t * L[0], y - t * L[1], z - t * L[2]]
}

/**
 * The plane a word's shadow falls on: its own back plane (M — wordModel), `gap` behind it (letters
 * mounted on an unseen panel: a dotted drop shadow that hugs them, however the word is turned).
 * Shared with the notes' layout check (layers/about-text/check.ts).
 */
export function wordShadowPlane(M: M4, gap: number): Plane {
  const n = applyDir4(M, 0, 0, 1)
  const nl = Math.hypot(n[0], n[1], n[2]) || 1
  const o0 = apply4(M, 0, 0, 0)
  return [n[0] / nl, n[1] / nl, n[2] / nl, (n[0] * o0[0] + n[1] * o0[1] + n[2] * o0[2]) / nl - gap]
}

/** The plane a card's shadow falls on (M — cardModel): the sheet plane under it, or its own lowest point if that is lower. */
export function cardShadowPlane(M: M4): Plane {
  let low = Infinity
  for (let i = 0; i < 8; i++) low = Math.min(low, apply4(M, i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0 : -1)[2])
  return [0, 0, 1, Math.min(0, low)]
}

/**
 * A card's shadow pool (gl.ts → SHADOW_FS): its picture face grown by the penumbra — shadow.soft × its
 * lift above the shadow plane — on every side (gx, gy: × the face's width / height), the density
 * 1 − r² from the middle to the rim over a superellipse of exponent n: shadow.round for a card low over
 * the sheet (a rounded rectangle), down to 2 (an ellipse) once the penumbra reaches the middle of the
 * face — high cards throw soft round pools, like the projects slab.
 */
export function shadowPool(S: AboutKnobs['shadow'], lift: number, width: number, height: number) {
  const pen = S.soft * Math.max(0, lift)
  const half = Math.max(1e-6, Math.min(width, height) / 2)
  const k = Math.min(1, pen / half)
  return {
    gx: (width + 2 * pen) / Math.max(1e-6, width),
    gy: (height + 2 * pen) / Math.max(1e-6, height),
    n: 2 + (Math.max(2, S.round) - 2) * (1 - k),
    pen,
  }
}

/**
 * How far a shadow's dots can reach beyond the flattened footprint of its caster, sheet units on its
 * plane (gl.ts → the shadow pass): a card's pool (shadowPool: the face grown by the penumbra; the
 * weight (1 − r²) × (1 − fade × lift) passes shadow.edge at r = √(1 − edge / that), along an axis) plus
 * the gaussian (shadow.blur). `half` — half the card's side along that axis, sheet units; words:
 * lift 0. An upper bound (the pool's corners are rounder than the face's); a pool that stays inside its
 * footprint gives the blur alone.
 */
export function shadowReach(S: AboutKnobs['shadow'], lift: number, half = 0) {
  const l = Math.max(0, lift)
  const w0 = 1 - S.fade * l
  if (w0 <= S.edge) return 0
  const pen = S.soft * l
  return Math.max(0, (half + pen) * Math.sqrt(1 - S.edge / w0) - half) + S.blur
}

/** The shadows' share at this camera (about.shadow.zoom: none in the pull's close-ups), × the reduced-motion dissolve. */
export function shadowShare(S: AboutKnobs['shadow'], cam: Pick<AboutCamera, 'zoom' | 'dissolve'>) {
  const sz = Math.log(Math.max(1e-3, cam.zoom))
  return (1 - smooth(remap(sz, Math.log(Math.min(S.zoomFull, S.zoomNone - 1e-3)), Math.log(S.zoomNone)))) * cam.dissolve
}

/**
 * Where a card's sheen band stands across its face (0 its left edge … 1 its right): about.cards.sheen.at,
 * sliding as the card crosses the screen (`sx` — its picture's centre at rest on screen, CSS px; × travel:
 * a light that stays put) and as it turns toward the pointer (× sheen.turn at about.turn.cards.maxTurn —
 * the slab's sheen does the same). Shared by gl.ts and the 2D fallback.
 */
export function sheenAt(K: AboutKnobs, c: Pick<CardInst, 'turn'>, sx: number | null, W: number) {
  const sh = K.cards.sheen
  return sh.at + (sx !== null ? (sx / Math.max(1, W) - 0.5) * sh.travel : 0) - (c.turn.yaw / Math.max(1, K.turn.cards.maxTurn)) * sh.turn
}

/**
 * Screen box of an object's box (its own coordinates `b` → M → the camera) and, with `L`, of its
 * shadow on `P` along L: the corners in front of the near plane plus where the box's edges cross it (exact for
 * the box); `dMax` — the farthest corner's distance along the view. null — wholly behind the camera.
 */
function screenBox(view: AboutCamera, M: M4, b: readonly number[], L: V3 | null, P: Plane): { box: Box; dMax: number } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let dMax = -Infinity
  const add = (x: number, y: number, z: number) => {
    const p = project3(view, x, y, z)
    if (!p) return
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  const lim = view.near * 1.001
  const set = (pts: [number, number, number][], own: boolean) => {
    const ds = pts.map((q) => depthOf(view, q[0], q[1], q[2]))
    for (let i = 0; i < 8; i++) {
      if (ds[i] >= lim) add(pts[i][0], pts[i][1], pts[i][2])
      // (the shadows are drawn at the far plane itself: only the object's own corners set it)
      if (own) dMax = Math.max(dMax, ds[i])
    }
    // the 12 edges of the box that cross the near plane
    for (let i = 0; i < 8; i++)
      for (const bit of [1, 2, 4]) {
        const j = i | bit
        if (j === i) continue
        const a = pts[i]
        const c = pts[j]
        if (ds[i] >= lim === ds[j] >= lim) continue
        const t = (lim - ds[i]) / (ds[j] - ds[i])
        add(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t)
      }
  }
  const corners: [number, number, number][] = []
  for (let i = 0; i < 8; i++) corners.push(apply4(M, i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]))
  set(corners, true)
  if (L) set(corners.map((c) => onPlane(L, P, c[0], c[1], c[2])), false)
  if (!(x1 >= x0)) return null
  return { box: [x0, y0, x1, y1], dMax }
}

const onStage = (b: Box, W: number, H: number, m: number) => b[2] >= -m && b[0] <= W + m && b[3] >= -m && b[1] <= H + m

/** The share of a box's area on the stage (0…1). */
function shareOnStage(b: Box, W: number, H: number) {
  const a = Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
  const w = Math.max(0, Math.min(W, b[2]) - Math.max(0, b[0]))
  const h = Math.max(0, Math.min(H, b[3]) - Math.max(0, b[1]))
  return (w * h) / a
}

/** The unit card box (mesh.ts → cardBox): x, y ∈ ±½, z ∈ −1…0. */
const CARD_BOUNDS = [-0.5, -0.5, -1, 0.5, 0.5, 0] as const

export interface AboutCore {
  readonly K: AboutKnobs
  readonly photos: ReturnType<typeof createAboutPhotos>
  resize(layout: Layout, config: ResolvedConfig): void
  step(frame: Frame): AboutState
  /** something the renderer must react to has changed (a photo arrived) */
  version: number
  /**
   * Forget the cards' clocks (pop-in, the finish on rest): the next step takes them from pos alone,
   * as a pinned frame would. On a renderer swap (a lost / restored context) and after a sleep.
   */
  resetPhotos(): void
  dispose(): void
}

export function createAboutCore(ctxLayout: Layout, ctxConfig: ResolvedConfig, onPhoto: (i: number) => void): AboutCore {
  let config = ctxConfig
  let layout = ctxLayout
  let K = aboutKnobs(config)
  /** one spring per element (by kind and key), and its turn on the TURN_STEP grid (hysteresis) */
  const springs = new Map<string, { f: Follower; turn: Turn }>()
  let pops: Pop[] = []
  /** the tour's words' finish on rest (by word key), as the cards' */
  let wordPops: Record<string, Pop> = {}
  /** the words' thin bands drawn as lines (by word key; WordInst.bands) */
  let wordBands: Record<string, boolean> = {}
  /** seconds the scroll has been still (REST_SPEED) */
  let still = 0
  /** the next step takes the cards' state from pos alone (resetPhotos, a wake from sleep) */
  let fresh = true
  /** performance.now() of the previous step: a long gap — the layer slept (sky.ts) */
  let lastStep = -1

  const core: AboutCore = {
    get K() {
      return K
    },
    photos: createAboutPhotos((i) => {
      core.version++
      onPhoto(i)
    }),
    version: 0,

    resetPhotos() {
      for (const pop of pops) if (pop) (pop.load = pop.hold = 0), (pop.on = pop.held = false)
      wordPops = {}
      wordBands = {}
      still = 0
      fresh = true
    },

    resize(l, c) {
      layout = l
      config = c
      K = aboutKnobs(c)
      core.photos.sync(K)
    },

    step(frame) {
      config = frame.config
      layout = frame.layout
      K = aboutKnobs(config)
      return stepState(frame)
    },

    dispose() {
      core.photos.dispose()
      aboutFrame.camera = null
      aboutFrame.drawn = false
      aboutFrame.frame = null
    },
  }

  function stepState(frame: Frame): AboutState {
    const { scroll, pointer } = frame
    const cam = aboutCameraAt(config, layout, scroll, scroll.pos)
    const cell = cam.cell
    const W = layout.width
    const H = layout.height
    const viewH = viewHeight(layout, scroll)
    const reduced = scroll.reduced

    // a wake after a sleep (sky.ts): whatever the clocks held belongs to another place in the film
    const now = performance.now()
    if (lastStep >= 0 && now - lastStep > 400) core.resetPhotos()
    lastStep = now

    // ── the pointer: every element turns toward it on its own spring (its own mass), faded by the
    // zoom (none in the pull's close-ups; the entry word's grows with the camera's turn instead — about-pose.ts →
    // turnFade, wordModelOf); the camera stays put ──
    const fade = turnFade(config, cam)
    const entryFade = turnFade(config, cam, true)
    const T = K.turn
    // a pinned frame with no live pointer (?scroll= + ?pointer=): every spring stands on the pointer —
    // the frame is a pure function of pos and the pointer; the first step after a wake or a renderer
    // swap starts every spring where the shared pointer is now (as the slab does)
    const stand = scroll.pinned && !pointer.active
    const wake = fresh
    const live = new Set<string>()
    const turnOf = (id: string, mass: number, rule: (x: number, y: number) => Turn, fade: number): Turn => {
      live.add(id)
      let sp = springs.get(id)
      if (!sp) springs.set(id, (sp = { f: new Follower(), turn: NO_TURN }))
      const f = sp.f
      if (stand || wake) {
        f.x = stand ? pointer.targetX : pointer.x
        f.y = stand ? pointer.targetY : pointer.y
        f.vx = f.vy = 0
      } else f.step(pointer, frame.dt, config.motion, mass)
      if (!(fade > 0)) return (sp.turn = NO_TURN)
      const raw = rule(f.x, f.y)
      const pure = stand || wake
      const yaw = pure ? stepped(raw.yaw) : stepTo(raw.yaw, sp.turn.yaw, TURN_STEP)
      const pitch = pure ? stepped(raw.pitch) : stepTo(raw.pitch, sp.turn.pitch, TURN_STEP)
      if (yaw !== sp.turn.yaw || pitch !== sp.turn.pitch) sp.turn = { yaw, pitch }
      return sp.turn
    }
    const wordRule = (x: number, y: number) => pointerTurn(config, cam, x, y)
    const entryRule = (x: number, y: number) => pointerTurn(config, cam, x, y, true)
    const cardRule = (x: number, y: number) => cardTurn(config, cam, x, y)
    const turns: AboutTurns = { words: {}, cards: {}, notes: {} }
    for (const p of wordPoses(config))
      turns.words[p.key] = p.entry ? turnOf(`w:${p.key}`, T.mass, entryRule, entryFade) : turnOf(`w:${p.key}`, massOf(T.mass, T.spread, 'word', p.key), wordRule, fade)
    for (const p of cardPoses(config)) turns.cards[p.key] = turnOf(`c:${p.key}`, massOf(T.cards.mass, T.cards.spread, 'card', p.key), cardRule, fade)
    for (const name of Object.keys(obj(aboutOf(config).notes))) turns.notes[name] = turnOf(`n:${name}`, massOf(T.notes.mass, T.notes.spread, 'note', name), cardRule, fade)
    for (const id of springs.keys()) if (!live.has(id)) springs.delete(id)
    const view = cam

    // ── motion energy (the title's formulas): the pointer and the scroll ──
    const R = K.raster
    const signed = num((scroll as unknown as { speed?: number }).speed, scroll.velocity)
    const speed = Math.abs(signed)
    const shimmer = reduced ? 0 : 1
    const energy = Math.max(pointer.energy, 0.6 * smooth(remap(speed, 0.05, 1.5)))
    const eMove = smooth(remap(energy, 0.04, 0.6)) * shimmer
    const e = Math.min(2, eMove + R.restShimmer * shimmer)
    const tick = Math.floor(frame.time * R.shimmerFps) % 9973
    const grainTick = reduced || R.grainFps <= 0 ? 0 : Math.floor(frame.time * R.grainFps) % 9973

    // ── shadows: none in the close-ups, all of them from about.shadow.zoom.full on ──
    const S = K.shadow
    const shadow = shadowShare(S, cam)
    const lamp = shadowLamp(S, view)
    const shading = shadow > 0 && S.opacity > 0
    const margin = 2 * cell
    // the farthest drawn thing's distance along the view (the far plane; at least the sheet plane under the frame's centre)
    let dMax = view.h

    const rp = K.reveal.photos
    const pinned = scroll.pinned
    // the pop-ins and the finish on rest without memory: pinned, or the first step after a reset
    const pure = pinned || fresh
    fresh = false
    // the finish on rest: the scroll has stayed still REST_AFTER s (never while pinned); turning back
    // hands every card and word to the scroll-driven reveal again
    still = speed < REST_SPEED ? still + frame.dt : 0
    const resting = !pinned && still >= REST_AFTER
    const back = signed < -REST_SPEED
    // a pinned frame ON a tour stop (pos 2 + its `at`, ± REST_KEY) shows what the page shows once it
    // has rested there: whatever has begun its reveal is finished (and sharp) — still a pure function
    // of pos, and no half-dotted ghost in a frame that is meant as a stop
    const restKey = pinned && tourKeys(config).some((k) => Math.abs(scroll.pos - (2 + k.at)) <= REST_KEY)

    // ── words ──
    const words: WordInst[] = []
    const re = K.reveal.enter
    const steps = K.reveal.photos.steps
    const enterAt = (cy: number) => {
      const f = remap(cy / viewH, re.from, re.to)
      return reduced ? (f >= 0.5 ? 1 : 0) : stipple(f, steps)
    }
    const seen = new Set<string>()
    if (cam.active) {
      for (const pose of wordPoses(config)) {
        if (words.length >= MAX_WORDS) break
        const turn = turns.words[pose.key] ?? NO_TURN
        const M = wordModelOf(config, pose, cam, turn)
        const o = pose.outline
        // its shadow falls on its own back plane, shadow.gap behind it
        const plane = wordShadowPlane(M, S.gap)
        // drawn only while the word itself touches the frame (never its shadow alone); the box with
        // the shadow is for the glitch pass's tears
        const own = screenBox(view, M, o.bounds, null, plane)
        if (!own || !onStage(own.box, W, H, margin)) continue
        // its light: from the lamp toward its middle
        const mid = apply4(M, 0, 0, o.depth / 2)
        const light = lightFrom(lamp, mid[0], mid[1], mid[2])
        const sb = (shading && screenBox(view, M, o.bounds, light, plane)) || own
        let reveal = 1
        if (!pose.entry) {
          // by the TOP of its own screen box (reveal.enter.word lower): a giant letter whose middle stays
          // below the frame is solid once a little of it is in (by its centre it never was: it rested
          // as a half-dotted ghost)
          reveal = enterAt(own.box[1] + re.word * viewH)
          // and, like the cards, it finishes on rest (and stays finished while the page moves on)
          const pop = (wordPops[pose.key] ??= { load: 0, on: false, held: false, hold: 0 })
          seen.add(pose.key)
          if (pure || back) pop.held = false
          else if (resting && reveal > 0) pop.held = true
          if (pure) pop.hold = 0
          else if (reduced) pop.hold = pop.held ? 1 : 0
          else pop.hold = clamp01(pop.held ? Math.max(pop.hold, reveal) + frame.dt / LOAD_TIME : pop.hold - frame.dt / LOAD_TIME)
          reveal = Math.max(reveal, stipple(pop.hold, steps))
          if (restKey && reveal > 0) reveal = 1
        }
        reveal = Math.min(reveal, cam.dissolve)
        if (reveal <= 0) continue
        dMax = Math.max(dMax, sb.dMax)
        // its bevel on screen, render px (at its middle): the thin bands as lines or as neighbours
        const pm = project3(view, mid[0], mid[1], mid[2])
        const bevelPx = pm ? (thinBands(pose.profile).bevel * o.cap * pose.width * pm[2]) / cell : 0
        const was = pure ? undefined : wordBands[pose.key]
        const bands = was === undefined ? bevelPx >= (BANDS_ON + BANDS_OFF) / 2 : was ? bevelPx >= BANDS_OFF : bevelPx >= BANDS_ON
        wordBands[pose.key] = bands
        words.push({ pose, M, reveal, box: sb.box, plane, light, shade: reveal, bands, turn })
      }
    }
    // a word out of the frame forgets its finish
    for (const key in wordPops) if (!seen.has(key)) delete wordPops[key]
    for (const key in wordBands) if (!words.some((w) => w.pose.key === key)) delete wordBands[key]

    // ── cards ──
    const cards: CardInst[] = []
    const items = K.photos.items
    const poses = cardPoses(config)
    const homeOrder = items.filter((p) => p.topic === 'home')
    pops.length = items.length
    const lods = lodSteps(POP_START)
    if (cam.active) {
      for (const k of items) {
        const pose = poses[k.index]
        const slot = core.photos.get(k.index)
        const pop = (pops[k.index] ??= { load: 0, on: false, held: false, hold: 0 })
        if (!slot || !pose) {
          pop.load = pop.hold = 0
          pop.on = pop.held = false
          continue
        }
        const turn = turns.cards[pose.key] ?? NO_TURN
        const M = cardModelOf(pose, turn)
        // its shadow falls on the sheet plane under it (on its own lowest point, if that is lower)
        const plane = cardShadowPlane(M)
        // its own box (no shadow): whether it is in the frame at all (a card above the frame or behind
        // the camera is not drawn, and neither is its shadow), its share in the frame (the pop-in, the
        // shadow's share); with the shadow — for the glitch pass's tears
        const own = screenBox(view, M, CARD_BOUNDS, null, plane)
        // its light: from the lamp toward the middle of its face (where the turn has put it)
        const light = lightFrom(lamp, M[12], M[13], M[14])
        const sb = own && ((shading && screenBox(view, M, CARD_BOUNDS, light, plane)) || own)
        const visible = !!own && onStage(own.box, W, H, margin)
        const centre = project3(view, pose.x, pose.y, pose.z)
        // scroll reveal: home cards by pos (staggered), the rest as they come up into the frame
        let reveal: number
        let share = 0
        let exiting = false
        if (k.topic === 'home') {
          const i = homeOrder.indexOf(k)
          const a = rp.from + i * rp.stagger
          const b = rp.to + i * rp.stagger
          reveal = reduced ? (scroll.pos >= a ? 1 : 0) : stipple(remap(scroll.pos, a, b), rp.steps)
        } else {
          const cy = centre ? centre[1] : -Infinity
          reveal = centre ? enterAt(cy) : 0
          share = visible && own ? shareOnStage(own.box, W, H) : 0
          // in the upper half of the frame: on its way out (the tour runs down the sheet) — it entered
          // sharp and stays sharp until it is gone, never un-popping into a grey mosaic at the edge
          exiting = visible && cy < viewH * 0.5
        }
        // the scroll stopped on it once it had begun: it finishes (stipple + LOD) on the load clock and
        // stays finished while the page moves on — until it leaves the frame or the scroll turns back
        if (pure || !visible || back) pop.held = false
        else if (resting && reveal > 0) pop.held = true
        if (pure || !visible) pop.hold = 0
        else if (reduced) pop.hold = pop.held ? 1 : 0
        else pop.hold = clamp01(pop.held ? Math.max(pop.hold, reveal) + frame.dt / LOAD_TIME : pop.hold - frame.dt / LOAD_TIME)
        reveal = Math.max(reveal, stipple(pop.hold, rp.steps))
        if (restKey && reveal > 0) reveal = 1
        let lod = 0
        if (k.topic !== 'home') {
          // the timed pop-in once reveal.enter.lod.at of it is in the frame, or the finish on rest; once
          // sharp it stays sharp while any of it is on screen; pinned — a pure function of pos
          const want = share >= re.lodAt || exiting || (restKey && reveal > 0)
          if (pure) pop.on = want
          else pop.on = want || pop.held || (!reduced && pop.on && visible)
          if (pure || reduced) pop.load = pop.on ? 1 : 0
          else pop.load = clamp01(pop.load + ((pop.on ? 1 : -1) * frame.dt) / (lods.length * re.lodStep))
          if (exiting) pop.load = 1
          lod = lods[Math.min(lods.length - 1, Math.floor(pop.load * lods.length + 1e-6))]
        }
        // a late file stipples in on its own clock, it does not pop
        const load = pinned || reduced ? 1 : stipple(clamp01((now - slot.at) / 1000 / LOAD_TIME), rp.steps)
        reveal = Math.min(reveal, load, cam.dissolve)
        if (!visible || !sb || !own || reveal <= 0 || cards.length >= MAX_CARDS) continue
        dMax = Math.max(dMax, sb.dMax)
        const shade = reveal * stipple(clamp01(shareOnStage(own.box, W, H) / S.share), rp.steps)
        cards.push({ pose, k, M, slot, reveal, lod, box: sb.box, plane, light, shade, turn })
      }
    }

    return { K, cam, view, turns, words, cards, shadow, lamp, e, eMove, tick, grainTick, far: dMax + 0.05 }
  }

  core.photos.sync(K)
  return core
}
