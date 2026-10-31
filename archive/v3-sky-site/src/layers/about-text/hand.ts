/**
 * The handwriting of the ABOUT notes — version 1's pen (archive/v1-paper/paper/glyphs.ts →
 * handwritten()), ported as is: every line gets its own tilt and shift (`--lt --lx --ly`), every
 * glyph its own tilt, lift, sideways nudge, size and pressure (`--gt --gy --gx --gs --gp`), all
 * seeded per note and stored unit-less (−1…1) on the spans; the amounts are applied in CSS
 * (about-text.css, × about.text.hand.jitter), so a new amount never rebuilds the DOM. The glyph
 * wobble drifts a little instead of being white noise — it reads as a hand, not a glitch.
 *
 * The visual note is aria-hidden: the real text lives once, in the layer's screen-reader copy.
 */

/** Stable small integer from a string (each note gets its own hand). */
export function strSeed(s: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Small seeded PRNG (mulberry32), as version 1's. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const span = (cls: string, text?: string) => {
  const e = document.createElement('span')
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * The lines of a handwritten note (one per entry of `lines`), each a block of unbreakable words
 * made of jittered glyphs. Only the line elements are returned: the caller types them in.
 */
export function handLines(lines: string[], seed: number): HTMLElement[] {
  const r = rng(seed)
  const sgn = () => r() * 2 - 1
  let drift = 0
  return lines.map((line) => {
    const ln = span('at-line at-hand-line')
    ln.style.setProperty('--lt', sgn().toFixed(3))
    ln.style.setProperty('--lx', sgn().toFixed(3))
    ln.style.setProperty('--ly', sgn().toFixed(3))
    for (const word of line.split(/(\s+)/)) {
      if (!word) continue
      if (/^\s+$/.test(word)) {
        ln.append(span('at-hand-space'))
        continue
      }
      const w = span('at-hand-word')
      for (const ch of word) {
        drift = drift * 0.6 + sgn() * 0.4
        const g = span('at-hg', ch)
        g.style.setProperty('--gt', (drift * 0.6 + sgn() * 0.4).toFixed(3))
        g.style.setProperty('--gy', (drift * 0.5 + sgn() * 0.5).toFixed(3))
        g.style.setProperty('--gs', sgn().toFixed(3))
        g.style.setProperty('--gp', Math.pow(r(), 1.6).toFixed(3))
        g.style.setProperty('--gx', sgn().toFixed(3))
        w.append(g)
      }
      ln.append(w)
    }
    return ln
  })
}
