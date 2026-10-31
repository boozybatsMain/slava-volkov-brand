# Sky plates for version 2 (`index.html`, `sky.source: 'photo'`)

| file             | size       | what                                                                  |
|------------------|------------|-----------------------------------------------------------------------|
| `sky-wide.webp`  | 4000×1812  | landscape screens — the whole reference sky, ~1:1 on a 1440×900 Retina |
| `sky-tall.webp`  | 1900×2531  | portrait screens — the cloudier right part, ~1:1 on a 390×844 @3x phone |

Both live in `public/assets/sky/`. The layer reads their real size; framing is set in
`src/sky.config.ts` → `sky` (`focus`, `tallFocus`, `zoom`). To try another file without
overwriting: `/?set.sky.wide=<name>.webp`.

## How they were made — `tools/fal_plates.py` (fal.ai; key only via `FAL_KEY` env)

The reference (`reference/sky-hero.png`, 2000×906) is soft by itself, so a plain upscaler cannot
add detail (tried: Real-ESRGAN via Upscayl — ~5 % sharper, nothing new). The plates are made with
generative models, keeping the reference's composition and colours:

1. **Clean plate** — `fill`: FLUX.1 Fill [pro] repaints the chrome title + the mockup's UI text.
   Mask = the fitted title silhouette (from `make_placeholders.py`) + chrome leftovers + text,
   grown 10 px. The result is composited back so everything outside the mask stays original.
   Used seed 21 with the "clear sky, a few small bright clouds, no dark clouds" prompt — the
   default prompt grew a dark band of cloud in the title's shape.
   `despeck` then removes a stray "bird" the fill invented in the top sky.
2. **Detail** — Topaz `Redefine` (creativity 2, texture 3) ×2 for the wide plate and ×4 on the
   portrait crop (x 1320–2000) for the tall one; Topaz `Wonder 3` at the same factor as a precise
   reference.
3. **Guard** — `merge`: luma from Redefine (the new cloud detail), chroma from Wonder 3; where the
   two disagree strongly in colour (an iridescent blotch) Wonder 3 is used outright; tiny points
   Redefine sprinkles over clear blue sky ("stars", a crescent moon) are put back from Wonder 3.
   `heal` retouched two more spots on the tall plate (`858,2055,14` and `1887,2753,70`).
4. WebP q92 (PSNR > 42 dB, no banding in the clear sky).

Commands (work files go to `$FAL_WORK`, default `./.fal-work`):

    FAL_KEY=… python3 src/layers/photo-sky/tools/fal_plates.py fill --seed 21 --n 1 --prompt "…" --tag fillB
    python3 src/layers/photo-sky/tools/fal_plates.py despeck .fal-work/fillB-0.png clean.png
    FAL_KEY=… python3 src/layers/photo-sky/tools/fal_plates.py upscale fal-ai/topaz/upscale/image \
        '{"model":"Redefine","upscale_factor":2,"creativity":2,"texture":3,"prompt":"…","output_format":"png","face_enhancement":false}' \
        .fal-work/clean.png up-topaz-redefine.png
    FAL_KEY=… python3 src/layers/photo-sky/tools/fal_plates.py upscale fal-ai/topaz/upscale/image \
        '{"model":"Wonder 3","upscale_factor":2,"output_format":"png","face_enhancement":false}' \
        .fal-work/clean.png up-topaz-wonder3.png
    python3 src/layers/photo-sky/tools/fal_plates.py merge .fal-work/up-topaz-redefine.png .fal-work/up-topaz-wonder3.png wide-merged.png

`make_placeholders.py` is the older, offline stand-in (patchwork fill, no network); it is only
kept for its title/text masks, which `fal_plates.py` imports.
