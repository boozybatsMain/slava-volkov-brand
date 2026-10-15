import type { AboutCamera } from './about-camera'
import type { Frame } from './types'

/**
 * What the ABOUT sheet tells the others — published by layers/about (WebGL or its 2D fallback). Same
 * kind of contract as slab-pose.ts and veil-clouds.ts.
 *
 * This frame's camera as the about layer drew it — snapped, plus the pointer sway (CSS px; a thing
 * with parallax depth d moves by (1 + d) × it). Written every frame the canvas updates, read by the
 * notes layer (declared after it: the same frame) so text and holes move as one. `drawn` — the sheet
 * has drawn at least once (the notes stay hidden before: light ink must never float on white).
 * `frame` — the Frame object of the update that wrote it: hero.ts hands the same object to every layer
 * in a tick, so `aboutFrame.frame === frame` is an exact «this frame's» test (a clamped timer cannot
 * fool it). `time` — performance.now() of the write (for debugging; `frame` is the exact test).
 *
 * (The nav needs nothing from here: on the sheet it inverts whatever is under it — mix-blend-mode
 * difference, sky-overlay — so every letter is light on black and dark on the white holes by itself.)
 */
export const aboutFrame: {
  camera: AboutCamera | null
  pointer: { x: number; y: number }
  drawn: boolean
  frame: Frame | null
  time: number
} = { camera: null, pointer: { x: 0, y: 0 }, drawn: false, frame: null, time: 0 }
