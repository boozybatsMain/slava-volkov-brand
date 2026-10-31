// The site: the light switch (day / night for the whole page), the "Show all 6 games" peek, the stars of the
// night hero and Нетопырь. three.js and the bat load after the page is up, so the first paint never waits for them.
import './styles.css'
import { site } from './site.config'
import type { SiteBat } from './bat/netopyr-site'

const root = document.documentElement
const isDark = () => root.dataset.theme === 'night'
let bat: SiteBat | null = null

// ---------- the light switch ----------
const sw = document.getElementById('switch') as HTMLButtonElement
const swLabel = sw.querySelector('.switch__label') as HTMLElement
const themeMeta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement
function showTheme() {
  const dark = isDark()
  sw.setAttribute('aria-pressed', dark ? 'false' : 'true')
  swLabel.textContent = dark ? 'Lights off' : 'Lights on'
  themeMeta.content = dark ? '#060811' : '#f2efe8'
}
sw.addEventListener('click', () => {
  const dark = !isDark()
  root.dataset.theme = dark ? 'night' : 'day'
  try {
    localStorage.setItem(site.themeKey, dark ? 'night' : 'day')
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  showTheme()
  bat?.setDark(dark)
})
showTheme()

// ---------- more games: the peek opens the next row in place ----------
const peek = document.getElementById('peek') as HTMLElement
const more = document.getElementById('more') as HTMLElement
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-more]')) {
  b.addEventListener('click', () => {
    const open = more.hidden
    more.hidden = !open
    peek.hidden = open
    // keep the keyboard on the control that is now there
    const next = (open ? more : peek).querySelector<HTMLButtonElement>('[data-more]')
    next?.focus({ preventScroll: true })
  })
}

// ---------- the night sky of the hero (2D, drawn once per size) ----------
const stars = document.getElementById('stars') as HTMLCanvasElement
function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function drawStars() {
  const w = stars.clientWidth
  const h = stars.clientHeight
  if (!w || !h) return
  const d = Math.min(2, window.devicePixelRatio || 1)
  stars.width = Math.round(w * d)
  stars.height = Math.round(h * d)
  const g = stars.getContext('2d')
  if (!g) return
  g.setTransform(d, 0, 0, d, 0, 0)
  const S = site.stars
  const r = rng(3)
  const n = Math.round((w * h) / S.areaPerStar)
  for (let i = 0; i < n; i++) {
    const big = r() < S.bigShare
    g.globalAlpha = big ? 0.9 : 0.2 + r() * 0.5
    g.fillStyle = r() < S.warmShare ? '#ffe2c4' : '#dfe8ff'
    const s = big ? 1.7 : 1
    g.fillRect(r() * w, S.topClear + r() * (h - S.topClear), s, s)
  }
  g.globalAlpha = 1
}
new ResizeObserver(drawStars).observe(stars)

// ---------- Нетопырь ----------
async function startBat() {
  const canvas = document.getElementById('bat') as HTMLCanvasElement
  const head = document.getElementById('head') as HTMLElement
  try {
    const { SiteBat } = await import('./bat/netopyr-site')
    bat = new SiteBat(canvas, document.getElementById('halo'), head, isDark())
    root.dataset.batReady = ''
  } catch (e) {
    // no WebGL: the site works the same without him
    canvas.remove()
    console.warn('Netopyr is off:', e)
  }
  root.dataset.heroReady = '' // scripts/shot.mjs waits for this
}
const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback
const later = () => (idle ? idle(startBat, { timeout: 1200 }) : setTimeout(startBat, 200))
if (document.readyState === 'complete') later()
else addEventListener('load', later, { once: true })
