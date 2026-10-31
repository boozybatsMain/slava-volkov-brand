// The site (both pages): the light switch (day / night, remembered), the game covers' videos, the scroll hint,
// the stars of the night hero and Нетопырь. three.js and the bat load after the page is up, so the first paint never waits for them.
import './styles.css'
import { site } from './site.config'

const root = document.documentElement
const isDark = () => root.dataset.theme === 'night'

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
})
showTheme()

// ---------- game covers: the featured video plays at once, the others on hover ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const canHover = matchMedia('(hover: hover)')
function play(v: HTMLVideoElement) {
  v.play().then(
    () => v.classList.add('is-playing'),
    () => {}, // autoplay refused (power saving etc.): the picture stays
  )
}
function stop(v: HTMLVideoElement) {
  v.pause()
  v.classList.remove('is-playing')
}
for (const v of document.querySelectorAll<HTMLVideoElement>('video[data-autoplay]')) {
  if (reducedMotion.matches) continue
  // only while it is on screen
  new IntersectionObserver(([e]) => (e.isIntersecting ? play(v) : v.pause())).observe(v)
}
for (const v of document.querySelectorAll<HTMLVideoElement>('video[data-hover]')) {
  const host = v.closest('[data-video]') as HTMLElement
  if (canHover.matches) {
    host.addEventListener('pointerenter', () => play(v))
    host.addEventListener('pointerleave', () => {
      stop(v)
      v.currentTime = 0
    })
    host.addEventListener('focus', () => play(v))
    host.addEventListener('blur', () => stop(v))
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
