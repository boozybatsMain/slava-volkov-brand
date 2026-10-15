#!/usr/bin/env python3
"""
Tone regression check: our title-only render vs reference/title-main.jpg, per region.

    python3 scripts/title-raster/tone.py <render.png> [<render2.png> ...]

<render.png> = a `?layers=title` screenshot (paper-coloured background #e4e2dd), any dpr.
Reports, inside the letters, for the whole title and for S / LAVA / VOLKOV (bbox thirds,
same split for both images): luminance percentiles, mean (B−R) "blueness", share of strongly
blue pixels (B−R > 25) and share of clipped highlights (lum > 220).
Adapted from scripts/title-mesh/{lumdist,regions}.py (mesh candidate's measurement scripts).
"""
import sys
import numpy as np
from PIL import Image

P = [5, 25, 50, 75, 95]


def stats(rgb, mask):
    lum = rgb.mean(2)[mask]
    br = (rgb[..., 2] - rgb[..., 0])[mask]
    return dict(
        p=np.percentile(lum, P).astype(int).tolist(),
        blue=round(float(br.mean()), 1),
        blue25=round(float((br > 25).mean() * 100), 1),
        hot=round(float((lum > 220).mean() * 100), 1),
        sd=round(float(lum.std()), 1),
    )


def regions(mask):
    xs = np.where(mask.any(0))[0]
    x0, x1 = xs.min(), xs.max()
    w = x1 - x0
    cuts = [(x0, x0 + 0.22 * w), (x0 + 0.22 * w, x0 + 0.6 * w), (x0 + 0.6 * w, x1 + 1)]
    out = {'ALL': mask}
    for name, (a, b) in zip(['S', 'LAVA', 'VOLKOV'], cuts):
        m = mask.copy()
        m[:, : int(a)] = False
        m[:, int(b):] = False
        out[name] = m
    return out


def fmt(s):
    return f"p{P}={s['p']} sd={s['sd']:5} B-R={s['blue']:5} blue%={s['blue25']:5} hot%={s['hot']:5}"


# reference = the client's render (color.png is title-main.jpg cropped, untouched) inside the
# same hard key the shader uses (maps.R > threshold), so near-white highlights count too
ref = np.asarray(Image.open('public/assets/title-raster/color.png').convert('RGB')).astype(int)
rmask = np.asarray(Image.open('public/assets/title-raster/maps.png').convert('RGB'))[..., 0] > 0.42 * 255
R = {k: stats(ref, m) for k, m in regions(rmask).items()}

for path in sys.argv[1:]:
    im = np.asarray(Image.open(path).convert('RGB')).astype(int)
    imask = np.abs(im - np.array([0xE4, 0xE2, 0xDD])).max(2) > 12
    print(f'== {path}')
    for k, m in regions(imask).items():
        s = stats(im, m)
        print(f'  {k:7s} ref  {fmt(R[k])}')
        print(f'  {"":7s} mine {fmt(s)}')
