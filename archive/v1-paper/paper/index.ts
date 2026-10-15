/**
 * LAYER 2 — PAPER
 *
 * A physical-feeling paper sheet in front of the world, with exactly two holes cut
 * in it, and the site's ordinary UI printed (typewriter) and written (pen) on it.
 *
 *   .pp-sheet  (clip-path: whole hero minus the two cutouts)
 *     canvas.pp-tex         static procedural paper, device resolution (area-capped)
 *     .pp-cut ×2            hairline of the cut on the paper around each hole
 *     h1 (visually hidden), header > nav, handwritten note, place/year, status
 *   .pp-hole ×2             soft shadow the sheet casts on the world inside each hole
 *
 * Numbers: hero.config.ts (cutouts, paper.color/texture, copy, ui.note, ui.navHover) +
 * params.ts (texture breakdown, ink, type sizes, margins, edge, handwriting jitter).
 */
import '@fontsource/roboto-mono/400.css'
import '@fontsource/roboto-mono/500.css'
import '@fontsource/kalam/300.css'
import '@fontsource/kalam/400.css'
import './paper.css'

import type { Layer, LayerFactory, Layout, Rect, ResolvedConfig } from '../../core/types'
import { getPaperParams, type PaperParams } from './params'
import { blit, renderPaper, type TextureSpec } from './texture'
import { handwritten, penUnderline, strSeed, typed } from './glyphs'

type Resolved = PaperParams

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

/** Snap a rect to device pixels so the cut is perfectly crisp. */
function snap(r: Rect, dpr: number): Rect {
  const s = (v: number) => Math.round(v * dpr) / dpr
  const x = s(r.x)
  const y = s(r.y)
  return { x, y, w: s(r.x + r.w) - x, h: s(r.y + r.h) - y }
}

const rectPath = (r: Rect) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`

function hexToRgb(hex: string): string {
  let s = hex.replace('#', '')
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  const n = parseInt(s.slice(0, 6), 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

/**
 * Starts loading exactly the faces the current config uses (weights differ between
 * desktop and mobile and can be changed in the tuner) and resolves when they are in,
 * or after `timeoutMs` at the latest. Calling it also works as a preload: the fetch
 * starts now, not when the text is first laid out.
 */
async function fontsReady(type: Resolved['type'], timeoutMs: number) {
  if (!document.fonts?.load) return
  const loads = Promise.all([
    document.fonts.load(`${type.monoWeight} 16px "Roboto Mono"`),
    document.fonts.load(`${type.handWeight} 30px "Kalam"`),
  ]).catch(() => undefined)
  await Promise.race([loads, new Promise((r) => setTimeout(r, timeoutMs))])
}

type NoteConfig = ResolvedConfig['ui']['note'] & {
  /** 'page' (default): x / y in % of the page. 'main': hung off the main window (gap, dy). */
  anchor?: string
  /** px (at the reference width) between the note's right ink edge and the main window. */
  gap?: number
  /** top of the note relative to the main window's top, in window heights. */
  dy?: number
}

/** Union of the transformed glyph boxes of a handwritten block, relative to `origin`. */
function glyphBox(root: HTMLElement, origin: HTMLElement) {
  const o = origin.getBoundingClientRect()
  let l = Infinity
  let t = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const g of root.querySelectorAll('.pp-hg')) {
    const q = g.getBoundingClientRect()
    if (!q.width || !q.height) continue
    l = Math.min(l, q.left)
    t = Math.min(t, q.top)
    r = Math.max(r, q.right)
    b = Math.max(b, q.bottom)
  }
  if (!(r > l)) return null
  return { left: l - o.left, top: t - o.top, right: r - o.left, bottom: b - o.top }
}

export const createPaperLayer: LayerFactory = async (mount, ctx) => {
  // fonts first: the fetch starts before any DOM exists
  const typeReady = fontsReady(getPaperParams(ctx.config).type, 3000)

  // ── static DOM ─────────────────────────────────────────────────────────────
  const sheet = h('div', 'pp-sheet')
  const tex = h('canvas', 'pp-tex')
  tex.setAttribute('aria-hidden', 'true')
  const cutMain = h('div', 'pp-cut')
  const cutSec = h('div', 'pp-cut')

  const title = h('h1', 'pp-sr')
  title.textContent = 'Slava Volkov'

  const header = h('header', 'pp-header')
  const nav = h('nav', 'pp-print pp-nav')
  nav.setAttribute('aria-label', 'Primary')
  header.append(nav)

  const note = h('div')
  const place = h('p', 'pp-print pp-place')
  const status = h('div', 'pp-print pp-status')

  sheet.append(tex, cutMain, cutSec, title, header, note, place, status)

  const holeMain = h('div', 'pp-hole')
  const holeSec = h('div', 'pp-hole')
  holeMain.setAttribute('aria-hidden', 'true')
  holeSec.setAttribute('aria-hidden', 'true')
  mount.append(sheet, holeMain, holeSec)

  // ── copy (rebuilt only when the text actually changes) ─────────────────────
  let copyKey = ''
  let noteEl: HTMLElement = note
  let ruleEl: HTMLElement = h('span', 'pp-rule')

  function buildCopy(config: ResolvedConfig, seed: number) {
    const c = config.copy
    const key = JSON.stringify(c) + '|' + seed
    if (key === copyKey) return
    copyKey = key

    // nav
    const ul = h('ul')
    c.nav.forEach((label, i) => {
      const li = h('li')
      const a = h('a')
      a.href = `#${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      a.append(typed(label, strSeed(label, seed + i)), penUnderline(strSeed(label, seed + 99 + i)))
      li.append(a)
      ul.append(li)
    })
    nav.replaceChildren(ul)

    // handwritten note
    const n = handwritten(c.note, strSeed(c.note, seed))
    n.classList.add('pp-note')
    noteEl.replaceWith(n)
    noteEl = n

    // place / year
    const l1 = h('span', 'pp-line')
    l1.append(typed(c.place, strSeed(c.place, seed)))
    const l2 = h('time', 'pp-line')
    l2.setAttribute('datetime', c.year)
    l2.append(typed(c.year, strSeed(c.year, seed)))
    place.replaceChildren(l1, l2)

    // status: short rule + text
    ruleEl = h('span', 'pp-rule')
    ruleEl.setAttribute('aria-hidden', 'true')
    const p = h('p')
    p.style.margin = '0'
    p.append(typed(c.status, strSeed(c.status, seed)))
    status.replaceChildren(ruleEl, p)
  }

  // ── texture (regenerated only when size / colour / params change) ──────────
  // Pixels are generated in a Web Worker; the result is blitted in one task, so the
  // previous texture (stretched) stays on screen until the new one is ready.
  let worker: Worker | null = null
  try {
    worker = new Worker(new URL('./texture.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    worker = null
  }
  let jobId = 0
  let lastSpec: TextureSpec | null = null
  let texKey = ''
  let texTimer = 0
  let markTextured: () => void = () => {}
  const textured = new Promise<void>((r) => (markTextured = r))

  const renderSync = () => {
    if (lastSpec) renderPaper(tex, lastSpec)
    markTextured()
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; W: number; H: number; buf: ArrayBuffer }>) => {
      const { id, W, H, buf } = e.data
      if (id !== jobId || !lastSpec) return // stale
      blit(tex, lastSpec, W, H, new Uint8ClampedArray(buf))
      markTextured()
    }
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      renderSync()
    }
  }
  const requestTexture = () => {
    const id = ++jobId
    if (worker && lastSpec) worker.postMessage({ id, spec: lastSpec })
    else renderSync()
  }

  function updateTexture(layout: Layout, config: ResolvedConfig, p: Resolved) {
    const spec: TextureSpec = {
      width: layout.width,
      height: layout.height,
      dpr: layout.dpr,
      color: config.paper.color,
      intensity: config.paper.texture,
      t: { ...p.texture },
    }
    sheet.style.backgroundColor = config.paper.color
    const key = JSON.stringify(spec)
    if (key === texKey) return
    const first = texKey === ''
    texKey = key
    lastSpec = spec
    window.clearTimeout(texTimer)
    // later changes (resize drags, tuner sliders) are debounced
    if (first) requestTexture()
    else texTimer = window.setTimeout(requestTexture, 120)
  }

  // ── per-frame state ───────────────────────────────────────────────────────
  let params = getPaperParams(ctx.config)
  let holes: { el: HTMLElement; rect: Rect }[] = []
  let shadowKey = ''

  function shadowCSS(px: number, py: number) {
    const e = params.edge
    const col = hexToRgb(e.shadowColor)
    const parts: string[] = []
    if (e.shadow > 0)
      parts.push(`inset ${(e.shadowX + px).toFixed(2)}px ${(e.shadowY + py).toFixed(2)}px ${e.shadowBlur}px rgba(${col}, ${e.shadow})`)
    if (e.contact > 0) parts.push(`inset 0 0 1.5px rgba(${col}, ${e.contact})`)
    return parts.length ? parts.join(', ') : 'none'
  }

  function applyShadow(px: number, py: number) {
    const q = (v: number) => Math.round(v * 20) / 20
    const key = `${q(px)},${q(py)}`
    if (key === shadowKey) return
    shadowKey = key
    const css = shadowCSS(q(px), q(py))
    for (const hole of holes) hole.el.style.boxShadow = css
  }

  // ── layout ────────────────────────────────────────────────────────────────
  function resize(layout: Layout, config: ResolvedConfig) {
    params = getPaperParams(config)
    const p = params
    const { width: W, height: H, dpr } = layout

    buildCopy(config, p.texture.seed)
    updateTexture(layout, config, p)

    // holes
    const main = snap(layout.cutouts.main, dpr)
    const sec = snap(layout.cutouts.secondary, dpr)
    sheet.style.clipPath = `path(evenodd, "M0 0H${W}V${H}H0Z ${rectPath(main)} ${rectPath(sec)}")`
    holes = [
      { el: holeMain, rect: main },
      { el: holeSec, rect: sec },
    ]
    const place_ = (el: HTMLElement, r: Rect) => {
      el.style.left = `${r.x}px`
      el.style.top = `${r.y}px`
      el.style.width = `${r.w}px`
      el.style.height = `${r.h}px`
    }
    place_(holeMain, main)
    place_(holeSec, sec)
    place_(cutMain, main)
    place_(cutSec, sec)
    shadowKey = ''
    applyShadow(0, 0)

    // type scale: sizes are authored at 1440 (desktop) / 390 (mobile) wide
    const refW = layout.isMobile ? 390 : 1440
    const k = Math.pow(W / refW, p.type.fluid)
    const px = (v: number) => v * k
    const t = p.type
    const L = p.layout
    const S = sheet.style
    const set = (name: string, v: string | number) => S.setProperty(name, String(v))

    set('--pp-print', p.ink.print)
    set('--pp-print-op', p.ink.printOpacity)
    set('--pp-uneven', p.ink.printUneven)
    set('--pp-pen', p.ink.pen)
    set('--pp-pen-op', p.ink.penOpacity)
    set('--pp-pressure', p.ink.penPressure)

    // whole device px (uncapped ratio) for the typebar wobble in paper.css
    set('--pp-dev-px', `${(1 / (window.devicePixelRatio || 1)).toFixed(4)}px`)
    // printed sizes on a quarter-px grid: odd fractional sizes rasterize unevenly
    const q4 = (v: number) => Math.round(v * 4) / 4

    const monoSize = q4(px(t.mono))
    const monoLead = t.monoLeading
    set('--pp-mono-size', `${monoSize.toFixed(2)}px`)
    set('--pp-mono-weight', t.monoWeight)
    set('--pp-mono-track', t.monoTracking)
    set('--pp-mono-lead', monoLead)
    const navSize = q4(px(t.nav))
    set('--pp-nav-size', `${navSize.toFixed(2)}px`)
    set('--pp-nav-track', t.navTracking)
    set('--pp-nav-gap', `${px(t.navGap).toFixed(2)}px`)
    set('--pp-nav-lead', monoLead)

    const note = config.ui.note
    const handSize = px(note.size) * t.handScale
    set('--pp-hand-size', `${handSize.toFixed(2)}px`)
    set('--pp-hand-weight', t.handWeight)
    set('--pp-hand-lead', t.handLeading)
    set('--pp-hand-track', t.handTracking)

    const j = p.hand
    set('--pp-j-lt', `${(j.lineTilt * j.jitter).toFixed(3)}deg`)
    set('--pp-j-lx', `${(px(j.lineShift) * j.jitter).toFixed(2)}px`)
    set('--pp-j-ly', `${(px(j.lineShift) * 0.35 * j.jitter).toFixed(2)}px`)
    set('--pp-j-gt', `${(j.glyphTilt * j.jitter).toFixed(3)}deg`)
    set('--pp-j-gy', `${(j.glyphLift * j.jitter).toFixed(4)}em`)
    set('--pp-j-gx', `${(j.glyphLift * 0.5 * j.jitter).toFixed(4)}em`)
    set('--pp-j-gs', (j.glyphScale * j.jitter).toFixed(4))

    // cut edge (1 device px hairline)
    const e = p.edge
    set('--pp-hair-w', `${(1 / dpr).toFixed(3)}px`)
    set('--pp-hair-w2', `${(2 / dpr).toFixed(3)}px`)
    set('--pp-hair-a', e.hairline)
    set('--pp-hl-a', e.highlight)

    // rule: printed, so crisp — an integer number of device px thick
    set('--pp-rule-w', `${px(L.ruleWidth).toFixed(2)}px`)
    set('--pp-rule-gap', `${px(L.ruleGap).toFixed(2)}px`)
    set('--pp-rule-drop', L.ruleDrop)
    set('--pp-rule-h', `${Math.max(1, Math.round(1.5 * k * dpr)) / dpr}px`)

    const lineH = monoSize * monoLead
    const left = (L.left / 100) * W
    const right = (L.right / 100) * W

    // nav — top right; a row (desktop) or a compact right-aligned column (mobile)
    nav.classList.toggle('is-stacked', L.navStacked)
    // hover / focus mark: 'print' (printed rule) | 'pen' (hand-drawn underline) | 'none'
    nav.dataset.hover = (config.ui as { navHover?: string }).navHover ?? 'print'
    nav.style.right = `${right}px`
    nav.style.left = 'auto'
    const navCy = (L.navY / 100) * H
    nav.style.top = L.navStacked ? `${navCy - (navSize * monoLead) / 2}px` : `${navCy - navSize / 2}px`

    // place / year — bottom-left (desktop) or top-left (mobile)
    place.classList.toggle('is-upper', L.placeUppercase)
    place.style.left = `${left}px`
    place.style.top = L.placeTop
      ? `${(L.placeY / 100) * H - lineH / 2}px`
      : `${(L.bottomY / 100) * H - 1.5 * lineH}px`

    // status — bottom-right with the rule before it (desktop) or bottom-left with the rule below (mobile)
    status.classList.toggle('is-upper', L.statusUppercase)
    status.classList.toggle('is-below', L.ruleBelow)
    status.classList.toggle('is-right', !L.ruleBelow)
    // rule goes before the text in a row, under it when stacked
    if (L.ruleBelow) status.append(ruleEl)
    else status.prepend(ruleEl)
    status.style.top = `${(L.bottomY / 100) * H - lineH / 2}px`
    if (L.ruleBelow) {
      status.style.left = `${left}px`
      status.style.right = 'auto'
    } else {
      status.style.right = `${right}px`
      status.style.left = 'auto'
    }

    // handwritten note — rotation from hero.config ui.note; position either in % of the
    // page, or (anchor 'main') hung off the main window so the pair keeps its spacing
    noteEl.style.transform = `rotate(${note.rotation}deg) skewX(${p.hand.slant}deg)`
    placeNote(layout, config, k)
    lastPlaced = { layout, config, k }

    // the faces this config uses (desktop/mobile/tuner can differ) — load, then re-measure
    const faces = `${t.monoWeight}|${t.handWeight}`
    if (faces !== facesKey) {
      const first = facesKey === ''
      facesKey = faces
      if (!first) fontsReady(t, 3000).then(replaceNote)
    }
  }

  let facesKey = ''
  let lastPlaced: { layout: Layout; config: ResolvedConfig; k: number } | null = null
  const replaceNote = () => {
    if (lastPlaced) placeNote(lastPlaced.layout, lastPlaced.config, lastPlaced.k)
  }

  function placeNote(layout: Layout, config: ResolvedConfig, k: number) {
    const note = config.ui.note as NoteConfig
    const { width: W, height: H } = layout
    if (note.anchor !== 'main') {
      noteEl.style.left = `${(note.x / 100) * W}px`
      noteEl.style.top = `${(note.y / 100) * H}px`
      return
    }
    // Hang the written block off the main window: its right ink edge sits `gap` px left
    // of the window, its top at `dy` × window height from the window's top. Measured on
    // the transformed glyphs, so rotation / slant / jitter are all accounted for.
    const main = layout.cutouts.main
    noteEl.style.left = `${main.x}px`
    noteEl.style.top = `${main.y}px`
    const box = glyphBox(noteEl, sheet)
    if (!box) return
    const gap = (note.gap ?? 18) * k
    const dy = note.dy ?? -0.14
    noteEl.style.left = `${(main.x + main.x - gap - box.right).toFixed(2)}px`
    noteEl.style.top = `${(main.y + main.y + dy * main.h - box.top).toFixed(2)}px`
  }

  // first layout right away, so the texture worker starts while fonts load
  resize(ctx.layout, ctx.config)
  // Text stays hidden until its real faces are in (no fallback-font flash + reflow);
  // the timeout inside fontsReady shows it anyway if a font never arrives. This does
  // not hold up the layer: only the texture is awaited below.
  typeReady.then(() => {
    sheet.classList.add('is-type-ready')
    replaceNote()
  })
  await Promise.race([textured, new Promise((r) => setTimeout(r, 2500))])

  const layer: Layer = {
    resize,
    update(frame) {
      const e = params.edge
      if (!e.shadowParallax || e.shadow <= 0) return
      // the shadow lies ON the world, so it drifts with the world's parallax
      // (world content moves opposite to the pointer), by a fraction of it
      const k = -frame.config.world.parallax * e.shadowParallax
      applyShadow(frame.pointer.x * k, frame.pointer.y * k)
    },
    dispose() {
      window.clearTimeout(texTimer)
      worker?.terminate()
      worker = null
      tex.width = tex.height = 0
      sheet.remove()
      holeMain.remove()
      holeSec.remove()
    },
  }
  return layer
}
