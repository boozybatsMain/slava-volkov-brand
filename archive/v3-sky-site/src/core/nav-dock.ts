/** A rect on the stage, CSS px (x, y — top-left; w, h — size). */
export interface DockRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where the nav's dock is on screen — published by the nav (layers/sky-overlay, which updates BEFORE
 * the about layers in the same frame), read by the about canvas: right behind each LABEL (its text and
 * its dot — `labels`) the concrete is kept from being lighter than the labels' ink and the cards are
 * washed toward the void, in a soft Bayer halo (about.concrete.dock, about.cards.dock), so the nav's
 * difference-blended labels stay legible over them — never the whole column (a dark plate).
 *
 * Stage CSS px: the union of the dock's labels, dots and line as drawn this frame (the about notes fade
 * under it), and `labels` — one rect per item (its dot and its label). null — the nav is not docked,
 * not shown yet (fonts), or not mounted.
 */
export const navDock: { current: (DockRect & { labels: DockRect[] }) | null } = { current: null }
