import type { LayerFactory } from '../../core/types'

/**
 * The floating title: the client's own render used as a raster asset + shader.
 * (A real-geometry alternative was built and judged against it; it lives in archive/title-mesh.)
 * Without WebGL the raster layer falls back to a static, equally pixelated cut-out by itself.
 */
export const createTitleLayer: LayerFactory = async (mount, ctx) => {
  const { createLayer } = await import('./raster')
  return createLayer(mount, ctx)
}
