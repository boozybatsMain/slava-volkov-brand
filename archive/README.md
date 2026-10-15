# archive

Not part of the build (outside `src/`, not typechecked).

- `title-mesh/` — the real-geometry version of the 3D title (Russo One, stepped chamfer,
  procedural pseudo-chrome). It lost the judged bake-off 0:3 to the raster version. To revive it,
  it needs `opentype.js` and `@fontsource/russo-one` again. Revived on 2026-10-13 as
  `src/layers/title/mesh` (title.mode 'mesh'): emboldened to the render's weight, fitted to it and
  painted with it at rest (HANDOFF.md, "Версия 2, шаг 10"); this folder stays as the original.
- `dev-probes/` — one-off measurement / comparison scripts the build agents used while tuning.
  Some refer to removed debug switches (`title.mode`, `?rtune`).
- `v1-paper/` — version 1 of the hero (world behind a paper sheet with two cutouts, UI on the
  paper), the old `/` until 2026-10-11: its `index.html`, `main.ts` and the `paper` layer
  (was `src/layers/paper`). The site is now version 2 only (the former `sky.html`). To revive it,
  move `paper/` back to `src/layers/`, `main.ts` to `src/`, and add the page to `vite.config.ts`.
- `v2-before-one-world/` — snapshot of `src/`, `public/`, `index.html`, `vite.config.ts`, `tsconfig.json`
  taken 2026-10-12 before the "one world" rework (HANDOFF.md, "Версия 2, шаг 9": the hero's warm
  palette on screens 2–3 with a peach void, About as black concrete 3D letters and photo cards on
  that void instead of the black sheet with cutouts). It is the state of HANDOFF "шаг 8" with its
  follow-ups: cold lilac-white void, the black about sheet (`layers/about/glyphs.ts`, `scene.ts`),
  crosses, torn photo edges. To roll back, REPLACE `src/` with the snapshot's (delete the current one
  first: files added by the rework — `src/core/raster-gl.ts`, `src/layers/about/gl.ts`, `mesh.ts`,
  `soft.ts`, `font.json` — would otherwise stay behind and fail the typecheck) and copy `index.html`
  back. `public/`, `vite.config.ts` and `tsconfig.json` did not change in the rework;
  `scripts/about-glyphs/` (the glyph bake) is only used by the new About and can stay.
