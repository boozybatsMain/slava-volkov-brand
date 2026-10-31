import type { AboutCamera } from './about-camera'
import type { AboutTurns } from './about-pose'
import type { Frame } from './types'

/**
 * What the ABOUT world tells the others — published by layers/about (WebGL or its 2D fallback). Same
 * kind of contract as slab-pose.ts and veil-clouds.ts.
 *
 * This frame's camera as the about layer drew it (core/about-camera.ts, with its 3D fields: h, fpx,
 * near, turn …) and every element's turn toward the pointer (core/about-pose.ts → AboutTurns: per
 * word, card and note, degrees, already faded by the zoom — each element has its own spring; the
 * pointer never moves the camera). Written EVERY update, before the notes layer (declared after it: the
 * same frame) reads it, so the notes turn in the same frame as the letters and cards. `drawn` — the world has been drawn at least once with the camera
 * past pull.from. `frame` — the Frame object of the update that wrote it: hero.ts hands the same
 * object to every layer in a tick, so `aboutFrame.frame === frame` is an exact «this frame's» test (a
 * clamped timer cannot fool it). `time` — performance.now() of the write (for debugging).
 *
 * (The nav needs nothing from here: over ABOUT it inverts whatever is under it with a constant ink —
 * mix-blend-mode difference, sky-overlay — dark over the void, light over black concrete.)
 */
export const aboutFrame: {
  camera: AboutCamera | null
  pointer: AboutTurns
  drawn: boolean
  frame: Frame | null
  time: number
} = { camera: null, pointer: { words: {}, cards: {}, notes: {} }, drawn: false, frame: null, time: 0 }
