#!/usr/bin/env python3
"""Silhouette geometry of ?layers=title stills (paper bg): bbox, span, S-left at its mid row.
   geom.py a.png b.png ...   (dpr-agnostic: reports CSS px, assumes width 1440 CSS)"""
import sys
import numpy as np
from PIL import Image
for f in sys.argv[1:]:
    im = np.asarray(Image.open(f).convert('RGB')).astype(int)
    s = im.shape[1] / 1440
    m = np.abs(im - np.array([0xE4, 0xE2, 0xDD])).max(2) > 12
    ys, xs = np.nonzero(m)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    # rightmost 8 % of the bbox = last V of VOLKOV: its vertical centre
    rv = m[:, int(x1 - 0.08 * (x1 - x0)):x1 + 1]
    vy = np.nonzero(rv.any(1))[0]
    print(f'{f.split("/")[-1]:24s} x {x0/s:7.1f}..{x1/s:7.1f} span {(x1-x0)/s:6.1f}  y {y0/s:6.1f}..{y1/s:6.1f}  lastV y {vy.mean()/s:6.1f}')
