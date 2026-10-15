import '@fontsource/kalam/300.css'
import '@fontsource/roboto-mono/400.css'
import './about-text.css'

import { aboutCameraAt, aboutUnit, focalPx, project3, tourKeys, unproject, viewHeight, type AboutCamera } from '../../core/about-camera'
import { apply4, NO_TURN, NO_TURNS, restTurns, turn4, turnKnobs, type AboutTurns, type M4, type Turn } from '../../core/about-pose'
import { aboutFrame } from '../../core/about-sheet'
import { clamp, clamp01 } from '../../core/ease'
import { num } from '../../core/loose'
import { navDock } from '../../core/nav-dock'
import { rectToQuad, type Pt } from '../../core/quad'
import { scrollControl } from '../../core/scroll'
import type { Frame, Layer, LayerFactory, Layout, ResolvedConfig } from '../../core/types'
import { clashesAt, drawOutline, overlapsAt, shapesIn, thingsAt, type Box } from './check'
import { quietFocus, releaseFocus } from './focus'
import { handLines, strSeed } from './hand'
import { dockKnobs, faceOf, fitOf, readKnobs, sizeOf, type NoteSpec, type TextKnobs } from './knobs'

/**
 * ABOUT — the notes of the one world: black ink on the warm void (DOM over the about canvas; numbers:
 * sky.config.ts → about.text / about.notes).
 *
 * Every note is a point of the 3D world — its corner (x, y) at height z above the sheet plane — and is
 * projected by the very camera the canvas drew with (core/about-sheet.ts → aboutFrame, written earlier
 * in the same frame — the canvas is declared before this layer; "this frame's" = the same Frame
 * object, hero.ts hands one to every layer of a tick), so text, letters and cards move as one through
 * the pull and the tour; when the canvas did not draw this frame (asleep, not mounted) the camera is
 * computed here (core/about-camera.ts is a pure function of pos). The pointer never moves the camera:
 * like every card and letter, each note TURNS toward it about its own centre — a flat sheet of paper
 * tilted in 3D (its own spring, published by the canvas: aboutFrame.pointer.notes; × about.turn.notes.share
 * for its kind — subtler than the cards, the type stays legible), bent onto the screen by one matrix3d,
 * like the projects texts on the slab. With no turn (the pointer in the middle, the pull's close-ups,
 * reduced motion) it is the plain 2D transform below, crisp on whole device pixels.
 *
 *   (x, y, z) ──project3(camera)──▶ screen point + px per unit at that height
 *     →  translate · rotate(roll × text.roll + rotation) · scale
 *     →  turned: its corners lifted to its plane, turned about its centre, projected → matrix3d
 *        (also while the camera itself is still turning on the pull's last stretch: the flat layout is
 *        then a straight-down twin's, and the real camera sees that sheet at its slant — flatOf)
 *
 * Size: px written for text.unit px per sheet unit, × clamp(U / unit, min, max), × the camera's scale
 * at the note's height (zoom × h / (h − z): a note floating above the sheet grows a little faster).
 * Crispness: each note is laid out at the scale it rests at (its topic's zoom at its height; × 1.5 on a 1× screen,
 * where a scaled-down raster beats a magnified or rotated 1× one) and the transform shrinks it back;
 * the translation lands on whole device pixels; a transform is written only when it changes. On the
 * 1× screen a resting note is shown at 2/3 of its layout, so its rows (line heights, the gap above
 * the dash) are whole multiples of 3 layout px = 2 device px; the dash itself — 1 device px, which no
 * row of a ⅔-scaled raster can hold — is drawn outside the note, at screen size (`.at-rule`), and the
 * note keeps only an invisible stand-in of it for the layout.
 *
 * Always live (in the accessibility tree whatever the scroll position): one screen-reader copy of
 * all notes, the photos' descriptions and the finale's words (THAT'S ALL FOR NOW — about.words), in
 * reading order (home, 01…05, the end), under an sr-only "About" heading; the visual notes are
 * aria-hidden and never focusable. The layer hides its own notes (opacity — never visibility, which
 * would drop the copy) until the world has drawn once and the pull-back has begun: no ink floats over
 * the projects screen or a void with nothing in it.
 *
 * Motion is the renderer's own: the lines step in as stepped clips, on a timer (the page may stop
 * anywhere — a half-typed line must never hang there):
 *   · home notes — once the scroll passes about.reveal.notes.from (back below .back while the page
 *     moves; once it rests, `from` alone decides);
 *   · tour notes — once a note's top has risen above about.reveal.enter.at of the visible height
 *     (and its bottom is as far from the top edge); they un-type once they have left that band again
 *     by more than BAND_SLACK, over either edge; once the page rests (REST_SPEED) the band alone
 *     decides — scrolling down or back up, the same place shows the same notes. The band sees the
 *     note without its turn toward the pointer: the mouse never types or un-types a note;
 *   · a pinned ?scroll= (screenshots) and reduced motion: no film, the notes are simply there.
 * Notes with a line under the docked nav's labels (top right) fade to about.text.dock: the nav inverts
 * what is under it (dark labels over the void), and dark ink under dark labels reads as mush. Tested line by line against the labels' part of the column (not
 * its dots and line, not the line's lead and tail): a paragraph clear of the labels does not ghost
 * because its box's corner grazes the column. The column is the one the nav drew this frame
 * (core/nav-dock.ts — the overlay updates before this layer); before it has docked, an estimate from
 * overlay.nav.dock.
 */

const DEG = Math.PI / 180
/** Faces slower than this do not hold the notes back (they come in with whatever face is there). */
const FONT_TIMEOUT = 1500
/**
 * On a screen below 1.5 dppx the notes are laid out this many times bigger and the transform shrinks
 * them back (the browser rasters a transformed layer at its layout resolution: a magnified or rotated
 * 1× raster smudges). Technical, not a knob of the pult — the same number as the projects texts'.
 */
const SUPERSAMPLE = 1.5
/**
 * A resting note on a 1× screen is shown at 1 / SUPERSAMPLE = 2/3 of its layout: LATTICE layout px =
 * 2 device px exactly, so its line heights and the gap above the dash are whole multiples of it.
 */
const LATTICE = 3
/** A note this far outside the screen (share of its larger side) is not moved at all: hidden, no writes. */
const FAR = 0.25
/** Clear space around the docked nav's labels that still counts as "under them", px. */
const DOCK_PAD = 10
/**
 * A typed tour note un-types once it has left the band it typed in (about.reveal.enter.at from either
 * edge) by more than this, px — a hair of hysteresis against a scroll trembling on the line while it
 * moves; at rest there is none (below).
 */
const BAND_SLACK = 6
/**
 * The page counts as at rest once the picture has moved slower than this (screens/s) for REST_AFTER s
 * (never while pinned — that is a pure function anyway); then a tour note is shown exactly when it is
 * inside its band, whichever way the page came. The same numbers as the projects texts' and the about
 * photos' rest rules.
 */
const REST_SPEED = 0.01
const REST_AFTER = 0.25
/** #about pressed while the page is elsewhere: the heading takes the focus once the notes can show — if within this many s. */
const FOCUS_WAIT = 6
const HEADING_ID = 'at-heading'
/** This screen's scroll stops (index.html): an address naming one focuses the heading. */
const HASHES = ['#about', '#about-end']
/** A fully clipped line. */
const CLIPPED = 'inset(0 100% 0 0)'
/**
 * The shortest typing clock, ms: a one-line note with about.text.reveal.duration 0 (a cut) still has
 * a clock that can be > 0 — "shown" is clock > 0.
 */
const MIN_TOTAL = 1

/** A turned note: its own px → screen (CSS px). */
type NoteMap = (lx: number, ly: number) => Pt

/**
 * A note turned less than this (degrees, both ways, after its share) keeps the flat 2D placement: the
 * pointer near the middle of the screen (or its idle float) leaves the type crisp on whole device px —
 * a 0.5° turn moves a note's edge by under a pixel. Technical, not a knob of the pult.
 */
const FLAT_TURN = 0.5

/**
 * A note's turn toward the pointer as a map of its own px onto the screen: the flat placement (corner
 * x0 / y0, scale k, angle th — laid out by `lift`, a camera looking straight down) lifted onto its plane
 * (height z: unproject), turned about its centre by yaw / pitch (core/about-pose.ts → turn4: the words'
 * and cards' signs, in sheet axes) and projected back by `cam` — the camera drawn with (turned a little
 * on the pull's last stretch: then the sheet itself is seen at a slant). Exact for a plane (four corners
 * → rectToQuad). null — its plane is not below the camera.
 */
function tiltMap(lift: AboutCamera, cam: AboutCamera, x0: number, y0: number, k: number, th: number, z: number, cx: number, cy: number, yaw: number, pitch: number): NoteMap | null {
  const cs = Math.cos(th) * k
  const sn = Math.sin(th) * k
  const flatX = (lx: number, ly: number) => x0 + cs * lx - sn * ly
  const flatY = (lx: number, ly: number) => y0 + sn * lx + cs * ly
  const C = unproject(lift, flatX(cx, cy), flatY(cx, cy), z)
  if (!C) return null
  const R: M4 = turn4(yaw, pitch)
  return (lx, ly) => {
    const sx = flatX(lx, ly)
    const sy = flatY(lx, ly)
    const P = unproject(lift, sx, sy, z)
    if (!P) return { x: sx, y: sy }
    const d = apply4(R, P[0] - C[0], P[1] - C[1], 0)
    const q = project3(cam, C[0] + d[0], C[1] + d[1], z + d[2])
    return q ? { x: q[0], y: q[1] } : { x: sx, y: sy }
  }
}

/**
 * The camera a note is laid out flat with: this one, or — while it is still turned on the pull's last
 * stretch (the notes type in from about.reveal.notes.from, ≈ 0.6° before the landing) — a camera looking
 * straight down over the same frame centre from the same distance, with the same roll; the real camera
 * then sees that flat sheet at its slant (tiltMap). The same object once it has landed.
 */
function flatOf(cam: AboutCamera): AboutCamera {
  if (!(cam.tilt > 1e-9)) return cam
  const c = Math.cos(cam.roll)
  const s = Math.sin(cam.roll)
  return { ...cam, eye: [cam.cx, cam.cy, cam.h], right: [c, -s, 0], down: [s, c, 0], fwd: [0, 0, -1], tilt: 0 }
}

const boundsOf = (pts: Pt[]): Box => [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y))]

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

/** Progress of something that starts at `start` and takes `dur` (dur 0 — a cut at `start`). */
const span = (now: number, start: number, dur: number) => (dur > 0 ? clamp01((now - start) / dur) : now >= start ? 1 : 0)

const round1 = (n: number) => Math.round(n * 10) / 10

/** A box nowhere on screen (a note behind the camera). */
const OFF: Box = [-1e6, -1e6, -1e6, -1e6]

interface Line {
  /** what the typing clips (the dash: its screen-size rule, outside the note) */
  el: HTMLElement
  /** what holds its place in the note's layout (the dash: the invisible stand-in; else el itself) */
  box: HTMLElement
  css: string
  /** hand lines overhang their box (jitter): the clip keeps a margin above / below / left */
  loose: boolean
  /** its box in the note's own px (offsetLeft / Top / Width / Height) — for the composition check */
  rect: [number, number, number, number]
}

/** The dash under a note, drawn at screen size beside the note (not inside its scaled raster). */
interface Rule {
  el: HTMLElement
  /** its size on screen when the note rests at its topic's zoom, CSS px (whole device px) */
  w: number
  h: number
  css: string
  op: string
}

interface Note {
  spec: NoteSpec
  el: HTMLElement
  lines: Line[]
  /** belongs to the first tour key (typed by pos, not by entering the frame) */
  home: boolean
  /** the laid-out box, the note's own px (offsetWidth / offsetHeight) */
  w: number
  h: number
  /** layout scale: the note is laid out L× its size at zoom 1 (its rest scale × the supersample) */
  L: number
  /** the scale it rests at: its topic's zoom × h / (h − z) at that zoom (a note above the sheet is a little larger) */
  zr: number
  rule: Rule | null
  /** its font px at zoom 1 when it was laid out (text.unit · fit · floor: knobs.ts → sizeOf) */
  base: number
  /** ms on its own typing clock */
  clock: number
  wanted: boolean
  /** this frame: its box on screen (CSS px), on screen at all, far off it (or behind the camera), under the dock */
  box: Box
  /** the same box without its turn toward the pointer — what the typing band tests (a mouse never types a note) */
  rest: Box
  /** this frame: note px → screen of the turned note (null — not turned: the flat transform) */
  map: NoteMap | null
  on: boolean
  far: boolean
  inDock: boolean
  /** shown size this frame: transform scale, font px on screen; the top-left corner and the angle (rad) */
  k: number
  x0: number
  y0: number
  th: number
  css: string
  op: string
  /** the opacity fades (class is-fade): only while the last change was the dock dimming of a shown note */
  fade: boolean
}

async function fontsReady(timeoutMs: number) {
  if (!document.fonts?.load) return
  const loads = Promise.all([
    document.fonts.load('300 24px "Kalam"', 'DIFFERENT GAMES, SAME BRAIN'),
    document.fonts.load('400 16px "Roboto Mono"', 'I BUILD WHATEVER 01 / 05'),
  ]).catch(() => undefined)
  await Promise.race([loads, new Promise((r) => setTimeout(r, timeoutMs))])
}

/** "01 / 05" → "1 of 5" for the screen-reader copy (a bare "/ 05" says nothing there: null). */
function countWords(text: string) {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text)
  return m ? `${Number(m[1])} of ${Number(m[2])}` : null
}

export const createAboutTextLayer: LayerFactory = (mount, ctx) => {
  // ── DOM ──
  const root = h('section', 'at')
  root.setAttribute('aria-labelledby', HEADING_ID)
  const heading = h('h2', 'sr-only')
  heading.id = HEADING_ID
  heading.tabIndex = -1
  heading.textContent = 'About'
  const copy = h('div', 'sr-only')
  const stage = h('div', 'at-stage')
  stage.setAttribute('aria-hidden', 'true')
  root.append(heading, copy, stage)
  mount.appendChild(root)

  // ── state ──
  let layout: Layout = ctx.layout
  let config: ResolvedConfig = ctx.config
  let K: TextKnobs = readKnobs(config)
  let notes: Note[] = []
  let contentKey = ''
  let fontsIn = false
  let measured = false
  let ss = 1
  /** the home key's name (the first tour key) */
  let homeName = 'home'
  let homeWanted = false
  /** this frame: the notes may show at all (fonts, the world drawn, past pull.from) */
  let can = false
  let lastCam: AboutCamera | null = null
  let lastPtr: AboutTurns = NO_TURNS
  /** stats({ outline }): the check's picture of the frame over the page (debug) */
  let outline: HTMLCanvasElement | null = null
  let camSource: 'published' | 'computed' = 'computed'
  let dock: Box | null = null
  let focusWanted = 0
  /** s the picture has stood still (REST_SPEED) */
  let still = 0

  // ── content ──

  /** The visual notes and the screen-reader copy, rebuilt only when the content changes (not on a resize). */
  function build() {
    const topics = tourKeys(config).map((k) => k.name)
    homeName = topics[0] ?? 'home'
    const key = JSON.stringify([K.notes.map((n) => [n.name, n.kind, n.lines, n.align, n.dash, n.topic, n.sr]), K.photos, K.words, topics])
    if (key === contentKey) {
      // same content: the notes stay, but their places, heights, sizes and angles are this config's
      // (the tuner moving a note must move it without a rebuild)
      const spec = new Map(K.notes.map((s) => [s.name, s]))
      for (const n of notes) n.spec = spec.get(n.spec.name) ?? n.spec
      return
    }
    contentKey = key
    const old = new Map(notes.map((n) => [n.spec.name, n]))
    notes = K.notes.map((spec) => {
      const el = h('div', `at-note at-note--${spec.kind}${spec.align === 'right' ? ' at-note--right' : ''}`)
      const els =
        spec.kind === 'hand'
          ? handLines(spec.lines, strSeed(`${spec.name}|${spec.lines.join('\n')}`))
          : spec.lines.map((t) => {
              const s = h('span', 'at-line')
              s.textContent = t || ' '
              return s
            })
      const lines: Line[] = els.map((e) => ({ el: e, box: e, css: '', loose: spec.kind === 'hand', rect: [0, 0, 0, 0] }))
      let rule: Rule | null = null
      if (spec.dash) {
        // the note keeps a hidden stand-in (its place in the layout); the visible dash is a rule at screen size
        const stand = h('i', 'at-dash')
        els.push(stand)
        rule = { el: h('i', 'at-rule'), w: 1, h: 1, css: '', op: '' }
        lines.push({ el: rule.el, box: stand, css: '', loose: false, rect: [0, 0, 0, 0] })
      }
      el.append(...els)
      const was = old.get(spec.name)
      return {
        spec,
        el,
        lines,
        home: spec.topic === homeName,
        w: 0,
        h: 0,
        L: 1,
        zr: 1,
        rule,
        base: 1,
        // a rebuilt note (tuner) keeps where its typing was, so it does not flash
        clock: was?.clock ?? 0,
        wanted: was?.wanted ?? false,
        box: [0, 0, 0, 0] as Box,
        rest: [0, 0, 0, 0] as Box,
        map: null,
        on: false,
        far: true,
        inDock: false,
        k: 1,
        x0: 0,
        y0: 0,
        th: 0,
        css: '',
        op: '',
        fade: false,
      }
    })
    stage.replaceChildren(...notes.map((n) => n.el), ...notes.flatMap((n) => (n.rule ? [n.rule.el] : [])))
    for (const n of notes) {
      for (const line of n.lines) setClip(line, n.clock > 0 ? 1 : 0)
    }
    measured = false

    // the copy for assistive tech: per topic in tour order — its counter, the finale's words (the
    // words of the last key: THAT'S ALL FOR NOW lives only in the canvas), its notes, its photos
    const endName = topics[topics.length - 1]
    const order = [...topics]
    for (const t of [...K.notes.map((n) => n.topic), ...K.photos.map((p) => p.topic)]) if (!order.includes(t)) order.push(t)
    const out: HTMLElement[] = []
    for (const topic of order) {
      const mine = K.notes.filter((n) => n.topic === topic)
      const said = topic === endName && topic !== homeName ? K.words.filter((w) => w.topic === topic).map((w) => w.text).join(' ') : ''
      for (const n of mine.filter((n) => n.kind === 'count')) {
        const words = countWords(n.lines.join(' '))
        if (!words) continue
        const p = h('p')
        p.textContent = words
        out.push(p)
      }
      if (said) {
        const p = h('p')
        p.textContent = said
        out.push(p)
      }
      for (const n of mine.filter((n) => n.kind !== 'count')) {
        if (n.kind === 'list') {
          const ul = h('ul')
          for (const line of n.lines) {
            if (!line.trim()) continue
            const li = h('li')
            li.textContent = line.trim()
            ul.append(li)
          }
          out.push(ul)
        } else {
          // the lines of one sentence, joined; a note whose lines are separate items (the signature)
          // says how it reads (about.notes.*.sr)
          const p = h('p')
          p.textContent = n.sr || n.lines.map((l) => l.trim()).filter(Boolean).join(' ')
          out.push(p)
        }
      }
      for (const ph of K.photos.filter((p) => p.topic === topic)) {
        const img = h('div')
        img.setAttribute('role', 'img')
        img.setAttribute('aria-label', ph.alt)
        out.push(img)
      }
    }
    copy.replaceChildren(...out)
  }

  /** Config → sizes on every note (each at its own layout scale), then measure. */
  function place() {
    K = readKnobs(config)
    build()
    const keys = tourKeys(config)
    const zoomOf = new Map(keys.map((k) => [k.name, k.zoom]))
    const dpr = window.devicePixelRatio || 1
    ss = dpr < 1.5 ? SUPERSAMPLE : 1
    const set = (name: string, value: string | number) => root.style.setProperty(`--at-${name}`, String(value))
    set('ink', K.ink)
    // version 1's pen at jitter 1 (its own jitter 1.3 × lineTilt 1.8°, lineShift 9 px of a 33.6 px
    // hand = 0.27 em, glyphTilt 3.2°, glyphLift 0.045 em, glyphScale 0.04, pressure 0.18)
    const j = K.hand.jitter * 1.3
    set('j-lt', `${(1.8 * j).toFixed(3)}deg`)
    set('j-lx', `${(0.27 * j).toFixed(4)}em`)
    set('j-ly', `${(0.27 * 0.35 * j).toFixed(4)}em`)
    set('j-gt', `${(3.2 * j).toFixed(3)}deg`)
    set('j-gy', `${(0.045 * j).toFixed(4)}em`)
    set('j-gx', `${(0.0225 * j).toFixed(4)}em`)
    set('j-gs', (0.04 * j).toFixed(4))
    set('pressure', (0.18 * Math.min(1, K.hand.jitter)).toFixed(3))

    const sc = scrollControl.current?.state
    const viewH = sc ? viewHeight(layout, sc) : layout.height
    const U = aboutUnit(config, layout, viewH)
    const fit = fitOf(K, U)
    // the camera's height at zoom 1 (core/about-camera.ts: h = F / zoom)
    const F = focalPx(config, viewH) / U
    // rows of the note's own raster that land on device rows when it rests (1 / ss of its layout):
    // whole px at ss 1, whole LATTICE px (= 2 device px) at ss 1.5
    const q = ss > 1 ? LATTICE : 1
    const row = (v: number, least: number) => Math.max(least, q * Math.round(v / q))
    const dev = (v: number) => Math.max(1, Math.round(v * dpr)) / dpr
    for (const n of notes) {
      const f = faceOf(K, n.spec.kind)
      // at rest on its topic the camera is F / zoom above the sheet: a note at height z shows h / (h − z) larger
      const zt = zoomOf.get(n.spec.topic) ?? 1
      const hr = F / zt
      n.zr = zt * (hr - n.spec.z > 0.1 * hr ? hr / (hr - n.spec.z) : 1)
      n.L = n.zr * ss
      n.base = sizeOf(K, n.spec, fit, n.zr)
      const fs = n.base * n.L
      // the dash grows with the type
      const s = fs / f.size
      const st = n.el.style
      st.fontSize = `${+fs.toFixed(2)}px`
      st.lineHeight = `${row(fs * f.leading, q)}px`
      st.letterSpacing = `${f.tracking}em`
      st.setProperty('--at-tr', String(f.tracking))
      if (n.rule) {
        // the rule at rest: dash.length × the type's scale long, dash.width × the zoom thick (≥ 1 device px)
        const len = Math.max(1, Math.round(K.dash.length * s))
        const r = n.rule
        r.w = dev(len / ss)
        r.h = dev(K.dash.width * n.zr)
        r.el.style.width = `${r.w}px`
        r.el.style.height = `${r.h}px`
        r.css = ''
        // its opacity (× dash.opacity) is written again on the next update
        n.op = ''
        st.setProperty('--at-dash-w', `${len}px`)
        st.setProperty('--at-dash-h', `${Math.max(1, Math.round(r.h * ss))}px`)
        st.setProperty('--at-dash-gap', `${row(K.dash.gap * s, 0)}px`)
      }
    }
    measured = false
  }

  function measure() {
    for (const n of notes) {
      n.w = n.el.offsetWidth
      n.h = n.el.offsetHeight
      for (const l of n.lines) l.rect = [l.box.offsetLeft, l.box.offsetTop, l.box.offsetWidth, l.box.offsetHeight]
    }
    measured = true
  }

  // ── the nav's docked column (what the notes fade under) ──

  /** Before the overlay has docked (or without it): the column estimated from overlay.nav.dock (top right). */
  function estimateDock(): Box {
    const d = dockKnobs(config)
    const W = layout.width
    const k = Math.pow(W / (layout.isMobile ? 390 : 1440), num(d.fluid, 0.5))
    const right = num(d.right, 150) * k
    const side = num(d.labelSide, 1) < 0 ? -1 : 1
    const label = 80 * k
    const top = num(d.top, 36) * k
    const tall = (num(d.lead, 47) + 2 * num(d.step, 78) + num(d.dot, 12) + num(d.tail, 57)) * k
    const x = W - right
    return side > 0 ? [x - 10 * k, top, W, top + tall] : [x - label, top, x + 10 * k, top + tall]
  }

  /** The docked nav this frame, as the overlay drew it (core/nav-dock.ts, written earlier in the frame); else the estimate. */
  function dockRect(): Box {
    const d = navDock.current
    dock = d && d.w > 0 && d.h > 0 ? [d.x, d.y, d.x + d.w, d.y + d.h] : estimateDock()
    return dock
  }

  /**
   * The labels' part of the docked column (what a light note under it turns to mush with): the column's
   * box without the dots and the line beside the labels (labelSide) and without the line's lead above
   * the first label and its tail below the last — the same overlay.nav.dock numbers the nav lays
   * itself out with (sky-overlay → layDock). A note crossing only the thin line is still readable.
   */
  function labelsOf([x0, y0, x1, y1]: Box): Box {
    const d = dockKnobs(config)
    const k = Math.pow(layout.width / (layout.isMobile ? 390 : 1440), num(d.fluid, 0.5))
    const dot = Math.max(1, num(d.dot, 12) * k)
    const beside = dot / 2 + num(d.labelGap, 21) * k
    const size = Math.max(1, num(d.size, 12.5) * k)
    const gap = num(d.gap, 2) * k
    const top = y0 + num(d.lead, 47) * k + gap + dot / 2 - size / 2
    const bottom = y1 - num(d.tail, 57) * k - gap - dot / 2 + size / 2
    const [ly0, ly1] = top < bottom ? [top, bottom] : [y0, y1]
    return num(d.labelSide, 1) < 0 ? [x0, ly0, Math.max(x0, x1 - beside), ly1] : [Math.min(x1, x0 + beside), ly0, x1, ly1]
  }

  // ── typing ──

  /** A note's whole typing, ms: its last line starts (lines − 1) × stagger in and takes duration (≥ MIN_TOTAL). */
  const totalOf = (n: Note) => Math.max(MIN_TOTAL, (n.lines.length - 1) * K.reveal.stagger + K.reveal.duration)

  function setClip(line: Line, p: number) {
    const cut = +((1 - p) * 100).toFixed(1)
    // a hand line's glyphs overhang its box (lift, tilt): the clip only ever cuts its right side
    const css = p >= 1 ? '' : p <= 0 ? CLIPPED : line.loose ? `inset(-0.6em ${cut}% -0.6em -0.6em)` : `inset(0 ${cut}% 0 0)`
    if (css === line.css) return
    line.css = css
    line.el.style.clipPath = css
  }

  // ── placement ──

  const snap = (v: number, dpr: number) => Math.round(v * dpr) / dpr

  /**
   * Where a note lands: its top-left corner, scale and angle (rad) of the flat placement, its box on
   * screen, the box without its turn, and — turned toward the pointer — the map of its px onto the screen.
   */
  interface Place {
    x0: number
    y0: number
    k: number
    th: number
    box: Box
    rest: Box
    map: NoteMap | null
  }

  /**
   * Where a note lands for this camera: its corner (x, y) at its height z through project3, the type
   * scaled by the px per unit at that height; then its own turn toward the pointer (`turn` — the
   * published one, AboutTurns.notes; × about.turn.notes.share for its kind) about its centre. Pure
   * (stats() asks about other positions and pointers). null — behind the camera (the pull's first
   * close-ups).
   */
  function geomOf(n: Note, cam: AboutCamera, fit: number, turn: Turn = NO_TURN): Place | null {
    const s = n.spec
    // laid out flat by a camera looking straight down (this one, but for the pull's last stretch)
    const flat0 = flatOf(cam)
    const p = project3(flat0, s.x, s.y, s.z)
    if (!p) return null
    const [ax, ay, ppu] = p
    // font px on screen = its px at zoom 1 (per U px of the sheet) × px per unit at its height / U
    const k = (sizeOf(K, s, fit, n.zr) * ppu) / cam.U / (n.base * n.L)
    // the anchor rides the rolled sheet; the type itself turns only by about.text.roll of the roll
    // (0: level lines while the cards and letters rotate — no stepped baselines)
    const th = cam.roll * K.roll + s.rotation * DEG
    const cs = Math.cos(th)
    const sn = Math.sin(th)
    const w = n.w * k
    const ht = n.h * k
    // the top-left corner (align 'right': the anchor is the top-right one)
    const x0 = s.align === 'right' ? ax - cs * w : ax
    const y0 = s.align === 'right' ? ay - sn * w : ay
    const xs = [x0, x0 + cs * w, x0 + cs * w - sn * ht, x0 - sn * ht]
    const ys = [y0, y0 + sn * w, y0 + sn * w + cs * ht, y0 + cs * ht]
    const flat: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    // its own turn: the share of its kind (the type stays legible), about its centre
    const share = turnKnobs(config).notes.share[s.kind] ?? 0
    const yaw = turn.yaw * share
    const pitch = turn.pitch * share
    // turned toward the pointer, or the camera still turned itself: one matrix3d (else the crisp flat transform)
    const turned = Math.abs(yaw) >= FLAT_TURN || Math.abs(pitch) >= FLAT_TURN
    const map = turned || flat0 !== cam ? tiltMap(flat0, cam, x0, y0, k, th, s.z, n.w / 2, n.h / 2, turned ? yaw : 0, turned ? pitch : 0) : null
    const box = map ? boundsOf([map(0, 0), map(n.w, 0), map(n.w, n.h), map(0, n.h)]) : flat
    return { x0, y0, k, th, box, rest: flat, map }
  }

  /** Where the note lands this frame (kept on it for the typing band, the dock test and the transform). */
  function placeNote(n: Note, cam: AboutCamera, fit: number, turn: Turn) {
    const g = geomOf(n, cam, fit, turn)
    if (!g) {
      n.box = OFF
      n.rest = OFF
      n.map = null
      return null
    }
    n.box = g.box
    n.rest = g.rest
    n.k = g.k
    n.x0 = g.x0
    n.y0 = g.y0
    n.th = g.th
    n.map = g.map
    return g
  }

  const hits = (a: Box, b: Box, pad = 0) => a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad

  /** Each line's box on screen for a placement (the composition check: a line is exactly as wide as its text). */
  function lineBoxes(n: Note, g: Pick<Place, 'x0' | 'y0' | 'k' | 'th' | 'map'> = n): Box[] {
    const m = g.map
    if (m) return n.lines.map(({ rect: [x, y, w, ht] }) => boundsOf([m(x, y), m(x + w, y), m(x + w, y + ht), m(x, y + ht)]))
    const c = Math.cos(g.th) * g.k
    const s = Math.sin(g.th) * g.k
    return n.lines.map(({ rect: [x, y, w, ht] }) => {
      const xs = [x, x + w, x + w, x].map((lx, i) => g.x0 + c * lx - s * (i < 2 ? y : y + ht))
      const ys = [x, x + w, x + w, x].map((lx, i) => g.y0 + s * lx + c * (i < 2 ? y : y + ht))
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Box
    })
  }

  /** Is a tour note's box (without its turn) inside its typing band (about.reveal.enter.at from either edge)? */
  const inBand = (r: Box, W: number, viewH: number) =>
    r[0] < W && r[2] > 0 && r[1] < K.enterAt * viewH && r[3] > (1 - K.enterAt) * viewH

  /**
   * The notes a page resting at `pos` shows (typed): their line boxes for this camera and these turns
   * (each note's own) — the home notes from about.reveal.notes.from, a tour note while its box (without
   * its turn) is in its band; for stats({ pos, pointer }). With the pointer resting (stats({ pointer }):
   * core/about-pose.ts → restTurns — the springs settled on it, on the TURN_STEP grid; the idle float of
   * a still pointer, a few hundredths, left out).
   */
  function restingNotes(cam: AboutCamera, ptr: AboutTurns, pos: number) {
    const W = layout.width
    const fit = fitOf(K, cam.U)
    const out: { name: string; lines: Box[] }[] = []
    if (!(fontsIn && measured && cam.active && pos >= K.pullFrom)) return out
    for (const n of notes) {
      const g = geomOf(n, cam, fit, ptr.notes[n.spec.name])
      if (!g) continue
      const b = g.box
      if (!(b[0] < W && b[2] > 0 && b[1] < cam.viewH && b[3] > 0)) continue
      const typed = n.home ? pos >= K.notesFrom : inBand(g.rest, W, cam.viewH)
      if (typed) out.push({ name: n.spec.name, lines: lineBoxes(n, g) })
    }
    return out
  }

  /**
   * The dash: where its stand-in sits in the note (the note's own px × its scale), on whole device px,
   * scaled by how far the camera is from the topic's zoom — at rest not at all: its rows are the
   * screen's rows (a size off by under a third of a device px is drawn at its exact size).
   */
  function placeRule(n: Note, r: Rule, x: number, y: number, turn: string, dpr: number) {
    const [lx, ly, lw] = n.lines[n.lines.length - 1].rect
    const kr = n.k * ss
    // align 'right': the rule ends where the stand-in ends
    const lu = n.spec.align === 'right' ? lx + lw - r.w * ss : lx
    const m = n.map
    if (m) {
      // turned with its note: its own px rectangle in the note, through the note's map (shifted as the note's corner was)
      const dx = x - n.x0
      const dy = y - n.y0
      const q = [m(lu, ly), m(lu + r.w * ss, ly), m(lu + r.w * ss, ly + r.h * ss), m(lu, ly + r.h * ss)].map((p) => ({ x: p.x + dx, y: p.y + dy }))
      const css = rectToQuad(0, 0, r.w, r.h, q[0], q[1], q[2], q[3])
      if (css !== r.css) {
        r.css = css
        r.el.style.transform = css
      }
      return
    }
    const ux = lu * n.k
    const uy = ly * n.k
    const c = Math.cos(n.th)
    const sn = Math.sin(n.th)
    const rx = snap(x + c * ux - sn * uy, dpr)
    const ry = snap(y + sn * ux + c * uy, dpr)
    let css = `translate(${+rx.toFixed(3)}px,${+ry.toFixed(3)}px)${turn}`
    if (Math.abs(kr - 1) * Math.max(r.w, r.h) * dpr > 0.3) css += ` scale(${+kr.toFixed(5)})`
    if (css !== r.css) {
      r.css = css
      r.el.style.transform = css
    }
  }

  /** stats() options: see there. */
  interface StatsOpts {
    box?: Box
    pos?: number
    pointer?: [number, number]
    outline?: boolean
  }

  const layer: Layer & { stats(opts?: StatsOpts): unknown } = {
    /**
     * Debug (__hero.layers.get('aboutText').stats()): whether the notes may show (fonts, the world
     * drawn, past pull.from), the camera used (published by the canvas this frame or computed here),
     * the dock rectangle and its labels' part (`labels` — what a note's lines fade under), and per
     * note — on screen, typed (0…1), opacity, font px on screen, layout scale, box on screen. The
     * composition check (check.ts — the world's own 3D geometry, rasterised): `overlaps` — what each
     * shown note comes closer than 16 px to, line by line (word: / card: / shadow:, note:, dock,
     * edge); `things` — the words, cards and shadows on screen (covered box, height z); `clashes` —
     * pairs of words / cards on screen closer than 16 px ('card:leafT × word:about': gap px);
     * `underDock` — the things with any of their shape under the dock rectangle (+ DOCK_PAD).
     * Options:
     *   box — adds `inBox`: the same as underDock for any screen box (CSS px x0, y0, x1, y1);
     *   pos — the same check for the page resting at another scroll position (the camera of that pos;
     *     the notes it would show typed: home ones from reveal.notes.from, tour ones in their band);
     *   pointer — [x, y] (−1…1, y down): with the pointer resting there (every element's turn the
     *     canvas would settle on: core/about-pose.ts → restTurns), e.g. [-1, -1] for the top-left corner;
     *   outline — true: draws the check's picture over the page (debug canvas), false: removes it.
     */
    stats(opts?: StatsOpts) {
      const sc = scrollControl.current?.state
      const synthetic = !!sc && (opts?.pos !== undefined || !!opts?.pointer)
      const pos = opts?.pos ?? sc?.pos ?? 0
      let cam = lastCam
      let ptr = lastPtr
      if (synthetic && sc) {
        cam = opts?.pos !== undefined ? aboutCameraAt(config, layout, sc, opts.pos) : lastCam
        if (cam && opts?.pointer) ptr = restTurns(config, cam, opts.pointer[0], opts.pointer[1])
      }
      const W = layout.width
      const fit = cam ? fitOf(K, cam.U) : 1
      const dk = dock ?? estimateDock()
      const view = { W, H: cam?.viewH ?? layout.height, stageH: layout.height, dock: dk }
      // the notes the check sees: shown this frame — or where they would rest at that pos / pointer
      const shown = !cam
        ? []
        : synthetic
          ? restingNotes(cam, ptr, pos)
          : notes.filter((n) => n.on && n.clock > 0 && n.op !== '0').map((n) => ({ name: n.spec.name, lines: lineBoxes(n) }))
      if (opts?.outline === false && outline) {
        outline.remove()
        outline = null
      } else if (opts?.outline && cam) {
        outline ??= document.body.appendChild(document.createElement('canvas'))
        outline.className = 'at-debug'
        drawOutline(config, cam, ptr, shown, view, outline)
      }
      return {
        fonts: fontsIn,
        drawn: aboutFrame.drawn,
        can,
        home: homeWanted,
        pos: +pos.toFixed(4),
        // the notes' own turns (before their kind's share); the words' and cards' are in the about layer's stats
        pointer: Object.fromEntries(Object.entries(ptr.notes).map(([k, t]) => [k, [t.yaw, t.pitch]])),
        camera: cam && {
          source: synthetic ? 'stats' : camSource,
          zoom: +cam.zoom.toFixed(4),
          roll: +(cam.roll / DEG).toFixed(3),
          cx: +cam.cx.toFixed(4),
          cy: +cam.cy.toFixed(4),
          h: +cam.h.toFixed(4),
          U: +cam.U.toFixed(1),
          viewH: cam.viewH,
          key: +cam.key.toFixed(3),
        },
        supersample: ss,
        dock: dk.map(round1),
        // the labels' part of the dock (what a note's lines fade under)
        labels: labelsOf(dk).map(round1),
        visible: shown.map((n) => n.name),
        notes: notes.map((n) => ({
          name: n.spec.name,
          topic: n.spec.topic,
          z: n.spec.z,
          on: n.on,
          far: n.far,
          typed: +(n.clock / totalOf(n)).toFixed(3),
          opacity: n.op,
          inDock: n.inDock,
          px: +(sizeOf(K, n.spec, fit, n.zr) * (cam?.zoom ?? 1)).toFixed(2),
          L: +n.L.toFixed(4),
          k: +n.k.toFixed(4),
          box: n.box.map(round1),
        })),
        overlaps: cam ? overlapsAt(config, cam, ptr, shown, view) : null,
        things: cam ? thingsAt(config, cam, ptr, view) : null,
        clashes: cam ? clashesAt(config, cam, ptr, view) : null,
        underDock: cam ? shapesIn(config, cam, ptr, [dk[0] - DOCK_PAD, dk[1] - DOCK_PAD, dk[2] + DOCK_PAD, dk[3] + DOCK_PAD], view) : null,
        inBox: cam && opts?.box ? shapesIn(config, cam, ptr, opts.box, view) : undefined,
      }
    },
    resize(l, c) {
      layout = l
      config = c
      place()
    },
    update(frame: Frame) {
      const now = performance.now()
      if (frame.config !== config) {
        config = frame.config
        place()
      }
      if (fontsIn && !measured) measure()
      const sc = frame.scroll
      // the canvas updates before this layer and stamps aboutFrame with the Frame it drew (hero.ts hands
      // the same object to every layer of a tick): the same object = this frame's (exact under coarse
      // timers too, unlike comparing timestamps)
      const fresh = !!aboutFrame.camera && aboutFrame.frame === frame
      const cam = fresh ? aboutFrame.camera! : aboutCameraAt(frame.config, frame.layout, sc)
      const ptr: AboutTurns = fresh ? aboutFrame.pointer : NO_TURNS
      camSource = fresh ? 'published' : 'computed'
      lastCam = cam
      lastPtr = ptr

      const could = can
      can = fontsIn && measured && aboutFrame.drawn && cam.active && sc.pos >= K.pullFrom
      // the notes get their own compositor layers only while they may show (none on the hero)
      if (can !== could) root.classList.toggle('is-on', can)
      still = !sc.pinned && Math.abs(sc.speed) < REST_SPEED ? still + frame.dt : 0
      const resting = still >= REST_AFTER
      // home notes: past reveal.notes.from, kept down to .back while the page moves; pinned or at rest
      // `from` alone decides — the same place shows the same notes whichever way the page came
      if (!can) homeWanted = false
      else if (sc.pinned || resting || !homeWanted) homeWanted = sc.pos >= K.notesFrom
      else if (sc.pos < K.notesBack) homeWanted = false

      const W = layout.width
      const H = layout.height
      const viewH = cam.viewH
      const m = FAR * Math.max(W, H)
      const dpr = window.devicePixelRatio || 1
      const fit = fitOf(K, cam.U)
      const dk = can ? dockRect() : null
      // the labels' part of it: what a note's lines are tested against
      const lab = dk && labelsOf(dk)
      const { stagger, duration, out } = K.reveal
      const cut = sc.pinned || sc.reduced || !can
      const steps = sc.reduced ? 1 : K.reveal.steps
      const q = (x: number) => Math.floor(x * steps + 1e-6) / steps
      for (const n of notes) {
        const g = placeNote(n, cam, fit, ptr.notes[n.spec.name] ?? NO_TURN)
        const b = n.box
        const wasFar = n.far
        n.on = !!g && b[0] < W && b[2] > 0 && b[1] < H && b[3] > 0
        // behind the camera counts as far: hidden, not moved
        n.far = !g || !(b[0] < W + m && b[2] > -m && b[1] < H + m && b[3] > -m)
        // under the dock: any of its lines near the labels (not the note's whole box against the whole
        // column — a paragraph whose long last line passes beside or below the labels must not ghost
        // while every line is clear of them)
        n.inDock = !!lab && hits(b, lab, DOCK_PAD) && lineBoxes(n).some((lb) => hits(lb, lab, DOCK_PAD))

        // ── wanted: home notes by the scroll, tour notes by entering the frame ──
        // A tour note types in once it is well inside vertically (its top above enter.at of the visible
        // height, its bottom below 1 − enter.at) and un-types once it has left that band again by more
        // than BAND_SLACK over either edge: the same rule from below and from above (scrolling back up);
        // pinned or at rest, the band alone — a place in the film shows the same notes whichever way
        // the page came. Tested on the box without its turn: moving the mouse over a page at rest never
        // types or un-types a note.
        const r = n.rest
        if (!can) n.wanted = false
        else if (n.home) n.wanted = homeWanted
        else if (!(r[0] < W && r[2] > 0 && r[1] < H && r[3] > 0)) n.wanted = false
        else {
          const lo = K.enterAt * viewH
          const hi = (1 - K.enterAt) * viewH
          const inside = r[1] < lo && r[3] > hi
          const left = r[1] >= lo + BAND_SLACK || r[3] <= hi - BAND_SLACK
          n.wanted = sc.pinned || resting || !n.wanted ? inside : !left
        }

        const total = totalOf(n)
        n.clock = cut ? (n.wanted ? total : 0) : clamp(n.clock + (n.wanted ? 1 : -out) * frame.dt * 1000, 0, total)
        n.lines.forEach((line, i) => setClip(line, cut ? (n.wanted ? 1 : 0) : q(span(n.clock, i * stagger, duration))))

        // ── opacity: hidden until typed; dimmed under the dock; a far note is hidden and not moved ──
        // Showing / hiding (typing in, typed out, going far) is a cut, in the same frame as its last
        // transform; only the dimming of a note that stays shown (the dock) fades.
        const f = faceOf(K, n.spec.kind)
        const shown = n.clock > 0 && !n.far
        const op = shown ? String(n.inDock ? Math.min(f.opacity, K.dock) : f.opacity) : '0'
        if (op !== n.op) {
          const fade = op !== '0' && n.op !== '0' && n.op !== ''
          if (fade !== n.fade) {
            n.fade = fade
            n.el.classList.toggle('is-fade', fade)
            n.rule?.el.classList.toggle('is-fade', fade)
          }
          n.op = op
          n.el.style.opacity = op
          if (n.rule) {
            n.rule.op = op === '0' ? '0' : String(+(Number(op) * K.dash.opacity).toFixed(3))
            n.rule.el.style.opacity = n.rule.op
          }
        }
        // a note that has just gone far gets its transform once more (where the camera put it), then rests
        if ((n.far && wasFar) || !g) continue
        const x = snap(g.x0, dpr)
        const y = snap(g.y0, dpr)
        const deg = g.th / DEG
        const turn = Math.abs(deg) > 1e-3 ? ` rotate(${+deg.toFixed(3)}deg)` : ''
        let css: string
        if (g.map) {
          // turned toward the pointer (or seen by the camera still turning on the pull): its corners
          // through its map, moved as the flat corner snaps to a device px (no jump when the turn starts
          // or ends) — one matrix3d, like the projects texts
          const m = g.map
          const dx = x - g.x0
          const dy = y - g.y0
          const q = [m(0, 0), m(n.w, 0), m(n.w, n.h), m(0, n.h)].map((p) => ({ x: p.x + dx, y: p.y + dy }))
          css = rectToQuad(0, 0, n.w, n.h, q[0], q[1], q[2], q[3])
        } else {
          css = `translate(${+x.toFixed(3)}px,${+y.toFixed(3)}px)${turn}`
          if (Math.abs(g.k - 1) > 1e-4) css += ` scale(${+g.k.toFixed(5)})`
        }
        if (css !== n.css) {
          n.css = css
          n.el.style.transform = css
        }
        if (n.rule) placeRule(n, n.rule, x, y, turn, dpr)
      }

      // ── focus: #about → the heading, once the notes can show; let go below the pull-back ──
      if (focusWanted) {
        if (now - focusWanted > FOCUS_WAIT * 1000) focusWanted = 0
        else if (can) {
          focusWanted = 0
          quietFocus(heading)
        }
      }
      if (sc.pos < K.pullFrom && root.contains(document.activeElement)) releaseFocus(root)
    },
    dispose() {
      off.abort()
      root.remove()
    },
  }

  // ── #about (the nav link — every time it is pressed, a pasted address, Back / Forward) ──
  const off = new AbortController()
  // any later address that is not this screen's (PROJECTS pressed meanwhile, Back) drops a request
  // still waiting — the focus is then that screen's business
  const toHeading = () => {
    focusWanted = HASHES.includes(location.hash) ? performance.now() : 0
  }
  window.addEventListener('hashchange', toHeading, { signal: off.signal })
  // a page opened at #about: the same — when the document really is here, and unless the visitor has
  // already put the focus somewhere
  const sc0 = scrollControl.current
  const about = sc0?.indexOf('about') ?? -1
  if (sc0 && about >= 0 && sc0.state.target >= about && (!document.activeElement || document.activeElement === document.body)) toHeading()

  // a face that arrives late (or another weight from the tuner) changes the boxes → measure again
  const remeasure = () => {
    measured = false
  }
  document.fonts?.addEventListener?.('loadingdone', remeasure, { signal: off.signal })

  place()
  fontsReady(FONT_TIMEOUT).then(() => {
    fontsIn = true
    remeasure()
  })
  return layer
}
