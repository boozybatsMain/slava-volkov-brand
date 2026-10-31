// The site (both pages): the light switch (day / night, remembered), the game covers' videos, the scroll hint,
// the stars of the night hero and Нетопырь. three.js and the bat load after the page is up, so the first paint never waits for them.
import './styles.css'
import { site } from './site.config'

const root = document.documentElement
const isDark = () => root.dataset.theme === 'night'

// ---------- the light switch: off / auto / on ----------
// Auto (the middle, the default) follows the device; a hand-picked off or on is remembered and always wins.
// html[data-mode] is the switch position, html[data-theme] the theme actually shown (the inline script in <head> sets both).
type Mode = 'auto' | 'day' | 'night'
const sw = document.getElementById('switch') as HTMLButtonElement
const swLabel = sw.querySelector('.switch__label') as HTMLElement
const themeMeta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement
const deviceDark = matchMedia('(prefers-color-scheme: dark)')
const mode = () => (root.dataset.mode as Mode) || 'auto'
function applyTheme() {
  const m = mode()
  root.dataset.theme = m === 'auto' ? (deviceDark.matches ? 'night' : 'day') : m
  const dark = isDark()
  sw.setAttribute('aria-pressed', m === 'auto' ? 'mixed' : m === 'day' ? 'true' : 'false')
  sw.setAttribute('aria-label', m === 'auto' ? 'Lights: auto, as on your device' : m === 'day' ? 'Lights: on' : 'Lights: off')
  swLabel.textContent = m === 'auto' ? 'Auto' : m === 'day' ? 'Lights on' : 'Lights off'
  themeMeta.content = dark ? '#060811' : '#f2efe8'
}
function setMode(m: Mode) {
  root.dataset.mode = m
  try {
    if (m === 'auto') localStorage.removeItem(site.themeKey)
    else localStorage.setItem(site.themeKey, m)
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  applyTheme()
}
// every click moves to the next position: auto → on → off → auto
const next: Record<Mode, Mode> = { auto: 'day', day: 'night', night: 'auto' }
sw.addEventListener('click', () => setMode(next[mode()]))
deviceDark.addEventListener('change', () => mode() === 'auto' && applyTheme())
applyTheme()

// ---------- game covers: the featured video plays at once, the others on hover ----------
// A cover video is shown only once it really plays (the 'playing' event), so a slow network never shows a black
// frame; until then the picture stays and a small ring says it is loading. Hover videos start downloading when
// their card comes near the screen, so by the time the cursor gets there they are usually ready.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const canHover = matchMedia('(hover: hover)')
const wanted = new WeakSet<HTMLVideoElement>()
function play(v: HTMLVideoElement) {
  wanted.add(v)
  const host = v.closest('.media') as HTMLElement
  if (v.preload !== 'auto') {
    v.preload = 'auto'
    v.load()
  }
  if (v.readyState < 3) host.classList.add('is-loading')
  v.play().catch(() => {
    // refused (power saving) or interrupted by a pause: the picture stays; 'canplay' below tries again if still wanted
  })
}
function stop(v: HTMLVideoElement, rewind = false) {
  wanted.delete(v)
  v.pause()
  v.classList.remove('is-playing')
  ;(v.closest('.media') as HTMLElement).classList.remove('is-loading')
  if (rewind && v.readyState > 0) v.currentTime = 0
}
for (const v of document.querySelectorAll<HTMLVideoElement>('.media video')) {
  const host = v.closest('.media') as HTMLElement
  v.addEventListener('playing', () => {
    host.classList.remove('is-loading')
    if (wanted.has(v)) v.classList.add('is-playing')
    else v.pause()
  })
  v.addEventListener('canplay', () => {
    if (wanted.has(v) && v.paused) v.play().catch(() => {})
  })
  v.addEventListener('waiting', () => wanted.has(v) && host.classList.add('is-loading'))
}
for (const v of document.querySelectorAll<HTMLVideoElement>('video[data-autoplay]')) {
  if (reducedMotion.matches) continue
  // only while it is on screen
  new IntersectionObserver(([e]) => (e.isIntersecting ? play(v) : stop(v))).observe(v)
}
const hoverVideos = document.querySelectorAll<HTMLVideoElement>('video[data-hover]')
// fetch the hover videos ahead, while their cards are approaching the screen
const warm = new IntersectionObserver(
  (es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue
      const v = e.target.querySelector('video') as HTMLVideoElement
      warm.unobserve(e.target)
      if (v.preload !== 'auto') {
        v.preload = 'auto'
        v.load()
      }
    }
  },
  { rootMargin: '600px 0px' },
)
for (const v of hoverVideos) {
  const host = v.closest('[data-video]') as HTMLElement
  warm.observe(host)
  if (canHover.matches) {
    host.addEventListener('pointerenter', () => play(v))
    host.addEventListener('pointerleave', () => stop(v, true))
    host.addEventListener('focus', () => play(v))
    host.addEventListener('blur', () => stop(v, true))
  } else if (!reducedMotion.matches) {
    // phones have no hover: a card plays while it is mostly on screen
    new IntersectionObserver(([e]) => (e.isIntersecting ? play(v) : stop(v)), { threshold: 0.75 }).observe(host)
  }
}

// ---------- "there is more below": the hint goes after the first scroll ----------
const hint = document.querySelector('.scroll-hint')
if (hint) {
  const check = () => hint.classList.toggle('is-gone', window.scrollY > 40)
  addEventListener('scroll', check, { passive: true })
  check()
}

// ---------- the night sky of the hero (2D, drawn once per size) ----------
const stars = document.getElementById('stars') as HTMLCanvasElement | null
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
  if (!stars) return
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
if (stars) new ResizeObserver(drawStars).observe(stars)

// ---------- Нетопырь ----------
async function startBat() {
  const canvas = document.getElementById('bat') as HTMLCanvasElement
  const head = document.getElementById('head') as HTMLElement
  try {
    const { SiteBat } = await import('./bat/netopyr-site')
    new SiteBat(canvas, document.getElementById('halo'), head)
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
