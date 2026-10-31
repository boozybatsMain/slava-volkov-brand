// HTML of the game cards, written into index.html and games/index.html at build time (vite.config.ts).
// Media paths start with / so Vite prefixes them with the deploy base.
import { games, home, gamesPage, type Game } from './games.data'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const byId = (id: string) => {
  const g = games.find((x) => x.id === id)
  if (!g) throw new Error(`games.data.ts: no game "${id}"`)
  return g
}

/** The cover: picture, plus a muted looping video on top when the game has one. */
function media(g: Game, autoplay: boolean, eager: boolean) {
  if (!g.cover) return '<span class="media media--ph">[Screenshot]</span>'
  const size = g.coverW ? ` width="${g.coverW}" height="${g.coverH}"` : ''
  let out = `<img src="/covers/${g.cover}"${size}${eager ? '' : ' loading="lazy"'} alt="${esc(g.alt)}" />`
  if (g.video) {
    const src = (g.video.webm ? `<source src="/covers/${g.video.webm}" type="video/webm" />` : '') + `<source src="/covers/${g.video.mp4}" type="video/mp4" />`
    out += `<video muted loop playsinline preload="${autoplay ? 'auto' : 'none'}" aria-hidden="true" tabindex="-1" ${autoplay ? 'data-autoplay' : 'data-hover'}>${src}</video>`
  }
  return `<span class="media">${out}</span>`
}

/** An <a> when the game has a link, a plain block otherwise. */
function wrap(g: Game, cls: string, inner: string) {
  const attrs = `class="${cls}" data-bat-avoid${g.video ? ' data-video' : ''}`
  return g.href
    ? `<a ${attrs} href="${esc(g.href)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div ${attrs}>${inner}</div>`
}

export function feature(g: Game, autoplay: boolean, eager = false) {
  const badge = g.badge ? `<span class="badge">${esc(g.badge)}</span>` : ''
  const play = g.href ? '<span class="feat__play">Play</span>' : ''
  return wrap(
    g,
    'feat',
    media(g, autoplay, eager) +
      '<span class="feat__shade" aria-hidden="true"></span>' +
      `<span class="feat__body"><span class="feat__text">${badge}<span class="feat__name">${esc(g.name)}</span><span class="feat__line">${esc(g.line)}</span></span>${play}</span>`,
  )
}

export function card(g: Game, extra = '') {
  return wrap(
    g,
    `card${extra}`,
    `<span class="card__im">${media(g, false, false)}</span><span class="card__name">${esc(g.name)}</span><span class="card__line">${esc(g.line)}</span>`,
  )
}

export function homeGames() {
  return (
    feature(byId(home.featured), true, true) +
    `<div class="row row--${home.row.length}">${home.row.map((id) => card(byId(id))).join('')}</div>`
  )
}

export function allGames() {
  let first = true
  return (
    '<div class="all">' +
    gamesPage
      .map(({ id, size }) => {
        const g = byId(id)
        if (size === 'feature') {
          const html = `<div class="all__feat">${feature(g, first, first)}</div>`
          first = false
          return html
        }
        return card(g, ` all__${size}`)
      })
      .join('') +
    '</div>'
  )
}
