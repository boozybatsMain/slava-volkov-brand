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

/** Laurel branch, drawn once and mirrored for the right side. */
const branch =
  '<path d="M7 21c-3.2-2.6-4.6-6.4-3.8-11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  [
    [3.6, 8.2, -20],
    [3.2, 11.6, -40],
    [4, 15, -60],
    [5.6, 18, -80],
  ]
    .map(([x, y, r]) => `<ellipse cx="${x - 1.6}" cy="${y}" rx="1.5" ry="2.8" transform="rotate(${r} ${x - 1.6} ${y})"/>`)
    .join('')
const laurel = (side: 'l' | 'r') =>
  `<svg class="award__laurel award__laurel--${side}" viewBox="0 0 10 24" aria-hidden="true" fill="currentColor">${branch}</svg>`

/** Jam awards on the cover corner, stacked: each is its own link, so they sit beside the card link, not inside it. */
function awards(g: Game) {
  if (!g.awards?.length) return ''
  return (
    '<span class="awards">' +
    g.awards
      .map(
        (a) =>
          `<a class="award award--${a.tier}" href="${esc(a.href)}" target="_blank" rel="noopener" aria-label="${esc(`${a.title}, ${a.event}`)}">` +
          laurel('l') +
          `<span class="award__text"><span class="award__title">${esc(a.title)}</span><span class="award__event">${esc(a.event)}</span></span>` +
          laurel('r') +
          '</a>',
      )
      .join('') +
    '</span>'
  )
}

/** target for a card link: own pages open in the same tab, games elsewhere in a new one. */
const target = (href: string) => (href.startsWith('/') ? '' : ' target="_blank" rel="noopener"')

/** An <a> when the game has a link, a plain block otherwise. A game with an award gets a block that holds
 *  the card link (display: contents, so the layout is the same) and the award links next to it. */
function wrap(g: Game, cls: string, inner: string) {
  const attrs = `class="${cls}${g.awards?.length ? ' has-award' : ''}" data-bat-avoid${g.video ? ' data-video' : ''}`
  if (g.awards?.length) {
    const link = g.href
      ? `<a class="contents" href="${esc(g.href)}"${target(g.href)}>${inner}</a>`
      : inner
    return `<div ${attrs}>${link}${awards(g)}</div>`
  }
  return g.href
    ? `<a ${attrs} href="${esc(g.href)}"${target(g.href)}>${inner}</a>`
    : `<div ${attrs}>${inner}</div>`
}

export function feature(g: Game, autoplay: boolean, eager = false) {
  const badge = g.badge ? `<span class="badge">${esc(g.badge)}</span>` : ''
  const play = g.href ? `<span class="feat__play">${esc(g.cta ?? 'Play')}</span>` : ''
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
  const [top, ...rest] = gamesPage
  return (
    '<div class="all">' +
    `<div class="all__feat">${feature(byId(top.id), true, true)}</div>` +
    rest.map(({ id, size }) => card(byId(id), ` all__${size}`)).join('') +
    '</div>'
  )
}
