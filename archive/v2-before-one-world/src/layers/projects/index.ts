import '@fontsource-variable/geist'
import '@fontsource/roboto-mono/400.css'
import './projects.css'

import { clamp, clamp01, remap, smoother } from '../../core/ease'
import { projects } from '../../core/projects'
import { rectToQuad, type Pt } from '../../core/quad'
import { scrollControl } from '../../core/scroll'
import { slabPose, slabTexts, type SlabPose } from '../../core/slab-pose'
import type { Frame, Layer, LayerFactory, Layout, ResolvedConfig } from '../../core/types'
import type { SkyConfig } from '../../sky.config'
import { bindInput, quietFocus, releaseFocus } from './input'

/**
 * PROJECTS — the texts and controls of the second screen, lying on the slab's plane.
 *
 * Plain DOM (a carousel for assistive tech: section label, the picture's description, title, meta,
 * description, link, two arrow buttons, a live region) — always in the accessibility tree and in
 * the tab order, whatever the scroll position; the visitor moving the focus in brings the page here,
 * and the focus is let go of when the texts leave the stage (input.ts).
 *
 * One element, `.pj-plane`, is the slab's front face as a flat rectangle of its size at scale 1.
 * Everything is laid out around it in flat px — a point (u, v) of the face sits at (u·w, v·h), and
 * may lie outside the box: the label left of the face, the texts and arrows under it — and ONE
 * matrix3d bends the whole sheet onto the slab:
 *
 *   flat px ──(÷ w, h)──▶ face units (u, v) ──(the slab's LIVE pose, core/slab-pose.ts)──▶ screen
 *
 * The slab publishes its pose earlier in the same frame, so the texts turn toward the cursor, float
 * and arrive exactly with it, as if printed on a sheet of glass that continues its face.
 *
 * Motion is the renderer's own: nothing fades or slides, lines appear and leave as stepped clips.
 *   · arrival: once the scroll passes ui.reveal.from the lines step in one after another ON A TIMER
 *     (the page may stop at any scroll position — a half-revealed line must never hang there);
 *   · leave: on the way on to ABOUT the same cascade un-types past projects.leave.text.from (and
 *     types back under leave.text.back, or anywhere below leave.text.from once the page is at rest:
 *     REST_SPEED) — from then on the block is not live: arrows, keys, swipe and zones do nothing and
 *     the focus is let go of, exactly as when the page goes back up. What is left of the un-typing
 *     is cut at leave.stipple.from: the texts never outlive the slab under them;
 *   · switch: the lines follow the store's timeline (core/projects.ts → state.t): they are wiped
 *     from ui.swap.out on, the new project's lines are typed back from ui.swap.in on — along `dir`.
 *
 * Two things keep the block usable whatever the slab does:
 *   · the safe-area fit: a block that would leave the screen at the slab's pose slides back in
 *     along the plane (and the info block shrinks, down to ui.info.minScale). It is taken when the
 *     slab has arrived and is calm, then holds — the texts do not swim on the plane;
 *   · the arrows' hit zones stand still while a project flips (the slab swings then, and the
 *     arrows on it travel tens of px): a second click at the same spot always lands.
 *
 * In return the layer tells the slab how far down the stage its texts reach with the slab at rest
 * (core/slab-pose.ts → slabTexts): the slab's floor shadow starts below them.
 *
 * Numbers: sky.config.ts → projects.ui (and label / link / soon / items).
 */

type Projects = SkyConfig['projects']
type Item = Projects['items'][keyof Projects['items']]

const projectsOf = (config: ResolvedConfig) => (config as unknown as SkyConfig).projects

/** Faces slower than this do not hold the texts back (they come in with whatever face is there). */
const FONT_TIMEOUT = 1500
/**
 * The live region speaks this long after the last flip, ms: holding an arrow key announces only where it ends.
 * (Screen-reader housekeeping, nothing one sees: not a knob of the pult.)
 */
const ANNOUNCE_DELAY = 300
/**
 * The slab counts as calm when its face moves less than this between two frames, px (its idle float is ≈ 0.1).
 * (A detection threshold between the float and a real turn — technical, not a knob of the pult.)
 */
const CALM = 0.75
/**
 * On a 1× screen the plane is laid out this many times bigger and the matrix3d shrinks it back:
 * the browser rasters a bent layer at its layout resolution, and small type warped from a 1× raster
 * comes out smudged. 1.5 is enough for the near, magnified end of the plane (× 1.2…1.4 on screen)
 * and still leaves the far end (× 0.75) above half size — bilinear sampling skips nothing there.
 * (How the browser rasters the layer, not how the page looks by design — technical, not a knob of the pult.)
 */
const SUPERSAMPLE = 1.5
/**
 * The focus is let go of when the page has rested this long, s, at a place where the texts are not
 * in while the focus is inside them (a scroll toward this screen that was stopped on the way, Back
 * to an address that says #projects with the page elsewhere). Longer than it takes a scroll that
 * was just asked for to start moving.
 */
const STRANDED = 0.3
/**
 * The page counts as AT REST once the picture has moved slower than REST_SPEED (screens/s — under a
 * pixel from home on the scroll's spring) for REST_TIME s. Then the leave's hysteresis is over: texts
 * that went out on the way to ABOUT come back wherever they belong at their position (below
 * leave.text.from), not only under leave.text.back — the wheel coming up from ABOUT rests at
 * 1.016…1.03 (100 px notches at 1440×900), and a still screen must not depend on the way it was
 * reached. The gap only matters while the page moves: a hand resting right at the threshold.
 * (When the scroll counts as stopped — a detection threshold, not a knob of the pult.)
 */
const REST_SPEED = 0.01
const REST_TIME = 0.25
/** A fully clipped line (still in the accessibility tree, still focusable). */
const CLIPPED = 'inset(0 100% 0 0)'
const LABEL_ID = 'pj-label'
const SLIDE_ID = 'pj-slide'

const pad2 = (n: number) => String(n).padStart(2, '0')
const round1 = (n: number) => Math.round(n * 10) / 10

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

/** Progress of something that starts at `start` and takes `dur` (dur 0 — a cut at `start`). */
const span = (now: number, start: number, dur: number) => (dur > 0 ? clamp01((now - start) / dur) : now >= start ? 1 : 0)

/**
 * Breaks `text` into lines of at most `measure` characters (the face is monospace: characters are
 * the unit) and evens them out: the narrowest column that still gives the same number of lines,
 * so the last line is never a lone word. Only ordinary spaces break; a no-break space holds.
 */
function wrap(text: string, measure: number) {
  // a dash between spaces stays with the word before it: no line starts with one
  const words = text
    .trim()
    .replace(/[ \t\n]+([—–-])(?=[ \t\n])/g, '\u00a0$1')
    .split(/[ \t\n]+/)
  const greedy = (width: number) => {
    const lines: string[] = []
    let line = ''
    for (const word of words) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(line)
    return lines
  }
  const longest = Math.max(...words.map((w) => w.length))
  let best = greedy(Math.max(measure, longest))
  for (let width = measure - 1; width >= longest; width--) {
    const lines = greedy(width)
    if (lines.length > best.length) break
    best = lines
  }
  return best
}

/**
 * A thin line arrow, pointing right (dir 1) or left (−1): `len` px long (whole), its head `head` px
 * (whole) to each side, drawn with a `line` px stroke (CSS: --pj-rule). The shaft covers whole
 * pixel rows of the plane's own raster (head … head + line of a box 2·head + line tall): one crisp
 * line, not two grey ones.
 */
const arrowSvg = (len: number, head: number, line: number, dir: 1 | -1) => {
  const c = head + line / 2
  const tip = dir > 0 ? len - line / 2 : line / 2
  const tail = dir > 0 ? 0 : len
  const back = tip - dir * head
  return (
    `<svg class="pj-arrow" width="${len}" height="${2 * c}" viewBox="0 0 ${len} ${2 * c}" aria-hidden="true" focusable="false">` +
    `<path d="M${tail} ${c}H${tip}M${back} ${c - head}L${tip} ${c}L${back} ${c + head}"/></svg>`
  )
}

/** The link's ↗, `s` px (whole): the two strokes of its corner cover whole pixel rows / columns too. */
const linkArrowSvg = (s: number, line: number) => {
  const e = line / 2
  const inset = Math.round(s * 0.3)
  return (
    `<svg class="pj-link-arrow" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" aria-hidden="true" focusable="false">` +
    `<path d="M${e} ${s - e}L${s - e} ${e}M${inset + e} ${e}H${s - e}V${s - inset - e}"/></svg>`
  )
}

/** One stepped-clip line: its place in the arrival cascade and in the switch cascade (−1 — not part of it). */
interface Line {
  el: HTMLElement
  arrive: number
  swap: number
  /** the clip-path last written */
  css: string
}

/**
 * A block of the plane with its safe-area fit: where its box sits in flat px, and the slide
 * (dx, dy) and scale (s, about the point (gx, gy) of the plane) that keep it on screen.
 */
interface Block {
  el: HTMLElement
  x: number
  y: number
  w: number
  h: number
  css: string
}
interface Fit {
  dx: number
  dy: number
  s: number
  gx: number
  gy: number
}

async function fontsReady(config: ResolvedConfig, timeoutMs: number) {
  if (!document.fonts?.load) return
  const p = projectsOf(config)
  const sample = Object.values(p.items)
    .map((i) => (i as Item).title)
    .join(' ')
  const loads = Promise.all([
    document.fonts.load(`${p.ui.title.weight} 30px "Geist Variable"`, sample.toUpperCase()),
    document.fonts.load('400 12px "Roboto Mono"', p.label),
  ]).catch(() => undefined)
  await Promise.race([loads, new Promise((r) => setTimeout(r, timeoutMs))])
}

export const createProjectsLayer: LayerFactory = (mount, ctx) => {
  projects.init(ctx.config)

  // ── DOM ──
  const root = h('section', 'pj')
  root.setAttribute('aria-roledescription', 'carousel')
  root.setAttribute('aria-labelledby', LABEL_ID)
  const plane = h('div', 'pj-plane')

  const label = h('h2', 'pj-label')
  label.id = LABEL_ID
  label.tabIndex = -1

  const face = h('div', 'pj-face')
  face.setAttribute('role', 'img')

  const info = h('div', 'pj-info')
  info.id = SLIDE_ID
  info.setAttribute('role', 'group')
  info.setAttribute('aria-roledescription', 'slide')
  const title = h('h3', 'pj-title')
  const meta = h('p', 'pj-meta')
  const text = h('div', 'pj-text')
  const more = h('p', 'pj-more')
  // both kept for the layer's life: a focused link stays the same element from project to project
  const link = h('a', 'pj-link')
  link.target = '_blank'
  link.rel = 'noopener'
  const linkWords = h('span', 'pj-link-words')
  const linkArrow = h('span')
  const linkHint = h('span', 'sr-only')
  linkHint.textContent = ' (opens in a new tab)'
  link.append(linkWords, linkArrow, linkHint)
  const soon = h('span', 'pj-soon')
  info.append(title, meta, text, more)

  const ctrl = h('div', 'pj-ctrl')
  const button = (cls: string, name: string) => {
    const b = h('button', `pj-btn ${cls}`)
    b.type = 'button'
    b.setAttribute('aria-label', name)
    b.setAttribute('aria-controls', SLIDE_ID)
    return b
  }
  const prev = button('pj-prev', 'Previous project')
  const next = button('pj-next', 'Next project')
  // "02 / 05" for the eye; assistive tech gets "2 of 5" from the slide's label and the live region
  const count = h('span', 'pj-count')
  count.setAttribute('aria-hidden', 'true')
  const countCur = h('span', 'pj-count-cur')
  const countSep = h('span', 'pj-count-sep')
  countSep.textContent = ' / '
  const countAll = h('span', 'pj-count-all')
  count.append(countCur, countSep, countAll)
  ctrl.append(prev, count, next)

  const live = h('p', 'sr-only')
  live.setAttribute('aria-live', 'polite')

  // Pointer-only stand-ins for the two arrows' hit areas, on a copy of the plane that HOLDS STILL
  // while a project flips: the slab swings then, the arrows on it with it (tens of px), and a second
  // click at the same spot must still count. At rest they lie exactly over the buttons.
  const zones = h('div', 'pj-zones')
  zones.setAttribute('aria-hidden', 'true')
  const zonePrev = h('div', 'pj-zone')
  const zoneNext = h('div', 'pj-zone')
  zones.append(zonePrev, zoneNext)

  plane.append(label, face, info, ctrl)
  root.append(plane, zones, live)
  mount.appendChild(root)

  // ── state ──
  let layout: Layout = ctx.layout
  let config: ResolvedConfig = ctx.config
  /** the plane's own px per flat px of the face: SUPERSAMPLE on a 1× screen, 1 on sharper ones */
  let ss = 1
  /** the plane's px per config px: (slab base / reference width)^fluid × ss */
  let k = 1
  /** bumped whenever the flat layout must be rebuilt (config, viewport, a face arriving) */
  let placeRev = 0
  /** the project whose texts are in the DOM */
  let shown = -1
  let lines: Line[] = []
  /** the last places in the two cascades */
  let lastArrive = 0
  let lastSwap = 0
  let fontsIn = false

  // ── content ──

  let announceTimer = 0
  function announce(message: string) {
    clearTimeout(announceTimer)
    announceTimer = window.setTimeout(() => {
      live.textContent = message
    }, ANNOUNCE_DELAY)
  }

  /** Put project `index` into the DOM and rebuild the list of clip lines (the description's lines differ). */
  function render(index: number) {
    const p = projectsOf(config)
    const items = Object.values(p.items) as Item[]
    if (!items.length) return
    const i = clamp(index, 0, items.length - 1)
    const item = items[i]
    const moved = shown >= 0 && i !== shown
    shown = i

    if (label.textContent !== p.label) label.textContent = p.label
    title.textContent = item.title
    meta.textContent = item.meta
    // the description is one paragraph for assistive tech; its drawn lines are for the eye only
    const whole = h('p', 'sr-only')
    whole.textContent = item.text
    const rows = wrap(item.text, Math.max(8, Math.round(p.ui.info.measure))).map((row) => {
      const el = h('span')
      el.setAttribute('aria-hidden', 'true')
      el.textContent = row
      return el
    })
    text.replaceChildren(whole, ...rows)
    root.style.setProperty('--pj-rows', String(rows.length))

    const hadFocus = link.contains(document.activeElement)
    if (item.href) {
      link.href = item.href
      linkWords.textContent = p.link
      if (link.parentNode !== more) more.replaceChildren(link)
    } else {
      soon.textContent = p.soon
      if (soon.parentNode !== more) more.replaceChildren(soon)
      // the focused link is gone: stay in this section (the next Tab goes on to the arrows)
      if (hadFocus) quietFocus(label)
    }

    countCur.textContent = pad2(i + 1)
    countAll.textContent = pad2(items.length)
    info.setAttribute('aria-label', `${i + 1} of ${items.length}`)
    face.setAttribute('aria-label', item.alt || item.title)
    if (moved) announce(`${item.title}, ${i + 1} of ${items.length}`)

    const tail = item.href ? link : soon
    const pieces: [HTMLElement, number, number][] = [
      [label, 0, -1],
      [title, 1, 0],
      [meta, 2, 1],
      ...rows.map((el, n): [HTMLElement, number, number] => [el, 3 + n, 2 + n]),
      [tail, 3 + rows.length, 2 + rows.length],
      [ctrl, 4 + rows.length, -1],
      // the number is the answer to the press and sits next to the arrow just pressed: it changes
      // first, with the title — not last, after the picture has already settled
      [countCur, -1, 0],
    ]
    lines = pieces.map(([el, arrive, swap]) => ({ el, arrive, swap, css: el.style.clipPath }))
    lastArrive = 4 + rows.length
    lastSwap = 2 + rows.length
    // A project with more description lines makes the arrival cascade longer. Lines that are all in
    // stay in: without this the clock, standing at the old end, would re-play the tail of the new
    // one, and the arrows block (the last place) would be clipped for a few frames of every such switch.
    if (arrivedAll) clock = Infinity
  }

  /** Config → custom properties and content. The plane itself is laid out when the slab's size is known (layoutPlane). */
  function place() {
    placeRev++
    const p = projectsOf(config)
    const ui = p.ui
    const safeH = scrollControl.current?.state.safeH || layout.height
    // the same base the slab's own width is a share of: the texts grow with the slab, not with a wide window
    const base = Math.min(layout.width, (p.slab.designAspect || Infinity) * safeH)
    ss = layout.dpr < 1.5 ? SUPERSAMPLE : 1
    k = ss * Math.pow(base / (layout.isMobile ? 390 : 1440), ui.fluid)
    // type sizes scale freely; boxes (line heights, gaps, offsets) are whole px, so that every
    // 1-px line of the block lands on a pixel row of the plane's raster
    const px = (v: number) => `${+(v * k).toFixed(2)}px`
    const whole = (v: number) => `${Math.max(1, Math.round(v * k))}px`

    const items = Object.values(p.items) as Item[]
    const measure = Math.max(8, Math.round(ui.info.measure))
    const set = (name: string, value: string | number) => root.style.setProperty(`--pj-${name}`, String(value))
    set('ink', ui.ink)
    set('text', ui.text)
    set('label', px(ui.label.size))
    set('label-box', whole(ui.label.size))
    set('label-track', ui.label.tracking)
    set('title', px(ui.title.size))
    set('title-box', whole(ui.title.size))
    set('title-w', ui.title.weight)
    set('title-track', ui.title.tracking)
    set('meta', px(ui.meta.size))
    set('meta-box', whole(ui.meta.size))
    set('meta-track', ui.meta.tracking)
    set('meta-gap', whole(ui.meta.gap))
    set('mono', px(ui.mono.size))
    set('row', whole(ui.mono.size * ui.mono.leading))
    set('mono-gap', whole(ui.mono.gap))
    // the longest description: how many lines, and how wide its widest one is
    const wrapped = items.map((item) => wrap(item.text, measure))
    set('lines', Math.max(1, ...wrapped.map((rows) => rows.length)))
    set('cols', Math.max(1, ...wrapped.flat().map((row) => row.length)))
    set('link', px(ui.link.size))
    set('link-box', whole(ui.link.size))
    set('link-track', ui.link.tracking)
    set('link-gap', whole(ui.link.gap))
    set('underline', whole(ui.link.underline))
    const line = Math.max(0.5, ui.rule) * ss
    set('rule', `${line}px`)
    set('ss', ss)
    set('count', px(ui.ctrl.count))
    set('ctrl-gap', whole(ui.ctrl.gap))
    const arrow = Math.max(8, Math.round(ui.ctrl.arrow * k))
    // the head grows slower than the type (√): on a big screen it stays a fine tick
    const head = Math.max(3, Math.round(ui.ctrl.head * ss * Math.sqrt(k / ss)))
    set('arrow', `${arrow}px`)
    // the button: the arrow's box plus the same whole number of px above and below it
    set('btn', `${2 * head + line + 2 * Math.round(ui.ctrl.count * k * 0.6)}px`)
    const left = arrowSvg(arrow, head, line, -1)
    if (prev.innerHTML !== left) {
      prev.innerHTML = left
      next.innerHTML = arrowSvg(arrow, head, line, 1)
    }
    // the ↗ is centred on the link's line: same parity as the line's box, or it would sit on half a px
    const lineBox = Math.max(1, Math.round(ui.link.size * k))
    const upSize = Math.max(5, Math.round(ui.link.arrow * k))
    const up = linkArrowSvg(upSize + ((lineBox - upSize) & 1), line)
    if (linkArrow.innerHTML !== up) linkArrow.innerHTML = up

    render(clamp(projects.state.index, 0, Math.max(0, items.length - 1)))
  }

  // ── geometry ──

  const blocks: Record<'label' | 'info' | 'ctrl', Block> = {
    label: { el: label, x: 0, y: 0, w: 0, h: 0, css: '' },
    info: { el: info, x: 0, y: 0, w: 0, h: 0, css: '' },
    ctrl: { el: ctrl, x: 0, y: 0, w: 0, h: 0, css: '' },
  }
  const NO_FIT: Fit = { dx: 0, dy: 0, s: 1, gx: 0, gy: 0 }
  const fits: Record<'label' | 'info' | 'ctrl', Fit> = { label: NO_FIT, info: NO_FIT, ctrl: NO_FIT }
  /** the flat layout these numbers were measured for */
  let planeKey = ''
  /** something jumped (layout, the pose's source): fit again right now */
  let fitDirty = true
  /** the fit was taken with the slab arrived and calm: it holds from now on */
  let fitSettled = false
  /** the face's corners last frame (x, y × 4): how fast the slab is moving */
  const lastCorners: number[] = []
  /** the pose came from the slab (not from the flat stand-in) last frame */
  let hadSlab = false
  let hit = 0
  /** flat px from an arrow's inner end to the middle of the counter */
  let reach = 0
  let zonesCss = ''
  let bentKey = ''
  let bentCss = ''

  /** Until the slab has published a pose (or without a slab at all): its face, flat and unturned, where the config puts it. */
  function flatPose(pos: number): SlabPose {
    const p = projectsOf(config)
    const W = layout.width
    const safeH = scrollControl.current?.state.safeH || layout.height
    const w = (Math.min(W, (p.slab.designAspect || Infinity) * safeH) * p.slab.width) / 100
    const ht = w / Math.max(0.1, p.slab.aspect)
    const x0 = p.slab.x * W - w / 2
    const y0 = p.slab.y * safeH - ht / 2
    const project = (u: number, v: number): Pt => ({ x: x0 + u * w, y: y0 + v * ht })
    return {
      key: `flat|${W}|${safeH}|${w}|${ht}|${x0}|${y0}`,
      project,
      rest: project,
      corners: [project(0, 0), project(1, 0), project(1, 1), project(0, 1)],
      flat: { w, h: ht },
      arrival: smoother(remap(pos, p.arrive.from, p.arrive.to)),
    }
  }

  /** Lay the blocks out around the face in flat px and measure them. */
  function layoutPlane(pose: SlabPose) {
    const ui = projectsOf(config).ui
    const w = pose.flat.w * ss
    const ht = pose.flat.h * ss
    plane.style.width = `${w}px`
    plane.style.height = `${ht}px`
    // whole px: see place()
    const put = (b: Block, x: number, y: number) => {
      b.x = Math.round(x)
      b.y = Math.round(y)
      b.el.style.left = `${b.x}px`
      b.el.style.top = `${b.y}px`
    }
    // the info block is as wide as its widest project, so the fit taken now holds for all of them
    const keep = title.textContent
    let widest = 0
    for (const item of Object.values(projectsOf(config).items) as Item[]) {
      title.textContent = item.title
      widest = Math.max(widest, title.offsetWidth)
    }
    title.textContent = keep
    info.style.minWidth = `${Math.ceil(widest)}px`
    for (const b of Object.values(blocks)) {
      b.w = b.el.offsetWidth
      b.h = b.el.offsetHeight
    }
    const { label: lb, info: i, ctrl: c } = blocks
    // align: which point of the block stands at u — 0 its left end, 1 its right end
    put(lb, ui.label.u * w - clamp01(ui.label.align) * lb.w, ui.label.v * ht)
    put(i, ui.info.u * w, ui.info.v * ht)
    // each arrow's hit area reaches the middle of the counter (projects.css)
    reach = (next.offsetLeft - prev.offsetLeft - prev.offsetWidth) / 2
    root.style.setProperty('--pj-reach', `${reach}px`)
    if (ui.ctrl.follow) put(c, i.x, i.y + i.h + ui.ctrl.followGap * k)
    else put(c, ui.ctrl.u * w - clamp01(ui.ctrl.align) * c.w, ui.ctrl.v * ht)
    fitDirty = true
    fitSettled = false

    // Where the texts under the slab end with the slab at rest (fitted as they will be there): the
    // slab keeps its floor shadow below that line (core/slab-pose.ts → slabTexts).
    const atRest: SlabPose = { ...pose, project: pose.rest }
    const resting = fitsAt(atRest, scrollControl.current?.state.safeH || layout.height)
    let bottom = -Infinity
    for (const name of ['info', 'ctrl'] as const) {
      for (const ax of [0, 1]) {
        const q = fitted(blocks[name], resting[name], ax, 1)
        bottom = Math.max(bottom, toScreen(atRest, q.x, q.y).y)
      }
    }
    slabTexts.current = Number.isFinite(bottom) ? { bottom } : null
  }

  /** the plane's px → screen, through the pose */
  const toScreen = (pose: SlabPose, x: number, y: number) => pose.project(x / (pose.flat.w * ss), y / (pose.flat.h * ss))

  /** A block's point (fractions of its box) in flat px, with its fit applied. */
  const fitted = (b: Block, f: Fit, ax: number, ay: number) => ({
    x: f.gx + f.dx + f.s * (b.x + ax * b.w - f.gx),
    y: f.gy + f.dy + f.s * (b.y + ay * b.h - f.gy),
  })

  /**
   * Keep a group of blocks inside the safe area at this pose: slide it along the plane's axes
   * (sideways always, up / down when `slideY`), then — if it is still too long for the room it
   * has — shrink it about (gx, gy), not below `minScale`.
   */
  function fitGroup(pose: SlabPose, group: Block[], gx: number, gy: number, minScale: number, slideY: boolean, box: [number, number, number, number]): Fit {
    const f: Fit = { dx: 0, dy: 0, s: 1, gx, gy }
    const [x0, y0, x1, y1] = box
    for (let pass = 0; pass < 5; pass++) {
      let bx0 = Infinity
      let by0 = Infinity
      let bx1 = -Infinity
      let by1 = -Infinity
      for (const b of group) {
        for (const [ax, ay] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const q = fitted(b, f, ax, ay)
          const s = toScreen(pose, q.x, q.y)
          bx0 = Math.min(bx0, s.x)
          by0 = Math.min(by0, s.y)
          bx1 = Math.max(bx1, s.x)
          by1 = Math.max(by1, s.y)
        }
      }
      // screen px per flat px along the plane's two axes, at the group's origin
      const o = toScreen(pose, gx + f.dx, gy + f.dy)
      const jx = Math.max(0.2, Math.abs(toScreen(pose, gx + f.dx + 8, gy + f.dy).x - o.x) / 8)
      const jy = Math.max(0.2, Math.abs(toScreen(pose, gx + f.dx, gy + f.dy + 8).y - o.y) / 8)
      let moved = false
      if (bx0 < x0 - 0.25) {
        f.dx += (x0 - bx0) / jx
        moved = true
      } else if (bx1 > x1 + 0.25 && bx0 > x0 + 0.5) {
        f.dx -= Math.min(bx1 - x1, bx0 - x0) / jx
        moved = true
      }
      if (slideY) {
        if (by0 < y0 - 0.25) {
          f.dy += (y0 - by0) / jy
          moved = true
        } else if (by1 > y1 + 0.25 && by0 > y0 + 0.5) {
          f.dy -= Math.min(by1 - y1, by0 - y0) / jy
          moved = true
        }
      }
      if (moved) continue
      let shrink = 1
      if (by1 > y1 + 0.25 && by1 > o.y) shrink = Math.min(shrink, (y1 - o.y) / (by1 - o.y))
      if (bx1 > x1 + 0.25 && bx1 > o.x) shrink = Math.min(shrink, (x1 - o.x) / (bx1 - o.x))
      if (shrink >= 1 || f.s <= minScale) break
      f.s = Math.max(minScale, f.s * Math.max(0.05, shrink))
    }
    return f
  }

  /** The safe-area fit of every block at this pose (nothing is written anywhere). */
  function fitsAt(pose: SlabPose, safeH: number): Record<'label' | 'info' | 'ctrl', Fit> {
    const ui = projectsOf(config).ui
    const m = Math.max(0, ui.safe)
    const box: [number, number, number, number] = [m, m, layout.width - m, safeH - m]
    const { label: lb, info: ib, ctrl: cb } = blocks
    const label = fitGroup(pose, [lb], lb.x, lb.y, 1, true, box)
    const minScale = clamp(ui.info.minScale, 0.2, 1)
    if (ui.ctrl.follow) {
      const both = fitGroup(pose, [ib, cb], ib.x, ib.y, minScale, false, box)
      return { label, info: both, ctrl: both }
    }
    return {
      label,
      info: fitGroup(pose, [ib], ib.x, ib.y, minScale, false, box),
      ctrl: fitGroup(pose, [cb], cb.x + clamp01(ui.ctrl.align) * cb.w, cb.y, minScale, false, box),
    }
  }

  function fit(pose: SlabPose, safeH: number) {
    const ui = projectsOf(config).ui
    const cb = blocks.ctrl
    Object.assign(fits, fitsAt(pose, safeH))
    for (const name of ['label', 'info', 'ctrl'] as const) {
      const b = blocks[name]
      const f = fits[name]
      // translate + scale about the block's own top-left corner = the fit about (gx, gy)
      const tx = f.dx + (1 - f.s) * (f.gx - b.x)
      const ty = f.dy + (1 - f.s) * (f.gy - b.y)
      const css =
        f.s !== 1
          ? `translate(${+tx.toFixed(2)}px,${+ty.toFixed(2)}px) scale(${+f.s.toFixed(4)})`
          : tx || ty
            ? `translate(${Math.round(tx)}px,${Math.round(ty)}px)`
            : ''
      if (css !== b.css) {
        b.css = css
        b.el.style.transform = css
      }
    }
    // the arrows' hit area: ctrl.size px ON SCREEN, whatever the plane's scale is where they sit
    const c = fitted(cb, fits.ctrl, 0.5, 0.5)
    const o = toScreen(pose, c.x, c.y)
    const ex = toScreen(pose, c.x + 8, c.y)
    const ey = toScreen(pose, c.x, c.y + 8)
    const scale = (fits.ctrl.s * Math.min(Math.hypot(ex.x - o.x, ex.y - o.y), Math.hypot(ey.x - o.x, ey.y - o.y))) / 8
    const want = Math.round(clamp(ui.ctrl.size / Math.max(0.2, scale), ui.ctrl.size, ui.ctrl.size * 3))
    if (want !== hit) {
      hit = want
      root.style.setProperty('--pj-hit', `${hit}px`)
    }
    // the stand-in zones: the same boxes as the buttons' own hit areas, in the plane's flat px
    const zone = (el: HTMLElement, x0: number, x1: number) => {
      const a = fitted(cb, fits.ctrl, x0 / cb.w, 0.5 - hit / 2 / cb.h)
      const b = fitted(cb, fits.ctrl, x1 / cb.w, 0.5 + hit / 2 / cb.h)
      const css = `left:${+a.x.toFixed(1)}px;top:${+a.y.toFixed(1)}px;width:${+(b.x - a.x).toFixed(1)}px;height:${+(b.y - a.y).toFixed(1)}px`
      if (el.style.cssText !== css) el.style.cssText = css
    }
    if (cb.w > 0 && cb.h > 0) {
      zone(zonePrev, -hit / 2, prev.offsetLeft + prev.offsetWidth + reach)
      zone(zoneNext, next.offsetLeft - reach, cb.w + hit / 2)
    }
  }

  // ── reveal and switch: stepped clips ──

  /** ms on the arrival cascade's own clock: runs forward while the texts are wanted, back when not */
  let clock = 0
  /** the arrival cascade has played to its end: every line is in (render() keeps it so) */
  let arrivedAll = false
  /** wanted on screen: the scroll is past ui.reveal.from and not yet past leave.text.from (with hysteresis) */
  let wanted = false
  /** `wanted` has been decided once (the first frame takes the plain rule, as a pinned one does) */
  let decided = false
  /** the furthest the current switch's wipe has got: a re-targeted switch does not bring wiped lines back */
  let wiped = 0
  let hereNow = false
  let liveNow = false
  /** s the page has rested with the focus inside texts that are not in (see STRANDED) */
  let stranded = 0
  /** s the picture has stood still (see REST_SPEED) */
  let still = 0

  function setClip(line: Line, p: number, fromEnd: boolean) {
    const cut = +((1 - p) * 100).toFixed(1)
    const css = p >= 1 ? '' : p <= 0 ? CLIPPED : fromEnd ? `inset(0 0 0 ${cut}%)` : `inset(0 ${cut}% 0 0)`
    if (css === line.css) return
    line.css = css
    line.el.style.clipPath = css
  }

  function animate(frame: Frame, arrived: boolean) {
    const p = projectsOf(frame.config)
    const r = p.ui.reveal
    const sw = p.ui.swap
    const sc = frame.scroll
    const st = projects.state

    // ── arrival and leave: a timer started by the scroll, not the scroll itself ──
    // In from ui.reveal.from (out again under from − back); out from leave.text.from on the way on
    // to ABOUT (in again under leave.text.back while the page moves; at rest — REST_SPEED — anywhere
    // below leave.text.from, on the same typing timer). A pinned scroll (and the first frame: a page
    // opened there) shows what belongs to its position, whichever way it was reached.
    const can = arrived && fontsIn
    const L = p.leave.text
    still = !sc.pinned && Math.abs(sc.speed) < REST_SPEED ? still + frame.dt : 0
    if (sc.pinned || !decided) wanted = sc.pos >= r.from && sc.pos < L.from
    else if (!wanted) wanted = sc.pos >= r.from && sc.pos < (still >= REST_TIME ? L.from : Math.min(L.back, L.from))
    else if (sc.pos < r.from - r.back || sc.pos >= L.from) wanted = false
    decided = true
    // …and never past the slab: from leave.stipple.from on (the slab starts to stipple out) the texts
    // are out at once, whatever is left of their un-typing — a fast scroll into ABOUT outruns the
    // out-timer, and the dark lines floated on in the white void inside the A after the slab was gone
    const gone = sc.pos >= p.leave.stipple.from
    const on = can && wanted && !gone
    const stagger = Math.max(0, r.stagger)
    const duration = Math.max(0, r.duration)
    const total = lastArrive * stagger + duration
    // a pinned scroll (screenshots) and reduced motion: no film, the texts are simply there (past
    // the slab: simply gone)
    const cut = sc.pinned || sc.reduced || gone
    clock = cut ? (on ? total : 0) : clamp(clock + (on ? 1 : -Math.max(0.1, r.out)) * frame.dt * 1000, 0, total)
    arrivedAll = clock >= total
    const steps = sc.reduced ? 1 : Math.max(1, Math.round(r.steps))
    const q = (x: number) => Math.floor(x * steps + 1e-6) / steps

    if (on !== liveNow) {
      liveNow = on
      root.classList.toggle('is-live', on)
      // the texts are leaving: a focus resting on one of them must not stay behind in a block nobody sees
      if (!on) releaseFocus(root)
    }
    // …nor when they never came: the page stopped short of this screen with the focus already in
    // here. While the page moves it may still be on its way (the focus goes first, the page follows:
    // input.ts); while the faces are loading the texts are only late, not away (a page opened at
    // #projects has its heading focused before they are in); a pinned page is a debug still — the
    // keyboard may walk it as it is.
    if (on || !fontsIn || sc.pinned || sc.velocity !== 0 || sc.raw !== sc.pos || !root.contains(document.activeElement)) stranded = 0
    else if ((stranded += frame.dt) >= STRANDED) {
      stranded = 0
      releaseFocus(root)
    }

    // ── switch: the store's timeline, in shares of the show ──
    const busy = st.t < 1 || st.pinned
    const leaving = busy && st.t < sw.in
    if (!busy || !leaving) wiped = 0
    else if (!st.pinned) wiped = Math.max(wiped, st.t)
    const show = Math.max(0.05, p.switch.duration) * 1000
    // both halves of the cascade must fit their windows: out…in for the wipe, in…1 for the new lines
    const gap = Math.max(0, sw.stagger) / show
    const dur = duration / show
    const whole = lastSwap * gap + dur
    const kOut = whole > 0 ? Math.min(1, Math.max(0, sw.in - sw.out) / whole) : 1
    const kIn = whole > 0 ? Math.min(1, Math.max(0, 1 - sw.in) / whole) : 1
    const tOut = st.pinned ? st.t : wiped

    for (const line of lines) {
      let pa = 1
      if (line.arrive >= 0) pa = cut ? (on ? 1 : 0) : on || clock > 0 ? q(span(clock, line.arrive * stagger, duration)) : 0
      let ps = 1
      if (busy && line.swap >= 0 && !sc.reduced) {
        ps = leaving
          ? 1 - q(span(tOut, sw.out + line.swap * gap * kOut, dur * kOut))
          : q(span(st.t, sw.in + line.swap * gap * kIn, dur * kIn))
      }
      // the wipe runs along the switch: next — erased from its end, typed back from its start; previous — mirrored
      setClip(line, Math.min(pa, ps), ps < pa && st.dir < 0)
    }
  }

  // ── layer ──

  let lastPose: SlabPose | null = null
  const deg = (a: Pt, b: Pt) => round1((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI)

  const layer: Layer & { stats(): unknown } = {
    /**
     * Debug (__hero.layers.get('projects').stats()): per element — its bounding box on screen, the
     * angle of its base line (degrees, + = falling to the right) and whether it is inside the safe
     * area [8, W − 8] × [8, safeH − 8]; `edge` — the slab's bottom edge angle; `fit` — what the
     * safe-area fit did to each block; `glue` — the largest distance, px, between the face as the
     * browser draws the plane and as the slab's pose of this frame describes it (0 = printed on the slab).
     */
    stats() {
      const pose = lastPose
      if (!pose) return null
      const safeH = scrollControl.current?.state.safeH || layout.height
      const W = layout.width
      const tail = link.isConnected ? link : soon
      const parts: [string, HTMLElement, 'label' | 'info' | 'ctrl' | null][] = [
        ['label', label, 'label'],
        ['title', title, 'info'],
        ['meta', meta, 'info'],
        ['text', text, 'info'],
        [link.isConnected ? 'link' : 'soon', tail, 'info'],
        ['prev', prev, 'ctrl'],
        ['count', count, 'ctrl'],
        ['next', next, 'ctrl'],
        ['face', face, null],
      ]
      const els = parts.map(([name, el, owner]) => {
        const r = el.getBoundingClientRect()
        // the element's bottom edge on the plane: its box inside its block, the block's fit, the pose
        let a: Pt
        let b: Pt
        if (owner) {
          const blk = blocks[owner]
          const f = fits[owner]
          const inBlock = el === blk.el
          const lx = inBlock ? 0 : el.offsetLeft
          const ly = inBlock ? 0 : el.offsetTop
          const at = (x: number, y: number) => {
            const q = fitted(blk, f, blk.w ? x / blk.w : 0, blk.h ? y / blk.h : 0)
            return toScreen(pose, q.x, q.y)
          }
          a = at(lx, ly + el.offsetHeight)
          b = at(lx + el.offsetWidth, ly + el.offsetHeight)
        } else {
          a = pose.project(0, 1)
          b = pose.project(1, 1)
        }
        const inside = r.left >= 8 && r.top >= 8 && r.right <= W - 8 && r.bottom <= safeH - 8
        return { name, bbox: { x: round1(r.left), y: round1(r.top), w: round1(r.width), h: round1(r.height) }, baseline: deg(a, b), inside }
      })
      // how far the plane as the browser draws it is from the face the pose describes, px
      const fr = face.getBoundingClientRect()
      const xs = pose.corners.map((c) => c.x)
      const ys = pose.corners.map((c) => c.y)
      const glue = Math.max(
        Math.abs(fr.left - Math.min(...xs)),
        Math.abs(fr.right - Math.max(...xs)),
        Math.abs(fr.top - Math.min(...ys)),
        Math.abs(fr.bottom - Math.max(...ys)),
      )
      return {
        project: shown,
        // the slab is on the stage (before that nothing below is laid out or bent) / the texts are in
        here: hereNow,
        live: liveNow,
        glue: +glue.toFixed(2),
        safe: { x0: 8, y0: 8, x1: W - 8, y1: safeH - 8 },
        edge: deg(pose.project(0, 1), pose.project(1, 1)),
        scale: +(k / ss).toFixed(3),
        supersample: ss,
        // in flat px of the face, like the config's numbers
        hit: hit / ss,
        fit: Object.fromEntries(Object.entries(fits).map(([name, f]) => [name, { dx: round1(f.dx / ss), dy: round1(f.dy / ss), s: +f.s.toFixed(3) }])),
        els,
      }
    },
    resize(l, c) {
      layout = l
      config = c
      place()
    },
    update(frame) {
      projects.step(frame)
      const published = slabPose.current
      const pose = published ?? flatPose(frame.scroll.pos)
      lastPose = pose
      // the slab has just mounted (or gone): what was fitted to the stand-in plane no longer holds
      if (!!published !== hadSlab) {
        hadSlab = !!published
        fitDirty = true
        fitSettled = false
      }
      const st = projects.state
      if (st.index !== shown && st.count > 0) render(st.index)

      // before the slab is on the stage: nothing to lie on — invisible, no bending
      const arrived = pose.arrival > 0
      const here = arrived && fontsIn
      if (here !== hereNow) {
        hereNow = here
        root.classList.toggle('is-here', here)
      }
      // The flat layout does not wait for the slab to arrive: it is measured once, at rest on the
      // hero (not in the middle of the scroll), and the slab's shadow knows from its first frame
      // where the texts will end.
      const pk = `${placeRev}|${pose.flat.w}|${pose.flat.h}|${ss}|${published ? 'slab' : 'flat'}`
      const fresh = pk !== planeKey && fontsIn
      if (fresh) {
        planeKey = pk
        layoutPlane(pose)
      }
      if (arrived) {
        const turned = fresh || pose.key !== bentKey
        let moved = 0
        pose.corners.forEach((c, n) => {
          moved = Math.max(moved, Math.abs(c.x - (lastCorners[2 * n] ?? Infinity)), Math.abs(c.y - (lastCorners[2 * n + 1] ?? Infinity)))
          lastCorners[2 * n] = c.x
          lastCorners[2 * n + 1] = c.y
        })
        // The safe-area fit follows the slab while it is on its way in, and is taken for good once
        // it has arrived AND is calm (not swinging through a switch, not chasing the cursor): from
        // then on it holds — the texts must not swim on the plane as the slab turns.
        const calm = pose.arrival >= 1 && !(st.t < 1) && moved < CALM
        if (pose.arrival < 1) fitSettled = false
        if (fitDirty || (!fitSettled && (pose.arrival < 1 ? turned : calm))) {
          fit(pose, frame.scroll.safeH || layout.height)
          fitDirty = false
          fitSettled = calm
        }
        if (turned) {
          bentKey = pose.key
          const P = pose.project
          const css = rectToQuad(0, 0, pose.flat.w * ss, pose.flat.h * ss, P(0, 0), P(1, 0), P(1, 1), P(0, 1))
          if (css !== bentCss) {
            bentCss = css
            plane.style.transform = css
          }
        }
        // the stand-in hit zones follow the plane, except while a project is flipping
        if (!(st.t < 1) && zonesCss !== bentCss) {
          zonesCss = bentCss
          zones.style.transform = bentCss
        }
      }
      animate(frame, arrived)
    },
    dispose() {
      unbind()
      slabTexts.current = null
      clearTimeout(announceTimer)
      document.fonts?.removeEventListener?.('loadingdone', remeasure)
      root.remove()
    },
  }

  const unbind = bindInput({
    root,
    face,
    prev,
    next,
    zonePrev,
    zoneNext,
    heading: label,
    live: () => liveNow,
    swipe: () => projectsOf(config).ui.swipe,
  })

  // a face that arrives (late, or another weight from the tuner) changes the blocks' sizes → measure again
  const remeasure = () => {
    placeRev++
  }
  document.fonts?.addEventListener?.('loadingdone', remeasure)

  place()
  fontsReady(ctx.config, FONT_TIMEOUT).then(() => {
    fontsIn = true
    root.classList.add('is-ready')
    remeasure()
  })
  return layer
}
