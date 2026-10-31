import { projects } from '../../core/projects'
import type { SlabKnobs } from './solve'

/**
 * SLAB — the project pictures.
 *
 * Every picture (public/assets/projects/<projects.items.*.src>) is fetched, decoded off the main
 * thread and REDUCED to raster.texWidth: the slab stretches that small frame back with no
 * smoothing — a texture of a late-90s game, not a photo. The current project loads first, the
 * rest one by one when the browser is idle; the picture a switch is heading for does not wait in
 * that queue — it is requested on the spot, next to whatever is on its way. Every result is
 * reported to the projects store (setLoaded), which holds a switch back until its picture is there.
 *
 * A missing or broken file becomes a «no signal» card (one warning), so the slab never shows a hole;
 * a file that does not come does not hold the others back (STALL), and ends as that card too
 * (DEADLINE). No three.js here: the WebGL slab uploads these canvases, the flat fallback draws them.
 */

const DIR = `${import.meta.env.BASE_URL}assets/projects/`
/** Height of a frame that could not be measured (the «no signal» card): 16:9. */
const CARD_ASPECT = 16 / 9
/**
 * How long one file may keep the idle queue to itself, ms. A picture still on its way after that
 * goes on loading (it shows up whenever it arrives), but the next one no longer waits for it.
 */
const STALL = 4000
/**
 * How long a file may take at all, ms: then the request is dropped and the picture becomes the
 * «no signal» card, like any other failure. A connection that hangs would otherwise leave the slab
 * untextured for as long as the browser keeps the request pending — minutes. (A picture is ≈ 220 kB:
 * this is a line slower than 7 kB/s.)
 */
const DEADLINE = 30000

export interface SlabPicture {
  /** The frame at raster.texWidth, or the «no signal» card. */
  canvas: HTMLCanvasElement
  /** false — the file is missing: `canvas` is the card. */
  ok: boolean
  /** Distinguishes one load of a slot from the next (a texture is rebuilt when it changes). */
  version: number
}

/**
 * Cover-crop of a picture `picAspect` wide onto a face `faceAspect` wide, around `focus` (fractions
 * of the picture): the picture uv of the face's top-left corner and the size of the visible window.
 */
export function coverCrop(picAspect: number, faceAspect: number, focus: { x: number; y: number }) {
  const sx = Math.min(1, faceAspect / picAspect)
  const sy = Math.min(1, picAspect / faceAspect)
  const fit = (f: number, s: number) => Math.min(1 - s, Math.max(0, f - s / 2))
  return { x: fit(focus.x, sx), y: fit(focus.y, sy), w: sx, h: sy }
}

/**
 * The pictures' grade (projects.raster.grade) as a saturation and a multiplier per channel:
 * c' = mix(luminance(c), c, saturation) × mul, in display space. mul is the tint divided by its own
 * luminance, mixed with 1 by tintAmount: it shifts the hue and keeps the brightness. Then the white
 * point: a luminance above `knee` is compressed so that pure white lands at `white` (the colour scaled
 * by l' / l: the hue kept; everything darker than the knee untouched) — a picture is never whiter than
 * the void around it, as the ABOUT cards (about.photos.grade.white). Shared by the shader (uPicGrade,
 * uPicWhite) and the flat fallback, so both show the same picture.
 */
export function pictureGrade(K: SlabKnobs): { saturation: number; mul: [number, number, number]; knee: number; white: number } {
  const g = K.raster.grade as SlabKnobs['raster']['grade'] & { white?: number; knee?: number }
  let hex = g.tint.replace('#', '')
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('')
  const v = parseInt(hex.slice(0, 6), 16)
  const rgb = Number.isFinite(v) ? [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255) : [1, 1, 1]
  const l = Math.max(1e-3, 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2])
  const a = Math.min(1, Math.max(0, g.tintAmount))
  const mul = rgb.map((c) => 1 + (c / l - 1) * a) as [number, number, number]
  const white = Math.min(1, Math.max(0.5, g.white ?? 1))
  const knee = Math.min(white, Math.max(0, g.knee ?? 0.8) * white)
  return { saturation: Math.max(0, g.saturation), mul, knee, white }
}

/** pictureGrade's white point for one luminance (0…1): the factor the colour is scaled by. */
export function whiteScale(l: number, knee: number, white: number) {
  if (!(l > knee) || white >= 1) return 1
  return (knee + ((l - knee) * (white - knee)) / Math.max(1e-3, 1 - knee)) / l
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

/** A late-night test card: bars, a black band, the words. Drawn at texture size, crisp. */
function drawNoSignal(width: number, name: string) {
  const c = makeCanvas(width, width / CARD_ASPECT)
  const g = c.getContext('2d')!
  const { width: w, height: h } = c
  const bars = ['#b9b9b4', '#b3b06a', '#6fa9a8', '#73a868', '#a56f9f', '#a8695f', '#5a62a0']
  const bw = Math.ceil(w / bars.length)
  bars.forEach((col, i) => {
    g.fillStyle = col
    g.fillRect(i * bw, 0, bw, Math.round(h * 0.66))
  })
  const low = ['#5a62a0', '#22242b', '#a56f9f', '#22242b', '#6fa9a8', '#22242b', '#b9b9b4']
  low.forEach((col, i) => {
    g.fillStyle = col
    g.fillRect(i * bw, Math.round(h * 0.66), bw, Math.round(h * 0.08))
  })
  g.fillStyle = '#17181d'
  g.fillRect(0, Math.round(h * 0.74), w, h)
  const fs = Math.max(8, Math.round(w / 14))
  g.fillStyle = '#17181d'
  g.fillRect(Math.round(w * 0.24), Math.round(h * 0.36), Math.round(w * 0.52), Math.round(fs * 1.9))
  g.fillStyle = '#eceae6'
  g.font = `700 ${fs}px "Roboto Mono", ui-monospace, Menlo, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('NO SIGNAL', Math.round(w / 2), Math.round(h * 0.36 + fs * 0.98))
  g.font = `400 ${Math.max(6, Math.round(w / 40))}px "Roboto Mono", ui-monospace, Menlo, monospace`
  g.textAlign = 'left'
  g.fillStyle = '#8b8d96'
  g.fillText(name, Math.round(w * 0.04), Math.round(h * 0.87))
  return c
}

/** The file → a canvas `width` px wide (smooth reduction, done by the decoder where it can). */
async function loadReduced(src: string, width: number) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(`no answer in ${DEADLINE / 1000} s`)), DEADLINE)
  let blob: Blob
  try {
    const res = await fetch(DIR + src, { signal: abort.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    blob = await res.blob()
  } finally {
    clearTimeout(timer)
  }
  const full = await createImageBitmap(blob)
  const w = Math.min(width, full.width)
  const c = makeCanvas(w, (w * full.height) / full.width)
  const g = c.getContext('2d')!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(full, 0, 0, c.width, c.height)
  full.close()
  return c
}

/** Safari has no requestIdleCallback before 16.4. */
const idle = (fn: () => void) => {
  const ric = (window as { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback
  if (ric) ric(fn, { timeout: 1500 })
  else setTimeout(fn, 200)
}

export function createSlabPictures(onChange: (index: number) => void) {
  /** per project: what is loaded (or being loaded) for it — `${src}|${texWidth}` */
  let wanted: string[] = []
  let slots: (SlabPicture | null)[] = []
  /** not requested yet, in the order the idle queue takes them */
  let queue: number[] = []
  /** the idle queue has a file on its way (one at a time: preloads must not compete with what is on screen) */
  let idling = false
  let disposed = false
  let version = 0
  const warned = new Set<string>()

  /** Request picture `i` now. Resolves once it is settled — loaded, or failed into its card (never rejects). */
  const load = (i: number) => {
    const want = wanted[i]
    const [src, width] = [want.slice(0, want.lastIndexOf('|')), Number(want.slice(want.lastIndexOf('|') + 1))]
    const done = (canvas: HTMLCanvasElement, ok: boolean) => {
      // the config moved on while this one was loading: it is queued again already
      if (disposed || wanted[i] !== want) return
      slots[i] = { canvas, ok, version: ++version }
      projects.setLoaded(i, ok)
      onChange(i)
    }
    return loadReduced(src, width).then(
      (canvas) => done(canvas, true),
      (err) => {
        if (!warned.has(src)) {
          warned.add(src)
          console.warn(`[slab] project picture "${src}" is unavailable → «no signal» card`, err)
        }
        done(drawNoSignal(width, src), false)
      },
    )
  }

  /** The idle queue: the next file when the one before it is settled — or has taken too long (STALL). */
  const pump = () => {
    if (idling || disposed || !queue.length) return
    idling = true
    let moved = false
    const next = () => {
      if (moved) return
      moved = true
      clearTimeout(stall)
      idling = false
      // the rest wait for an idle moment: they must not compete with what is on screen
      if (queue.length && !disposed) idle(pump)
    }
    const stall = setTimeout(next, STALL)
    void load(queue.shift()!).then(next)
  }

  return {
    /**
     * Bring the set in line with the config: (re)load what changed (`src`, raster.texWidth), the
     * `first` project before the others, those nearest to it next.
     */
    sync(K: SlabKnobs, first: number) {
      const items = Object.values(K.items)
      const width = Math.max(16, Math.round(K.raster.texWidth))
      const next = items.map((it) => `${it.src}|${width}`)
      const changed = next.map((w, i) => w !== wanted[i])
      if (next.length === wanted.length && !changed.some(Boolean)) return
      wanted = next
      slots = next.map((_, i) => (changed[i] ? null : (slots[i] ?? null)))
      const n = next.length
      const dist = (i: number) => Math.min((i - first + n) % n, (first - i + n) % n)
      queue = next.map((_, i) => i).filter((i) => changed[i]).sort((a, b) => dist(a) - dist(b))
      pump()
    },

    /**
     * This is the picture the visitor is looking at, or the one a switch is heading for: if it still
     * waits in the queue it is requested at once — next to whatever the idle queue has on its way,
     * not after it. Loaded or already requested: nothing to do (the slab calls this every frame).
     */
    hurry(i: number) {
      const at = queue.indexOf(i)
      if (at < 0) return
      queue.splice(at, 1)
      void load(i)
    },

    get(i: number): SlabPicture | null {
      return slots[i] ?? null
    },

    /** Debug (stats()). */
    state: () => slots.map((s, i) => (s ? (s.ok ? 'ok' : 'no signal') : queue.includes(i) ? 'queued' : 'loading')),

    dispose() {
      disposed = true
      queue = []
    },
  }
}

export type SlabPictures = ReturnType<typeof createSlabPictures>
