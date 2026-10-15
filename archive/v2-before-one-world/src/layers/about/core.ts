import { aberrationAt } from '../../core/aberration'
import { aboutCameraAt, aboutEntry, aboutUnit, toScreen, viewHeight, type AboutCamera } from '../../core/about-camera'
import { aboutFrame } from '../../core/about-sheet'
import { clamp01, remap, smooth } from '../../core/ease'
import { num } from '../../core/loose'
import { Follower } from '../../core/spring'
import type { Frame, Layout, ResolvedConfig, ScrollState } from '../../core/types'
import { buildGlyphs, glyphId, glyphKey, wordFontReady, type Glyph, type GlyphSet } from './glyphs'
import { aboutKnobs, type AboutKnobs, type HoleKnobs, type PhotoKnobs } from './knobs'
import { createAboutPhotos, debrisReach, type PhotoSlot } from './photos'
import { centreOf, onStage, placeHole, placePhoto, seedOf, shareOnStage, stipple, unitsPerPx, type Placed, type Sway } from './scene'

/**
 * ABOUT — what the sheet shows this frame, as numbers for whoever draws it (the WebGL renderer in
 * index.ts or the 2D fallback). One object per layer, whatever draws:
 *   · the camera (core/about-camera.ts — a pure function of the scroll) and the pointer sway (its own
 *     spring, about.response.mass; the sway is snapped to whole cells like the camera);
 *   · the words' turn toward the pointer (about.turn: its own spring, the title's edge knee, faded out
 *     by the camera's zoom, none under reduced motion; quantised to TURN_STEP with hysteresis, so a
 *     resting pointer — the idle float included — almost never redraws pass 1);
 *   · the letters' LOD (power-of-two levels with hysteresis, raster.lod; a switch dissolves in over
 *     raster.lod.fade — never on the first visible step, after a sleep or a renderer swap, or under
 *     reduced motion: those take the pure level of their zoom) and the zoom ramps (letters.texture),
 *     the edge crawl tick (raster.crawlFps, only while something moves);
 *   · which holes, photos and crosses touch the screen (culled on the CPU), where, how far revealed —
 *     the photos' load clocks, the tour photos' timed LOD pop-in (a photo on its way out — the upper
 *     half of the frame — stays sharp until it is gone) and the finish on rest live here (a pinned
 *     scroll is a pure function of pos: no clock, no memory; so is the first step after a renderer
 *     swap or a sleep — resetPhotos);
 *   · the glyph atlas (glyphs.ts) and the photos (photos.ts);
 *   · what it tells the others: aboutFrame every update (the camera and the sway the notes follow).
 */

/** At most this many of each in one frame (the renderer's instance rows). */
export const MAX_HOLES = 12
export const MAX_PHOTOS = 14
export const MAX_CROSSES = 24

/** The load clock of a photo that has just arrived: its stipple steps take this long, s. */
const LOAD_TIME = 0.32
/**
 * The scroll counts as resting once its speed has stayed under REST_SPEED (screens/s) this long, s:
 * then every photo on screen that has begun its reveal finishes it (stipple and LOD) on the load clock.
 */
const REST_AFTER = 0.25
const REST_SPEED = 0.01
/** The tour photos' pop-in: coarsest mip level it starts from (5 → 3 → 1 → 0, like the slab's picture). */
const POP_START = 5
/** Twinkles are decided this many times a second. */
const TWINKLE_FPS = 4
/**
 * The pointer's turn moves in steps of this many degrees (with hysteresis): ≈ 0.5 px at the ends of
 * ABOUT on 1440 — under a cell, so the steps never show, but a resting pointer (its slow idle float)
 * changes the picture only every second or two instead of every frame.
 */
const TURN_STEP = 0.2

/** The title's edge knee (title/raster): linear up to `knee` of the way to the edge, then softer. */
function easeEdge(p: number, knee: number) {
  const k = Math.min(1, Math.max(0.05, knee))
  const a = Math.abs(p)
  if (k >= 1 || a <= k) return p
  const u = Math.min(1, (a - k) / (1 - k))
  return Math.sign(p) * (k + (1 - k) * (u - (u * u) / 2))
}

/** A value quantised to `step`, kept until the raw one has moved 0.6 step away (no flicker on a boundary). */
function stepTo(raw: number, cur: number, step: number) {
  // ÷ (1 / step), not × step: 29 steps of 0.2 come out as 5.8, not 5.800000000000001
  return Math.abs(raw - cur) > 0.6 * step ? Math.round(raw / step) / (1 / step) : cur
}

export interface HoleInst {
  k: HoleKnobs
  g: Glyph
  placed: Placed
  /** sheet units per glyph px */
  upp: number
  /**
   * The interior texture's scale: this hole's letters ÷ the word ABOUT's (glyph px are alike in every
   * text): the blotches and toner rectangles belong to the letter, so a giant fragment gets giant ones
   */
  tex: number
  seed: number
}

export interface PhotoInst {
  k: PhotoKnobs
  placed: Placed & { W: number; H: number }
  slot: PhotoSlot
  /** stipple coverage, 0…1 in steps */
  reveal: number
  /** mip level shown (tour pop-in), whole */
  lod: number
  seed: number
}

export interface CrossInst {
  /** cell of its centre (cells from the stage's top-left) */
  cx: number
  cy: number
  reveal: number
  alpha: number
}

export interface AboutState {
  K: AboutKnobs
  cam: AboutCamera
  sway: Sway
  /** letters: LOD level, texel (sheet units) and its size on screen (CSS px) */
  lod: number
  texel: number
  texelPx: number
  /** a LOD switch dissolving in: the old level's texel ÷ the new one's, and the share of cells already on the new one (1 — done) */
  lodRatio: number
  lodMix: number
  /** letters.texture ramp: 0 — no interior texture (the first frames of the pull), 1 — all of it */
  ramp: number
  /** how much of the edge damage shows at this zoom: letters.home at the home framing … 1 from letters.texture.full closer */
  calm: number
  crawl: number
  holes: HoleInst[]
  photos: PhotoInst[]
  crosses: CrossInst[]
  /** largest aberration shift, CSS px (culling margin) */
  reach: number
  /** the entry point on screen (CSS px) and the radius kept free of specks around it */
  keep: [number, number, number]
}

/** Per photo: the tour photos' pop-in clock, and the finish on rest. */
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

/** Integer hash → 0…1 (JS twin of the shaders' h3 for the few decisions taken on the CPU). */
function hash01(a: number, b: number) {
  let x = (Math.imul(a, 1664525) + 1013904223) >>> 0
  let y = (Math.imul(b, 1664525) + 1013904223) >>> 0
  x = (x + Math.imul(y, 2654435761)) >>> 0
  x ^= x >>> 16
  y = (y + Math.imul(x, 2246822519)) >>> 0
  y ^= y >>> 13
  return (Math.imul(x ^ y, 3266489917) >>> 0) / 4294967296
}

export interface AboutCore {
  readonly K: AboutKnobs
  readonly glyphs: GlyphSet | null
  readonly photos: ReturnType<typeof createAboutPhotos>
  /** the entry point measured from the glyphs (sheet units), for stats() */
  readonly measured: { x: number; y: number; r: number } | null
  /** wait for the font + the glyph atlas of the current config */
  ready(): Promise<void>
  resize(layout: Layout, config: ResolvedConfig): void
  /** `flat` — the 2D fallback: the reduced-motion camera (a dissolve, no pull-back, zoom 1). */
  step(frame: Frame, flat: boolean): AboutState
  /** something the renderer must react to has changed (a photo arrived, the atlas was rebuilt) */
  version: number
  /**
   * Forget the photos' clocks (pop-in, the finish on rest): the next step takes them from pos alone,
   * as a pinned frame would. On a renderer swap (a lost / restored context) and after a sleep.
   */
  resetPhotos(): void
  dispose(): void
}

export function createAboutCore(ctxLayout: Layout, ctxConfig: ResolvedConfig, onPhoto: (i: number) => void): AboutCore {
  let config = ctxConfig
  let layout = ctxLayout
  let K = aboutKnobs(config)
  let glyphs: GlyphSet | null = null
  let building: Promise<void> | null = null
  let buildingKey = ''
  let measured: AboutCore['measured'] = null
  const follower = new Follower()
  /** the words' own spring toward the pointer (about.turn.mass) */
  const turner = new Follower()
  let lod = 0
  let lodStarted = false
  let lodPrev = 0
  let lodFade = 1
  let crawl = 0
  let pops: Pop[] = []
  let sway: Sway = { x: 0, y: 0, yaw: 0, pitch: 0 }
  /** seconds the scroll has been still (REST_SPEED) */
  let still = 0
  /** the next step takes the photos' state from pos alone (resetPhotos, a wake from sleep) */
  let fresh = true
  /** performance.now() of the previous step: a long gap — the layer slept (sky.ts) */
  let lastStep = -1
  /** bumped when the word's font lands after its timeout: part of the glyph key (the atlas is rebuilt) */
  let fontEpoch = 0
  let fontWatch = false
  let disposed = false

  const core: AboutCore = {
    get K() {
      return K
    },
    get glyphs() {
      return glyphs
    },
    photos: createAboutPhotos((i) => {
      core.version++
      onPhoto(i)
    }),
    get measured() {
      return measured
    },
    version: 0,

    resetPhotos() {
      for (const pop of pops) if (pop) pop.load = pop.hold = 0, pop.on = pop.held = false
      still = 0
      fresh = true
      // the letters' LOD too: the next visible step takes the pure level of its zoom, no fade from
      // whatever level a hidden frame (or another renderer) left behind
      lodStarted = false
    },

    ready() {
      return ensureGlyphs()
    },

    resize(l, c) {
      layout = l
      config = c
      K = aboutKnobs(c)
      core.photos.sync(K)
      void ensureGlyphs()
    },

    step(frame, flat) {
      config = frame.config
      layout = frame.layout
      K = aboutKnobs(config)
      return stepState(frame, flat)
    },

    dispose() {
      disposed = true
      core.photos.dispose()
      aboutFrame.camera = null
      aboutFrame.drawn = false
      aboutFrame.frame = null
    },
  }

  /** The 'about' hole (the word itself): the camera enters its first letter. */
  const entryHole = () => K.holes.find((h) => h.key === 'about') ?? K.holes[0] ?? null

  function ensureGlyphs(): Promise<void> {
    const key = `${glyphKey(K)}|${fontEpoch}`
    if (glyphs?.key === key) return Promise.resolve()
    if (building && buildingKey === key) return building
    buildingKey = key
    const knobs = K
    const p = (async () => {
      const later = await wordFontReady(knobs)
      if (later && !fontWatch) {
        // the font is late (an eager open at #about, a slow line): the letters are drawn in the system
        // fallback now and rebuilt in the real font the moment it lands (the atlas follows the key)
        fontWatch = true
        void later.arrives.then(() => {
          if (disposed) return
          fontEpoch++
          void ensureGlyphs()
        })
      }
      const entry = entryHole()
      const set = await buildGlyphs(knobs, entry ? glyphId(entry) : null)
      if (buildingKey !== key || disposed) return
      glyphs = { ...set, key }
      measured = null
      if (entry && set.entry) {
        const g = set.glyphs.get(glyphId(entry))
        if (g) {
          const upp = unitsPerPx(entry, g)
          const lx = (set.entry.gx - (g.inkX + g.inkW / 2)) * upp
          const ly = (set.entry.gy - (g.inkY + g.inkH / 2)) * upp
          const c = Math.cos((entry.rotation * Math.PI) / 180)
          const s = Math.sin((entry.rotation * Math.PI) / 180)
          measured = { x: entry.x + c * lx - s * ly, y: entry.y + s * lx + c * ly, r: set.entry.r * upp }
        }
      }
      core.version++
    })()
    building = p
    void p.finally(() => {
      if (building === p) building = null
    })
    return p
  }

  /**
   * Camera of `pos` for this core. The 2D fallback: the reduced-motion one — and without reduced
   * motion (no WebGL2, ?nogl=about) the slab still plays its own leave (WebGL, projects.leave), so
   * the dissolve starts only once that is over: at max(pull.reduced.from, projects.leave.to), over
   * the same length; before that the sheet is not there at all (never a stipple over the slab).
   */
  const cameraAt = (scroll: ScrollState, pos: number, flat: boolean) => {
    if (!flat || scroll.reduced) return aboutCameraAt(config, layout, scroll, pos)
    const cam = aboutCameraAt(config, layout, { ...scroll, reduced: true }, pos)
    if (pos >= 2) return cam
    const c = config as unknown as { about?: { pull?: { from?: number; reduced?: { from?: number; to?: number } } }; projects?: { leave?: { to?: number } } }
    const rFrom = num(c.about?.pull?.reduced?.from, num(c.about?.pull?.from, 1.16))
    const rTo = Math.max(rFrom + 1e-3, num(c.about?.pull?.reduced?.to, rFrom + 0.2))
    const from = Math.max(rFrom, num(c.projects?.leave?.to, rFrom))
    const k = remap(pos, from, from + (rTo - rFrom))
    // the camera's own 4 steps (about-camera.ts → stepped)
    const dissolve = k <= 0 ? 0 : Math.min(4, Math.floor(k * 4) + 1) / 4
    return { ...cam, active: cam.active && pos >= from, dissolve }
  }

  function stepState(frame: Frame, flat: boolean): AboutState {
    const { scroll, pointer } = frame
    const cam = cameraAt(scroll, scroll.pos, flat)
    const cell = cam.cell
    const W = layout.width
    const H = layout.height
    const viewH = viewHeight(layout, scroll)

    // ── the pointer: the sheet sways with its own mass, by whole cells ──
    follower.step(pointer, frame.dt, config.motion, K.response.mass)
    const amp = K.response.depth * config.world.parallax
    // ── the words turn toward the pointer like the title: the end on the pointer's side recedes
    // (pointer right → yaw −, the right end farther; pointer down → pitch +, the bottom farther) ──
    // Faded by the zoom: none above turn.fade.none (the pull's close-ups: a degree there is half a
    // screen; the first frame of the pull stays the bare void), all of it below fade.full.
    const tk = K.turn
    turner.step(pointer, frame.dt, config.motion, tk.mass)
    const fade = scroll.reduced
      ? 0
      : 1 - smooth(remap(Math.log(Math.max(1e-3, cam.zoom)), Math.log(Math.min(tk.fadeFull, tk.fadeNone - 1e-3)), Math.log(tk.fadeNone)))
    const yaw = fade > 0 ? stepTo(-fade * tk.tiltY * easeEdge(turner.x, tk.edgeKnee), sway.yaw, TURN_STEP) : 0
    const pitch = fade > 0 ? stepTo(fade * tk.tiltX * easeEdge(turner.y, tk.edgeKnee), sway.pitch, TURN_STEP) : 0
    sway = { x: Math.round((-follower.x * amp) / cell) * cell, y: Math.round((-follower.y * amp) / cell) * cell, yaw, pitch }

    // a wake after a sleep (sky.ts): whatever the clocks held belongs to another place in the film
    const now = performance.now()
    if (lastStep >= 0 && now - lastStep > 400) core.resetPhotos()
    lastStep = now

    // ── letters: texel locked to the sheet, power-of-two LOD with hysteresis ──
    // the sheet hidden (before the pull, or the reduced-motion dissolve): no history — the first
    // visible step starts on the pure level of its zoom, never fading in from a hidden frame's level
    if (!cam.active) lodStarted = false
    const z = cam.zoom
    const max = K.raster.lodMax
    const before = lod
    if (!lodStarted || scroll.pinned) lod = Math.max(0, Math.ceil(Math.log2(z / max) - 1e-9))
    else {
      while (z / 2 ** lod > max) lod++
      while (lod > 0 && z / 2 ** (lod - 1) <= max * K.raster.lodBack) lod--
    }
    // a switch dissolves in over raster.lod.fade, cell by cell (Bayer); pinned, the first frame,
    // reduced motion or fade 0 — at once (a pinned frame depends on pos only)
    if (!lodStarted || scroll.pinned || scroll.reduced || K.raster.lodFade <= 0) {
      lodPrev = lod
      lodFade = 1
    } else if (lod !== before) {
      lodPrev = before
      lodFade = 0
    } else lodFade = Math.min(1, lodFade + frame.dt / K.raster.lodFade)
    lodStarted = true
    const lodMix = lodFade >= 1 ? 1 : stipple(lodFade, 4)
    const lodRatio = lodMix >= 1 ? 1 : 2 ** (lod - lodPrev)
    const U = aboutUnit(config, layout, viewH)
    const texel = (K.raster.block * cell) / U / 2 ** lod
    const texelPx = texel * cam.scale
    const tx = K.letters.texture
    const ramp = 1 - smooth(remap(Math.log(z), Math.log(Math.min(tx.full, tx.none - 1e-3)), Math.log(tx.none)))
    const calm = K.letters.home + (1 - K.letters.home) * smooth(remap(Math.log(Math.max(1, z)), 0, Math.log(Math.max(1.01, tx.full))))

    // ── edge crawl: ticks only while the page or the pointer moves ──
    const signed = num((scroll as unknown as { speed?: number }).speed, scroll.velocity)
    const speed = Math.abs(signed)
    const moving = speed > 0.02 || pointer.energy > 0.05
    if (!scroll.reduced && K.raster.crawlFps > 0 && moving) crawl = Math.floor(frame.time * K.raster.crawlFps) % 9973

    // ── aberration reach (culling margin) ──
    const ab = aberrationAt(config, layout, pointer.energy)
    const reach = ab.on ? ab.reach * K.aberration : 0

    // ── holes ──
    const holes: HoleInst[] = []
    if (cam.active && glyphs) {
      const ek = entryHole()
      const eg = ek && glyphs.glyphs.get(glyphId(ek))
      const refUpp = ek && eg ? unitsPerPx(ek, eg) : 0
      for (const k of K.holes) {
        if (holes.length >= MAX_HOLES) break
        const g = glyphs.glyphs.get(glyphId(k))
        if (!g) continue
        const placed = placeHole(config, cam, sway, k, g, reach + cell, K.turn)
        if (!onStage(placed.box, W, H)) continue
        const upp = unitsPerPx(k, g)
        const tex = refUpp > 0 ? Math.min(8, Math.max(0.25, upp / refUpp)) : 1
        holes.push({ k, g, placed, upp, tex, seed: seedOf(k.key) })
      }
    }

    // ── photos ──
    const photos: PhotoInst[] = []
    const rp = K.reveal.photos
    const re = K.reveal.enter
    const steps = rp.steps
    const pinned = scroll.pinned
    // the photos' pop-in and finish without memory: pinned, or the first step after a reset
    const pure = pinned || fresh
    fresh = false
    const homeOrder = K.photos.items.filter((p) => p.topic === 'home')
    pops.length = K.photos.items.length
    const lods = lodSteps(POP_START)
    // the finish on rest: the scroll has stayed still REST_AFTER s (never while pinned); turning back
    // hands every photo to the scroll-driven reveal again
    still = speed < REST_SPEED ? still + frame.dt : 0
    const resting = !pinned && still >= REST_AFTER
    const back = signed < -REST_SPEED
    if (cam.active) {
      for (const k of K.photos.items) {
        const slot = core.photos.get(k.index)
        const pop = (pops[k.index] ??= { load: 0, on: false, held: false, hold: 0 })
        if (!slot) {
          pop.load = pop.hold = 0
          pop.on = pop.held = false
          continue
        }
        const placed = placePhoto(config, cam, sway, k, debrisReach(K, k) * k.width, reach + cell)
        const visible = onStage(placed.box, W, H)
        // scroll reveal: home windows by pos (staggered), the rest as they come up into the frame
        let reveal: number
        let share = 0
        let exiting = false
        if (k.topic === 'home') {
          const i = homeOrder.indexOf(k)
          const a = rp.from + i * rp.stagger
          const b = rp.to + i * rp.stagger
          reveal = scroll.reduced ? (scroll.pos >= a ? 1 : 0) : stipple(remap(scroll.pos, a, b), steps)
        } else {
          const [, sy] = toScreen(cam, ...centreOf(config, cam, k.x, k.y, k.depth, k.topic))
          const cy = sy + sway.y * (1 + k.depth)
          const f = remap(cy / viewH, re.from, re.to)
          reveal = scroll.reduced ? (f >= 0.5 ? 1 : 0) : stipple(f, steps)
          share = visible ? shareOnStage(placed.box, W, H) : 0
          // in the upper half of the frame: on its way out (the tour runs down the sheet) — it entered
          // sharp and stays sharp until it is gone, never un-popping into a grey mosaic at the edge
          exiting = visible && cy < viewH * 0.5
        }
        // the scroll stopped on it once it had begun: it finishes (stipple + LOD) on the load clock and
        // stays finished while the page moves on — until it leaves the frame or the scroll turns back
        if (pure || !visible || back) pop.held = false
        else if (resting && reveal > 0) pop.held = true
        if (pure || !visible) pop.hold = 0
        else if (scroll.reduced) pop.hold = pop.held ? 1 : 0
        else pop.hold = clamp01(pop.held ? Math.max(pop.hold, reveal) + frame.dt / LOAD_TIME : pop.hold - frame.dt / LOAD_TIME)
        reveal = Math.max(reveal, stipple(pop.hold, steps))
        let lodLevel = 0
        if (k.topic !== 'home') {
          // the timed pop-in once reveal.enter.lod.at of it is in the frame or the finish on rest; once
          // sharp it stays sharp while any of it is on screen (it un-plays only off screen) — and one
          // on its way out is sharp anyway; pinned — a pure function of pos, no memory
          const want = share >= re.lodAt || exiting
          if (pure) pop.on = want
          else pop.on = want || pop.held || (!scroll.reduced && pop.on && visible)
          if (pure || scroll.reduced) pop.load = pop.on ? 1 : 0
          else pop.load = clamp01(pop.load + ((pop.on ? 1 : -1) * frame.dt) / (lods.length * re.lodStep))
          // in the upper half it is sharp at once (scrolling back up, a photo comes in from the top: it
          // was seen already — no loading mosaic at the top edge)
          if (exiting) pop.load = 1
          lodLevel = lods[Math.min(lods.length - 1, Math.floor(pop.load * lods.length + 1e-6))]
        }
        // a late file stipples in on its own clock, it does not pop
        const load = pinned || scroll.reduced ? 1 : stipple(clamp01((now - slot.at) / 1000 / LOAD_TIME), steps)
        reveal = Math.min(reveal, load)
        if (!visible || reveal <= 0 || photos.length >= MAX_PHOTOS) continue
        photos.push({ k, placed, slot, reveal, lod: lodLevel, seed: seedOf(k.key) })
      }
    }

    // ── crosses ──
    const crosses: CrossInst[] = []
    if (cam.active) {
      const ck = K.crosses
      const tick = Math.floor(frame.time * TWINKLE_FPS)
      let homeIndex = 0
      for (const c of K.crosses.items) {
        const [x, y] = centreOf(config, cam, c.x, c.y, 0, c.topic)
        const [sx0, sy0] = toScreen(cam, x, y)
        const sx = sx0 + sway.x
        const sy = sy0 + sway.y
        let reveal: number
        if (c.topic === 'home') {
          const i = homeIndex++
          const a = rp.from + i * rp.stagger * 0.5
          const b = rp.to + i * rp.stagger * 0.5
          reveal = scroll.reduced ? (scroll.pos >= a ? 1 : 0) : stipple(remap(scroll.pos, a, b), steps)
        } else {
          const f = remap(sy / viewH, re.from, re.to)
          reveal = scroll.reduced ? (f >= 0.5 ? 1 : 0) : stipple(f, steps)
        }
        const r = (ck.size + 1) * cell
        if (reveal <= 0 || sx < -r || sy < -r || sx > W + r || sy > H + r || crosses.length >= MAX_CROSSES) continue
        const dim = !scroll.reduced && ck.twinkle > 0 && hash01(seedOf(c.key), tick) < ck.twinkle * 0.08
        crosses.push({ cx: Math.floor(sx / cell), cy: Math.floor(sy / cell), reveal, alpha: ck.opacity * (dim ? 0.25 : 1) })
      }
    }

    // ── specks keep away from the entry point (the first frames inside the A stay clean) ──
    // (the camera's entry: through the word's turn in depth — the pointer's part is 0 that close up)
    const e = aboutEntry(config)
    const [ex, ey] = toScreen(cam, e.x, e.y)
    const keep: [number, number, number] = [ex + sway.x, ey + sway.y, 2 * e.r * cam.scale]

    return { K, cam, sway, lod, texel, texelPx, lodRatio, lodMix, ramp, calm, crawl, holes, photos, crosses, reach, keep }
  }

  void ensureGlyphs()
  core.photos.sync(K)
  return core
}

