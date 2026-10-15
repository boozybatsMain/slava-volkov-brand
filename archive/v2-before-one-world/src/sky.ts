import './styles.css'
import { startHero } from './core/hero'
import { computeFullscreenLayout } from './core/layout'
import type { LayerFactory } from './core/types'
import { skyConfig, type SkyConfig } from './sky.config'

/** A layer with nothing to draw (the front sky when the sky is not the layered one). */
const nothing: LayerFactory = () => ({ resize() {}, update() {}, dispose() {} })

/** Below this scroll position the veil has nothing to draw: its canvas sleeps on the hero. */
const VEIL_FROM = 0.002
/** The slab wakes this much (in screens) before its arrival starts: its first frame is ready when it shows. */
const SLAB_LEAD = 0.03
/** The about sheet wakes this much (in screens) before its pull-back starts, for the same reason. */
const ABOUT_LEAD = 0.03

/**
 * Version 2: SLAVA VOLKOV floating over a full-bleed sky — under its nearest clouds, with the nav and
 * tagline on top. Scrolling down sinks the camera into the clouds (veil) and comes out in a white
 * void where a screen with the projects hangs (slab + projects).
 */
startHero({
  root: document.getElementById('hero')!,
  config: skyConfig,
  computeLayout: computeFullscreenLayout,
  // back → front (= update order: a layer reads what an earlier one published this frame)
  layers: {
    // sky.source: 'layers' (default) | 'photo' | 'procedural' — read after ?set. overrides
    sky: () => {
      switch (skyConfig.sky.source) {
        case 'photo':
          return import('./layers/photo-sky').then((m) => m.createPhotoSkyLayer)
        case 'procedural':
          return import('./layers/world').then((m) => m.createWorldLayer)
        default:
          return import('./layers/sky-layers').then((m) => m.createSkyLayersLayer)
      }
    },
    title: () => import('./layers/title/raster').then((m) => m.createLayer),
    // the layers of the layered sky marked `front: true` (sky.config.ts): over the title
    skyFront: () =>
      skyConfig.sky.source === 'layers'
        ? import('./layers/sky-layers').then((m) => m.createSkyFrontLayer)
        : Promise.resolve(nothing),
    // nav + tagline on the title's plane (sky.config.ts → overlay). The tagline sits right over the
    // nearest clouds, the nav over everything on the stage (two z-roots: styles.css)
    overlay: () => import('./layers/sky-overlay').then((m) => m.createSkyOverlayLayer),
    // the clouds that rise over the tagline and the title, the whiteout, then the void itself
    veil: () => import('./layers/sky-layers').then((m) => m.createSkyVeilLayer),
    // the project screen hanging in the void
    slab: () => import('./layers/slab').then((m) => m.createSlabLayer),
    // project texts and arrows on the slab's plane
    projects: () => import('./layers/projects').then((m) => m.createProjectsLayer),
    // ABOUT: the black sheet with the holes (ABOUT, THAT'S ALL FOR NOW) the void shows through, photos, crosses
    about: () => import('./layers/about').then((m) => m.createAboutLayer),
    // ABOUT: the notes on the sheet (DOM), placed by the same camera (core/about-camera.ts)
    aboutText: () => import('./layers/about-text').then((m) => m.createAboutTextLayer),
  },
  scroll: {
    track: document.querySelector<HTMLElement>('.scroll-track')!,
    // From scroll.veiledFrom on the title is already behind the cloud wall: a page opened there must
    // not show it bare while the veil is still loading (styles.css → html[data-veiled]). Its own
    // number, not veil.fog.from: the fog starts under the clouds, well before the title is covered.
    // Reduced motion: nothing rises, the title shows through the fog until the page is half-way —
    // and from there data-section covers it.
    veiled: (scroll, config) => !scroll.reduced && scroll.pos >= (config as unknown as SkyConfig).scroll.veiledFrom,
  },
  // the later screens load once the hero is up
  defer: ['veil', 'slab', 'projects', 'about', 'aboutText'],
  debugKeys: ['scroll', 'project', 'switch', 'dir', 'nogl'],
  /**
   * What sleeps when: the hero's three canvases once the veil has fully covered them (and only if
   * there IS a veil to cover them), the veil while the page rests on the hero, the slab outside its
   * arrival … leave, the about sheet until just before the pull-back. The overlay, the project texts
   * and the about notes are DOM: always live (in the tab order and the accessibility tree), they
   * hide themselves.
   */
  isLive(name, frame, mounted) {
    const { pos, covered } = frame.scroll
    const config = frame.config as unknown as SkyConfig
    switch (name) {
      case 'sky':
      case 'title':
      case 'skyFront':
        return !(covered && mounted('veil'))
      case 'veil':
        return pos > VEIL_FROM
      case 'slab':
        return pos >= config.projects.arrive.from - SLAB_LEAD && pos <= config.projects.leave.to + SLAB_LEAD
      case 'about': {
        // under reduced motion the sheet dissolves in from about.pull.reduced.from (where the slab is cut)
        const pull = config.about.pull
        const from = frame.scroll.reduced ? Math.min(pull.from, pull.reduced.from) : pull.from
        return pos >= from - ABOUT_LEAD
      }
      default:
        return true
    }
  },
})

// styles.css: the flat sheet that stands in for the veil while a page opened further down is still
// loading — the void's white, and the about sheet's black on the about screen (after startHero: ?set.
// overrides are in)
document.documentElement.style.setProperty('--veil-color', skyConfig.veil.color)
document.documentElement.style.setProperty('--about-color', skyConfig.about.sheet.color)
