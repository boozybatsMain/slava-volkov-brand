/**
 * Where the veil's own clouds are on screen — published by the veil's renderer (sky-layers, veil
 * mode) every frame it places them, read by whoever must know "is there cloud behind this point"
 * without drawing (the nav decides the ink of each of its pieces by it: sky-overlay).
 * The same kind of contract as the title's pose (title/raster/pose.ts) and the slab's (slab-pose.ts).
 *
 * Only the clouds that paint by themselves before the fog: not the plate, not what lives in the void
 * (afterFog). The boxes carry what a reader cannot work out from the config alone — the wind's sway
 * and the layer's own (mass-lagged) pointer.
 */
export interface VeilCloudBox {
  /** the layer's key in veil.layers */
  name: string
  /** the picture's box as drawn, CSS px (a bank repeats sideways and goes on below it) */
  left: number
  top: number
  width: number
  height: number
  /** how far the scroll had lifted it in that frame, CSS px (already in `top`) */
  rise: number
}

export const veilClouds: {
  current: VeilCloudBox[] | null
  /** performance.now() of the frame that wrote `current`: the veil sleeps on the hero and its last boxes go stale */
  at: number
} = { current: null, at: 0 }

/** Boxes older than this (ms) are nobody's: the veil is asleep, lost its context, or was resized away. */
export const VEIL_CLOUDS_FRESH = 250
