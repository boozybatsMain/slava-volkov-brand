import type { SkyConfig } from './sky.config'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  БАННЕРЫ ДЛЯ СОЦСЕТЕЙ — кадры хиро версии 2 (index.html) без навигации
 * ─────────────────────────────────────────────────────────────────────────────
 *  Рендер: node scripts/banners.mjs (опции — в шапке скрипта). Кадр снимает живой хиро на
 *  dev-сервере ровно в итоговых пикселях: тайтл не масштабируется и не сглаживается.
 *  Здесь только то, чем кадр баннера отличается от сайта: размер, поза, момент времени и
 *  композиция (overrides ложатся поверх sky.config.ts так же, как ?set.).
 *
 *  Требования площадок замерены 2026-10-08 (DOM / CSS живых страниц и заголовки JPEG, которые
 *  они отдают); Reddit замерить не удалось — там только сводка гайдов.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** Разметка для превью (banners/preview): что площадка обрезает и что перекрывает, px холста. */
export type BannerGuide =
  | { kind: 'safe'; label: string; x: number; y: number; w: number; h: number }
  | { kind: 'crop'; label: string; x: number; y: number; w: number; h: number }
  | { kind: 'avatar'; label: string; cx: number; cy: number; r: number }

export interface BannerSpec {
  /** Итоговый размер файла, px. */
  width: number
  height: number
  /**
   * Пикселей файла на CSS px страницы (как devicePixelRatio). 1 — страница шириной во весь файл.
   * От него зависят размеры в CSS px: зерно, подзаголовок, pixelSize тайтла.
   */
  scale: number
  /** Поза надписи: куда «смотрит» мышь, -1…1 (0, 0 — покой). */
  pointer: { x: number; y: number }
  /** Момент анимации, секунды: от него зависят лучи за надписью и ветер. */
  time: number
  /** Подзаголовок GAMES / SOFTWARE & / EXPERIMENTS (навигации на баннерах нет никогда). */
  tagline: boolean
  /** Отличия от sky.config.ts — та же структура. */
  overrides: DeepPartial<SkyConfig>
  /** Файлы на выходе: png — полноцветный, jpg — лучшее качество (4:4:4) не больше maxBytes. */
  export: { formats: ('png' | 'jpg')[]; maxBytes: number }
  /**
   * Как баннер видно на площадке: ширина в CSS px и плотность экрана. Превью *-display снимается
   * в этом размере (браузер уменьшает картинку так же, как площадка), с первым аватаром из guides.
   * crop — какая часть холста видна (по умолчанию весь).
   */
  display: { width: number; dpr: number; crop?: { x: number; y: number; w: number; h: number } }
  guides: BannerGuide[]
}

export const banners: Record<string, BannerSpec> = {
  /**
   * YouTube: 2560×1440, до 6 МБ. TV показывает весь кадр 16:9. Десктоп и мобильный веб — только
   * полосу 6.2:1 во всю ширину: y ≈ 514–926 (до 1284×207 CSS px на десктопе). Официальная
   * безопасная зона для всех устройств — 1546×423 по центру. Аватар баннер не перекрывает
   * (стоит под ним). Показывает YouTube всегда свой JPEG ≈ q89 4:2:0, оригинал не виден.
   *
   * Имя и подзаголовок целиком в безопасной зоне (общая рамка x 595–1896, y 538–910 — запас
   * 88 / 18 / 157 / 10 px). Наклон пологий (3.5°, при ширине 50%; шире — последняя «V» уходит за
   * низ полосы), поза к левому верху (pointer, perspective 0.75) — VOLKOV крупнее и читается в
   * полосе 1284×207. Подзаголовок — над «LKOV», справа сверху (под «S» нет места: там низ полосы),
   * в 40 px от букв; прописные ≈ 31 px холста ≈ 15 CSS px в полосе на десктопе. Луна ушла вправо.
   * Остальной кадр (его видит TV) — как на сайте: чистое небо сверху, «S» в облаке, «башня»
   * ближнего вала справа, за концом VOLKOV.
   * renderWidth 316 — лесенка ≈ 4.35 px холста = 2.2 CSS px в полосе на десктопе, как на сайте.
   */
  youtube: {
    width: 2560,
    height: 1440,
    scale: 1,
    pointer: { x: -0.6, y: -0.5 },
    time: 4,
    tagline: true,
    overrides: {
      title: {
        anchor: { x: 0.235, y: 0.452 },
        width: 50,
        rotation: 3.5,
        perspective: 0.75,
        raster: { renderWidth: 316 },
        glow: { amount: 0.35 },
      },
      // над «LKOV»: along — место вдоль надписи, below < -1 — выше её верхнего края (в её высотах)
      overlay: { tagline: { along: 0.8, below: -2.25, size: 25 } },
      sky: {
        layers: {
          moon: { x: 87, y: 41.5, width: 3.2 },
          // россыпь целиком под валами: в полосе она засыпала небо вокруг имени
          cloudletsMid: { y: 100 },
          cloudlets: { x: 89, y: 52, width: 18, flipX: false },
          cloudletsLeft: { y: 86 },
          // валы не шире ≈ 1.2 исходника — иначе клубы мылятся от растяжения
          bankBack: { width: 125, y: 71 },
          bankFront: { x: 69.5, y: 59.5, width: 140, flipX: true },
          // малое облако под «S» закрывает ≈ 15% её низа, дальше чисто
          frontClouds: { x: 16.9, y: 49.4, width: 36.6, anchor: { x: 0.5, y: 0.376 } },
        },
      },
    },
    export: { formats: ['png'], maxBytes: 6_000_000 },
    display: { width: 1284, dpr: 2, crop: { x: 0, y: 514, w: 2560, h: 413 } },
    guides: [
      { kind: 'crop', label: 'desktop / mobile web 6.2:1', x: 0, y: 514, w: 2560, h: 413 },
      { kind: 'safe', label: 'safe, all devices', x: 507, y: 520, w: 1546, h: 400 },
    ],
  },
  /**
   * X (Twitter): шапка 1500×500 (3:1), до 2 МБ. Десктоп: 600×200 CSS px, аватар Ø 340 px холста
   * (с кольцом) с центром на нижнем крае, x 40–380. Мобильный веб: высота 200 CSS px, бока
   * срезаны — видно только x ≈ 281–1219, аватар x 321–536. Сверху и снизу «может срезаться 60 px».
   * Полноцветный файл X пережимает в JPEG q85 4:2:0. PNG-8 (≤ 256 цветов) он не трогает, но в
   * 256 цветах гаснут голубые блики хрома (проверено) — грузить JPEG.
   *
   * Ближе всех к сайту: тот же наклон 7.95° и поза покоя, «S» в облаке, лучи за «LAVA», персиковые
   * валы внизу. Под «S» (место подзаголовка на сайте) — аватар, поэтому подзаголовок справа сверху,
   * над «VOLKOV» (там на сайте навигация): диагональ имени уравновешена им и аватаром по углам.
   * Общая рамка x 325–1182, y 80–427 — в безопасной зоне и в мобильном кадре, до аватаров 107 / 115 px,
   * до букв 44 px; прописные ≈ 12 CSS px при показе 600 px. Луна ушла вправо, за подзаголовок.
   * renderWidth 250 — лесенка ≈ 1.45 CSS px при показе 600 px.
   */
  x: {
    width: 1500,
    height: 500,
    scale: 1,
    pointer: { x: 0, y: 0 },
    time: 4,
    tagline: true,
    overrides: {
      title: {
        anchor: { x: 0.226, y: 0.332 },
        width: 58.3,
        raster: { renderWidth: 250 },
        glow: { amount: 0.5 },
      },
      overlay: { tagline: { along: 0.66, below: -2.5, size: 44 } },
      sky: {
        layers: {
          // небо чуть насыщеннее: рядом с ярко-синей аватаркой не выглядит блёклым
          plate: { focus: { x: 0.5, y: 0.3 }, grade: { saturation: 1.15, brightness: 0.95, contrast: 1.05 } },
          moon: { x: 90, y: 19, width: 5.2 },
          cloudletsMid: { x: 56, y: 92, width: 120, opacity: 0.75 },
          cloudlets: { x: 81, y: 37 },
          cloudletsLeft: { x: 9, y: 80, width: 34, opacity: 0.45 },
          bankBack: { y: 80 },
          bankFront: { y: 76 },
          frontClouds: { x: 28.5, y: 48, width: 48, anchor: { x: 0.765, y: 0.4 } },
        },
      },
    },
    export: { formats: ['jpg'], maxBytes: 2_000_000 },
    display: { width: 600, dpr: 2 },
    guides: [
      { kind: 'crop', label: 'mobile web', x: 281, y: 0, w: 938, h: 500 },
      { kind: 'safe', label: 'safe', x: 300, y: 60, w: 900, h: 380 },
      { kind: 'avatar', label: 'desktop', cx: 210, cy: 500, r: 170 },
    ],
  },
  /**
   * Reddit: баннер профиля u/. Официальной спецификации нет; чаще всего 10:3 (API отдаёт кроп
   * 1280×384), лимиты в гайдах от 500 КБ до 5 МБ — держим ≤ 500 КБ. Аватар: на десктопе слева
   * внизу, в приложении — внизу по центру (по гайдам, не замерено). Безопасная зона — центр.
   *
   * Раз размещение не замерено — компактная связка в безопасной зоне, как на сайте: имя сверху,
   * подзаголовок под «S» (общая рамка x 421–1039, y 98–362). Связка чуть левее центра: так
   * подзаголовок обходит аватар приложения (внизу по центру) — до него 42 px, до десктопного 68 px.
   * Подзаголовок крупнее, чем на сайте (прописные ≈ 33 px холста), иначе в приложении (390 CSS px)
   * его не прочесть. Наклон 3.5° — при 7.95° имя в зоне 800×288 было бы на 20% мельче.
   * Над «S» запаса 2 px: если двигать надпись — сначала width 38.6 → 38, потом перемерить.
   * renderWidth 220 — лесенка ≈ 2.8 px холста.
   */
  reddit: {
    width: 1600,
    height: 480,
    scale: 1,
    pointer: { x: 0, y: 0 },
    time: 4,
    tagline: true,
    overrides: {
      title: {
        anchor: { x: 0.27, y: 0.336 },
        width: 38.6,
        rotation: 3.5,
        raster: { renderWidth: 220 },
        glow: { amount: 0.4 },
      },
      overlay: { tagline: { below: 0.1, size: 42 } },
      sky: {
        // 10:3: слои по ширине холста, а не 1.8 × высоты — иначе мелкие и повторяются
        designAspect: 3.34,
        layers: {
          // focus 0.45 убирает серую дымку у луны; grade — небо того же цвета, что на YouTube и X
          plate: { focus: { y: 0.45 }, grade: { saturation: 1.25, brightness: 0.92, contrast: 0.95 } },
          moon: { x: 86, y: 22, width: 3 },
          cloudletsMid: { x: 50, y: 100, width: 45 },
          // облачка слева уравновешивают луну справа
          cloudlets: { x: 13, y: 39, width: 25, flipX: false },
          cloudletsLeft: { opacity: 0 },
          bankBack: { x: 50, y: 76, width: 110, anchor: { x: 0.5, y: 0.66 } },
          bankFront: { x: 50, y: 66, width: 110, flipX: true },
          frontClouds: { x: 34, y: 49.5, width: 38, anchor: { x: 0.765, y: 0.485 }, opacity: 0.75 },
        },
      },
    },
    export: { formats: ['jpg'], maxBytes: 500_000 },
    // как в приложении: телефон 390 CSS px, аватар внизу по центру
    display: { width: 390, dpr: 3 },
    guides: [
      { kind: 'safe', label: 'safe (guides)', x: 400, y: 96, w: 800, h: 288 },
      { kind: 'avatar', label: 'app?', cx: 800, cy: 480, r: 150 },
      { kind: 'avatar', label: 'desktop?', cx: 240, cy: 480, r: 150 },
    ],
  },
}
