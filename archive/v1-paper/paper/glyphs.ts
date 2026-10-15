/**
 * Text builders for the two type systems.
 *
 * Both keep the real string for assistive tech (visually-hidden span) and render the
 * visible copy as aria-hidden per-glyph spans, so each glyph can carry its own
 * deterministic imperfection (typewriter strike density / pen pressure + wobble).
 * The visible glyphs are empty spans drawn with `::before { content: attr(data-ch) }`
 * (paper.css): generated text is not part of innerText, selection, copy or find-in-page,
 * so the hidden copy stays the only real text on the page.
 * Jitter values are stored on the spans as CSS custom properties (unit-less, −1…1),
 * and the amounts are applied in CSS — so changing the amount never rebuilds the DOM.
 */
import { rng } from './texture'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** A visible glyph: no text node, the character is drawn from `data-ch` in CSS. */
const glyph = (cls: string, ch: string) => {
  const e = el('span', cls)
  e.dataset.ch = ch
  return e
}

/** Stable small integer from a string (so each text gets its own jitter). */
export function strSeed(s: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const sr = (text: string) => el('span', 'pp-sr', text)

/**
 * Typewriter / printed line: per-glyph strike density (`--k`, 0…1 → opacity loss)
 * and a vertical wobble (`--v`, −1…1; CSS turns it into whole device px, so only a
 * few letters actually sit a pixel off).
 */
export function typed(text: string, seed: number): HTMLSpanElement {
  const wrap = el('span', 'pp-typed')
  wrap.append(sr(text))
  const vis = el('span', 'pp-typed__vis')
  vis.setAttribute('aria-hidden', 'true')
  const r = rng(seed)
  for (const ch of text) {
    if (ch === ' ') {
      vis.append(glyph('pp-sp', ' '))
      continue
    }
    const g = glyph('pp-g', ch)
    // most strikes are full; a few are a touch lighter
    const k = Math.pow(r(), 2.4)
    g.style.setProperty('--k', k.toFixed(3))
    g.style.setProperty('--v', (r() * 2 - 1).toFixed(3))
    vis.append(g)
  }
  wrap.append(vis)
  return wrap
}

/**
 * Handwritten block: one line per "\n". Each line gets its own tilt/shift
 * (`--lt`, `--lx`, `--ly`), each glyph its own tilt, lift, size and pressure
 * (`--gt`, `--gy`, `--gs`, `--gp`). Words are kept unbreakable.
 */
export function handwritten(text: string, seed: number): HTMLElement {
  const wrap = el('p', 'pp-hand')
  wrap.append(sr(text.replace(/\n/g, ' ')))
  const vis = el('span', 'pp-hand__vis')
  vis.setAttribute('aria-hidden', 'true')
  const r = rng(seed)
  const sgn = () => r() * 2 - 1
  // glyph wobble drifts a little instead of being pure white noise — reads as a hand, not a glitch
  let drift = 0
  text.split('\n').forEach((line) => {
    const ln = el('span', 'pp-hand__line')
    ln.style.setProperty('--lt', sgn().toFixed(3))
    ln.style.setProperty('--lx', sgn().toFixed(3))
    ln.style.setProperty('--ly', sgn().toFixed(3))
    for (const word of line.split(/(\s+)/)) {
      if (!word) continue
      if (/^\s+$/.test(word)) {
        ln.append(el('span', 'pp-hand__space'))
        continue
      }
      const w = el('span', 'pp-hand__word')
      for (const ch of word) {
        drift = drift * 0.6 + sgn() * 0.4
        const g = glyph('pp-hg', ch)
        g.style.setProperty('--gt', (drift * 0.6 + sgn() * 0.4).toFixed(3))
        g.style.setProperty('--gy', (drift * 0.5 + sgn() * 0.5).toFixed(3))
        g.style.setProperty('--gs', sgn().toFixed(3))
        g.style.setProperty('--gp', Math.pow(r(), 1.6).toFixed(3))
        g.style.setProperty('--gx', sgn().toFixed(3))
        w.append(g)
      }
      ln.append(w)
    }
    vis.append(ln)
  })
  wrap.append(vis)
  return wrap
}

/**
 * A wobbly, hand-drawn underline (SVG). Drawn on hover/focus via stroke-dashoffset.
 * viewBox is 100×10 and stretched to the link; stroke width stays constant.
 */
export function penUnderline(seed: number): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'pp-underline')
  svg.setAttribute('viewBox', '0 0 100 10')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const r = rng(seed)
  const y0 = 4.5 + r() * 2
  const y1 = 4 + r() * 3
  const p = document.createElementNS(NS, 'path')
  // start slightly left, end slightly past the word, with a tiny pen-lift hook at the end
  p.setAttribute(
    'd',
    `M${-2 + r() * 3} ${y0.toFixed(2)} C ${25 + r() * 10} ${(y0 + (r() - 0.5) * 3).toFixed(2)}, ${60 + r() * 10} ${(y1 + (r() - 0.5) * 3).toFixed(2)}, ${101 + r() * 3} ${y1.toFixed(2)} l ${-2 - r() * 2} ${(-0.8 - r()).toFixed(2)}`,
  )
  p.setAttribute('pathLength', '1')
  p.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.append(p)
  return svg
}
