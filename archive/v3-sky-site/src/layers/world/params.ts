import type { ResolvedConfig } from '../../core/types'

/**
 * Knobs of the full-screen "cumulus" sky (version 2, index.html, set in sky.config.ts).
 * They are not in hero.config.ts: version 1 never sets them, so it falls back to these
 * defaults — and with scene = 'deck' (the default) the version-1 renderer runs untouched.
 */
export interface CumulusKnobs {
  /** 'deck' — version 1 (sky seen through the paper cutouts); 'cumulus' — full-screen golden-hour sky. */
  scene: 'deck' | 'cumulus'
  /** Camera elevation at the screen centre, degrees (the horizon is below the screen). */
  pitch: number
  /** Vertical field of view across the screen height, degrees. */
  vfov: number
  /** Which cloud layout (any integer). */
  cloudSeed: number
  /** Clouds built of many small flakes (altocumulus) instead of a few big puffs. 0…1 */
  flakes: number
  /** Vertical development: 1 = cumulus heaps, ~0.4 = flat altocumulus (flatter low in the sky). */
  thickness: number
  /** Thin translucent veils of cloud around the far heaps (0 = none). 0…1 */
  veils: number
  /** Clear sky at the top of the screen: 0 = clouds everywhere, 1 = fully clear. */
  clearTop: number
  /** Where (share of the screen height) the cloud field starts below that clear sky. */
  clearDepth: number
  /** Slope of that line: > 0 — the clear sky reaches lower on the left than on the right. */
  clearTilt: number
  /** Extra cloud cover low on the screen (far away). 0…0.5 */
  farCover: number
  /** How many of the far heaps sit in the shade (grey-violet). 0…1 */
  farShade: number
  /** Brightest sunlit tops of the clouds. */
  cloudGlow: string
  /** Haze colour low in the sky. */
  hazeColor: string
  /** Lift of the sky toward the sun side. 0…0.3 */
  sunSide: number
}

export const CUMULUS_DEFAULTS: CumulusKnobs = {
  scene: 'deck',
  pitch: 36,
  vfov: 26,
  cloudSeed: 3,
  flakes: 0.9,
  thickness: 0.4,
  veils: 0.3,
  clearTop: 1,
  clearDepth: 0.22,
  clearTilt: 0.15,
  farCover: 0.1,
  farShade: 0.35,
  cloudGlow: '#fff0d0',
  hazeColor: '#d9a59a',
  sunSide: 0.1,
}

/** Look of the sky. Values live in hero.config.ts → world.look (v2 overrides in sky.config.ts). */
export type WorldParams = ResolvedConfig['world']['look'] & CumulusKnobs

// The resolved config is a fresh object after every refresh (resize, tuner edit), so the
// merged view can be cached per look object.
const cache = new WeakMap<object, WorldParams>()

export function getWorldParams(config: ResolvedConfig): WorldParams {
  const look = config.world.look
  let p = cache.get(look)
  if (!p) {
    p = { ...CUMULUS_DEFAULTS, ...(look as Partial<WorldParams>) } as WorldParams
    cache.set(look, p)
  }
  return p
}
