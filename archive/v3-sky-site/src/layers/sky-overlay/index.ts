import '@fontsource-variable/geist'
import './overlay.css'

import { aboutCameraAt } from '../../core/about-camera'
import { clamp, clamp01, lerp, remap, smooth } from '../../core/ease'
import { num, obj, type Loose } from '../../core/loose'
import { navDock } from '../../core/nav-dock'
import { rectToQuad, type Pt } from '../../core/quad'
import { scrollControl } from '../../core/scroll'
import { Follower } from '../../core/spring'
import type { Frame, Layer, LayerFactory, Layout, ResolvedConfig } from '../../core/types'
import { VEIL_CLOUDS_FRESH, veilClouds as veilBoxes } from '../../core/veil-clouds'
import type { SkyConfig } from '../../sky.config'
import { fogOf, getSkyLayersKnobs, riseOf, type LayerKnobs, type SkyLayersKnobs } from '../sky-layers/params'
import { ASSET_DIR, type Meta } from '../title/raster/fallback'
import { titleEdgeY, titleRestMap } from '../title/raster/geometry'
import { titlePose } from '../title/raster/pose'
import { dir, lying, para, solveRod, type Quad, type Rod } from './dock'
import { cloudAt, silhouetteOf } from './cloud-edge'

/**
 * SKY OVERLAY — the nav and the tagline of version 2, lying on the title's own plane.
 *
 * Plain DOM text (real links, selectable, accessible). Every piece — each nav word, each segment
 * of the nav line, the tagline block — is laid out FLAT in CSS px and bent onto the title by its own
 * CSS matrix3d (a 2D homography fitted at the piece's own four corners, so each word's slant is the
 * plane's exact one right where the word sits):
 *
 *   flat (u, v) CSS px ──(plane)──▶ title texel ──(title's LIVE 3D pose)──▶ screen
 *
 * Plane: a one-point perspective like the render's own — texel verticals stay vertical, every line
 * v = const runs into the title's vanishing point (meta.vanish). A block's origin sits at scale 1
 * (u = 1 px along the line there) and things shrink toward the vanishing point; `foreshorten` < 1
 * pushes a virtual vanishing point further out along the same line → the line keeps its direction,
 * the text shrinks slower (exact perspective makes the far nav item half the size of the first).
 * The nav is one flat strip — lead line, word, equal segments between the words, word, …, tail —
 * stretched so it runs from `from` to `to` along the title: the perspective alone makes the far
 * segments shorter and the far words smaller.
 *
 * Live pose: the title publishes how it projects texels right now (title/raster/pose.ts — the vertex
 * shader's front faces, baked depth included), so the text turns toward the cursor exactly with
 * SLAVA VOLKOV, as if printed on it. overlay.turn blends that with the rest pose (0 — the text
 * stays put); until the title is up (or without it) the rest pose is used.
 * On top of that each block may drift with its own parallax (world.parallax × depth, against the
 * pointer like the sky) and inertia (mass). Numbers: sky.config.ts → overlay.
 *
 * Scrolling to the second screen, the strip leaves the plane and becomes the vertical progress nav
 * at the edge of the screen: line, a dot per screen, labels (overlay.nav.dock / morph; the geometry
 * is dock.ts). Three states of the same DOM:
 *   strip  — the scroll is at the hero: everything above, untouched;
 *   flight — in between: the same elements, each on a quad of the rod (matrix3d), dots growing in;
 *   dock   — arrived: plain whole-pixel DOM, the labels at their real font size (no transform
 *            scaling → as crisp as any text), the passed part of the line filled.
 * The words are the links the whole way; a link whose screen does not exist yet is inert and dimmed
 * (overlay.nav.disabled on the strip, dock.disabled docked). The current item is the live word with
 * the largest screen not below the one the picture is at: ABOUT stays current through its whole tour
 * (its second stop, 'about-end', has no word of its own).
 * The tagline stays on the plane and goes to sleep once the hero is fully behind the clouds.
 *
 * Ink, per piece (word with its dot, line segment with its progress fill): light on the sky, dark once
 * the veil's white is under it (whiteUnder / the fog). On ABOUT (from about.pull.from on) the nav stops
 * choosing: the whole root inverts what is under it (mix-blend-mode: difference) with one constant ink,
 * dock.invertInk = the void under the nav − dock.ink — exactly dock.ink over the void (as on the
 * projects screen), light over the black concrete letters, letter by letter.
 * Under reduced motion the scene dissolves in as a Bayer checker instead: the nav keeps the dark ink,
 * on a backing in the void's colour, for the whole dissolve (¼ ½ ¾ — an inverted label over a fine
 * checker is a checker itself and vanishes) and inverts once the scene is all there.
 * Colour fades are for the white reaching a piece as the page moves; after an instant jump, a flip
 * of the blend or a re-layout the colours are simply there (snap).
 *
 * Docked, the nav publishes its column (labels, dots, line; stage CSS px) and each item's own rect
 * (its dot and its label) as core/nav-dock.ts → navDock: the about canvas keeps a soft halo behind
 * each label (the concrete no lighter than the ink, the photos washed toward the void), the about
 * notes fade under the column.
 */

type Overlay = SkyConfig['overlay']
type NavItem = Overlay['nav']['items'][keyof Overlay['nav']['items']]

const overlayOf = (config: ResolvedConfig) => (config as unknown as SkyConfig).overlay

/** Fonts slower than this do not hold the text back (it fades in with whatever face is there). */
const FONT_TIMEOUT = 1500
/** The text fades in once the title is up (it then turns with it from its first frame), or after this. */
const TITLE_TIMEOUT = 3000
/** Local length of the progress fill and of a line segment the strip does not show, CSS px (any number: the matrix scales it). */
const UNIT = 100
/** The veil layer overlay.nav.morph.ink.crest speaks of: its cloud wall (sky.config.ts → veil.layers). */
const VEIL_WALL = 'wall'
/** Where the veil's pictures live: the same folder src/layers/sky-layers draws them from. */
const VEIL_ASSETS = `${import.meta.env.BASE_URL}assets/sky-layers/`
/** '#rrggbb' (or '#rgb') → 'r, g, b' for an rgba() — the halo colours of overlay.nav.morph. */
function rgbOf(hex: string): string {
  let s = hex.replace('#', '')
  if (s.length === 3) s = [...s].map((c) => c + c).join('')
  const n = parseInt(s.slice(0, 6), 16)
  return Number.isFinite(n) ? `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}` : '0, 0, 0'
}

/** A cloud of the veil that can come behind the nav: its knobs and the picture it is drawn from. */
interface VeilCloud {
  name: string
  k: LayerKnobs
  url: string
}

/** Where a piece of the nav is on screen, for the ink: the two ends of its middle line, px. */
interface Spot {
  ax: number
  ay: number
  bx: number
  by: number
}
const NOWHERE: Spot = { ax: 0, ay: 0, bx: 0, by: 0 }
/** A piece is looked at in this many points along its middle line; it is dark once the white is under half of them. */
const INK_SAMPLES = 5
/**
 * Where the ABOUT sheet starts, pos: about.pull.from — under reduced motion about.pull.reduced.from (no
 * pull-back there: the finished sheet dissolves in over the void from that pos). No about block → never.
 */
function sheetFromOf(config: ResolvedConfig, reduced: boolean) {
  const pull = obj(obj((config as unknown as Loose).about).pull)
  const from = num(pull.from, Infinity)
  return reduced ? num(obj(pull.reduced).from, from) : from
}
/** '#rrggbb' (or '#rgb') → [r, g, b], 0…255 (unreadable → black). */
function rgbArr(hex: string): [number, number, number] {
  return rgbOf(hex).split(',').map(Number) as [number, number, number]
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

interface Plane {
  /** origin, texel */
  ox: number
  oy: number
  /** (virtual) vanishing point, texel */
  vx: number
  vy: number
  /** distance origin → vanishing point, texel (= unit speed along the line at the origin) */
  L: number
}

function makePlane(meta: Meta, ox: number, oy: number, foreshorten: number): Plane {
  const k = clamp(foreshorten, 0.02, 1)
  const vx = ox + (meta.vanish[0] - ox) / k
  const vy = oy + (meta.vanish[1] - oy) / k
  return { ox, oy, vx, vy, L: Math.hypot(vx - ox, vy - oy) }
}

/** flat (X along the line, Y texel-vertical; texel units at the origin) → texel */
function flatToTexel(p: Plane, X: number, Y: number) {
  const w = X + p.L
  return { x: (p.vx * X + p.ox * p.L) / w, y: (p.vy * X + (p.oy + Y) * p.L) / w }
}

/** texel column x → flat X of the plane's base line (v = 0) */
const flatXAt = (p: Plane, x: number) => (p.L * (x - p.ox)) / Math.max(1e-6, p.vx - x)

/** Waits for the faces the current config uses, at most `timeoutMs`. */
async function fontsReady(o: Overlay, timeoutMs: number) {
  if (!document.fonts?.load) return
  const loads = Promise.all([
    document.fonts.load(`${o.nav.weight} 16px "Geist Variable"`, o.nav.items.projects?.label),
    document.fonts.load(`${o.tagline.weight} 44px "Geist Variable"`, o.tagline.text),
  ]).catch(() => undefined)
  await Promise.race([loads, new Promise((r) => setTimeout(r, timeoutMs))])
}

/** One bent element: where its local box sits in flat coords of its plane. */
interface Piece {
  el: HTMLElement
  plane: Plane
  /** flat (u, v) of the element's local origin (its top-left corner), CSS px */
  u0: number
  v0: number
  /** local box to fit the homography on, CSS px */
  box: [number, number, number, number]
  /** 'nav' | 'tag' — which parallax offset applies */
  group: 'nav' | 'tag'
  /** last transform written */
  css: string
  /** its screen corners from the last bend (debug: stats()) */
  quad?: Pt[]
}

/** A segment of the nav line: where it lies in the flat strip, and its progress fill. */
interface NavSeg {
  el: HTMLElement
  /** the part of this segment the scroll has passed (the segments that lead to a dot have one) */
  fill: HTMLElement | null
  /** flat u of its start and its flat length, CSS px */
  u: number
  len: number
  /** the strip shows it (it has a length and the line has a width) */
  shown: boolean
}

/** A nav word with its dot. */
interface NavWord {
  el: HTMLAnchorElement
  dot: HTMLElement
  /** flat u of its start; width of its box (with the tracking after the last letter) and of the visible word, CSS px, unrounded */
  u: number
  box: number
  vis: number
  /** index of the screen it leads to; −1 — an in-page link with no screen yet (inert); −2 — an ordinary link */
  stop: number
  /** the pos from which it is the current item (overlay.nav.items.<k>.from; by default half-way to its screen) */
  from: number
}

/** The docked nav in CSS px, everything that must be crisp already on the device-pixel grid. */
interface Dock {
  side: 1 | -1
  /** centre and left edge of the line, its width */
  x: number
  left: number
  width: number
  /** the rod's tail (bottom) end */
  tail: Pt
  /** per segment (head → tail): top and length */
  segTop: number[]
  segLen: number[]
  dot: number
  gap: number
  ring: number
  /** per word: the dot's centre y; the label's box (left, top, its real font size) and visible length */
  dotY: number[]
  labelLeft: number[]
  labelTop: number[]
  labelLen: number[]
  size: number
  /** line ↔ word gap at the docked type size, while the word still lies in the line */
  wordGap: number
  /** hit area: height; reach past the label's near end (over the dot) and past its far end */
  hit: number
  hitNear: number[]
  hitFar: number
  /** the whole column as drawn — labels, dots, line — stage CSS px, and each item (its dot + its label): what navDock publishes */
  box: { x: number; y: number; w: number; h: number; labels: { x: number; y: number; w: number; h: number }[] }
}

type Mode = 'strip' | 'flight' | 'dock'

export const createSkyOverlayLayer: LayerFactory = async (mount, ctx) => {
  const meta: Meta = await fetch(ASSET_DIR + 'meta.json').then((r) => r.json())

  // Two roots, each with its own place in the stage's stacking order (overlay.css; the mount itself
  // is not a stacking context on this page): the tagline right over the nearest clouds, the nav over
  // everything — the second screen's layers (veil, slab, project texts) go between the two.
  // Reading / tab order: the nav right after the h1, then the tagline.
  const navRoot = h('div', 'so-root so-root--nav')
  const tagRoot = h('div', 'so-root so-root--tag')
  mount.append(navRoot, tagRoot)

  const nav = h('nav', 'so-nav')
  nav.setAttribute('aria-label', 'Main')
  // under the nav: the reduced-motion panel (look() → backing), cut out of the dissolving checker
  const backPanel = h('div', 'so-backing')
  backPanel.setAttribute('aria-hidden', 'true')
  const tagText = h('p', 'so-tagline')
  // measures env(safe-area-inset-*): the docked nav keeps clear of a phone's notch
  const safe = h('i', 'so-safe')
  navRoot.append(backPanel, nav, safe)
  tagRoot.append(tagText)

  let navKey = ''
  /** the nav's line segments: lead, between each two words, tail */
  let segs: HTMLElement[] = []
  let links: HTMLAnchorElement[] = []
  let dots: HTMLElement[] = []
  let fills: HTMLElement[] = []
  /** per link: the screen it leads to (see NavWord.stop) */
  let stops: number[] = []

  /** A link to a screen of this page: its stop index, −1 when that screen does not exist yet; −2 for any other link. */
  const stopOf = (href: string) => (href.startsWith('#') && scrollControl.current ? scrollControl.current.indexOf(href.slice(1)) : -2)

  /** (Re)build the nav when its items change (tuner): line, word + dot, line, word + dot, …, line; then the fills. */
  function buildNav(items: NavItem[]) {
    const key = JSON.stringify(items.map((i) => [i.label, i.href]))
    if (key === navKey) return
    navKey = key
    nav.replaceChildren()
    segs = [h('div', 'so-line')]
    links = []
    dots = []
    fills = []
    stops = []
    nav.append(segs[0])
    for (const item of items) {
      const a = h('a', 'so-link')
      const stop = stopOf(item.href)
      if (stop === -1) {
        // its screen is not built yet: looks the same, does nothing, and the keyboard skips it
        a.setAttribute('role', 'link')
        a.setAttribute('aria-disabled', 'true')
      } else a.href = item.href
      a.textContent = item.label
      const dot = h('i', 'so-dot')
      dot.setAttribute('aria-hidden', 'true')
      const seg = h('div', 'so-line')
      links.push(a)
      dots.push(dot)
      stops.push(stop)
      segs.push(seg)
      const fill = h('i', 'so-progress')
      fill.setAttribute('aria-hidden', 'true')
      fills.push(fill)
      nav.append(a, dot, seg)
    }
    nav.append(...fills)
  }

  // A nav link scrolls the page there (core/scroll.ts → to()) instead of jumping.
  // The address still gets its #hash and a history entry, as a plain anchor would give it.
  nav.addEventListener('click', (e) => {
    // (a dot is part of its word's target: a click on it is a click on the link before it)
    const hit = (e.target as Element | null)?.closest?.('a.so-link, .so-dot')
    const a = (hit?.classList.contains('so-dot') ? hit.previousElementSibling : hit) as HTMLAnchorElement | null
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const control = scrollControl.current
    const hash = a.getAttribute('href') ?? ''
    if (!control || !hash.startsWith('#') || control.indexOf(hash.slice(1)) < 0) return
    e.preventDefault()
    const from = location.href
    // a history entry only when the address changes… The scroll makes it (core/scroll.ts → pushHash):
    // it first saves the exact place into the entry being left, then pushes the new one with the stop
    // it leads to for a place instead of a copy of the old one — a quick Back lands where the click
    // found the page, a Forward on the stop. (A scroll without pushHash: the plain push.)
    if (location.hash !== hash) {
      if (typeof control.pushHash === 'function') control.pushHash(hash)
      else history.pushState(history.state, '', hash)
    }
    // …but whoever follows the hash hears of EVERY activation (pushState is silent anyway): the
    // projects layer moves the focus to its heading — also on a second click from the hero, when
    // the address has said #projects all along
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: from, newURL: location.href }))
    control.to(hash.slice(1))
  })

  let pieces: Piece[] = []
  /** the veil's knobs (the page has one): where its cloud wall and its fog are decides the nav's ink */
  let veilKnobs: SkyLayersKnobs | null = null
  /** the veil's clouds that rise behind the nav before the fog (its wisp, its wall): where they are decides each piece's ink */
  let veilClouds: VeilCloud[] = []
  /** how much of what is under it a cloud must cover to count as white (overlay.nav.morph.ink.cover) */
  let inkCover = 0.3
  /** opacity of an inert word on the strip (overlay.nav.disabled), as place() read it */
  let stripOff = ''
  /** CSS px per texel of the current layout (the title's scale) */
  let scale = 1
  let rest: ReturnType<typeof titleRestMap>['toScreen'] = (x, y) => ({ x, y })
  /** bumped by every place(): forces the next update to rewrite the transforms */
  let placeRev = 0

  /** the nav strip as place() laid it out: its plane, flat length, type size, pieces */
  let navPlane: Plane | null = null
  let stripLen = 0
  let navSize = 16
  /** the line's local box: its v offset and height, CSS px */
  let lineV = 0
  let lineH = 1
  let navSegs: NavSeg[] = []
  let navWords: NavWord[] = []
  let dock: Dock | null = null
  /** which of its three states the nav's DOM is dressed for */
  let mode: Mode = 'strip'
  /** the nav has a line at all (overlay.nav.line.width > 0); the progress fill is complete at this share of the way to a screen */
  let lineOn = true
  let fillBy = 1

  /** The docked nav for this viewport: overlay.nav.dock in px, snapped to device pixels where it must be crisp. */
  function layDock(layout: Layout, n: Overlay['nav'], fluid: (px: number, f: number) => number): Dock {
    const d = n.dock
    const dpr = window.devicePixelRatio || 1
    const snap = (v: number) => Math.round(v * dpr) / dpr
    const px = (v: number) => fluid(v, d.fluid)
    const side = d.labelSide < 0 ? -1 : 1
    const count = navWords.length
    const size = Math.max(1, px(d.size))
    const ratio = size / navSize
    const labelLen = navWords.map((w) => w.vis * ratio)
    const labelGap = px(d.labelGap)
    const dot = Math.max(1, px(d.dot))
    const width = Math.max(1 / dpr, snap(d.lineWidth))
    // the line: `right` from the screen's edge (and its notch), but never so close that a label leaves the screen
    const longest = Math.max(0, ...labelLen)
    const room = side > 0 ? labelGap + longest + 8 : dot / 2 + 4
    const reach = side > 0 ? dot / 2 + 4 : labelGap + longest + 8
    const wantX = layout.width - safe.offsetWidth - Math.max(px(d.right), room)
    const left = snap(Math.max(wantX, reach) - width / 2)
    const x = left + width / 2
    const top = snap(px(d.top) + safe.offsetHeight)
    // along the line, top → bottom: lead, [gap dot gap], between, [gap dot gap], …, tail. Every line end on the pixel grid.
    const slot = snap(dot + 2 * px(d.gap))
    const between = Math.max(0, snap(px(d.step)) - slot)
    const segTop: number[] = []
    const segLen: number[] = []
    const dotY: number[] = []
    let y = top
    for (let i = 0; i <= count; i++) {
      segTop[i] = y
      segLen[i] = i === 0 ? snap(px(d.lead)) : i === count ? snap(px(d.tail)) : between
      y += segLen[i]
      if (i < count) {
        dotY[i] = y + slot / 2
        y += slot
      }
    }
    const step = count > 1 ? dotY[1] - dotY[0] : Infinity
    // never taller than the step: two neighbours' areas must not overlap
    const hit = Math.max(size, Math.min(d.hit, step))
    // the label starts on a whole pixel (as any text does); on the left of the line it ends `labelGap` before it
    const labelLeft = labelLen.map((len) => snap(side > 0 ? x + labelGap : x - labelGap - len))
    const labelTop = dotY.map((cy) => snap(cy - size / 2))
    // the column as drawn: every label's box, every dot, the line from its top to its tail (when it is shown)
    let bx0 = Infinity
    let by0 = Infinity
    let bx1 = -Infinity
    let by1 = -Infinity
    const grow = (x0: number, y0: number, x1: number, y1: number) => {
      bx0 = Math.min(bx0, x0)
      by0 = Math.min(by0, y0)
      bx1 = Math.max(bx1, x1)
      by1 = Math.max(by1, y1)
    }
    if (lineOn) grow(left, top, left + width, y)
    // per item: its dot and its label (the about canvas keeps a halo behind each — core/nav-dock.ts)
    const labels: { x: number; y: number; w: number; h: number }[] = []
    for (let j = 0; j < count; j++) {
      grow(x - dot / 2, dotY[j] - dot / 2, x + dot / 2, dotY[j] + dot / 2)
      grow(labelLeft[j], labelTop[j], labelLeft[j] + labelLen[j], labelTop[j] + size)
      const lx0 = Math.min(x - dot / 2, labelLeft[j])
      const lx1 = Math.max(x + dot / 2, labelLeft[j] + labelLen[j])
      const ly0 = Math.min(dotY[j] - dot / 2, labelTop[j])
      const ly1 = Math.max(dotY[j] + dot / 2, labelTop[j] + size)
      labels.push({ x: r2(lx0), y: r2(ly0), w: r2(lx1 - lx0), h: r2(ly1 - ly0) })
    }
    const box = Number.isFinite(bx0) ? { x: r2(bx0), y: r2(by0), w: r2(bx1 - bx0), h: r2(by1 - by0), labels } : { x, y: top, w: 0, h: 0, labels }
    return {
      side,
      x,
      left,
      width,
      tail: { x, y },
      segTop,
      segLen,
      dot,
      gap: (slot - dot) / 2,
      ring: Math.min(dot / 2, d.ring),
      dotY,
      labelLeft,
      labelTop,
      labelLen,
      size,
      wordGap: fluid(n.line.gap, n.fluid) * ratio,
      hit,
      // over the dot and a little past it
      hitNear: labelLen.map((len, j) => (side > 0 ? labelLeft[j] - x : x - labelLeft[j] - len) + dot / 2 + 6),
      hitFar: (hit - size) / 2,
      box,
    }
  }

  function place(layout: Layout, config: ResolvedConfig) {
    placeRev++
    // undress() below puts the strip's light ink back for the measuring: the colours the next bend()
    // dresses the nav in again go in at once, not as a fade from that light ink (see snapping)
    snap()
    const o = overlayOf(config)
    veilKnobs = 'veil' in config ? getSkyLayersKnobs(config, 'veil') : null
    // Its clouds that paint by themselves and stay where the knobs put them: not the plate, not what
    // lives in the void (afterFog), not a cloud too thin to hide a light letter, not one that travels
    // with the wind (where it is then is the renderer's own clock). The picture of each is the one
    // sky-layers picks.
    const tall = layout.height > 0 && layout.width / layout.height < (veilKnobs?.tallBelow ?? 1)
    inkCover = clamp(o.nav.morph.ink.cover, 0.05, 0.95)
    veilClouds = (veilKnobs?.layers ?? [])
      .filter(({ k }) => (k.kind === 'clouds' || k.kind === 'bank') && !k.afterFog && !k.drift.wrap && k.opacity >= inkCover)
      .map(({ name, k }) => ({ name, k, url: VEIL_ASSETS + (tall && k.srcTall ? k.srcTall : k.src) }))
      .filter((c) => !c.url.endsWith('/'))
    const map = titleRestMap(meta, layout, Math.max(0.05, config.title.perspective))
    scale = map.scale
    rest = map.toScreen
    const s = scale
    const [bx0, , bx1] = meta.bbox
    const texelX = (f: number) => bx0 + f * (bx1 - bx0)
    const refW = layout.isMobile ? 390 : 1440
    const fluid = (px: number, f: number) => px * Math.pow(layout.width / refW, f)
    const next: Piece[] = []

    // ── nav: its line starts `above` title heights over the title's top edge at `from` ──
    const n = o.nav
    const items = Object.values(n.items) as NavItem[]
    buildNav(items)
    // An item whose screen does not exist yet is dimmed on the strip too (docked: dock.disabled).
    stripOff = String(n.disabled)
    // the strip is measured in its own dress: undo what the dock put on (it is put back by the next update)
    undress()
    navSize = fluid(n.size, n.fluid)
    Object.assign(nav.style, {
      fontSize: `${navSize}px`,
      fontWeight: String(n.weight),
      letterSpacing: `${n.tracking}em`,
    })
    nav.style.setProperty('--so-ink', n.color)
    nav.style.setProperty('--so-line-w', `${n.line.width}px`)
    nav.style.setProperty('--so-line-a', String(n.line.opacity))
    nav.style.setProperty('--so-link-a', String(n.opacity))
    nav.style.setProperty('--so-hover-a', String(n.hover.opacity))
    nav.style.setProperty('--so-glow', String(n.hover.glow))
    nav.style.setProperty('--so-hit', `${n.hit}em`)
    nav.style.setProperty('--so-ink-t', `${Math.max(0, Math.round(n.morph.ink.time * 1000))}ms`)

    const x0 = texelX(n.from)
    const top0 = titleEdgeY(meta, 'top', x0)
    const navP = makePlane(meta, x0, top0 - n.above * (titleEdgeY(meta, 'bottom', x0) - top0), n.foreshorten)
    // the flat strip, origin = `from`: [lead][gap] word [gap][seg][gap] word … word [gap][tail].
    // Its length is where `to` lands on the plane; the segments between words share what the words
    // and gaps leave (equal in the plane → shorter and shorter on screen), lead / tail are fractions of one.
    const gap = fluid(n.line.gap, n.fluid)
    const lw = Math.max(0, n.line.width)
    const track = n.tracking * navSize
    // the word's box includes letter-spacing after its last letter: not part of the visible word
    const widths = links.map((a) => Math.max(1, a.offsetWidth - track))
    const total = s * flatXAt(navP, texelX(n.to))
    const nW = links.length
    const shares = Math.max(1e-3, n.line.lead + Math.max(0, nW - 1) + n.line.tail)
    const segLen = Math.max(0, (total - 2 * nW * gap - widths.reduce((a, b) => a + b, 0)) / shares)
    const strip: NavSeg[] = []
    const words: NavWord[] = []
    let u = 0
    const line = (el: HTMLElement, len: number) => {
      el.style.width = `${len}px`
      el.style.display = len > 0.5 && lw > 0 ? '' : 'none'
      if (len > 0.5 && lw > 0) next.push({ el, plane: navP, u0: u, v0: -lw / 2, box: [0, 0, len, Math.max(1, lw)], group: 'nav', css: '' })
      strip.push({ el, fill: fills[strip.length] ?? null, u, len, shown: len > 0.5 && lw > 0 })
      u += len
    }
    line(segs[0], segLen * n.line.lead)
    links.forEach((a, i) => {
      u += gap
      // line-height 1 → the box is one em tall, caps centred on the line (v = 0)
      next.push({ el: a, plane: navP, u0: u, v0: -navSize / 2, box: [0, 0, a.offsetWidth, navSize], group: 'nav', css: '' })
      // the same box unrounded (offsetWidth is a whole number): the docked label is placed to the pixel
      const box = parseFloat(getComputedStyle(a).width) || a.offsetWidth
      // current from its own `from`, or from half-way to its screen (what round(pos) would say)
      const item = items[i] as NavItem & { from?: unknown }
      const from = num(item?.from, stops[i] - 0.5)
      words.push({ el: a, dot: dots[i], u, box, vis: Math.max(1, box - track), stop: stops[i], from })
      u += widths[i] + gap
      line(segs[i + 1], i < nW - 1 ? segLen : segLen * n.line.tail)
    })
    navPlane = navP
    stripLen = u
    lineOn = lw > 0
    fillBy = clamp(n.dock.fillBy, 0.05, 1)
    lineV = -lw / 2
    lineH = Math.max(1, lw)
    navSegs = strip
    navWords = words
    dock = lw > 0 || nW > 0 ? layDock(layout, n, fluid) : null
    // published already: the new column at once (a reader that runs before the next update must not see the old viewport's)
    if (navDock.current) navDock.current = dock?.box ?? null
    if (dock) {
      nav.style.setProperty('--so-dot', `${dock.dot}px`)
      nav.style.setProperty('--so-ring', `${dock.ring}px`)
    }

    // ── tagline: its top-left corner `below` title heights under the title's bottom edge at `along` ──
    const t = o.tagline
    if (tagText.textContent !== t.text) tagText.textContent = t.text
    Object.assign(tagText.style, {
      color: t.color,
      opacity: String(t.opacity),
      fontSize: `${fluid(t.size, t.fluid)}px`,
      fontWeight: String(t.weight),
      lineHeight: String(t.leading),
      letterSpacing: `${t.tracking}em`,
      textShadow: t.shadow > 0 ? `0 0 0.45em rgba(24, 40, 68, ${t.shadow})` : 'none',
    })
    const xt = texelX(t.along)
    const bot = titleEdgeY(meta, 'bottom', xt)
    const tagP = makePlane(meta, xt, bot + t.below * (bot - titleEdgeY(meta, 'top', xt)), t.foreshorten)
    // layout size (transforms do not change it); re-measured when the fonts arrive
    const tw = Math.max(1, tagText.offsetWidth)
    const th = Math.max(1, tagText.offsetHeight)
    next.push({ el: tagText, plane: tagP, u0: 0, v0: 0, box: [0, 0, tw, th], group: 'tag', css: '' })

    pieces = next
  }

  // ── the nav's three states ──

  /** Back to the strip's own inline styles (what place() measures and the hero shows). */
  function undress() {
    mode = 'strip'
    nav.classList.remove('is-flying', 'is-docked')
    nav.style.removeProperty('opacity')
    nav.style.removeProperty('--so-fill-a')
    links.forEach((a, i) => {
      a.style.fontSize = a.style.letterSpacing = a.style.color = ''
      for (const p of ['--so-halo', '--so-hit-y', '--so-hit-s', '--so-hit-e']) a.style.removeProperty(p)
      // an inert word: its own, dimmer opacity (the others inherit the nav's --so-link-a)
      if (stops[i] === -1 && stripOff) a.style.setProperty('--so-link-a', stripOff)
      else a.style.removeProperty('--so-link-a')
    })
    for (const d of dots) {
      d.style.color = d.style.transform = d.style.visibility = ''
      d.style.removeProperty('--so-link-a')
    }
    for (const sg of navSegs) {
      sg.el.style.width = `${sg.len}px`
      sg.el.style.height = sg.el.style.color = sg.el.style.boxShadow = ''
      sg.el.style.display = sg.shown ? '' : 'none'
      if (sg.fill) sg.fill.style.cssText = ''
    }
  }

  /** Dress the DOM for a state: sizes and typography only — the transforms follow in fly() / park(). */
  function dress(next: Mode, o: Overlay) {
    if (next === mode) return
    undress()
    mode = next
    if (next === 'strip' || !dock) {
      // the strip's transforms were overwritten: have bend() write them again
      for (const pc of pieces) if (pc.group === 'nav') pc.css = ''
      nav.style.setProperty('--so-ink', o.nav.color)
      nav.style.setProperty('--so-line-a', String(o.nav.line.opacity))
      return
    }
    nav.classList.add(next === 'dock' ? 'is-docked' : 'is-flying')
    for (const sg of navSegs) {
      sg.el.style.display = lineOn ? '' : 'none'
      if (next === 'flight' && !sg.shown) sg.el.style.width = `${UNIT}px`
    }
    if (next === 'dock') {
      navSegs.forEach((sg, i) => {
        sg.el.style.width = `${dock!.width}px`
        sg.el.style.height = `${dock!.segLen[i]}px`
      })
      for (const a of links) {
        a.style.fontSize = `${dock.size}px`
        // the nav's letter-spacing is inherited in px: say it again in em of the label's own size
        a.style.letterSpacing = `${o.nav.tracking}em`
      }
    }
  }

  const follow = { nav: new Follower(), tag: new Follower() }
  const offset = { nav: { x: 0, y: 0 }, tag: { x: 0, y: 0 } }
  let lastKey = ''
  let lastNavKey = ''
  let lastLookKey = ''
  /** reduced motion: where the cross-fade between the strip (0) and the dock (1) is; −1 — not started */
  let swap = -1
  let swapTo = 0
  let tagHidden = false
  /** where every segment and word is on screen, as last drawn off the strip (the ink goes by the white under each; a dot follows its word, a fill its segment) */
  const spots: { segs: Spot[]; words: Spot[] } = { segs: [], words: [] }
  /** …and which of them are in the dark ink now */
  const dark: { segs: boolean[]; words: boolean[] } = { segs: [], words: [] }
  /** the nav inverts what is under it (on the ABOUT sheet: .so-invert, mix-blend-mode difference); the ink it does it with */
  let inverted = false
  let invertInk = ''
  /**
   * This frame's colours (and opacities, halos) go in without their CSS fades (.so-snap; taken in and
   * lifted at the end of bend): the blend just flipped, the page jumped (JUMP), or place() has just
   * re-laid the nav out — it undresses the DOM to measure the strip, and the dock dressed again over
   * that faded from the strip's light ink to the dark one: 260 ms of pale letters on the white after
   * every resize, font load or tuner edit.
   */
  let snapping = false
  const snap = () => {
    if (snapping) return
    snapping = true
    navRoot.classList.add('so-snap')
  }
  /**
   * pos moved this much in one frame (sections): not a hand, an instant jump — a pinned value, Back /
   * Forward, a #hash landing, a reload (the hand's own speed is capped at scroll.maxSpeed, ≤ 0.3 even
   * in a 0.1 s frame). The nav's colours are simply there, as everything else is after a jump.
   */
  const JUMP = 0.3
  /** pos at the last bend (null — none yet) */
  let lastPos: number | null = null
  /** the rod of the last flight (debug: stats()) */
  let rod: Rod | null = null

  /** the middle line of a quad (TL, TR, BR, BL): from the middle of its left side to the middle of its right */
  const spotOf = (q: Quad): Spot => ({ ax: (q[0].x + q[3].x) / 2, ay: (q[0].y + q[3].y) / 2, bx: (q[1].x + q[2].x) / 2, by: (q[1].y + q[2].y) / 2 })
  const setTransform = (el: HTMLElement, css: string) => {
    if (el.style.transform !== css) el.style.transform = css
  }
  const setVar = (el: HTMLElement, name: string, value: string) => {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
  }
  const r2 = (v: number) => +v.toFixed(2)
  const r3 = (v: number) => +v.toFixed(3)

  /** In flight: every nav element onto its quad of the rod. `at` — flat strip (u, v) → screen, this frame. */
  function fly(M: number, o: Overlay, at: (u: number, v: number) => Pt, pos: number) {
    const d = dock!
    const m = o.nav.morph
    const head = at(0, 0)
    const tail0 = at(stripLen, 0)
    const angle0 = Math.atan2(tail0.y - head.y, tail0.x - head.x)
    const u0 = dir(angle0)
    const box = (ua: number, ub: number, v: number, hgt: number): Quad => [at(ua, v), at(ub, v), at(ub, v + hgt), at(ua, v + hgt)]
    rod = solveRod(
      tail0,
      angle0,
      navSegs.map((sg, i) => ({ from: lying(box(sg.u, sg.u + sg.len, lineV, lineH), tail0, u0), len: d.segLen[i], width: d.width })),
      navWords.map((w, j) => ({
        from: lying(box(w.u, w.u + w.vis, -navSize / 2, navSize), tail0, u0),
        len: d.labelLen[j],
        size: d.size,
        at: { x: d.labelLeft[j] + d.labelLen[j] / 2, y: d.labelTop[j] + d.size / 2 },
        gap: d.wordGap,
      })),
      { tail: d.tail, dot: d.dot, gap: d.gap, side: d.side },
      { M, reel: m.reel, stand: m.stand, stagger: m.stagger, lift: m.lift },
    )
    const r = rod
    navSegs.forEach((sg, i) => {
      const q = r.segs[i].quad
      setTransform(sg.el, rectToQuad(0, 0, sg.shown ? sg.len : UNIT, lineH, q[0], q[1], q[2], q[3]))
      spots.segs[i] = spotOf(q)
    })
    // the words' centres and their common baseline direction: how much room each has across it
    const centres = r.words.map(({ quad: q }) => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 }))
    navWords.forEach((w, j) => {
      const rw = r.words[j]
      const q = rw.quad
      setTransform(w.el, rectToQuad(0, 0, w.vis, navSize, q[0], q[1], q[2], q[3]))
      spots.words[j] = spotOf(q)
      setTransform(w.dot, `translate(${r2(rw.anchor.x)}px,${r2(rw.anchor.y)}px) scale(${r3(rw.dot / d.dot)})`)
      w.dot.style.visibility = rw.dot > 0.01 ? '' : 'hidden'
      // hit area, in the link's local px: from the strip's (overlay.nav.hit, em) to the docked one, on screen
      const sx = rw.len / w.vis
      const sy = rw.size / navSize
      const em = o.nav.hit * navSize
      const near = lerp(0.6 * em * sx, d.hitNear[j], r.b) / sx
      const far = lerp(0.6 * em * sx, d.hitFar, r.b) / sx
      // …and never taller than the room to the next word: half-way each, so no word's area eats its neighbour's
      const bx = (q[1].x - q[0].x) / (rw.len || 1)
      const by = (q[1].y - q[0].y) / (rw.len || 1)
      let room = Infinity
      for (const k of [j - 1, j + 1]) {
        if (!r.words[k]) continue
        const dx = centres[k].x - centres[j].x
        const dy = centres[k].y - centres[j].y
        // only words stacked one over the other compete for height; side by side (as on the strip) they do not
        if (Math.abs(dx * bx + dy * by) < (rw.len + r.words[k].len) / 2) room = Math.min(room, Math.abs(dx * by - dy * bx))
      }
      const y = Math.min(lerp(em * sy, (d.hit - d.size) / 2, r.b), Math.max(0, (room - rw.size) / 2)) / sy
      setVar(w.el, '--so-hit-y', `${r2(-y)}px`)
      setVar(w.el, '--so-hit-s', `${r2(-(d.side > 0 ? near : far))}px`)
      // the box ends with the tracking after the last letter: the far side starts from the visible word
      setVar(w.el, '--so-hit-e', `${r2(-(d.side > 0 ? far : near) + (w.box - w.vis))}px`)
    })
    // progress: the passed part of each segment that leads to a dot, from its head end
    const side2 = dir(r.angle + Math.PI / 2)
    navSegs.forEach((sg, i) => {
      if (!sg.fill) return
      const f = fillOf(i, pos)
      const s = r.segs[i]
      const len = s.len * f
      const c = { x: r.tail.x - r.u.x * (s.near + s.len - len / 2), y: r.tail.y - r.u.y * (s.near + s.len - len / 2) }
      const q = para(c, { x: r.u.x * len, y: r.u.y * len }, { x: side2.x * s.width, y: side2.y * s.width })
      const on = f > 0 && r.b > 0.9 && lineOn
      sg.fill.style.visibility = on ? '' : 'hidden'
      if (on) setTransform(sg.fill, rectToQuad(0, 0, UNIT, 1, q[0], q[1], q[2], q[3]))
    })
  }

  /** Docked: plain boxes on whole pixels. Written once; only the progress fill follows the scroll. */
  function park(pos: number, fresh: boolean) {
    const d = dock!
    if (fresh) {
      spots.segs = d.segTop.map((top, i) => ({ ax: d.x, ay: top, bx: d.x, by: top + d.segLen[i] }))
      spots.words = d.dotY.map((y, j) => ({ ax: d.labelLeft[j], ay: y, bx: d.labelLeft[j] + d.labelLen[j], by: y }))
      navSegs.forEach((sg, i) => setTransform(sg.el, `translate(${d.left}px,${d.segTop[i]}px)`))
      navWords.forEach((w, j) => {
        setTransform(w.el, `translate(${d.labelLeft[j]}px,${d.labelTop[j]}px)`)
        setTransform(w.dot, `translate(${d.x}px,${d.dotY[j]}px)`)
        w.dot.style.visibility = ''
        setVar(w.el, '--so-hit-y', `${r2(-(d.hit - d.size) / 2)}px`)
        const tail = (w.box - w.vis) * (d.size / navSize)
        setVar(w.el, '--so-hit-s', `${r2(-(d.side > 0 ? d.hitNear[j] : d.hitFar))}px`)
        setVar(w.el, '--so-hit-e', `${r2(-(d.side > 0 ? d.hitFar : d.hitNear[j]) + tail)}px`)
      })
    }
    navSegs.forEach((sg, i) => {
      if (!sg.fill) return
      const f = lineOn ? fillOf(i, pos) : 0
      sg.fill.style.visibility = f > 0 ? '' : 'hidden'
      if (fresh) {
        sg.fill.style.width = `${d.width}px`
        sg.fill.style.height = `${d.segLen[i]}px`
      }
      if (f > 0) setTransform(sg.fill, `translate(${d.left}px,${d.segTop[i]}px) scaleY(${r3(f)})`)
    })
  }

  /**
   * How much of segment i (the one that leads to word i's dot) the scroll has passed: from the previous
   * screen to this one — full a little before the page gets there (fillBy), like everything else on a screen.
   */
  function fillOf(i: number, pos: number) {
    const stop = navWords[i]?.stop ?? -1
    if (stop < 1) return 0
    let prev = 0
    for (let j = 0; j < i; j++) if (navWords[j].stop > prev && navWords[j].stop < stop) prev = navWords[j].stop
    return remap(pos, prev, prev + (stop - prev) * fillBy)
  }

  /** a veil cloud on screen this frame: the picture's left side, top row and width, px; its edges (null: one flat `crest`) */
  interface Placed {
    c: VeilCloud
    left: number
    top: number
    width: number
    edge: ReturnType<typeof silhouetteOf>
  }
  const span: [number, number] = [0, 0]

  /**
   * Where the veil's clouds are this frame. The renderer says where it drew each of them
   * (core/veil-clouds.ts): its box has the wind's sway and the layer's own inertia in it — the two
   * things nobody outside can know. That box is one frame old (the veil draws after the nav), so the
   * scroll's rise — the fast part — is brought up to this frame from the knobs.
   * While the veil has not drawn (it sleeps on the hero, its context is lost, the DOM stand-in plays
   * it) the box is worked out here, from the veil's own knobs: the same rise (sky-layers/params.ts →
   * riseOf), the same size and place the renderer gives each picture (sky-layers/index.ts →
   * sizeOf() and the placement in its draw loop), only without the wind — ink.lead covers that.
   * Either way the ink follows the clouds however they are re-timed or moved. The SHAPE of each is
   * its picture's own (cloud-edge.ts).
   */
  function placeClouds(frame: Frame): Placed[] {
    if (!veilKnobs) return []
    const W = lastLayout.width
    const H = lastLayout.height
    const world = frame.config.world
    const base = Math.min(W, H * Math.max(0.5, veilKnobs.designAspect))
    const par = Math.abs(world.parallax) * Math.max(1, frame.config.motion.intensity) * 1.15
    const drawn = veilBoxes.current && performance.now() - veilBoxes.at < VEIL_CLOUDS_FRESH ? veilBoxes.current : null
    const out: Placed[] = []
    for (const c of veilClouds) {
      const k = c.k
      // a pixel of the picture is "white behind" when it covers at least `inkCover` of what is under it
      const edge = silhouetteOf(c.url, inkCover / Math.min(1, k.opacity))
      // until its picture is read only the wall is known, as one height (ink.crest)
      if (!edge && c.name !== VEIL_WALL) continue
      const box = drawn?.find((b) => b.name === c.name)
      if (box) {
        out.push({ c, left: box.left, top: box.top + box.rise - riseOf(k, frame.scroll, H), width: box.width, edge })
        continue
      }
      let width = (base * k.width) / 100
      const x0 = (W * k.x) / 100
      // the cover rule: a bank is never narrower than the screen plus everything that can move it
      if (k.kind === 'bank' || (k.front && k.width >= 100)) {
        const reach = par * Math.abs(k.depth) + Math.abs(k.drift.range) + Math.max(0, k.billow.amount) + 1
        const ax = clamp(k.anchor.x, 0.05, 0.95)
        width = Math.max(width, (x0 + reach) / ax, (W - x0 + reach) / (1 - ax))
      }
      out.push({
        c,
        // lifted by the scroll, nudged by the pointer like the layer itself
        left: x0 - k.anchor.x * width - frame.pointer.x * world.parallax * k.depth,
        top: (H * k.y) / 100 - k.anchor.y * width * (edge?.ratio ?? 0) - frame.pointer.y * world.parallax * k.depth - riseOf(k, frame.scroll, H),
        width,
        edge,
      })
    }
    return out
  }

  /**
   * The white under a piece of the nav: the veil's clouds rising from below — the wisp that goes
   * first, then the wall. The piece is looked at along its middle line:
   *   share — of it that lies on a cloud, or within `slack` px of one (0 … 1);
   *   gap   — how far it is from the nearest cloud on average, px (negative: inside one).
   * The wall goes on down for good; a cloud like the wisp has a lower edge too and passes.
   * Until the wall's picture is read (or if it cannot be) `crest` stands in for its edge: one height
   * for the whole wall (overlay.nav.morph.ink.crest). No clouds in the config → no white from them
   * (the fog alone decides).
   */
  function whiteUnder(clouds: Placed[], crest: number, at: Spot, slack: number) {
    let under = 0
    let gap = 0
    for (let i = 0; i < INK_SAMPLES; i++) {
      const t = i / (INK_SAMPLES - 1)
      const x = lerp(at.ax, at.bx, t)
      const y = lerp(at.ay, at.by, t)
      let near = Infinity
      for (const p of clouds) {
        const bank = p.c.k.kind === 'bank'
        if (p.edge) cloudAt(p.edge, (x - p.left) / p.width, p.c.k.flipX, bank, span)
        else span[0] = span[1] = crest
        if (!bank && span[0] > span[1]) continue
        const above = p.top + span[0] * p.width - y
        // a bank has no lower edge: under its picture it goes on (its last row, or its mirror image)
        near = Math.min(near, bank ? above : Math.max(above, y - (p.top + span[1] * p.width)))
      }
      if (near <= slack) under++
      gap += near
    }
    return { share: under / INK_SAMPLES, gap: gap / INK_SAMPLES }
  }

  /**
   * On ABOUT the nav inverts what is under it (.so-invert, mix-blend-mode difference) with ONE constant
   * ink, dock.invertInk = (the void under the nav) − dock.ink, channel by channel. The blend gives
   * |under − invertInk|: over the void that is dock.ink exactly — the nav looks as on the projects
   * screen, its opacities included (a word at opacity a shows void + a·(ink − void) either way), so
   * the switch at about.pull.from does not show — and over the black concrete letters it turns light
   * by itself. The void under the nav is then invertInk + ink: the colour of the reduced-motion
   * backing panel (look()), 'r, g, b'.
   */
  function voidUnderNav(n: Overlay['nav']) {
    const ink = rgbArr(n.dock.ink)
    return rgbArr(n.dock.invertInk)
      .map((v, i) => Math.min(255, v + ink[i]))
      .join(', ')
  }

  /**
   * The current item: the live word with the largest screen whose own `from` the scroll has passed
   * (overlay.nav.items.<k>.from; by default half-way to its screen, as round(pos) would say) — ABOUT
   * stays current through its tour (pos 3, 'about-end', has no word of its own); on the hero none.
   * −1: none.
   */
  function currentOf(pos: number) {
    let cur = -1
    navWords.forEach((w, j) => {
      if (w.stop >= 0 && pos >= w.from && (cur < 0 || w.stop > navWords[cur].stop)) cur = j
    })
    return cur
  }

  /**
   * Colours, opacities and the current item. `M` — the morph position, `w` — how much of a dock the
   * nav is (0 strip … 1).
   * The ink is per piece: the white comes from below (the veil's cloud wall), so every word and
   * segment (with its dot, its fill) goes dark as the white reaches IT — where it is on screen, under
   * the wall's own uneven edge (whiteUnder), not at one height for the whole nav. A piece is either
   * light or dark; the change itself is a short CSS transition, so a page that stops half-way never
   * rests on a grey that reads on neither.
   * On ABOUT nothing is chosen: the nav inverts what is under it with one constant ink (voidUnderNav).
   */
  function look(frame: Frame, o: Overlay, M: number, w: number, fade: number) {
    const n = o.nav
    const d = n.dock
    const ink = n.morph.ink
    const off = n.disabled
    const morph = n.morph
    const haloDark = rgbOf(morph.haloDark)
    const haloLight = rgbOf(morph.haloLight)
    const sc = frame.scroll
    const H = lastLayout.height
    // On ABOUT (from where its pull starts on) the nav inverts what is under it — and on the loading
    // stand-in (a flat sheet of veil.color) while a page opened on ABOUT is still loading (the about
    // stop's section on, as styles.css says it with data-section, until html[data-hero-full]): the
    // constant ink makes it dark over that light sheet, as over the void. Below that, everything as
    // it was: the veil's logic.
    const sheetFrom = sheetFromOf(frame.config, sc.reduced)
    const aboutStop = scrollControl.current?.indexOf('about') ?? -1
    const loading = aboutStop >= 0 && sc.section >= aboutStop && !document.documentElement.hasAttribute('data-hero-full')
    // Reduced motion: the ABOUT scene dissolves in over the void as a fine Bayer checker (¼ ½ ¾ 1 — the
    // camera's `dissolve`, about.pull.reduced). An inverted label over a checker of black letter is a
    // checker of the opposite phase — the same mean grey as around it, it vanishes; so is a plain dark
    // one over ½ or ¾ black. For the whole dissolve (¼, ½ AND ¾) the nav keeps the dark ink and stands
    // on its backing (see `backing`: a patch of the void under the nav, under every label, dot and the
    // line); it inverts only once the scene is all there (dissolve 1). Over the bare void the two look
    // the same (the constant ink), so the change does not show.
    const held = sc.reduced && sc.pos >= sheetFrom && sc.pos < 2 && aboutCameraAt(frame.config, frame.layout, sc).dissolve < 1
    const invert = mode !== 'strip' && ((sc.pos >= sheetFrom && !held) || loading)
    if (invert !== inverted) {
      inverted = invert
      navRoot.classList.toggle('so-invert', invert)
      // the blend flips in this frame: the colours flip with it, without their fade (see bend)
      snap()
    }
    // (off the strip only: the clouds' pictures are first asked for when the nav leaves the hero, not with the hero's own)
    const clouds = mode === 'strip' || invert ? [] : placeClouds(frame)
    // …or the whiteout is far enough along to have lightened everything (the whole transition under reduced motion)
    const fogged = !invert && !!veilKnobs && fogOf(veilKnobs, sc) >= ink.fog
    // a piece changes a little before the white is level with it: light letters must never meet the white
    const lead = ink.lead * H
    const band = Math.max(1, ink.band * H)
    const flip = (was: boolean, at: Spot) => {
      if (mode === 'strip') return false
      // going back up, a little later than it came: no flicker around the line (a pinned debug value is a pure function)
      return fogged || whiteUnder(clouds, ink.crest, at, lead + (was && !sc.pinned ? ink.back * H : 0)).share >= 0.5
    }
    dark.segs.length = navSegs.length
    dark.words.length = navWords.length
    // inverted: one ink for all — the blend makes it dark over the void and light over the black, per pixel
    navSegs.forEach((_, i) => (dark.segs[i] = !invert && flip(!!dark.segs[i], spots.segs[i] ?? NOWHERE)))
    navWords.forEach((_, j) => (dark.words[j] = !invert && flip(!!dark.words[j], spots.words[j] ?? NOWHERE)))
    // the light ink: over the sky the nav's own colour; inverting, the constant ink of the blend
    invertInk = invert ? d.invertInk : ''
    const light = invert ? invertInk : n.color
    // Off the plane the letters cross whatever the sky does (a wisp of cloud passes before the wall): light
    // ones carry a soft dark halo, as the tagline does; dark ones a light one until the white is well past them.
    // (Inverting, no halo: the blend would turn it into a light smudge over the white.)
    const under = mode === 'flight' && !invert ? r2(d.halo * smooth(remap(M, 0, Math.max(1e-3, morph.haloIn)))) : 0
    const halos = navWords.map((_, j) => {
      if (!dark.words[j] || mode !== 'flight') return under
      if (fogged) return 0
      return r2(d.halo * remap(whiteUnder(clouds, ink.crest, spots.words[j] ?? NOWHERE, lead).gap, -band, lead))
    })
    // …and while the reduced-motion checker holds the inversion back: the dark ink alone is masked by
    // the fine pattern (the dimmed labels all but vanish in it), so the whole column — labels, dots,
    // line — stands on a panel in the colour of the void under the nav (invertInk + ink: over the bare
    // void it does not show; dock.checkerHalo — its opacity), cut out of the checker. (A halo of light
    // rims round the letters was tried first: blurred, it is too thin between the strokes, and the
    // checker's dots ran right through the words.)
    const backing = held && mode === 'dock' ? r2(clamp01(d.checkerHalo)) : 0
    const panel = backing > 0 ? voidUnderNav(n) : ''
    const cur = currentOf(sc.pos)
    const key = `${placeRev}|${mode}|${invert}|${light}|${dark.segs}|${dark.words}|${halos}|${under}|${r3(w)}|${cur}|${r3(fade)}|${backing}|${panel}`
    if (key === lastLookKey) return
    lastLookKey = key
    if (fade < 1) nav.style.opacity = String(r3(fade))
    else nav.style.removeProperty('opacity')
    if (backing > 0 && dock) {
      // the column as drawn, a little more than half the label size round it, on whole px — plus the
      // feather its edge fades out over (overlay.css → .so-backing: the void under it is not flat)
      const feather = Math.max(8, Math.round(dock.size * 1.1))
      const pad = Math.max(8, Math.round(dock.size * 0.8)) + feather
      const b = dock.box
      const x0 = Math.floor(b.x - pad)
      const y0 = Math.floor(b.y - pad)
      backPanel.style.setProperty('--so-feather', `${feather}px`)
      Object.assign(backPanel.style, {
        display: 'block',
        transform: `translate(${x0}px,${y0}px)`,
        width: `${Math.ceil(b.x + b.w + pad) - x0}px`,
        height: `${Math.ceil(b.y + b.h + pad) - y0}px`,
        background: `rgba(${panel}, ${backing})`,
        opacity: fade < 1 ? String(r3(fade)) : '',
      })
    } else if (backPanel.style.display !== 'none') backPanel.style.display = 'none'
    navWords.forEach((word, j) => {
      const current = j === cur
      if (current) word.el.setAttribute('aria-current', 'true')
      else word.el.removeAttribute('aria-current')
      word.dot.classList.toggle('is-current', current)
      if (mode === 'strip') return
      // From what the strip had to what the dock wants. An inert word starts from its dimmed strip
      // value; a live word that has turned dark starts from full ink — the strip's opacity is for
      // light letters on the sky, and dark ones at 0.75 over the cloud wall read 3.3–3.9 : 1.
      const from = word.stop === -1 ? off : dark.words[j] ? 1 : n.opacity
      const a = String(r3(lerp(from, current ? 1 : word.stop === -1 ? d.disabled : d.idle, w)))
      setVar(word.el, '--so-link-a', a)
      setVar(word.dot, '--so-link-a', a)
      // the dot takes its word's ink
      const color = dark.words[j] ? d.ink : light
      if (word.el.style.color !== color) word.el.style.color = color
      if (word.dot.style.color !== color) word.dot.style.color = color
      // a soft cloud of it plus a tight rim: the rim is what keeps a light letter's edge on a white wisp
      const tone = dark.words[j] ? haloLight : haloDark
      // (on the reduced-motion panel: none — dark ink on the void's white, as on the projects screen)
      if (halos[j] > 0 && backing <= 0) setVar(word.el, '--so-halo', `0 0 0.5em rgba(${tone}, ${halos[j]}), 0 0 0.14em rgba(${tone}, ${r2(halos[j] * 0.9)})`)
      else word.el.style.removeProperty('--so-halo')
    })
    // --so-ink: what anything else in the nav inherits — dark once the whole nav is
    const allDark = dark.segs.every(Boolean) && dark.words.every(Boolean)
    setVar(nav, '--so-ink', mode !== 'strip' && allDark ? d.ink : light)
    if (mode === 'strip') return
    navSegs.forEach((sg, i) => {
      // the fill (the passed part) takes its segment's ink
      const color = dark.segs[i] ? d.ink : light
      if (sg.el.style.color !== color) sg.el.style.color = color
      if (sg.fill && sg.fill.style.color !== color) sg.fill.style.color = color
      // the light line gets the same dark breath as the light letters
      const halo = dark.segs[i] || under <= 0 ? '' : `0 0 5px rgba(${haloDark}, ${under})`
      if (sg.el.style.boxShadow !== halo) sg.el.style.boxShadow = halo
    })
    setVar(nav, '--so-line-a', String(r3(lerp(n.line.opacity, d.line, w))))
    setVar(nav, '--so-fill-a', String(r3(d.progress * remap(w, 0.9, 1))))
  }

  /** texel → screen: rest pose blended with the title's live one (overlay.turn), plus the group's parallax */
  function bend(frame: Frame) {
    const o = overlayOf(frame.config)
    const live = titlePose.current
    const turn = live ? clamp(o.turn, 0, 1) : 0
    for (const g of ['nav', 'tag'] as const) {
      const k = g === 'nav' ? o.nav : o.tagline
      const f = follow[g].step(frame.pointer, frame.dt, frame.config.motion, k.mass)
      const par = frame.config.world.parallax * k.depth
      offset[g].x = +(-f.x * par).toFixed(2)
      offset[g].y = +(-f.y * par).toFixed(2)
    }

    // ── where the nav is between the strip and the dock ──
    const sc = frame.scroll
    // an instant jump (JUMP): this frame's colours without their fades — Back from the about sheet
    // to the projects screen must not show the sheet's light ink fading to dark over the white
    const jumped = lastPos !== null && Math.abs(sc.pos - lastPos) >= JUMP
    if (jumped) snap()
    lastPos = sc.pos
    let M = dock ? remap(sc.pos, o.nav.morph.from, o.nav.morph.to) : 0
    let fade = 1
    if (sc.reduced && dock) {
      // no flight: past the middle the strip fades out, the dock fades in (and back), on a clock
      // (overlay.nav.morph.reduced: where, with what hysteresis, how long)
      const rm = o.nav.morph.reduced
      swapTo = swapTo ? (M > Math.min(rm.at, rm.back) ? 1 : 0) : M >= rm.at ? 1 : 0
      // (there already: no step — a step "back" from swap === swapTo was taken every other frame, and
      // the docked nav at rest flickered between opacity 1 and ≈ 0.97, re-styled on every frame)
      // (after a jump the swap is simply done, like everything else on the page: no light strip fading
      // out over the white of the projects screen)
      swap = swap < 0 || rm.time <= 0 || jumped ? swapTo : swap === swapTo ? swap : clamp01(swap + ((swapTo > swap ? 1 : -1) * frame.dt) / rm.time)
      if (Math.abs(swap - swapTo) < 1e-3) swap = swapTo
      M = swap < 0.5 ? 0 : 1
      fade = smooth(Math.abs(2 * swap - 1))
    } else swap = -1
    const next: Mode = M <= 0 ? 'strip' : M >= 1 ? 'dock' : 'flight'
    const fresh = next !== mode
    dress(next, o)

    // the tagline lies under the veil: once the hero is fully covered there is nothing to show or bend
    const tagOff = sc.covered
    if (tagOff !== tagHidden) {
      tagHidden = tagOff
      tagRoot.style.visibility = tagOff ? 'hidden' : ''
    }

    const pose = `${placeRev}|${turn}|${turn > 0 ? live!.key : ''}|${offset.nav.x},${offset.nav.y}|${offset.tag.x},${offset.tag.y}`
    const s = scale
    /** flat (u, v) of a plane → screen, this frame */
    const screenAt = (plane: Plane, off: Pt, u: number, v: number): Pt => {
      const tx = flatToTexel(plane, u / s, v / s)
      const r = rest(tx.x, tx.y)
      if (turn > 0) {
        const l = live!.project(tx.x, tx.y)
        r.x += (l.x - r.x) * turn
        r.y += (l.y - r.y) * turn
      }
      return { x: r.x + off.x, y: r.y + off.y }
    }

    const key = `${pose}|${mode}|${tagOff}`
    if (key !== lastKey) {
      lastKey = key
      for (const pc of pieces) {
        if (pc.group === 'nav' ? mode !== 'strip' : tagOff) continue
        const off = offset[pc.group]
        const [a0, b0, a1, b1] = pc.box
        pc.quad = [
          screenAt(pc.plane, off, pc.u0 + a0, pc.v0 + b0),
          screenAt(pc.plane, off, pc.u0 + a1, pc.v0 + b0),
          screenAt(pc.plane, off, pc.u0 + a1, pc.v0 + b1),
          screenAt(pc.plane, off, pc.u0 + a0, pc.v0 + b1),
        ]
        const css = rectToQuad(a0, b0, a1, b1, ...(pc.quad as [Pt, Pt, Pt, Pt]))
        if (css !== pc.css) {
          pc.css = css
          pc.el.style.transform = css
        }
      }
    }

    let w = 0
    if (mode === 'flight' && navPlane) {
      const navKeyNow = `${pose}|${M}|${sc.pos}`
      if (fresh || navKeyNow !== lastNavKey) {
        lastNavKey = navKeyNow
        const plane = navPlane
        fly(M, o, (u, v) => screenAt(plane, offset.nav, u, v), sc.pos)
      }
      w = rod?.b ?? 0
    } else if (mode === 'dock') {
      const navKeyNow = `${placeRev}|dock|${sc.pos}`
      if (fresh || navKeyNow !== lastNavKey) {
        lastNavKey = navKeyNow
        park(sc.pos, fresh)
      }
      w = 1
    } else lastNavKey = ''
    look(frame, o, M, w, fade)
    if (snapping) {
      // the blend flipped / the page jumped / the nav was re-laid out: the colours written for it are
      // taken in now, with the fades off (.so-snap) — a fade across the flip would show the old ink in
      // the new blend (light letters on the white); the fades are back for whatever changes next
      snapping = false
      void getComputedStyle(links[0] ?? nav).color
      navRoot.classList.remove('so-snap')
    }
  }

  let fontsIn = false
  let shown = false
  const born = performance.now()
  let lastLayout = ctx.layout
  let lastConfig = ctx.config
  let lastFrame: Frame | null = null

  const deg = (v: Pt) => +((Math.atan2(v.y, v.x) * 180) / Math.PI).toFixed(1)
  const layer: Layer & { stats(): unknown } = {
    /**
     * Debug (__hero.layers.get('overlay').stats()): per nav word and the tagline block — its box height
     * on screen at the left edge, px, and the screen angles of its top edge and of its verticals, degrees.
     * The last entry is the nav as a rod: its state, its angle, how far any piece of the line is off it;
     * its ink, and the docked column it publishes (navDock).
     */
    stats() {
      const flying = mode === 'flight' && rod
      /** where the piece is drawn: on the plane, on the rod (the visible word, no tracking after it), or docked */
      const drawn = (pc: Piece): Pt[] | undefined => {
        const j = navWords.findIndex((w) => w.el === pc.el)
        const d = dock
        if (j < 0 || mode === 'strip' || !d) return pc.quad
        if (flying) return rod!.words[j].quad
        return para({ x: d.labelLeft[j] + d.labelLen[j] / 2, y: d.labelTop[j] + d.size / 2 }, { x: d.labelLen[j], y: 0 }, { x: 0, y: d.size })
      }
      const words = pieces
        .filter((pc) => (pc.el.tagName === 'A' || pc.el === tagText) && drawn(pc))
        .map((pc) => {
          const [q0, q1, , q3] = drawn(pc)!
          // the title's own vertical at the same texel column, through the same pose (live or rest)
          const tx = flatToTexel(pc.plane, pc.u0 / scale, 0).x
          const proj = titlePose.current?.project ?? rest
          const t0 = proj(tx, titleEdgeY(meta, 'top', tx))
          const t1 = proj(tx, titleEdgeY(meta, 'bottom', tx))
          return {
            word: pc.el.textContent,
            height: +Math.hypot(q3.x - q0.x, q3.y - q0.y).toFixed(1),
            width: +Math.hypot(q1.x - q0.x, q1.y - q0.y).toFixed(1),
            baseline: deg({ x: q1.x - q0.x, y: q1.y - q0.y }),
            vertical: deg({ x: q3.x - q0.x, y: q3.y - q0.y }),
            titleVertical: deg({ x: t1.x - t0.x, y: t1.y - t0.y }),
            at: { x: Math.round(q0.x), y: Math.round(q0.y) },
          }
        })
      // the line as drawn: the ends of every segment and every dot, against the straight line through its two far ends
      const d = dock
      const ends: Pt[] = []
      const lens: number[] = []
      const midOf = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      if (mode === 'strip') {
        for (const pc of pieces) {
          if (pc.group !== 'nav' || !pc.quad) continue
          const [q0, q1, q2, q3] = pc.quad
          ends.push(midOf(q0, q3), midOf(q1, q2))
          if (pc.el.tagName !== 'A') lens.push(Math.hypot(midOf(q1, q2).x - midOf(q0, q3).x, midOf(q1, q2).y - midOf(q0, q3).y))
        }
      } else if (flying) {
        rod!.segs.forEach((sg, i) => {
          const [q0, q1, q2, q3] = sg.quad
          ends.push(midOf(q0, q3), midOf(q1, q2))
          lens.push(sg.len)
          if (i < rod!.words.length) ends.push(rod!.words[i].anchor)
        })
      } else if (d) {
        d.segTop.forEach((top, i) => {
          ends.push({ x: d.x, y: top }, { x: d.x, y: top + d.segLen[i] })
          lens.push(d.segLen[i])
          if (i < d.dotY.length) ends.push({ x: d.x, y: d.dotY[i] })
        })
      }
      let angle = 0
      let maxOff = 0
      if (ends.length > 1) {
        const a = ends[0]
        const b = ends[ends.length - 1]
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        angle = deg({ x: b.x - a.x, y: b.y - a.y })
        for (const p of ends) maxOff = Math.max(maxOff, Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len)
      }
      // the ink of every piece (1 — dark), head → tail; on the ABOUT sheet: inverting, with this ink
      const bits = (a: boolean[]) => a.map((v) => (v ? 1 : 0)).join('')
      const ink = { invert: inverted, light: invertInk || null, words: bits(dark.words), segs: bits(dark.segs) }
      // what navDock publishes for the about layers (null: not docked)
      return [...words, { rod: { mode, angle, maxOff: +maxOff.toFixed(3), segments: lens.map((v) => +v.toFixed(1)) }, ink, navDock: navDock.current }]
    },
    resize(layout, config) {
      lastLayout = layout
      lastConfig = config
      // re-laid out and straight back into the state the scroll is in, in this same task (as refit):
      // the hero updates a layer right after its resize only when the viewport's size changed, and a
      // frame painted in between would show the undressed strip at the dock's place
      refit()
    },
    update(frame) {
      lastFrame = frame
      bend(frame)
      // (docked, the nav no longer lies on the title: a page opened on a later screen does not wait for it)
      if (!shown && fontsIn && (titlePose.current || mode === 'dock' || performance.now() - born > TITLE_TIMEOUT)) {
        shown = true
        navRoot.classList.add('so-ready')
        tagRoot.classList.add('so-ready')
      }
      // the docked column for the about layers (they update after the nav: they read this frame's);
      // not before the nav is shown — until then its labels are measured in whatever face was there
      navDock.current = mode === 'dock' && dock && shown ? dock.box : null
    },
    dispose() {
      navDock.current = null
      document.fonts?.removeEventListener?.('loadingdone', refit)
      navRoot.remove()
      tagRoot.remove()
    },
  }

  // a face that arrives (late, or another weight from the tuner) changes the tagline's box → re-fit
  const refit = () => {
    place(lastLayout, lastConfig)
    // …and straight back into the state the scroll is in: the dock must not flash as a strip
    if (lastFrame) bend({ ...lastFrame, dt: 0, layout: lastLayout, config: lastConfig })
  }
  document.fonts?.addEventListener?.('loadingdone', refit)

  layer.resize(ctx.layout, ctx.config)
  fontsReady(overlayOf(ctx.config), FONT_TIMEOUT).then(() => {
    fontsIn = true
    refit()
  })
  return layer
}
