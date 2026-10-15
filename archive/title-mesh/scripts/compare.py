#!/usr/bin/env python3
"""
Side-by-side (stacked) comparison of a mesh-title render with reference/title-main.jpg.

  python3 scripts/title-mesh/compare.py <render.png> <out.png> [--width 1100] [--bg e4e2dd]

The render should be a ?layers=title screenshot (title over the plain body colour).
Both titles are cropped to their bounding boxes and scaled to the same width.
"""
import sys
import numpy as np
from PIL import Image

args = sys.argv[1:]
src, out = args[0], args[1]
width = int(args[args.index('--width') + 1]) if '--width' in args else 1100
bg = args[args.index('--bg') + 1] if '--bg' in args else 'e4e2dd'
bgc = np.array([int(bg[i:i + 2], 16) for i in (0, 2, 4)])


def bbox(im, bgcol, thr):
    a = np.asarray(im.convert('RGB')).astype(int)
    d = np.abs(a - bgcol).max(axis=2)
    ys, xs = np.where(d > thr)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


ref = Image.open('reference/title-main.jpg').convert('RGB')
rb = bbox(ref, np.array([254, 254, 254]), 18)
mine = Image.open(src).convert('RGB')
mb = bbox(mine, bgc, 14)

pad = 12
def crop_scale(im, b):
    c = im.crop((b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad))
    h = round(c.height * width / c.width)
    return c.resize((width, h), Image.LANCZOS)

r = crop_scale(ref, rb)
m = crop_scale(mine, mb)
sheet = Image.new('RGB', (width, r.height + m.height + 6), (40, 40, 40))
sheet.paste(r, (0, 0))
sheet.paste(m, (0, r.height + 6))
sheet.save(out)
print('ref bbox', rb, 'mine bbox', mb, '->', out)
