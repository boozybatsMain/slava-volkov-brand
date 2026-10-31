import type { Layer, LayerContext } from '../../../core/types'
import { titleEdgeY } from './geometry'
import { getRasterTitleParams, renderPixelSize, type RasterTitleParams } from './params'

/**
 * TITLE — static fallback (no three.js in here, so it loads even when WebGL is the problem).
 *
 * Used when there is no WebGL / the title's shader fails to link (index.ts); during a WebGL context
 * loss the WebGL title stays blank until three restores it. The same render, keyed at runtime from color.png + maps.png
 * with title.raster.threshold / fringe, is drawn at the REST pose onto the same low-res pixel grid
 * as the WebGL title (renderPixelSize), nearest-sampled, `image-rendering: pixelated` — so it is
 * just as stair-stepped and "badly cut out". No turn, sliding highlights or shimmer;
 * title.perspective / tilt are not applied (the render's own baked perspective stays).
 * The light behind the letters (title.glow) is drawn as canvas shadows (no perspective shrink).
 */

export interface Meta {
  size: [number, number]
  anchor: [number, number]
  bbox: [number, number, number, number]
  vanish: [number, number]
  lines: { top: [number, number]; bottom: [number, number] }
}

export const ASSET_DIR = `${import.meta.env.BASE_URL}assets/title-raster/`

/** onload, not decode(): decode() may wait for the page to become visible. */
function loadImage(name: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`[title] cannot load ${name}`))
    img.src = ASSET_DIR + name
  })
}

const hexRgb = (hex: string) => {
  // '#rgb' → '#rrggbb' (?set. and THREE.Color accept both)
  if (/^#[0-9a-f]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return v.every(Number.isFinite) ? v : [255, 255, 255]
}

/** Hard cut of the matte at `threshold` + the light white-keyed fringe, at texel resolution. */
function keyTitle(color: HTMLImageElement, maps: HTMLImageElement, P: RasterTitleParams) {
  const w = color.naturalWidth
  const h = color.naturalHeight
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const g = out.getContext('2d', { willReadFrequently: true })!
  g.drawImage(maps, 0, 0)
  const m = g.getImageData(0, 0, w, h).data
  g.clearRect(0, 0, w, h)
  g.drawImage(color, 0, 0)
  const img = g.getImageData(0, 0, w, h)
  const d = img.data
  const thr = P.threshold * 255
  const fc = hexRgb(P.fringeColor)
  for (let i = 0; i < d.length; i += 4) {
    const a = m[i]
    if (a < thr) {
      d[i + 3] = 0
      continue
    }
    // same ramp as the shader: fringe = 1 - smoothstep(thr, thr + 0.28, matte)
    const t = Math.min(1, (a - thr) / (0.28 * 255))
    const f = (1 - t * t * (3 - 2 * t)) * P.fringe
    for (let c = 0; c < 3; c++) d[i + c] += (fc[c] - d[i + c]) * f
    d[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return out
}

export async function createTitleFallback(mount: HTMLElement, ctx: LayerContext): Promise<Layer> {
  const [meta, color, maps] = await Promise.all([
    fetch(ASSET_DIR + 'meta.json').then((r) => r.json() as Promise<Meta>),
    loadImage('color.png'),
    loadImage('maps.png'),
  ])
  const [ax, ay] = meta.anchor
  const [bx0, , bx1] = meta.bbox

  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    imageRendering: 'pixelated',
    pointerEvents: 'none',
  })
  canvas.setAttribute('aria-hidden', 'true')
  canvas.dataset.titleFallback = ''
  mount.appendChild(canvas)
  const g = canvas.getContext('2d')!

  let keyed: HTMLCanvasElement | null = null
  let keyedFor = ''

  const layer: Layer = {
    resize(layout, config) {
      const P = getRasterTitleParams(config)
      const k = `${P.threshold}|${P.fringe}|${P.fringeColor}`
      if (!keyed || k !== keyedFor) {
        keyed = keyTitle(color, maps, P)
        keyedFor = k
      }
      const ps = renderPixelSize(layout, config)
      const w = Math.max(1, Math.round(layout.width / ps))
      const h = Math.max(1, Math.round(layout.height / ps))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      // rest pose of the WebGL title: anchor texel on layout.title.{x,y}, span = layout.title.width
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, w, h)
      g.imageSmoothingEnabled = false
      g.setTransform(w / layout.width, 0, 0, h / layout.height, 0, 0)
      g.translate(layout.title.x, layout.title.y)
      g.rotate((layout.title.rotation * Math.PI) / 180)
      const s = layout.title.width / Math.max(1, bx1 - bx0)
      g.scale(s, s)
      // title.glow: halo, then rim, as blurred shadows of the cut-out (shadowBlur is in canvas px = 2σ).
      // At the contour a shadow covers half of its alpha → alpha 2·(1 − e^(−strength·amount/2)) gives
      // the same edge brightness as the WebGL light, 1 − e^(−amount·(rim + halo)/2).
      const G = config.title.glow
      if (G.amount > 0) {
        const hS = titleEdgeY(meta, 'bottom', ax) - titleEdgeY(meta, 'top', ax)
        const pxPerTexel = (s * w) / layout.width
        const lights: [number, number, string][] = [
          [G.halo.strength, G.halo.radius, G.haloColor],
          [G.core.strength, G.core.radius, G.color],
        ]
        for (const [strength, radius, hex] of lights) {
          if (strength <= 0) continue
          const [r, gr, b] = hexRgb(hex)
          const alpha = Math.min(1, 2 * (1 - Math.exp((-G.amount * strength) / 2)))
          g.shadowColor = `rgba(${r}, ${gr}, ${b}, ${alpha.toFixed(3)})`
          g.shadowBlur = 2 * radius * hS * pxPerTexel
          g.drawImage(keyed, -ax, -ay)
        }
        g.shadowColor = 'transparent'
        g.shadowBlur = 0
      }
      g.drawImage(keyed, -ax, -ay)
    },
    update() {},
    dispose() {
      canvas.remove()
    },
  }

  layer.resize(ctx.layout, ctx.config)
  return layer
}
