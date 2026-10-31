import type { Layout, ResolvedConfig } from '../../../core/types'

/**
 * Material / depth / "bad render" knobs of the title. Values live in hero.config.ts → title.raster.
 *
 * How title.response.highlight reads here:
 *   0 — reflections are glued to the letters (any pose shows the client's render on the faces);
 *   1 — reflections slide physically as the title turns (slide, env, lamp, glint);
 *   >1 — the same, exaggerated.
 *
 * `renderWidth` is optional here so the layer keeps working while the config has no such key.
 */
export type RasterTitleParams = ResolvedConfig['title']['raster'] & { renderWidth?: number }

export function getRasterTitleParams(config: ResolvedConfig): RasterTitleParams {
  return config.title.raster
}

/** Default max internal width of the title, render px (= the look tuned at 1440: 0.66·1440 / 1.5). */
const RENDER_WIDTH = 634

/**
 * Size of one render pixel, CSS px. The degradation is relative to the TITLE, not to the screen:
 * the title never gets more than `title.raster.renderWidth` render pixels across, so a 2560 monitor
 * shows the same "шакальное" resolution as 1440 instead of the source's native one.
 * `title.pixelSize` stays the floor (small screens keep their visible stair-steps).
 */
export function renderPixelSize(layout: Layout, config: ResolvedConfig) {
  const rw = getRasterTitleParams(config).renderWidth ?? RENDER_WIDTH
  return Math.max(0.25, config.title.pixelSize, layout.title.width / Math.max(50, rw))
}
