import type { AboutKnobs, PhotoKnobs } from './knobs'

/**
 * ABOUT — the pictures on the cards (public/assets/about/<about.photos.items.*.src>).
 *
 * Each card gets its own small picture: its crop of the file at the card's aspect, reduced to
 * photos.texWidth across with smooth filtering — then stretched back by the renderer with none (point
 * sampling, an explicit mip level): a texture of a late-90s game, not a photo. One file may feed
 * several cards; it is fetched and decoded once.
 *
 * Lazy and never in the way: the cards around ABOUT (topic 'home') load first, together; the rest
 * one by one when the browser is idle. Nothing here blocks the layer's factory (the page's scroll
 * waits for deferred layers). A file that is missing, broken or hangs becomes a dark warm scrap with
 * a little «no signal» noise (one warning per file).
 *
 * Every picture is a CPU-backed canvas (willReadFrequently): the WebGL upload copies it without a GPU
 * readback, and the 2D fallback reads its pixels without one.
 */

const DIR = `${import.meta.env.BASE_URL}assets/about/`
/** A file that takes longer than this, ms, is given up on (the scrap). */
const DEADLINE = 30000

export interface PhotoSlot {
  /** what it was made from: src, crop, aspect, texWidth */
  key: string
  /** texWidth × texWidth / aspect: the card's crop of its file */
  canvas: HTMLCanvasElement
  ok: boolean
  /** bumped by every new picture (the renderer re-uploads) */
  version: number
  /** performance.now() when it arrived (the load clock of the reveal) */
  at: number
  /**
   * The picture's own luma range inside the crop (2nd / 98th percentile, 0…1): the halftone style
   * stretches it to full black … white before it quantises (a pale wall still gets its blacks).
   */
  lo: number
  hi: number
}

const slotKey = (p: PhotoKnobs, texWidth: number) => `${p.src}|${p.crop.x},${p.crop.y},${p.crop.w}|${p.aspect}|${texWidth}`

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

/** A slot's own 2D context: CPU-backed (uploads and the fallback's reads need no GPU readback). */
const slotContext = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!

/** The card's crop of `img` (its aspect), reduced to `size` px across. */
function cut(img: ImageBitmap, p: PhotoKnobs, size: number) {
  const iw = img.width
  const ih = img.height
  // the crop, kept inside the picture (a card taller than the file narrows its crop)
  let cw = p.crop.w * iw
  let ch = cw / p.aspect
  if (ch > ih) {
    ch = ih
    cw = ch * p.aspect
  }
  const cx = Math.min(iw - cw / 2, Math.max(cw / 2, p.crop.x * iw))
  const cy = Math.min(ih - ch / 2, Math.max(ch / 2, p.crop.y * ih))
  const c = makeCanvas(size, size / p.aspect)
  const g = slotContext(c)
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, cx - cw / 2, cy - ch / 2, cw, ch, 0, 0, c.width, c.height)
  return c
}

/**
 * The luma range of a slot's picture: the 2nd and 98th percentile of a 256-bin histogram, every
 * second pixel. A flat picture gets a range of at least 0.1.
 */
function lumaRange(c: HTMLCanvasElement): [number, number] {
  const n = c.width
  const d = slotContext(c).getImageData(0, 0, n, c.height).data
  const hist = new Uint32Array(256)
  let count = 0
  for (let y = 0; y < c.height; y += 2) {
    for (let x = 0; x < n; x += 2) {
      const o = (y * n + x) * 4
      hist[Math.min(255, Math.round(0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]))]++
      count++
    }
  }
  const at = (share: number) => {
    let acc = 0
    for (let i = 0; i < 256; i++) if ((acc += hist[i]) >= share * count) return i / 255
    return 1
  }
  let lo = at(0.02)
  let hi = at(0.98)
  if (hi - lo < 0.1) {
    const mid = (lo + hi) / 2
    lo = Math.max(0, mid - 0.05)
    hi = Math.min(1, lo + 0.1)
  }
  return [lo, hi]
}

/** A dark warm scrap with a little noise and NO SIGNAL — the card of a file that did not come. */
function scrap(size: number, height: number, name: string) {
  const c = makeCanvas(size, height)
  const W = c.width
  const H = c.height
  const g = slotContext(c)
  g.fillStyle = '#2e2b28'
  g.fillRect(0, 0, W, H)
  const img = g.getImageData(0, 0, W, H)
  const d = img.data
  let s = 1234567
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  const cell = Math.max(2, Math.round(W / 96))
  for (let y = 0; y < H; y += cell) {
    const band = rnd() < 0.06 ? 26 : 0
    for (let x = 0; x < W; x += cell) {
      const v = (rnd() - 0.5) * 30 + band
      for (let yy = y; yy < Math.min(H, y + cell); yy++) {
        for (let xx = x; xx < Math.min(W, x + cell); xx++) {
          const i = (yy * W + xx) * 4
          d[i] = Math.max(0, Math.min(255, d[i] + v))
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v))
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v))
        }
      }
    }
  }
  g.putImageData(img, 0, 0)
  const fs = Math.max(8, Math.round(Math.min(W, H * 1.5) / 13))
  g.font = `700 ${fs}px "Roboto Mono", ui-monospace, Menlo, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#1e1c1a'
  g.fillRect(W * 0.2, H / 2 - fs, W * 0.6, fs * 2)
  g.fillStyle = '#a39789'
  g.fillText('NO SIGNAL', W / 2, H / 2)
  g.font = `400 ${Math.max(6, Math.round(W / 30))}px "Roboto Mono", ui-monospace, Menlo, monospace`
  g.fillStyle = '#7a7066'
  g.fillText(name, W / 2, H * 0.86)
  return c
}

async function fetchBitmap(src: string) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error(`no answer in ${DEADLINE / 1000} s`)), DEADLINE)
  try {
    const res = await fetch(DIR + src, { signal: abort.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await createImageBitmap(await res.blob())
  } finally {
    clearTimeout(timer)
  }
}

/** Safari has no requestIdleCallback before 16.4. */
const idle = (fn: () => void) => {
  const ric = (window as { requestIdleCallback?: typeof requestIdleCallback }).requestIdleCallback
  if (ric) ric(fn, { timeout: 1200 })
  else setTimeout(fn, 150)
}

export function createAboutPhotos(onChange: (index: number) => void) {
  /** per card (index = PhotoKnobs.index): what it should show */
  let wanted: string[] = []
  let items: PhotoKnobs[] = []
  let size = 384
  let slots: (PhotoSlot | null)[] = []
  let version = 0
  let disposed = false
  /** decoded files on their way / in use, per src */
  const files = new Map<string, Promise<ImageBitmap>>()
  const warned = new Set<string>()
  let queue: number[] = []
  let idling = false

  const file = (src: string) => {
    let f = files.get(src)
    if (!f) {
      f = fetchBitmap(src)
      files.set(src, f)
    }
    return f
  }

  /** Cards still waiting for a src: when none, its decoded file is let go. */
  const release = (src: string) => {
    const pending = items.some((p, i) => p.src === src && !slots[i])
    if (pending) return
    const f = files.get(src)
    files.delete(src)
    void f?.then((b) => b.close(), () => undefined)
  }

  const load = (i: number) => {
    const want = wanted[i]
    const p = items[i]
    const done = (canvas: HTMLCanvasElement, ok: boolean) => {
      if (disposed || wanted[i] !== want) return
      const [lo, hi] = lumaRange(canvas)
      slots[i] = { key: want, canvas, ok, version: ++version, at: performance.now(), lo, hi }
      onChange(i)
      release(p.src)
    }
    return file(p.src).then(
      (img) => done(cut(img, p, size), true),
      (err) => {
        if (!warned.has(p.src)) {
          warned.add(p.src)
          console.warn(`[about] photo "${p.src}" is unavailable → a «no signal» scrap`, err)
        }
        files.delete(p.src)
        done(scrap(size, size / p.aspect, p.src), false)
      },
    )
  }

  /** The idle queue: one card at a time, each when the browser is idle. */
  const pump = () => {
    if (idling || disposed || !queue.length) return
    idling = true
    const i = queue.shift()!
    void load(i).finally(() => {
      idling = false
      if (queue.length && !disposed) idle(pump)
    })
  }

  return {
    /** Bring the set in line with the config: (re)load what changed, the home cards first. */
    sync(K: AboutKnobs) {
      const next = K.photos.items.map((p) => slotKey(p, K.photos.texWidth))
      const same = next.length === wanted.length && next.every((k, i) => k === wanted[i])
      items = K.photos.items
      if (same) return
      size = K.photos.texWidth
      const old = new Map(slots.filter((s): s is PhotoSlot => !!s).map((s) => [s.key, s]))
      wanted = next
      slots = next.map((k) => old.get(k) ?? null)
      const missing = next.map((_, i) => i).filter((i) => !slots[i])
      const home = missing.filter((i) => items[i].topic === 'home')
      queue = missing.filter((i) => items[i].topic !== 'home')
      // the cards around ABOUT: all at once (the first thing anyone sees); the rest after them
      if (home.length) void Promise.allSettled(home.map(load)).then(() => idle(pump))
      else idle(pump)
    },

    get(i: number): PhotoSlot | null {
      return slots[i] ?? null
    },

    /** How many cards. */
    get count() {
      return wanted.length
    },

    get size() {
      return size
    },

    /** Debug (stats()). */
    state: () => slots.map((s, i) => (s ? (s.ok ? 'ok' : 'no signal') : queue.includes(i) ? 'queued' : 'loading')),

    dispose() {
      disposed = true
      queue = []
      for (const f of files.values()) void f.then((b) => b.close(), () => undefined)
      files.clear()
    },
  }
}

export type AboutPhotos = ReturnType<typeof createAboutPhotos>
