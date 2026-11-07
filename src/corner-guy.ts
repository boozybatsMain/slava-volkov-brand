// Страница Corner Guy (corner-guy/index.html): звук ролика и лист ожидания.
// Заявка уходит в функцию Cloudflare Pages /api/waitlist (functions/api/waitlist.ts), почты лежат в базе D1.

/** Куда уходит заявка. Функция есть везде, где сайт отдаёт Cloudflare (slavavolkov.com и slavavolkov.pages.dev —
 *  его X пока не помечает опасным); на зеркале GitHub Pages функций нет, оттуда — на основной домен. */
const WAITLIST_URL = location.hostname.endsWith('github.io') ? 'https://slavavolkov.com/api/waitlist' : '/api/waitlist'
/** Отметка в браузере, что этот человек уже записался: при повторном заходе сразу «You’re in». */
const JOINED_KEY = 'cg-waitlist'

// ---------- ролик: без звука играет сам, кнопка включает звук и начинает с начала ----------
const video = document.getElementById('cg-trailer') as HTMLVideoElement
const sound = document.getElementById('cg-sound') as HTMLButtonElement
const soundLabel = sound.querySelector('span') as HTMLElement
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

if (!reducedMotion.matches) {
  // только пока ролик на экране
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting) video.play().catch(() => {})
    else if (video.muted) video.pause()
  }).observe(video)
}
sound.addEventListener('click', () => {
  const on = video.muted
  video.muted = !on
  if (on) {
    video.currentTime = 0
    video.play().catch(() => {})
  }
  sound.setAttribute('aria-pressed', String(on))
  soundLabel.textContent = on ? 'Sound off' : 'Sound on'
})
video.addEventListener('click', () => (video.paused ? video.play().catch(() => {}) : video.pause()))

// ---------- лист ожидания ----------
const form = document.getElementById('waitlist') as HTMLFormElement
const input = document.getElementById('cg-email') as HTMLInputElement
const note = document.getElementById('cg-note') as HTMLElement
const done = document.getElementById('cg-done') as HTMLElement
const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement
const honey = form.querySelector('input[name="_honey"]') as HTMLInputElement
const noteText = note.textContent || ''

function showDone() {
  form.hidden = true
  done.hidden = false
}
try {
  if (localStorage.getItem(JOINED_KEY)) showDone()
} catch {
  /* private mode: the form just shows again */
}

function fail(msg: string) {
  note.textContent = msg
  note.classList.add('is-error')
  submit.disabled = false
  submit.textContent = 'Join the waitlist'
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = input.value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail('That email looks off. Try again?')
    input.focus()
    return
  }
  if (honey.value) return showDone() // a bot: pretend it worked
  note.textContent = noteText
  note.classList.remove('is-error')
  submit.disabled = true
  submit.textContent = 'Joining…'
  try {
    const res = await fetch(WAITLIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        email,
        source: location.search.slice(1) || document.referrer || 'direct',
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
    if (!res.ok || !data.ok) throw new Error(`waitlist: ${res.status}`)
    try {
      localStorage.setItem(JOINED_KEY, '1')
    } catch {
      /* fine */
    }
    showDone()
  } catch (err) {
    console.warn(err)
    fail('Couldn’t save it. Try again in a minute, or DM @buzzybats on X.')
  }
})
