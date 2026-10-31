import type { Frame, Layer, Layout, LayerFactory, ResolvedConfig } from '../../core/types'

/**
 * PHOTO SKY — version 2 (index.html): a full-bleed photograph of the sky behind the title.
 *
 * Plain DOM: one <img> per plate, sized once per resize (object-fit: cover maths done here, so
 * the focus point and the motion margin are exact), moved every frame by a compositor-only
 * `transform`. No canvas, no re-layout per frame, the photo stays as crisp as the file.
 *
 *   wide plate (landscape screens) / tall plate (portrait screens: phones, tablets)
 *   → cover the hero like `object-fit: cover`, with `sky.focus` / `sky.tallFocus` kept in frame
 *     (the same maths as `object-position`: focus x = 0.3 → 30 % of the overflow goes left);
 *   → `sky.zoom` ≥ 1 adds a margin; it is grown automatically if parallax + drift need more,
 *     so an edge of the photo can never show;
 *   → life, calm and photographic: mouse parallax (world.parallax px, opposite to the pointer,
 *     as the v1 world) + an ultra-slow ping-pong drift (sky.drift, × world.drift — damped by
 *     prefers-reduced-motion in resolveConfig). No zoom pulsing, no wrapping.
 *
 * Until a plate is decoded the layer shows a flat gradient in the photo's own colours
 * (sky.colorTop → sky.colorBottom), then fades the photo in. Switching between wide and tall
 * (rotating a tablet, resizing a window) decodes the other plate first and cross-fades.
 */

interface SkyKnobs {
  wide: string
  tall: string
  tallBelow: number
  focus: { x: number; y: number }
  tallFocus: { x: number; y: number }
  zoom: number
  drift: { x: number; y: number; period: number }
  colorTop: string
  colorBottom: string
  fadeIn: number
}

/** Used when sky.config.ts has no such key (the layer must work with any config). */
const DEFAULTS: SkyKnobs = {
  wide: 'sky-wide.webp',
  tall: 'sky-tall.webp',
  tallBelow: 1,
  focus: { x: 0.5, y: 0.5 },
  tallFocus: { x: 0.5, y: 0.5 },
  zoom: 1.03,
  drift: { x: 14, y: 4, period: 150 },
  colorTop: '#5a7192',
  colorBottom: '#a49a9b',
  fadeIn: 600,
}

const ASSET_DIR = `${import.meta.env.BASE_URL}assets/sky/`

type Variant = 'wide' | 'tall'

function knobs(config: ResolvedConfig): SkyKnobs {
  const s = ((config as unknown as { sky?: Partial<SkyKnobs> }).sky ?? {}) as Partial<SkyKnobs>
  return {
    ...DEFAULTS,
    ...s,
    focus: { ...DEFAULTS.focus, ...s.focus },
    tallFocus: { ...DEFAULTS.tallFocus, ...s.tallFocus },
    drift: { ...DEFAULTS.drift, ...s.drift },
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number) => clamp(Number.isFinite(v) ? v : 0.5, 0, 1)

/** Resolves once the image is fully decoded (no half-painted frame, no jank when it appears). */
async function decodePlate(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  img.fetchPriority = 'high'
  img.alt = ''
  img.draggable = false
  img.src = url
  await img.decode()
  return img
}

interface Plate {
  variant: Variant
  url: string
  img: HTMLImageElement
  /** Geometry for the current viewport, CSS px. Rest position (focus) and the allowed range. */
  baseX: number
  baseY: number
  minX: number
  minY: number
  /** Last transform written (skip identical writes → no style invalidation when nothing moves). */
  tx: number
  ty: number
}

export const createPhotoSkyLayer: LayerFactory = async (mount, ctx) => {
  let layout: Layout = ctx.layout
  let config: ResolvedConfig = ctx.config
  let disposed = false

  // Flat sky in the photo's colours right away (no flash of the page colour, no layout shift).
  const paintBackdrop = () => {
    const k = knobs(config)
    mount.style.background = `linear-gradient(180deg, ${k.colorTop} 0%, ${k.colorBottom} 100%)`
  }
  mount.style.overflow = 'hidden'
  mount.style.contain = 'strict'
  paintBackdrop()

  const variantFor = (l: Layout, k: SkyKnobs): Variant =>
    l.height > 0 && l.width / l.height < k.tallBelow ? 'tall' : 'wide'
  const urlFor = (v: Variant, k: SkyKnobs) => ASSET_DIR + (v === 'tall' ? k.tall : k.wide)

  /** Max |offset| the motion can ask for on each axis (pointer spring may overshoot a little). */
  const motionReach = () => {
    const k = knobs(config)
    const par = Math.abs(config.world.parallax) * Math.max(1, config.motion.intensity) * 1.15
    const drift = Math.max(0, config.world.drift) > 0 ? 1 : 0
    return { x: par + Math.abs(k.drift.x) * drift + 1, y: par + Math.abs(k.drift.y) * drift + 1 }
  }

  /** object-fit: cover + zoom + guaranteed motion margin, focus kept like object-position. */
  const fit = (p: Plate) => {
    const k = knobs(config)
    const W = layout.width
    const H = layout.height
    const iw = p.img.naturalWidth || 1
    const ih = p.img.naturalHeight || 1
    const reach = motionReach()
    const scale = Math.max(
      Math.max(W / iw, H / ih) * Math.max(1, k.zoom),
      (W + 2 * reach.x) / iw,
      (H + 2 * reach.y) / ih,
    )
    const w = iw * scale
    const h = ih * scale
    const f = p.variant === 'tall' ? k.tallFocus : k.focus
    p.minX = W - w
    p.minY = H - h
    // the focus point lands where it sits in the photo (object-position), but never so close to
    // an edge that the motion could pull the photo off it
    p.baseX = clamp((W - w) * clamp01(f.x), p.minX + reach.x, -reach.x)
    p.baseY = clamp((H - h) * clamp01(f.y), p.minY + reach.y, -reach.y)
    p.img.style.width = `${w}px`
    p.img.style.height = `${h}px`
    p.tx = p.ty = NaN
  }

  const place = (p: Plate, dx: number, dy: number) => {
    const x = clamp(p.baseX + dx, p.minX, 0)
    const y = clamp(p.baseY + dy, p.minY, 0)
    if (Math.abs(x - p.tx) < 0.01 && Math.abs(y - p.ty) < 0.01) return
    p.tx = x
    p.ty = y
    p.img.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
  }

  let current: Plate | null = null
  /** Plate fading out after a wide ↔ tall switch. */
  let leaving: Plate | null = null
  let pending: Variant | null = null
  let pendingUrl = ''
  /** Plates that failed to load: not retried on every resize. */
  const failed = new Set<string>()
  let offset = { x: 0, y: 0 }

  const show = (img: HTMLImageElement, variant: Variant, url: string) => {
    const k = knobs(config)
    Object.assign(img.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'block',
      maxWidth: 'none',
      transformOrigin: '0 0',
      willChange: 'transform',
      pointerEvents: 'none',
      userSelect: 'none',
      opacity: '0',
      transition: `opacity ${Math.max(0, k.fadeIn)}ms ease-out`,
    } satisfies Partial<CSSStyleDeclaration>)
    img.setAttribute('aria-hidden', 'true')
    const plate: Plate = { variant, url, img, baseX: 0, baseY: 0, minX: 0, minY: 0, tx: NaN, ty: NaN }
    fit(plate)
    place(plate, offset.x, offset.y)
    mount.appendChild(img)
    if (current) {
      leaving?.img.remove()
      leaving = current
      const old = current
      window.setTimeout(() => {
        old.img.remove()
        if (leaving === old) leaving = null
      }, Math.max(0, k.fadeIn) + 50)
    }
    current = plate
    // next frame: the transition needs a committed opacity: 0 to start from
    requestAnimationFrame(() => requestAnimationFrame(() => (img.style.opacity = '1')))
  }

  const load = async (variant: Variant) => {
    const k = knobs(config)
    const url = urlFor(variant, k)
    if (current?.url === url || pendingUrl === url || failed.has(url)) return
    pending = variant
    pendingUrl = url
    try {
      const img = await decodePlate(url)
      // the viewport may have rotated back while this plate was decoding
      const now = knobs(config)
      if (disposed || pendingUrl !== url || urlFor(variantFor(layout, now), now) !== url) return
      show(img, variant, url)
    } catch (err) {
      failed.add(url)
      if (!disposed && pendingUrl === url) console.warn(`[sky] photo "${url}" failed to load — flat sky instead`, err)
    } finally {
      if (pendingUrl === url) {
        pending = null
        pendingUrl = ''
      }
    }
  }

  // Wait for the first plate (≤ the hero's mount timeout): the photo then appears in one piece.
  await load(variantFor(layout, knobs(config)))

  let phase = NaN
  let lastTime = 0

  const layer: Layer = {
    resize(l, c) {
      layout = l
      config = c
      paintBackdrop()
      const k = knobs(config)
      const want = variantFor(layout, k)
      if (!current || urlFor(want, k) !== current.url) {
        if (pending !== want || pendingUrl !== urlFor(want, k)) void load(want)
      } else {
        // back to the plate already on screen: drop a stale load of the other one
        pending = null
        pendingUrl = ''
      }
      if (current) fit(current)
      if (leaving) fit(leaving)
    },

    update(frame: Frame) {
      const k = knobs(frame.config)
      const world = frame.config.world
      // drift: phase advances with animation time (frozen by ?freeze, no jump after a hidden tab),
      // speed × world.drift so the tuner / reduced motion change speed without a jump
      const omega = (2 * Math.PI) / Math.max(1, k.drift.period)
      const speed = Math.max(0, world.drift)
      if (Number.isNaN(phase)) phase = frame.time * omega * speed
      else phase += clamp(frame.time - lastTime, 0, 0.1) * omega * speed
      lastTime = frame.time
      // a slow Lissajous ping-pong: the two axes never turn around at the same moment
      const driftX = k.drift.x * Math.sin(phase)
      const driftY = k.drift.y * Math.sin(phase * 0.71 + 1.3)
      // parallax: the sky is far behind the title → moves opposite to the pointer (v1 semantics)
      const px = -frame.pointer.x * world.parallax
      const py = -frame.pointer.y * world.parallax
      offset = { x: px + driftX, y: py + driftY }
      if (current) place(current, offset.x, offset.y)
      if (leaving) place(leaving, offset.x, offset.y)
    },

    dispose() {
      disposed = true
      pendingUrl = ''
      current?.img.remove()
      leaving?.img.remove()
      current = leaving = null
      mount.style.background = ''
      mount.style.overflow = ''
      mount.style.contain = ''
    },
  }
  return layer
}
