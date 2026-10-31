// Все игры сайта: одна правка здесь меняет и главную, и страницу /games.
// Карточки вписываются в HTML при сборке (vite.config.ts → плагин games), так что они есть и без JS.
// Картинки и видео лежат в public/covers/. Видео: mp4 (H.264, без звука) обязательно, webm по желанию.
// Пока здесь только вышедшие игры: Corner Guy, Frigate Naval Battles и Big Big Kick Слава попросит добавить сам.

export interface Game {
  id: string
  name: string
  /** Куда ведёт карточка. '' — ссылки пока нет. */
  href: string
  /** Строка под названием. */
  line: string
  /** Обложка (public/covers/…), '' — серая заглушка. */
  cover: string
  coverW?: number
  coverH?: number
  alt: string
  /** Видео-обложка: на главной акцентной игре играет сразу, у остальных при наведении. */
  video?: { mp4: string; webm?: string }
  badge?: string
}

export const games: Game[] = [
  {
    id: 'pumpkin-night',
    name: 'Pumpkin Night',
    href: 'https://genex.games/snowball',
    line: 'Play in browser',
    cover: 'pumpkin-night.webp',
    coverW: 1600,
    coverH: 900,
    alt: 'Pumpkin Night: a giant jack-o’-lantern in a witch hat floating over a graveyard under the full moon',
    video: { mp4: 'pumpkin-night.mp4' },
    badge: 'Newest',
  },
  {
    id: 'hollowgrin',
    name: 'Hollowgrin',
    href: 'https://genex.games/hollowgrin',
    line: 'Play in browser',
    cover: 'hollowgrin.webp',
    coverW: 1260,
    coverH: 1000,
    alt: 'Hollowgrin: a pumpkin-headed host with long spider legs over three numbered cups',
    video: { mp4: 'hollowgrin.mp4', webm: 'hollowgrin.webm' },
  },
  {
    id: 'fold-the-duo',
    name: 'Fold the Duo',
    href: 'https://genex.games/foldtheduo',
    line: 'Play in browser',
    cover: 'fold-the-duo.webp',
    coverW: 1600,
    coverH: 900,
    alt: 'Fold the Duo: two hands holding a folding phone with a broken screen above its open box',
    video: { mp4: 'fold-the-duo.mp4' },
  },
]

/** Главная: первая — большая, с видео сразу; две следующие — карточки с видео при наведении. */
export const home = { featured: 'pumpkin-night', row: ['hollowgrin', 'fold-the-duo'] }

/**
 * Страница /games: сверху вниз. 'feature' — большая карточка на всю ширину (видео играет сразу только
 * у первой), 'wide' и 'narrow' — пара в одном ряду (7 и 5 колонок из 12), 'card' — по две в ряд.
 */
export const gamesPage: { id: string; size: 'feature' | 'wide' | 'narrow' | 'card' }[] = [
  { id: 'pumpkin-night', size: 'feature' },
  { id: 'hollowgrin', size: 'wide' },
  { id: 'fold-the-duo', size: 'narrow' },
]
