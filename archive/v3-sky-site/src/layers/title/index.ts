import type { LayerFactory } from '../../core/types'

/**
 * The floating title, by hero.config.ts → title.mode:
 *   'raster' — the client's own render used as a raster asset + shader (./raster);
 *   'mesh'   — real extruded letters fitted to that render, painted with it at rest (./mesh).
 * (The first real-geometry attempt, judged against the raster, lives in archive/title-mesh.)
 * Without WebGL both fall back to the raster's static, equally pixelated cut-out.
 */
export const createTitleLayer: LayerFactory = async (mount, ctx) => {
  const { createLayer } = await (ctx.config.title.mode === 'mesh' ? import('./mesh') : import('./raster'))
  return createLayer(mount, ctx)
}
