import type { HeroConfig } from '../hero.config'
import { computeLayout as defaultLayout, resolveConfig } from './layout'
import { Pointer } from './pointer'
import { projects } from './projects'
import { FROZEN_SCROLL, Scroll, scrollControl, scrollKnobs } from './scroll'
import type { Frame, Layer, LayerContext, LayerFactory, Layout, ResolvedConfig, ScrollState } from './types'

/*
 * Debug URL params (all optional) — live in `npm run dev`, and in a build only when it was
 * made with VITE_HERO_DEBUG=1 (art-direction staging). On the public build they are ignored
 * and dropped from the address bar, so nobody can share a link that rewrites the hero.
 *   ?layers=sky,title,overlay   render only these layers
 *   ?set.title.rotation=4       override any numeric / colour / boolean config value (A/B without editing)
 *   ?pointer=0.6,-0.4           pin the pointer (normalized -1…1) for repeatable screenshots
 *   ?freeze=3.5                 freeze animation time at t seconds
 *   ?tune                       open the live tuning panel
 *   ?rtenergy=0.8 / ?worldDebug=1   title shimmer energy / sky debug views (read by the layers)
 * Pages add their own (HeroOptions.debugKeys). Version 2 (sky.ts):
 *   ?scroll=0.45                pin the scroll position, in stops (0 hero, 1 projects, 2 about, 3 the end
 *                               of the about tour; fractions in between) — core/scroll.ts
 *   ?project=2&switch=0.4&dir=-1   start on a project / hold its switch at t — core/projects.ts
 *   ?nogl=veil,slab             force these layers' no-WebGL fallbacks (read by the layers);
 *                               slab-glitch / slab-lens — the slab without that one pass
 */
const DEBUG = import.meta.env.DEV || import.meta.env.VITE_HERO_DEBUG === '1'
const DEBUG_KEYS = ['layers', 'freeze', 'pointer', 'tune', 'rtenergy', 'worldDebug']

/** Public build: the layers (and Pointer) read their debug params from location, so clean it before they load. */
function stripDebugParams(query: URLSearchParams, extraKeys: string[]) {
  const keys = [...query.keys()].filter((k) => k.startsWith('set.') || DEBUG_KEYS.includes(k) || extraKeys.includes(k))
  if (!keys.length) return
  for (const k of keys) query.delete(k)
  const q = query.toString()
  history.replaceState(history.state, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`)
}

function applyUrlOverrides(target: Record<string, unknown>, query: URLSearchParams) {
  for (const [key, raw] of query) {
    if (!key.startsWith('set.')) continue
    const path = key.slice(4).split('.')
    let obj: Record<string, unknown> | undefined = target
    for (const part of path.slice(0, -1)) obj = obj?.[part] as Record<string, unknown> | undefined
    const leaf = path[path.length - 1]
    if (!obj || !(leaf in obj)) {
      console.warn(`[hero] unknown config path "${key.slice(4)}"`)
      continue
    }
    const cur = obj[leaf]
    if (typeof cur === 'number' && Number.isFinite(Number(raw))) obj[leaf] = Number(raw)
    else if (typeof cur === 'boolean') obj[leaf] = raw === 'true' || raw === '1'
    else if (typeof cur === 'string') obj[leaf] = /^[0-9a-f]{3,8}$/i.test(raw) && cur.startsWith('#') ? `#${raw}` : raw
  }
}

/** A layer that has not mounted by then no longer holds up `ready` (it still appears when it arrives). */
const MOUNT_TIMEOUT = 8000
/** Deferred layers slower than this (after `ready`) no longer hold the page back: it counts as full without them. */
const FULL_TIMEOUT = 4000

export interface HeroOptions<N extends string> {
  root: HTMLElement
  /** The live config object of this page (mutated by ?set. and the tuner). */
  config: HeroConfig
  /** Layers back → front. Each gets its own absolutely positioned mount `.layer--<name>`. */
  layers: Record<N, () => Promise<LayerFactory>>
  /** Config → px layout. Defaults to the paper hero's layout (cutouts + title on the main window). */
  computeLayout?: (config: ResolvedConfig, width: number, height: number) => Layout
  /** Page-specific debug params to strip on the public build. */
  debugKeys?: string[]
  /**
   * The page scrolls between screens (core/scroll.ts): `track` holds one `.scroll-stop` per screen.
   * Without it Frame.scroll is frozen at the hero — no listeners, no DOM writes.
   */
  scroll?: {
    track: HTMLElement
    /**
     * true while, at this scroll position, the hero is already hidden by a later screen's layers:
     * `html[data-veiled]` is kept in step with it every frame. A page that opens there (a reload, a
     * restored tab) covers the stage with a flat sheet until those layers are in (styles.css) — the
     * hero must not flash bare first.
     */
    veiled?: (scroll: ScrollState, config: ResolvedConfig) => boolean
  }
  /**
   * Layers of the later screens: mounted only once the others are up (they must not compete with
   * the first paint), then `html[data-hero-full]` is set and the scroll is released (also when they
   * take longer than FULL_TIMEOUT). A page that opens away from the hero (restored scroll, #hash,
   * ?scroll) mounts them with the rest. Each layer on its own is announced in `html[data-in]` (a
   * space-separated list of names, for `[data-in~='veil']`) as soon as it is in: it has drawn its
   * first frame — on screen, or hidden if it arrived asleep — or it failed and nothing will come. So
   * a stand-in for one screen's layer (styles.css) can go with that layer, not with the slowest one.
   */
  defer?: NoInfer<N>[]
  /**
   * Called every frame for every layer. false → the layer sleeps: its mount is `visibility: hidden`
   * and update() is not called (resize() still is) — after one last update on the frame it fell
   * asleep, and one first update, hidden, when it mounts already asleep. `mounted(n)` — layer n is
   * up (it loaded and did not fail). Default: every layer is always live.
   */
  isLive?: (name: N, frame: Frame, mounted: (n: N) => boolean) => boolean
}

/** Mounts the layers, runs the shared pointer + animation loop and keeps everything in sync with the viewport. */
export function startHero<N extends string>(opts: HeroOptions<N>) {
  const { root, config: baseConfig } = opts
  const computeLayout = opts.computeLayout ?? defaultLayout
  const names = Object.keys(opts.layers) as N[]

  const params = new URLSearchParams(location.search)
  if (!DEBUG) stripDebugParams(params, opts.debugKeys ?? [])
  applyUrlOverrides(baseConfig as unknown as Record<string, unknown>, params)
  const enabled = new Set(params.get('layers')?.split(',') ?? names)
  const freeze = params.has('freeze') ? Number(params.get('freeze')) || 0 : null

  const pointer = new Pointer(root)
  const mounts = {} as Record<N, HTMLElement>
  const layers = new Map<N, Layer>()
  /** Bumped by every (re)mount: a mount that finishes after a newer one started is discarded. */
  const gen = Object.fromEntries(names.map((n) => [n, 0])) as Record<N, number>
  /** Animation time of the last frame (a redraw outside the loop reuses it). */
  let lastTime = freeze ?? 0

  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)')
  const resolve = () =>
    resolveConfig(baseConfig, root.clientWidth, root.clientHeight, { reducedMotion: reducedMq.matches })

  let config: ResolvedConfig = resolve()
  // After the strip, like the pointer (it reads ?scroll itself), and after resolve(): the stops get
  // their lengths from the resolved config (mobile, ?set.) in the constructor, and a page opened on a
  // #stop or reloaded part of the way down is put in its place there — before anything is measured,
  // and before `eager` below reads scrollY.
  const scroll = opts.scroll ? new Scroll(opts.scroll.track, config) : null
  scrollControl.current = scroll
  let layout: Layout = computeLayout(config, root.clientWidth, root.clientHeight)
  scroll?.resize(layout.height)
  const scrollState = scroll?.state ?? FROZEN_SCROLL

  for (const name of names) {
    const el = document.createElement('div')
    el.className = `layer layer--${name}`
    el.dataset.layer = name
    root.appendChild(el)
    mounts[name] = el
  }

  async function mountLayer(name: N) {
    if (!enabled.has(name)) return
    const g = ++gen[name]
    const ctx: LayerContext = { layout, config }
    try {
      const factory = await opts.layers[name]()
      const layer = await factory(mounts[name], ctx)
      if (g !== gen[name]) {
        layer.dispose()
        return
      }
      layer.resize(layout, config)
      layers.set(name, layer)
      // A layer that arrives asleep (the hero's, on a page opened on the second screen; the second
      // screen's, on the hero) still draws its first frame now, hidden: programs compiled, textures
      // uploaded, its own fade-in spent — not on the frame the first scroll wakes it, in plain sight.
      if (!live[name]) {
        layer.update({ time: lastTime, dt: 0, pointer: pointer.state, scroll: scrollState, layout, config })
        markIn(name, true)
      } else fresh.add(name)
    } catch (err) {
      console.error(`[hero] layer "${name}" failed`, err)
      if (g === gen[name]) markIn(name, true)
    }
  }

  /** html[data-in]: the layers that are in (HeroOptions.defer) */
  const inNow = new Set<N>()
  function markIn(name: N, on: boolean) {
    if (inNow.has(name) === on) return
    if (on) inNow.add(name)
    else inNow.delete(name)
    document.documentElement.dataset.in = [...inNow].join(' ')
  }
  /**
   * Mounted live, first update still to come: in from the end of the next frame's updates — in the
   * same task as the drawing itself, so the stand-in that waits for it (styles.css) goes in the very
   * paint that shows the layer, not one paint before it.
   */
  const fresh = new Set<N>()

  function mountWithTimeout(name: N) {
    let timer = 0
    const timeout = new Promise<void>((resolve) => {
      timer = window.setTimeout(() => {
        console.warn(`[hero] layer "${name}" is still loading after ${MOUNT_TIMEOUT / 1000}s — not waiting for it`)
        resolve()
      }, MOUNT_TIMEOUT)
    })
    return Promise.race([mountLayer(name).finally(() => clearTimeout(timer)), timeout])
  }

  /**
   * Mounted layers in their DECLARED order (back → front), not in the order they finished loading:
   * a layer may read the pose another one published earlier in the same frame (the sky overlay
   * sits on the title's plane → it must update after the title).
   */
  function* mountedInOrder() {
    for (const name of names) {
      const layer = layers.get(name)
      if (layer) yield [name, layer] as const
    }
  }

  /**
   * One layer's update, contained: a layer that throws (a bug, a driver hiccup, a half-saved file in
   * dev) must not stop the loop — the other layers and the scroll keep running. Reported once per
   * layer until it updates cleanly again.
   */
  const failing = new Set<N>()
  function updateLayer(name: N, layer: Layer, frame: Frame) {
    try {
      layer.update(frame)
      failing.delete(name)
    } catch (err) {
      if (failing.has(name)) return
      failing.add(name)
      console.error(`[hero] layer "${name}" threw in update — skipping its frame`, err)
    }
  }

  /** Per layer: awake this frame (opts.isLive). A sleeping layer is hidden and not updated. */
  const live = Object.fromEntries(names.map((n) => [n, true])) as Record<N, boolean>
  /**
   * Layers that fell asleep on this very frame. They get this one last update (already hidden): what
   * a layer publishes for the others (the slab's pose, with how far it has arrived) must end on the
   * state that put it to sleep — a fast scroll can jump over every frame in which it would have said so.
   */
  const dozing = new Set<N>()
  const isMounted = (name: N) => layers.has(name)
  function syncLive(frame: Frame) {
    if (!opts.isLive) return
    // every mount, not only the mounted layers: one that arrives asleep must never flash its first frame
    for (const name of names) {
      const on = opts.isLive(name, frame, isMounted)
      if (on === live[name]) continue
      live[name] = on
      if (!on) dozing.add(name)
      mounts[name].style.visibility = on ? '' : 'hidden'
    }
  }

  let lastSection = -1
  let lastVeiled = false
  function stepScroll(dt: number) {
    if (!scroll) return
    scroll.step(dt, config, reducedMq.matches)
    const s = scroll.state
    // The title's edges crawl while the page travels, as they do under the cursor — no change in the title.
    pointer.state.energy = Math.max(pointer.state.energy, s.energy * scrollKnobs(config).shimmer)
    if (s.section !== lastSection) {
      lastSection = s.section
      document.documentElement.dataset.section = String(s.section)
    }
    const veiled = opts.scroll?.veiled?.(s, config) ?? false
    if (veiled !== lastVeiled) {
      lastVeiled = veiled
      document.documentElement.toggleAttribute('data-veiled', veiled)
    }
  }

  /** Re-resolve config + layout and push to every layer (viewport / DPR change, reduced-motion switch, tuner edit). */
  function refresh() {
    const prev = layout
    config = resolve()
    layout = computeLayout(config, root.clientWidth, root.clientHeight)
    scroll?.resize(layout.height)
    // Viewport changed → redraw right away: resizing a canvas clears it, and the next rAF
    // comes after this frame is painted → blank title / empty windows while resizing.
    const redraw = layout.width !== prev.width || layout.height !== prev.height || layout.dpr !== prev.dpr
    const frame: Frame = { time: lastTime, dt: 0, pointer: pointer.state, scroll: scrollState, layout, config }
    for (const [name, layer] of mountedInOrder()) {
      layer.resize(layout, config)
      if (redraw && live[name]) updateLayer(name, layer, frame)
    }
  }

  /** Re-create a layer from scratch (e.g. after rebuilding its assets). */
  async function rebuild(name: N) {
    gen[name]++
    layers.get(name)?.dispose()
    layers.delete(name)
    fresh.delete(name)
    markIn(name, false)
    mounts[name].replaceChildren()
    refresh()
    await mountLayer(name)
  }

  new ResizeObserver(() => refresh()).observe(root)
  reducedMq.addEventListener('change', refresh)

  const start = performance.now()
  let last = start
  let mounted = false
  let framesSinceReady = 0
  /** the deferred layers are in too */
  let full = false
  let framesSinceFull = 0
  // devicePixelRatio alone (window dragged to a Retina screen, browser zoom) resizes nothing,
  // so the ResizeObserver stays silent → compare it every frame (a property read).
  let lastDpr = window.devicePixelRatio

  function tick(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const time = freeze ?? (now - start) / 1000
    lastTime = time
    if (window.devicePixelRatio !== lastDpr) {
      lastDpr = window.devicePixelRatio
      refresh()
    }
    pointer.step(dt, time, config)
    stepScroll(dt)
    const frame: Frame = { time, dt, pointer: pointer.state, scroll: scrollState, layout, config }
    syncLive(frame)
    for (const [name, layer] of mountedInOrder()) if (live[name] || dozing.has(name)) updateLayer(name, layer, frame)
    dozing.clear()
    // (a layer mounted live and asleep by now got its last update just above, as a dozing one)
    for (const name of fresh) if (layers.has(name)) markIn(name, true)
    fresh.clear()
    if (mounted && ++framesSinceReady === 12) document.documentElement.dataset.heroReady = '1'
    // a few frames later, not at once: by then every late layer has drawn itself
    if (full && ++framesSinceFull === 3) document.documentElement.dataset.heroFull = '1'
    requestAnimationFrame(tick)
  }

  // The later screens' layers (opts.defer) wait for the hero — unless the page opens away from it.
  const eager = window.scrollY > 0 || location.hash.length > 1 || params.has('scroll')
  const deferred = eager ? [] : names.filter((n) => opts.defer?.includes(n))
  const first = names.filter((n) => !deferred.includes(n))

  // Animate whatever is mounted from the first frame: the sky and the paper must not wait
  // for the (much heavier) title to arrive.
  requestAnimationFrame(tick)
  const ready = Promise.all(first.map(mountWithTimeout)).then(() => {
    mounted = true
  })

  if (opts.defer) {
    // Until they are in (or took too long), the scroll does not travel: there is nothing to travel to yet.
    const release = () => {
      full = true
      scroll?.unlock()
    }
    ready.then(() => {
      const cap = window.setTimeout(release, FULL_TIMEOUT)
      Promise.all(deferred.map(mountLayer)).then(() => {
        clearTimeout(cap)
        release()
      })
    })
  } else scroll?.unlock()

  if (DEBUG) {
    Object.assign(window, {
      __hero: {
        config: baseConfig,
        get resolved() { return config },
        get layout() { return layout },
        pointer: pointer.state,
        // version 2: __hero.scroll.pin(0.45) / .to('projects') / .state; __hero.projects.pin(0.4) / .request(1) / .state
        ...(scroll ? { scroll, projects } : null),
        layers,
        refresh,
        rebuild,
        ready,
      },
    })

    const openTuner = () => import('../dev/tuner').then((m) => m.openTuner({ config: baseConfig, refresh }))
    if (params.has('tune')) ready.then(openTuner)
    window.addEventListener('keydown', (e) => {
      if (e.key === '`' && !e.repeat) ready.then(openTuner)
    })
  }
}
