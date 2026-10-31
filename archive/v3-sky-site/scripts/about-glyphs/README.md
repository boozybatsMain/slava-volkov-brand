# about-glyphs — letter outlines for the 3D ABOUT words

`src/layers/about/font.json` holds the outlines of **Russo One** (the hero title's letterforms), so the
site never parses a font at runtime. `src/layers/about/mesh.ts` builds the extruded concrete letters
from it.

- `russo-one-latin-400-normal.woff` — the source (latin subset, `@fontsource/russo-one` 5.3.0).
- `OFL.txt` — its license: SIL Open Font License 1.1, © 2011-2012 Jovanny Lemonad, Reserved Font Name
  "Russo". Keep it next to the font and keep the `license` line in `font.json`.
- `bake.py` — the bake (fontTools).

## Re-run

fontTools lives in the user's site-packages, so run Python with `-E` (not `-I`):

```sh
/usr/bin/python3 -E scripts/about-glyphs/bake.py \
    scripts/about-glyphs/russo-one-latin-400-normal.woff src/layers/about/font.json
```

It prints the glyph count, the kerning pair count and the size (now: 44 glyphs, 139 pairs, ≈ 14 KB).

## What is baked

- Characters: `A–Z`, `0–9`, `'` `’` `&` `.` `,` `-` `!` `?` and the space advance. Lowercase text is drawn
  in uppercase; any other character is drawn as a space (with one console warning). To add characters,
  extend `CHARS` in `bake.py` and re-run.
- Format (the archived title-mesh `glyphs.json`): `{ source, license, unitsPerEm, capHeight, space,
  glyphs: { ch: { adv, cmds } }, kern: { "AB": dx } }`. `cmds` are `['M', x, y]`, `['L', x, y]`,
  `['Q', x1, y1, x, y]`, `['C', …]`, `['Z']` in font units, y up (the mesh builder flips y).
- `kern`: GPOS pair kerning of the `kern` feature (PairPos format 1 and 2, extension lookups too) between
  every two baked characters, in font units added to the first glyph's advance. Russo One has no legacy
  `kern` table.
