import GUI from 'lil-gui'
import { scrollControl } from '../core/scroll'
import type { HeroConfig } from '../hero.config'

interface TunerOptions {
  config: HeroConfig
  refresh: () => void
}

/** Slider ranges for known paths; anything else gets a plain (drag-able) number field. */
const RANGES: Record<string, [number, number, number?]> = {
  breakpoint: [0, 1400, 10],
  mobileAspect: [0.4, 1.6, 0.01],

  'cutouts.main.x': [-10, 100, 0.1],
  'cutouts.main.y': [-10, 100, 0.1],
  'cutouts.main.size': [5, 80, 0.1],
  'cutouts.main.aspect': [0.6, 1.6, 0.01],
  'cutouts.main.maxBottom': [30, 100, 0.5],
  'cutouts.secondary.x': [-10, 100, 0.1],
  'cutouts.secondary.y': [-10, 100, 0.1],
  'cutouts.secondary.width': [3, 80, 0.1],
  'cutouts.secondary.aspect': [1, 4, 0.01],

  'title.anchor.x': [-0.5, 1.5, 0.01],
  'title.anchor.y': [-0.5, 1.5, 0.01],
  'title.width': [20, 160, 0.5],
  'title.rotation': [-30, 30, 0.1],
  'title.tilt.x': [-12, 12, 0.1],
  'title.tilt.y': [-12, 12, 0.1],
  'title.perspective': [0.3, 3, 0.01],
  'title.pixelSize': [1, 5, 0.05],
  'title.response.tiltX': [0, 12, 0.1],
  'title.response.tiltY': [0, 12, 0.1],
  'title.response.highlight': [0, 3, 0.01],
  'title.response.shimmer': [0, 3, 0.01],
  'title.response.mass': [0.3, 4, 0.05],

  'title.raster.fov': [20, 60, 1],
  'title.raster.recess': [0, 0.6, 0.01],
  'title.raster.relief': [0, 80, 1],
  'title.raster.meshStep': [1, 6, 1],
  'title.raster.maxTurn': [6, 20, 0.5],
  'title.raster.edgeKnee': [0.3, 1, 0.01],
  'title.raster.mipBias': [-1, 2, 0.05],
  'title.raster.threshold': [0.2, 0.8, 0.01],
  'title.raster.fringe': [0, 1, 0.01],
  'title.raster.fringeWobble': [0, 1, 0.01],
  'title.raster.slide': [0, 40, 0.5],
  'title.raster.slideMix': [0, 1, 0.01],
  'title.raster.glint': [0, 3, 0.01],
  'title.raster.glintSharpness': [4, 80, 1],
  'title.raster.glintSteps': [0, 8, 1],
  'title.raster.lamp': [0, 2, 0.01],
  'title.raster.lampSize': [1, 6, 0.05],
  'title.raster.lampTravel': [0, 1.5, 0.01],
  'title.raster.lampFade': [0, 1, 0.01],
  'title.raster.sideShade': [0, 2, 0.01],
  'title.raster.envMix': [0, 1, 0.01],
  'title.raster.envDarken': [0, 1, 0.01],
  'title.raster.envHorizon': [-0.6, 0.6, 0.01],
  'title.raster.shimmerFps': [6, 30, 1],
  'title.raster.crawl': [0, 1, 0.01],
  'title.raster.jitter': [0, 0.6, 0.01],
  'title.raster.lensJitter': [0, 1, 0.01],
  'title.raster.rowGlitch': [0, 0.01, 0.0001],
  'title.raster.rowShift': [0, 4, 1],
  'title.raster.rowRun': [4, 60, 1],
  'title.raster.restShimmer': [0, 0.3, 0.001],

  // the mesh title (title.mode 'mesh'); letters / pose / fit come from scripts/title-mesh/fit.mjs
  'title.mesh.letters.boldX': [0, 0.12, 0.001],
  'title.mesh.letters.boldY': [0, 0.12, 0.001],
  'title.mesh.letters.condense': [0.8, 1.2, 0.001],
  'title.mesh.letters.tracking': [-0.15, 0.1, 0.001],
  'title.mesh.letters.wordSpace': [0.3, 1.2, 0.005],
  'title.mesh.letters.word2Scale': [0.7, 1.1, 0.001],
  'title.mesh.letters.depth': [0.2, 1, 0.005],
  'title.mesh.letters.bevelOuter': [0, 0.06, 0.001],
  'title.mesh.letters.bevelStep': [0, 0.05, 0.001],
  'title.mesh.letters.bevelInner': [0, 0.06, 0.001],
  'title.mesh.letters.seam': [0, 0.02, 0.0005],
  'title.mesh.letters.seamAt': [0, 1, 0.01],
  'title.mesh.letters.curveSegments': [1, 8, 1],
  'title.mesh.letters.crease': [0, 90, 1],
  'title.mesh.letters.bend': [-20, 30, 0.1],
  'title.mesh.maxTurn': [6, 30, 0.5],
  'title.mesh.turn': [0, 1.5, 0.01],
  'title.mesh.paint': [0, 1, 0.01],
  'title.mesh.envMix': [0, 1, 0.01],
  'title.mesh.envDarken': [0, 1, 0.01],
  'title.mesh.chrome.bulge': [0, 0.8, 0.01],
  'title.mesh.chrome.wobble': [0, 0.6, 0.01],
  'title.mesh.chrome.bevelLight': [0, 1, 0.01],
  'title.mesh.chrome.seamShade': [0, 1, 0.01],
  'title.mesh.chrome.contrast': [0.8, 1.5, 0.01],

  'title.glow.amount': [0, 2, 0.01],
  'title.glow.core.strength': [0, 2, 0.01],
  'title.glow.core.radius': [0.005, 0.15, 0.001],
  'title.glow.halo.strength': [0, 2, 0.01],
  'title.glow.halo.radius': [0.03, 0.6, 0.005],
  'title.glow.rays.strength': [0, 3, 0.01],
  'title.glow.rays.length': [0, 1.5, 0.005],
  'title.glow.rays.center.x': [-0.2, 1.2, 0.005],
  'title.glow.rays.center.y': [-1, 3, 0.01],
  'title.glow.rays.count': [8, 240, 1],
  'title.glow.rays.sharpness': [0.5, 8, 0.05],
  'title.glow.rays.speed': [0, 1, 0.005],
  'title.glow.perspective': [0, 1, 0.01],
  'title.glow.depth': [0, 100, 1],

  'post.aberration.amount': [-12, 12, 0.1],
  'post.aberration.center.x': [0, 1, 0.01],
  'post.aberration.center.y': [0, 1, 0.01],
  'post.aberration.start': [0, 0.9, 0.01],
  'post.aberration.curve': [0.5, 4, 0.05],
  'post.aberration.shift.x': [-6, 6, 0.05],
  'post.aberration.shift.y': [-6, 6, 0.05],
  'post.aberration.motion': [0, 4, 0.05],

  'motion.intensity': [0, 3, 0.01],
  'motion.stiffness': [1, 60, 0.1],
  'motion.damping': [0.5, 20, 0.1],
  'motion.idle': [0, 2, 0.01],
  'motion.reduced.intensity': [0, 1, 0.01],
  'motion.reduced.idle': [0, 1, 0.01],
  'motion.reduced.shimmer': [0, 1, 0.01],
  'motion.reduced.drift': [0, 1, 0.01],

  'paper.texture': [0, 3, 0.01],
  'paper.edge.hairline': [0, 1, 0.01],
  'paper.edge.highlight': [0, 1, 0.01],
  'paper.edge.shadow': [0, 1, 0.01],
  'paper.edge.shadowBlur': [0, 40, 0.5],
  'paper.edge.contact': [0, 1, 0.01],
  'paper.edge.shadowParallax': [0, 1, 0.01],

  'world.offset.x': [-400, 400, 1],
  'world.offset.y': [-400, 400, 1],
  'world.parallax': [0, 40, 0.5],
  'world.drift': [0, 5, 0.01],
  'world.windows.main.horizon': [-1, 3, 0.01],
  'world.windows.secondary.horizon': [-1, 3, 0.01],
  'world.look.gradient': [8, 30, 0.1],
  'world.look.veil': [0, 1.2, 0.01],
  'world.look.coverage': [0.4, 0.85, 0.005],
  'world.look.size': [0.15, 1, 0.01],
  'world.look.puffiness': [0, 1.6, 0.01],
  'world.look.softness': [0.5, 2, 0.01],
  'world.look.density': [0.5, 5, 0.05],
  'world.look.selfShadow': [0.3, 2, 0.01],
  'world.look.sunAzimuth': [0, 360, 1],
  'world.look.sunElevation': [10, 70, 0.5],
  'world.look.haze': [0, 3, 0.01],
  'world.look.fov': [10, 40, 0.5],
  'world.look.windAngle': [0, 360, 1],
  'world.look.windSpeed': [0, 0.01, 0.0001],
  'world.look.evolve': [0, 3, 0.01],
  'world.look.grain': [0, 0.08, 0.001],
  'world.look.renderScale': [0.5, 2, 0.05],

  'ui.note.x': [-5, 100, 0.1],
  'ui.note.y': [-5, 100, 0.1],
  'ui.note.rotation': [-45, 45, 0.5],
  'ui.note.size': [10, 80, 0.5],
  'ui.note.gap': [-40, 120, 1],
  'ui.note.dy': [-1, 1, 0.01],
  'ui.hand.jitter': [0, 2, 0.01],

  'title.raster.renderWidth': [300, 1100, 1],
  'paper.detail.formation': [0, 3, 0.01],
  'world.windows.main.zoom': [0.2, 1, 0.01],
  'world.windows.secondary.zoom': [0.2, 1, 0.01],
  'world.windows.main.cloudScale': [1, 4, 0.05],
  'world.windows.secondary.cloudScale': [1, 4, 0.05],
  'world.windows.main.drift': [0, 5, 0.05],
  'world.windows.secondary.drift': [0, 5, 0.05],
  'world.windows.main.offset.x': [-400, 400, 1],
  'world.windows.main.offset.y': [-400, 400, 1],
  'world.windows.secondary.offset.x': [-400, 400, 1],
  'world.windows.secondary.offset.y': [-400, 400, 1],
}

// version 2 (index.html)
Object.assign(RANGES, {
  'sky.tallBelow': [0.5, 1.6, 0.01],
  'sky.focus.x': [0, 1, 0.01],
  'sky.focus.y': [0, 1, 0.01],
  'sky.tallFocus.x': [0, 1, 0.01],
  'sky.tallFocus.y': [0, 1, 0.01],
  'sky.zoom': [1, 1.6, 0.01],
  'sky.drift.x': [0, 80, 1],
  'sky.drift.y': [0, 40, 1],
  'sky.drift.period': [20, 600, 5],
  'sky.fadeIn': [0, 3000, 50],
  'world.look.pitch': [20, 60, 0.5],
  'world.look.vfov': [16, 40, 0.5],
  'world.look.cloudSeed': [0, 50, 1],
  'world.look.flakes': [0, 1, 0.01],
  'world.look.thickness': [0.2, 1.2, 0.01],
  'world.look.veils': [0, 1, 0.01],
  'world.look.clearTop': [0, 1, 0.01],
  'world.look.clearDepth': [0, 0.8, 0.01],
  'world.look.clearTilt': [-0.5, 0.5, 0.01],
  'world.look.farCover': [0, 0.5, 0.01],
  'world.look.farShade': [0, 1, 0.01],
  'world.look.sunSide': [0, 0.3, 0.01],

  // layered sky (sky.source 'layers')
  'sky.renderScale': [0.25, 1, 0.05],
  'sky.maxTexture': [512, 8192, 256],
  'sky.designAspect': [1, 3.6, 0.01],
  'sky.grain.amount': [0, 0.08, 0.001],
  'sky.grain.size': [0.5, 4, 0.05],
  'sky.grain.fps': [0, 30, 1],
  'sky.grain.blend': [0, 1, 0.01],
  'sky.wind.period': [20, 600, 1],
  'sky.wind.direction': [-1, 1, 2],
  'sky.wind.speed': [0, 30, 0.1],
  'sky.layers.plate.focus.x': [0, 1, 0.01],
  'sky.layers.plate.focus.y': [0, 1, 0.01],
  'sky.layers.plate.zoom': [1, 2, 0.01],
  'sky.layers.moon.haze': [0, 6, 0.05],
  'sky.layers.moon.glow': [0, 1, 0.005],
  'sky.layers.moon.glowSize': [0.3, 6, 0.05],
  'sky.layers.moon.blend': [0, 1, 0.01],
  'sky.layers.moon.terminator': [-1, 1, 0.01],
  'sky.layers.moon.terminatorTilt': [-90, 90, 1],
  'sky.layers.moon.terminatorSoftness': [0, 0.5, 0.005],
  'sky.layers.moon.earthshine': [0, 0.5, 0.005],
} satisfies Record<string, [number, number, number]>)

// sky overlay (sky.config.ts → overlay): nav + tagline
const OVERLAY_RANGES: Record<string, [number, number, number]> = {
  'overlay.turn': [0, 1, 0.01],
  'overlay.nav.from': [-0.3, 1.3, 0.005],
  'overlay.nav.to': [-0.3, 1.5, 0.005],
  'overlay.nav.above': [-1, 3, 0.01],
  'overlay.nav.size': [6, 40, 0.5],
  'overlay.nav.weight': [100, 900, 10],
  'overlay.nav.tracking': [-0.1, 0.6, 0.005],
  'overlay.nav.opacity': [0, 1, 0.01],
  'overlay.nav.disabled': [0.2, 1, 0.05],
  'overlay.nav.hover.opacity': [0, 1, 0.01],
  'overlay.nav.hover.glow': [0, 2, 0.01],
  'overlay.nav.hit': [0, 5, 0.05],
  'overlay.nav.line.width': [0, 4, 0.1],
  'overlay.nav.line.opacity': [0, 1, 0.01],
  'overlay.nav.line.gap': [0, 80, 1],
  'overlay.nav.line.lead': [0, 2, 0.01],
  'overlay.nav.line.tail': [0, 2, 0.01],
  'overlay.nav.fluid': [0, 1, 0.01],
  'overlay.nav.foreshorten': [0, 1, 0.01],
  'overlay.nav.depth': [0, 3, 0.01],
  'overlay.nav.mass': [0.3, 4, 0.05],
  'overlay.tagline.along': [-0.3, 1.3, 0.005],
  'overlay.tagline.below': [-1, 3, 0.01],
  'overlay.tagline.size': [10, 140, 0.5],
  'overlay.tagline.weight': [100, 900, 10],
  'overlay.tagline.leading': [0.7, 1.6, 0.01],
  'overlay.tagline.tracking': [-0.1, 0.4, 0.005],
  'overlay.tagline.opacity': [0, 1, 0.01],
  'overlay.tagline.shadow': [0, 1, 0.01],
  'overlay.tagline.fluid': [0, 1, 0.01],
  'overlay.tagline.foreshorten': [0, 1, 0.01],
  'overlay.tagline.depth': [0, 4, 0.01],
  'overlay.tagline.mass': [0.3, 4, 0.05],
}
for (const [p, r] of Object.entries(OVERLAY_RANGES)) RANGES[p] ??= r

// knobs every layer of sky.layers has (sky.layers.<name>.<knob>)
const SKY_LAYER_RANGES: Record<string, [number, number, number]> = {
  x: [-50, 150, 0.1],
  y: [-50, 200, 0.1],
  width: [1, 400, 0.1],
  'anchor.x': [0, 1, 0.01],
  'anchor.y': [0, 1, 0.01],
  opacity: [0, 1, 0.01],
  depth: [0, 3, 0.01],
  mass: [0.3, 4, 0.05],
  'drift.range': [0, 300, 1],
  'billow.amount': [0, 8, 0.05],
  'billow.size': [10, 400, 1],
  'billow.speed': [0, 2, 0.01],
  feather: [0, 0.3, 0.005],
  seam: [0, 0.5, 0.01],
  'grade.saturation': [0, 2, 0.01],
  'grade.brightness': [0.3, 2, 0.01],
  'grade.contrast': [0.2, 2, 0.01],
  'grade.tintAmount': [0, 1, 0.01],
}
for (const layer of ['plate', 'moon', 'cloudlets', 'cloudletsLeft', 'bankBack', 'bankFront', 'frontClouds']) {
  for (const [knob, range] of Object.entries(SKY_LAYER_RANGES)) RANGES[`sky.layers.${layer}.${knob}`] ??= range
}

// ── the later screens of version 2 ──
// (sky.config.ts → scroll, descent, veil, overlay.nav.dock / morph, projects, about)
// Scroll positions (from / to / at …) are in stops: 0 hero, 1 projects, 2 about, 3 the end of the about
// tour. POS covers the way to projects, POS3 the whole page (the projects leave and the about screen).
const POS: [number, number, number] = [0, 1, 0.005]
const POS3: [number, number, number] = [0, 3, 0.005]
Object.assign(RANGES, {
  'scroll.travel': [0.5, 3, 0.05],
  'scroll.maxSpeed': [0.5, 8, 0.1],
  'scroll.smooth': [2, 40, 0.5],
  'scroll.clickTime': [0, 3, 0.05],
  'scroll.clickMax': [0, 5, 0.05],
  'scroll.cover.at': POS,
  'scroll.cover.back': POS,
  'scroll.veiledFrom': POS,
  'scroll.shimmer': [0, 1, 0.01],
  'scroll.shimmerAt': [0.2, 4, 0.05],
  'scroll.reducedSpeed': [0.5, 20, 0.1],

  'descent.from': POS,
  'descent.to': POS,
  'descent.ease': [0, 1, 0.01],

  'veil.fog.from': POS,
  'veil.fog.to': POS,
  'veil.fog.reducedFrom': POS,
  'veil.fog.lift': [0, 2, 0.01],
  'veil.fog.patchy': [0, 1, 0.01],
  'veil.fog.size': [100, 2000, 10],
  'veil.fog.speed': [0, 60, 1],
  'veil.renderScale': [0.25, 1, 0.05],
  'veil.designAspect': [1, 3.6, 0.01],
  'veil.maxTexture': [512, 8192, 256],
  'veil.tallBelow': [0.5, 1.6, 0.01],
  'veil.fadeIn': [0, 3000, 50],
  'veil.grain.amount': [0, 0.08, 0.001],
  'veil.grain.size': [0.5, 4, 0.05],
  'veil.grain.fps': [0, 30, 1],
  'veil.grain.blend': [0, 1, 0.01],

  'overlay.nav.dock.right': [0, 400, 1],
  'overlay.nav.dock.top': [0, 300, 1],
  'overlay.nav.dock.lead': [0, 200, 1],
  'overlay.nav.dock.step': [10, 240, 1],
  'overlay.nav.dock.tail': [0, 200, 1],
  'overlay.nav.dock.dot': [2, 30, 0.5],
  'overlay.nav.dock.ring': [0.5, 4, 0.1],
  'overlay.nav.dock.gap': [0, 12, 0.5],
  'overlay.nav.dock.labelGap': [0, 80, 1],
  'overlay.nav.dock.labelSide': [-1, 1, 2],
  'overlay.nav.dock.size': [6, 30, 0.5],
  'overlay.nav.dock.lineWidth': [0.5, 4, 0.1],
  'overlay.nav.dock.idle': [0, 1, 0.01],
  'overlay.nav.dock.disabled': [0, 1, 0.01],
  'overlay.nav.dock.line': [0, 1, 0.01],
  'overlay.nav.dock.progress': [0, 1, 0.01],
  'overlay.nav.dock.fillBy': [0.5, 1, 0.01],
  'overlay.nav.dock.halo': [0, 1, 0.01],
  'overlay.nav.dock.hit': [24, 72, 1],
  'overlay.nav.dock.fluid': [0, 1, 0.01],
  'overlay.nav.morph.from': POS,
  'overlay.nav.morph.to': POS,
  'overlay.nav.morph.reel': [0.05, 1, 0.01],
  'overlay.nav.morph.stand': [0, 0.95, 0.01],
  'overlay.nav.morph.lift': [0.1, 1, 0.01],
  'overlay.nav.morph.stagger': [0, 0.15, 0.005],
  'overlay.nav.morph.ink.cover': [0.1, 0.9, 0.05],
  'overlay.nav.morph.ink.lead': [0, 0.3, 0.005],
  'overlay.nav.morph.ink.back': [0, 0.1, 0.005],
  'overlay.nav.morph.ink.band': [0, 0.3, 0.005],
  'overlay.nav.morph.ink.fog': [0, 1, 0.01],
  'overlay.nav.morph.ink.time': [0, 1, 0.01],
  'overlay.nav.morph.ink.crest': [0, 0.6, 0.005],
  'overlay.nav.morph.haloIn': [0.01, 1, 0.01],
  'overlay.nav.morph.reduced.at': [0, 1, 0.01],
  'overlay.nav.morph.reduced.back': [0, 1, 0.01],
  'overlay.nav.morph.reduced.time': [0, 1.5, 0.01],

  'projects.slab.x': [0, 1, 0.005],
  'projects.slab.y': [0, 1, 0.005],
  'projects.slab.width': [20, 140, 0.5],
  'projects.slab.aspect': [1, 3, 0.01],
  'projects.slab.thickness': [0, 0.3, 0.005],
  'projects.slab.designAspect': [1, 3.6, 0.01],
  'projects.slab.perspective': [0.4, 4, 0.01],
  'projects.slab.yaw': [-60, 60, 0.5],
  'projects.slab.pitch': [-45, 45, 0.5],
  'projects.slab.roll': [-30, 30, 0.5],
  'projects.slab.response.tiltX': [0, 12, 0.1],
  'projects.slab.response.tiltY': [0, 12, 0.1],
  'projects.slab.response.maxTurn': [1, 20, 0.5],
  'projects.slab.response.mass': [0.3, 6, 0.05],
  'projects.slab.response.depth': [0, 4, 0.01],
  'projects.slab.float.y': [0, 30, 0.5],
  'projects.slab.float.roll': [0, 3, 0.05],
  'projects.slab.float.period': [1, 30, 0.5],
  'projects.slab.sideLeak': [0, 1, 0.01],
  'projects.slab.seamWidth': [0, 4, 1],
  'projects.slab.sheen': [0, 1, 0.01],
  'projects.slab.sheenBand.at': [-0.5, 1.5, 0.01],
  'projects.slab.sheenBand.width': [0.02, 1.5, 0.01],
  'projects.slab.sheenBand.slant': [-1.5, 1.5, 0.01],
  'projects.slab.sheenBand.travel': [-2, 2, 0.01],
  'projects.slab.sheenBand.steps': [1, 8, 1],
  'projects.slab.sideBlock.w': [1, 12, 1],
  'projects.slab.sideBlock.h': [1, 40, 1],
  'projects.slab.haze': [0, 1, 0.01],
  'projects.slab.hazeSteps': [1, 16, 1],
  'projects.arrive.from': POS,
  'projects.arrive.to': POS,
  'projects.arrive.rise': [0, 80, 0.5],
  'projects.arrive.scale': [0.5, 1.2, 0.01],
  'projects.arrive.pitch': [-30, 30, 0.5],
  'projects.arrive.stipple.to': POS,
  'projects.arrive.stipple.steps': [1, 16, 1],
  'projects.arrive.lod.from': POS,
  'projects.arrive.lod.back': POS,
  'projects.arrive.lod.step': [0.02, 0.6, 0.01],
  'projects.arrive.lod.start': [0, 8, 1],
  'projects.arrive.tear.rows': [0, 12, 1],
  'projects.arrive.tear.shift': [0, 40, 1],
  'projects.arrive.tear.ticks': [1, 8, 1],
  'projects.raster.renderWidth': [120, 1100, 1],
  'projects.raster.pixelSize': [1, 5, 0.05],
  'projects.raster.texWidth': [64, 2048, 32],
  'projects.raster.bits': [1, 8, 1],
  'projects.raster.dither': [0, 1, 0.01],
  'projects.raster.affine': [0, 1, 0.01],
  'projects.raster.affineCells': [1, 24, 1],
  'projects.raster.crawl': [0, 1, 0.01],
  'projects.raster.rowGlitch': [0, 0.01, 0.0001],
  'projects.raster.rowShift': [0, 12, 1],
  'projects.raster.rowRun': [4, 60, 1],
  'projects.raster.restShimmer': [0, 0.3, 0.001],
  'projects.raster.shimmerFps': [6, 30, 1],
  'projects.shadow.opacity': [0, 1, 0.01],
  'projects.shadow.y': [0.5, 1.2, 0.005],
  'projects.shadow.width': [0.2, 2, 0.01],
  'projects.shadow.height': [0, 0.3, 0.005],
  'projects.shadow.clear': [0, 0.2, 0.002],
  'projects.shadow.skew': [-0.5, 0.5, 0.01],
  'projects.shadow.steps': [1, 16, 1],
  'projects.shadow.soft': [0.5, 4, 0.05],
  'projects.shadow.breathe': [0, 0.3, 0.005],
  'projects.switch.duration': [0.2, 3, 0.01],
  'projects.switch.reenter': [0, 0.5, 0.01],
  'projects.switch.phases.evict': [0, 1, 0.01],
  'projects.switch.phases.fight': [0, 1, 0.01],
  'projects.switch.phases.lock': [0, 1, 0.01],
  'projects.switch.phases.settle': [0, 1, 0.01],
  'projects.switch.swing': [0, 20, 0.5],
  'projects.switch.swingTime': [0.05, 1, 0.01],
  'projects.switch.zBits': [2, 48, 1],
  'projects.switch.zone': [0.05, 1, 0.01],
  'projects.switch.teeth': [0, 2, 0.01],
  'projects.switch.rows': [1, 16, 1],
  'projects.switch.slivers': [0, 0.3, 0.005],
  'projects.switch.lod': [0, 6, 1],
  'projects.switch.bits': [1, 8, 1],
  'projects.switch.tearRows': [0, 12, 1],
  'projects.switch.sharpenAt': [0, 0.99, 0.01],
  'projects.switch.tearShift': [0, 40, 1],
  'projects.switch.tearTicks': [0, 8, 1],
  'projects.switch.split': [0, 12, 0.5],
  'projects.switch.splitTicks': [0, 12, 1],
  'projects.switch.scan.coarse': [2, 64, 1],
  'projects.switch.scan.fine': [1, 32, 1],
  'projects.switch.scan.cursor': [0, 8, 1],
  'projects.ui.fluid': [0, 1, 0.01],
  'projects.ui.safe': [0, 60, 1],
  'projects.ui.rule': [0.5, 3, 0.5],
  'projects.ui.label.u': [-1, 1.5, 0.005],
  'projects.ui.label.v': [-1, 2, 0.005],
  'projects.ui.label.align': [0, 1, 1],
  'projects.ui.label.size': [6, 30, 0.5],
  'projects.ui.label.tracking': [-0.05, 0.4, 0.005],
  'projects.ui.info.u': [-1, 1.5, 0.005],
  'projects.ui.info.v': [-1, 2, 0.005],
  'projects.ui.info.measure': [16, 80, 1],
  'projects.ui.info.minScale': [0.4, 1, 0.01],
  'projects.ui.title.size': [10, 90, 0.5],
  'projects.ui.title.weight': [100, 900, 10],
  'projects.ui.title.tracking': [-0.1, 0.2, 0.005],
  'projects.ui.meta.size': [6, 30, 0.5],
  'projects.ui.meta.tracking': [-0.05, 0.4, 0.005],
  'projects.ui.meta.gap': [0, 60, 1],
  'projects.ui.mono.size': [6, 30, 0.5],
  'projects.ui.mono.leading': [1, 2.2, 0.01],
  'projects.ui.mono.gap': [0, 60, 1],
  'projects.ui.link.size': [6, 30, 0.5],
  'projects.ui.link.tracking': [-0.05, 0.4, 0.005],
  'projects.ui.link.gap': [0, 80, 1],
  'projects.ui.link.underline': [0, 20, 1],
  'projects.ui.link.arrow': [4, 24, 1],
  'projects.ui.ctrl.u': [-1, 1.5, 0.005],
  'projects.ui.ctrl.v': [-1, 2, 0.005],
  'projects.ui.ctrl.align': [0, 1, 1],
  'projects.ui.ctrl.size': [24, 96, 1],
  'projects.ui.ctrl.arrow': [12, 160, 1],
  'projects.ui.ctrl.head': [2, 16, 1],
  'projects.ui.ctrl.gap': [0, 80, 1],
  'projects.ui.ctrl.count': [6, 30, 0.5],
  'projects.ui.ctrl.followGap': [0, 80, 1],
  'projects.ui.reveal.from': POS,
  'projects.ui.reveal.back': [0, 0.2, 0.005],
  'projects.ui.reveal.stagger': [0, 400, 5],
  'projects.ui.reveal.duration': [0, 800, 10],
  'projects.ui.reveal.steps': [1, 12, 1],
  'projects.ui.reveal.out': [0.5, 6, 0.1],
  'projects.ui.swap.out': POS,
  'projects.ui.swap.in': POS,
  'projects.ui.swap.stagger': [0, 200, 5],
  'projects.ui.swipe': [10, 200, 1],

  // the projects leave (pos 1 → ≈ 1.2) and the about screen (pos 1.16 → 3)
  'projects.leave.text.from': POS3,
  'projects.leave.text.back': POS3,
  'projects.leave.lod.from': POS3,
  'projects.leave.lod.back': POS3,
  'projects.leave.stipple.from': POS3,
  'projects.leave.stipple.steps': [1, 16, 1],
  'projects.leave.to': POS3,

  'about.pull.from': POS3,
  'about.pull.to': POS3,
  'about.pull.margin': [1, 3, 0.01],
  'about.pull.max': [1, 300, 1],
  'about.pull.roll': [-15, 15, 0.1],
  // the camera's one turn on the pull (from the A's counter tunnel to the home view)
  'about.pull.orbit.from': POS3,
  'about.pull.orbit.to': POS3,
  'about.pull.orbit.ease': [0, 0.5, 0.01],
  'about.pull.orbit.lead': [0.5, 2, 0.05],
  // every element's turn toward the pointer (words; cards; notes — a share of the cards')
  'about.turn.tiltX': [0, 15, 0.1],
  'about.turn.tiltY': [0, 15, 0.1],
  'about.turn.maxTurn': [1, 60, 0.5],
  'about.turn.mass': [0.3, 6, 0.05],
  'about.turn.spread': [0, 0.6, 0.01],
  'about.turn.edgeKnee': [0.05, 1, 0.01],
  'about.turn.fade.full': [0.5, 6, 0.05],
  'about.turn.fade.none': [1, 10, 0.05],
  'about.turn.cards.tiltX': [0, 20, 0.1],
  'about.turn.cards.tiltY': [0, 20, 0.1],
  'about.turn.cards.maxTurn': [1, 30, 0.5],
  'about.turn.cards.mass': [0.3, 6, 0.05],
  'about.turn.cards.spread': [0, 0.6, 0.01],
  'about.turn.notes.share.mono': [0, 1.5, 0.01],
  'about.turn.notes.share.list': [0, 1.5, 0.01],
  'about.turn.notes.share.hand': [0, 1.5, 0.01],
  'about.turn.notes.share.count': [0, 1.5, 0.01],
  'about.turn.notes.mass': [0.3, 6, 0.05],
  'about.turn.notes.spread': [0, 0.6, 0.01],
  'about.cards.sheen.turn': [-1, 1, 0.01],
  'about.camera.fov': [10, 90, 0.5],
  'about.camera.near': [0.001, 0.2, 0.001],
  'about.word.tracking': [-0.1, 0.2, 0.001],
  'about.word.stretchY': [0.6, 1.6, 0.01],
  'about.letters.depth': [0.05, 2, 0.01],
  'about.letters.chamferOuter': [0, 0.12, 0.001],
  'about.letters.chamferStep': [0, 0.12, 0.001],
  'about.letters.chamferInner': [0, 0.12, 0.001],
  'about.letters.seam': [0, 0.05, 0.001],
  'about.letters.seamAt': [0, 1, 0.01],
  'about.letters.curveSegments': [1, 12, 1],
  'about.letters.crease': [0, 90, 1],
  'about.raster.texel': [0.5, 8, 0.25],
  'about.raster.bits': [1, 8, 1],
  'about.raster.dither': [0, 1.5, 0.01],
  'about.raster.affineCells': [1, 16, 1],
  'about.concrete.light.x': [-1, 1, 0.01],
  'about.concrete.light.y': [-1, 1, 0.01],
  'about.concrete.light.z': [0, 1, 0.01],
  'about.concrete.bands': [1, 8, 1],
  'about.concrete.glint.size': [0.5, 40, 0.5],
  'about.concrete.glint.steps': [1, 6, 1],
  'about.concrete.glint.lamp.x': [-4, 4, 0.05],
  'about.concrete.glint.lamp.y': [-4, 4, 0.05],
  'about.concrete.glint.lamp.z': [-2, 2, 0.05],
  'about.concrete.mottle.size': [0.002, 0.1, 0.001],
  'about.concrete.aggregate.size': [0.0005, 0.02, 0.0005],
  'about.concrete.haze.near': [-1, 0.5, 0.01],
  'about.concrete.haze.far': [-1, 0.5, 0.01],
  'about.concrete.haze.steps': [1, 8, 1],
  'about.cards.haze.near': [-0.5, 1, 0.01],
  'about.cards.haze.far': [-0.5, 1, 0.01],
  'about.cards.haze.steps': [1, 8, 1],
  'about.cards.sheen.steps': [1, 8, 1],
  'about.shadow.light.x': [-1, 1, 0.01],
  'about.shadow.light.y': [-1, 1, 0.01],
  'about.shadow.light.z': [0.1, 2, 0.01],
  'about.shadow.lampAt': [0, 1, 0.01],
  'about.shadow.steps': [1, 16, 1],
  'about.shadow.gap': [0, 0.2, 0.001],
  'about.shadow.soft': [0, 2, 0.01],
  'about.shadow.round': [2, 12, 0.1],
  'about.shadow.blur': [0, 0.03, 0.0005],
  'about.shadow.edge': [0, 0.9, 0.01],
  'about.shadow.share': [0.05, 1, 0.01],
  'about.concrete.dock.amount': [0, 1, 0.01],
  'about.reveal.photos.from': POS3,
  'about.reveal.photos.to': POS3,
  'about.reveal.photos.stagger': [0, 0.06, 0.001],
  'about.reveal.photos.steps': [1, 16, 1],
  'about.reveal.notes.from': POS3,
  'about.reveal.notes.back': POS3,
  'about.reveal.enter.word': [0, 0.5, 0.01],
  'about.concrete.dock.edge': [1, 24, 1],
  'about.tour.dwell': [0, 0.9, 0.01],
} satisfies Record<string, [number, number, number]>)

/**
 * Knobs of keyed lists (any key: a photo, a note, a key of the camera path added by hand), matched on
 * the path with the item's own key replaced by `*`. Sheet units: 1 = the width of the word ABOUT,
 * x across, y down from its centre (the tour goes ≈ 5.5 units down on a desktop, ≈ 12 on a phone).
 */
const ITEM_RANGES: Record<string, [number, number, number]> = {
  'scroll.stops.*': [0.3, 8, 0.05],
  'about.pull.keys.*.at': POS3,
  'about.pull.keys.*.zoom': [1, 150, 0.05],
  'about.pull.keys.*.start': [0, 1, 0.005],
  'about.pull.keys.*.x': [0, 1, 0.005],
  'about.pull.keys.*.y': [0, 1, 0.005],
  'about.tour.keys.*.at': [0, 1, 0.005],
  'about.tour.keys.*.zoom': [0.4, 3, 0.01],
  'about.tour.keys.*.x': [-1.5, 1.5, 0.005],
  'about.tour.keys.*.y': [-1, 13, 0.005],
  'about.tour.keys.*.roll': [-15, 15, 0.1],
  'about.words.*.x': [-1.5, 1.5, 0.005],
  'about.words.*.y': [-1, 13, 0.005],
  'about.words.*.z': [-1, 1, 0.005],
  'about.words.*.width': [0.05, 2, 0.001],
  'about.words.*.rotation': [-180, 180, 0.5],
  'about.words.*.yaw': [-60, 60, 0.5],
  'about.words.*.pitch': [-60, 60, 0.5],
  'about.words.*.turn': [0, 1, 0.01],
  'about.words.*.depth': [0.05, 2, 0.01],
  'about.words.*.stretchY': [0.6, 1.6, 0.01],
  'about.words.*.tracking': [-0.1, 0.2, 0.001],
  'about.photos.items.*.x': [-1.5, 1.5, 0.005],
  'about.photos.items.*.y': [-1, 13, 0.005],
  'about.photos.items.*.z': [-0.5, 1, 0.005],
  'about.photos.items.*.width': [0.02, 1, 0.001],
  'about.photos.items.*.aspect': [0.3, 3, 0.01],
  'about.photos.items.*.thickness': [0.001, 0.08, 0.001],
  'about.photos.items.*.rotation': [-30, 30, 0.5],
  'about.photos.items.*.yaw': [-45, 45, 0.5],
  'about.photos.items.*.pitch': [-45, 45, 0.5],
  'about.photos.items.*.crop.x': [0, 1, 0.005],
  'about.photos.items.*.crop.y': [0, 1, 0.005],
  'about.photos.items.*.crop.w': [0.05, 1, 0.005],
  'about.photos.items.*.saturation': [-1, 1, 0.01],
  'about.notes.*.x': [-1.5, 1.5, 0.005],
  'about.notes.*.y': [-1, 13, 0.005],
  'about.notes.*.z': [-0.2, 0.3, 0.005],
  'about.notes.*.rotation': [-30, 30, 0.5],
}
/** Keyed lists whose items get ITEM_RANGES and the `*` entries of OPTIONS: `<list>.<key>.<rest>` → `<list>.*.<rest>` */
const ITEM_LISTS = /^(scroll\.stops|about\.(?:pull\.keys|tour\.keys|words|photos\.items|notes))\.[^.]+(\.|$)/
const itemPath = (p: string) => p.replace(ITEM_LISTS, (_, list: string, dot: string) => `${list}.*${dot}`)

// what a layer of veil.layers has on top of the shared per-layer knobs
const VEIL_LAYER_RANGES: Record<string, [number, number, number]> = {
  'focus.x': [0, 1, 0.01],
  'focus.y': [0, 1, 0.01],
  zoom: [1, 2, 0.01],
  'scroll.rise': [0, 300, 1],
  'scroll.from': POS,
  'scroll.to': POS,
  'scroll.ease': [0, 1, 0.01],
}

// every project of projects.items
const PROJECT_ITEM_RANGES: Record<string, [number, number, number]> = {
  'focus.x': [0, 1, 0.01],
  'focus.y': [0, 1, 0.01],
}

/** String knobs with a fixed set of values: a dropdown instead of a text field. */
const OPTIONS: Record<string, string[]> = {
  // takes effect on reload (?set.title.mode=mesh)
  'title.mode': ['raster', 'mesh'],
  'projects.switch.mode': ['zfight', 'scan', 'cut'],
  // keyed lists, any key (itemPath)
  'about.photos.items.*.style': ['photo', 'halftone'],
  'about.notes.*.kind': ['mono', 'list', 'hand', 'count'],
  'about.notes.*.align': ['left', 'right'],
}
/** The dropdown of a string knob (mobile.* reuses the desktop list), or undefined. */
const optionsFor = (path: string) => {
  const p = path.replace(/^mobile\./, '')
  return OPTIONS[p] ?? OPTIONS[itemPath(p)]
}

/** Blocks of the later screens: a numeric knob there with no range above still gets a slider. */
const AUTO_RANGE = /^(scroll|descent|veil|projects|about|overlay\.nav\.(dock|morph))\./
const autoRange = (v: number): [number, number] => [v < 0 ? 3 * v : 0, Math.max(1, 3 * Math.abs(v))]

/** The mobile block reuses the desktop ranges: mobile.cutouts.main.x → cutouts.main.x.
 *  A layer of the layered sky or of the veil — also one added by hand (sky.layers.<any>.x,
 *  veil.layers.<any>.x …) — gets the shared per-layer ranges; so does an item of a keyed list
 *  (ITEM_RANGES: a stop of scroll.stops, a photo, a note, a key of the about camera …). */
const rangeFor = (path: string, value: number): [number, number, number?] | undefined => {
  const p = path.replace(/^mobile\./, '')
  const [, block, knob = ''] = /^(sky|veil)\.layers\.[^.]+\.(.+)$/.exec(p) ?? []
  return (
    RANGES[p] ??
    SKY_LAYER_RANGES[knob] ??
    (block === 'veil' ? VEIL_LAYER_RANGES[knob] : undefined) ??
    PROJECT_ITEM_RANGES[/^projects\.items\.[^.]+\.(.+)$/.exec(p)?.[1] ?? ''] ??
    ITEM_RANGES[itemPath(p)] ??
    (AUTO_RANGE.test(p) ? autoRange(value) : undefined)
  )
}

type Tree = Record<string, unknown>

/**
 * A text with line breaks (the about notes, the hero's tagline) in a one-line field: lil-gui's text
 * input is an <input type=text>, which drops a real newline the moment it shows the value — and the
 * first keystroke would then write the text back as one line. So the field edits a stand-in: a line
 * break shows as the two characters \n and is turned back into one on the way in. Nothing else is
 * escaped: the field shows exactly what was typed (lil-gui rewrites it on every keystroke — any
 * other difference would move the caret), so a backslash followed by n cannot be written as text.
 */
const escapeLines = (s: string) => s.replace(/\n/g, '\\n')
const unescapeLines = (s: string) => s.replace(/\\n/g, '\n')
function multiline(obj: Record<string, unknown>, key: string): Record<string, string> {
  return Object.defineProperty({}, key, {
    get: () => escapeLines(String(obj[key] ?? '')),
    set: (v: string) => {
      obj[key] = unescapeLines(v)
    },
    enumerable: true,
  })
}

/** Leaves that differ between two config snapshots, as dot paths. */
function diff(a: Tree, b: Tree, path = '', out: [string, unknown, unknown][] = []) {
  for (const key of Object.keys(b)) {
    const p = path ? `${path}.${key}` : key
    const va = a?.[key]
    const vb = b[key]
    if (typeof vb === 'object' && vb !== null && !Array.isArray(vb)) diff(va as Tree, vb as Tree, p, out)
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push([p, va, vb])
  }
  return out
}

/** Fine-tuning blocks start collapsed so the main knobs stay on top. */
const COLLAPSED = new Set([
  'raster', 'look', 'detail', 'edge', 'type', 'layout', 'hand', 'ink', 'mobile', 'windows', 'reduced', 'grade', 'billow',
  // the second screen of version 2
  'switch', 'shadow', 'dock', 'morph', 'arrive',
])
/**
 * …and these by full path: version 1 has a top-level `ui` of its own and the nav a list of `items`,
 * which stay open. The about block's long keyed lists (a dozen photos, eighteen notes …) start closed
 * too: open, they push its own knobs a few screens down.
 */
const COLLAPSED_PATHS = new Set([
  'projects.ui', 'projects.items',
  'about.photos.items', 'about.notes', 'about.words', 'about.tour.keys', 'about.pull.keys',
])
/**
 * Top-level blocks of version 2's later screens. When the panel is opened while the page is on one
 * of them, every other top-level folder starts closed: these come last in the panel, after a few
 * hundred knobs of the hero. The second screen (projects) from raw 0.5, the about screen from 1.5 —
 * where the nav calls it ABOUT.
 */
const SECOND_SCREEN = new Set(['overlay', 'scroll', 'descent', 'veil', 'projects'])
const ABOUT_SCREEN = new Set(['overlay', 'scroll', 'about'])

let gui: GUI | null = null

export function openTuner({ config, refresh }: TunerOptions) {
  if (gui) {
    gui.show(gui._hidden)
    return
  }
  gui = new GUI({ title: 'Hero tuner' })
  gui.domElement.style.zIndex = '1000'
  const initial = structuredClone(config) as unknown as Tree

  // Below the breakpoint the `mobile` block overrides cutouts / title / note / type: say so,
  // and keep that folder open, otherwise the top-level sliders seem to do nothing.
  const hero = (window as unknown as { __hero?: { layout: { isMobile: boolean } } }).__hero
  const notice = gui.add({ note: '' }, 'note').name('⚠').disable()
  let mobileFolder: GUI | null = null
  const syncNotice = () => {
    const mobile = !!hero?.layout.isMobile
    notice.setValue(mobile ? 'мобильная композиция: правьте папку mobile' : '').show(mobile)
    if (mobile) mobileFolder?.open()
  }
  const onChange = () => {
    refresh()
    syncNotice()
  }

  const raw = scrollControl.current?.state.raw ?? 0
  const screen = raw >= 1.5 ? ABOUT_SCREEN : raw >= 0.5 ? SECOND_SCREEN : null
  const build = (folder: GUI, obj: Record<string, unknown>, path: string) => {
    for (const [key, value] of Object.entries(obj)) {
      const p = path ? `${path}.${key}` : key
      if (p === 'copy') continue
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const sub = folder.addFolder(key)
        if (COLLAPSED.has(key) || COLLAPSED_PATHS.has(p.replace(/^mobile\./, ''))) sub.close()
        if (screen && !path && !screen.has(key)) sub.close()
        if (p === 'mobile') mobileFolder = sub
        build(sub, value as Record<string, unknown>, p)
        continue
      }
      let c
      if (typeof value === 'number') {
        const r = rangeFor(p, value)
        c = r ? folder.add(obj, key, r[0], r[1], r[2]) : folder.add(obj, key)
      } else if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) {
        c = folder.addColor(obj, key)
      } else if (typeof value === 'string' && optionsFor(p)) {
        c = folder.add(obj, key, optionsFor(p))
      } else if (typeof value === 'string' && value.includes('\n')) {
        c = folder.add(multiline(obj, key), key)
      } else if (typeof value === 'boolean' || typeof value === 'string') {
        c = folder.add(obj, key)
      } else continue
      c.onChange(onChange)
    }
  }
  build(gui, config as unknown as Record<string, unknown>, '')
  syncNotice()
  // after main.ts's own observer → runs once refresh() has updated the layout
  new ResizeObserver(syncNotice).observe(document.getElementById('hero')!)

  // Only what changed since the panel opened: lines to copy into hero.config.ts by hand,
  // plus a ready ?set.… link for sharing an A/B.
  gui.add(
    {
      'Copy changes': () => {
        const changes = diff(initial, config as unknown as Tree)
        const lines = changes.map(([p, from, to]) => `${p}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`)
        const query = changes
          .map(([p, , to]) => `set.${p}=${encodeURIComponent(String(to).replace(/^#/, ''))}`)
          .join('&')
        const text = changes.length
          ? `${lines.join('\n')}\n\n${location.origin}${location.pathname}?${query}`
          : 'no changes'
        navigator.clipboard?.writeText(text).catch(() => {})
        console.log(text)
      },
    },
    'Copy changes',
  )
}
