import { aboutFrame } from '../../core/about-sheet'
import { FROZEN_SCROLL } from '../../core/scroll'
import type { Frame, Layer, LayerFactory, Layout, ResolvedConfig } from '../../core/types'
import { createAboutCore, type AboutState } from './core'
import { createAboutFallback } from './fallback'
import { createGLRenderer, type GLRenderer } from './gl'

/**
 * ABOUT — the one world, third screen (version 2; numbers: sky.config.ts → about).
 *
 * The warm void of the projects screen goes on (the veil, under this layer: the canvas is transparent
 * outside its objects). In it stand real 3D letters of BLACK CONCRETE — ABOUT, the stray giant letters
 * along the tour, THAT'S ALL FOR NOW (mesh.ts: Russo One, extruded, a stepped double chamfer, faceted
 * curves) — and photo CARDS, thick slabs like the projects slab, hanging at different heights above the
 * sheet plane, all casting dotted shadows onto it. The camera (core/about-camera.ts, a pure function of
 * the scroll) starts INSIDE the counter of the A — the first frame is the bare void — backs out along
 * the counter's tunnel (the black walls enter as wedges), over the letter's face (black fills the frame)
 * and, turning in one rotation to look straight down, pulls back until the void shows around the whole
 * word; then it zig-zags down the notes to the finale.
 *
 *   core.ts (camera, every element's turn toward the pointer, reveals, culling) ─▶ gl.ts (three.js, one canvas) or
 *   fallback.ts (2D) — behind the AboutRenderer seam below
 *
 * Drawn by the site's «bad render» recipe on the about lattice: binary coverage, low resolution,
 * point-sampled pictures, quantised dithered colour, edges that crawl. Nothing is anti-aliased — do
 * not "improve" it.
 *
 * It publishes core/about-sheet.ts → aboutFrame EVERY update (the camera — with its 3D fields — every
 * element's turn toward the pointer, `drawn`, the Frame it was written in, the time), before the
 * notes read it in the same frame; it reads core/nav-dock.ts (cards under the nav are washed toward the
 * void, about.cards.dock). No WebGL, `?nogl=about`, a program that fails, or a lost context →
 * ./fallback; a restored context brings the WebGL renderer back. `?nogl=about-glitch` / `about-lens` —
 * as if that pass had failed to compile.
 */

const noGL = () => new URLSearchParams(location.search).get('nogl')?.split(',') ?? []

/** What draws the world: the WebGL renderer (gl.ts) or the 2D fallback (fallback.ts). */
export interface AboutRenderer {
  kind: 'gl' | 'flat'
  resize(layout: Layout, config: ResolvedConfig): void
  /** draw this frame's state; true — the scene is on screen (the camera is past pull.from) */
  draw(frame: Frame, st: AboutState): boolean
  /** debug; `covered` — cells covered by anything in the last frame drawn (0 — the bare void) */
  stats(): Record<string, unknown>
  dispose(): void
}

const STILL_POINTER = { x: 0, y: 0, vx: 0, vy: 0, energy: 0, rawX: 0, rawY: 0, targetX: 0, targetY: 0, active: false }

export const createAboutLayer: LayerFactory = (mount, ctx) => {
  const off = noGL()
  let renderer: AboutRenderer | null = null
  /** the WebGL renderer, kept also while the fallback stands in for it (a lost context): dispose frees both */
  let glr: GLRenderer | null = null
  let disposed = false
  const core = createAboutCore(ctx.layout, ctx.config, (i) => glr?.onPhoto(i))

  let layout = ctx.layout
  let config = ctx.config
  let st: AboutState | null = null

  const toFlat = () => {
    const prev = renderer
    renderer = createAboutFallback(mount, core)
    renderer.resize(layout, config)
    if (prev?.kind === 'flat') prev.dispose()
    core.resetPhotos()
  }

  const makeGL = (): GLRenderer | null => {
    let r: GLRenderer | null = null
    try {
      r = createGLRenderer(
        mount,
        core,
        {
          lost() {
            if (!disposed) toFlat()
          },
          restored(gl) {
            if (disposed) return
            if (renderer?.kind === 'flat') renderer.dispose()
            renderer = gl
            renderer.resize(layout, config)
            core.resetPhotos()
          },
        },
        { glitch: !off.includes('about-glitch'), lens: !off.includes('about-lens') },
      )
      // compile now (one invisible frame before the pull: every program, every buffer), so a broken
      // program is caught here and not on the visitor's first frame of the pull
      const frame = { time: 0, dt: 0, pointer: STILL_POINTER, scroll: { ...FROZEN_SCROLL, pos: 0 }, layout, config } as Frame
      r.draw(frame, core.step(frame))
      core.resetPhotos()
      if (r.shaderError) throw new Error(`[about] a program failed to link\n${r.shaderError}`)
      return r
    } catch (err) {
      r?.dispose()
      console.warn('[about] WebGL renderer unavailable → 2D fallback', err)
      return null
    }
  }

  if (!off.includes('about')) renderer = glr = makeGL()
  else console.warn('[about] WebGL switched off (?nogl=about) — 2D fallback')
  if (!renderer) toFlat()

  const layer: Layer & { stats(): unknown; published: unknown } = {
    /** Debug: what this layer tells the others (core/about-sheet.ts), as the page sees it. */
    published: { frame: aboutFrame },

    /** Debug (__hero.layers.get('about').stats(); shot.mjs --stats about). */
    stats() {
      const cam = st?.cam
      const r3 = (v: number) => +v.toFixed(3)
      return {
        renderer: renderer?.kind,
        camera: cam && {
          active: cam.active,
          cx: +cam.cx.toFixed(5),
          cy: +cam.cy.toFixed(5),
          zoom: +cam.zoom.toFixed(4),
          h: +cam.h.toFixed(5),
          roll: r3((cam.roll * 180) / Math.PI),
          // the camera's turn on the pull (0 down the A's tunnel … 1 the home view) and its tilt from straight down, degrees
          orbit: r3(cam.orbit),
          tilt: r3((cam.tilt * 180) / Math.PI),
          eye: cam.eye.map((v) => +v.toFixed(5)),
          pull: +cam.pull.toFixed(4),
          tour: +cam.tour.toFixed(4),
          z0: r3(cam.z0),
          dissolve: cam.dissolve,
          U: +cam.U.toFixed(2),
        },
        // every element's turn toward the pointer, degrees (yaw, pitch) — words, cards, notes
        turns: st && {
          words: Object.fromEntries(Object.entries(st.turns.words).map(([k, t]) => [k, [t.yaw, t.pitch]])),
          cards: Object.fromEntries(Object.entries(st.turns.cards).map(([k, t]) => [k, [t.yaw, t.pitch]])),
          notes: Object.fromEntries(Object.entries(st.turns.notes).map(([k, t]) => [k, [t.yaw, t.pitch]])),
        },
        shadow: st && r3(st.shadow),
        energy: st && { e: r3(st.e), eMove: r3(st.eMove) },
        words: st?.words.map((w) => `${w.pose.key}${w.reveal < 1 ? `:${w.reveal}` : ''}`),
        cards: st?.cards.map((c) => `${c.k.key}:${c.reveal}${c.lod ? `@${c.lod}` : ''}`),
        photos: core.photos.state(),
        ...renderer?.stats(),
      }
    },

    resize(l, c) {
      layout = l
      config = c
      core.resize(l, c)
      renderer?.resize(l, c)
    },

    update(frame) {
      layout = frame.layout
      config = frame.config
      if (!renderer) return
      st = core.step(frame)
      const on = renderer.draw(frame, st)
      aboutFrame.camera = st.cam
      aboutFrame.pointer = st.turns
      if (on) aboutFrame.drawn = true
      aboutFrame.frame = frame
      aboutFrame.time = performance.now()
    },

    dispose() {
      disposed = true
      renderer?.dispose()
      if (glr && glr !== renderer) glr.dispose()
      renderer = glr = null
      core.dispose()
      mount.style.width = mount.style.height = ''
    },
  }
  return layer
}
