/**
 * Where the nav's dock is on screen — published by the nav (layers/sky-overlay, which updates BEFORE
 * the about layers in the same frame), read by the about canvas: photo texels under the dock are
 * darkened (about.photos.dock) so the nav's difference-blended labels stay legible over them.
 *
 * Stage CSS px (x, y — top-left; w, h — size): the union of the dock's labels, dots and line as drawn
 * this frame (the about notes fade under it too). null — the nav is not docked, not shown yet (fonts),
 * or not mounted.
 */
export const navDock: { current: { x: number; y: number; w: number; h: number } | null } = { current: null }
