#!/usr/bin/env python3
"""Luminance percentiles per word region: reference vs a 1440x900@1x ?layers=title&mesh.render.fringe=0 render."""
import sys
import numpy as np
from PIL import Image
ref = np.asarray(Image.open('reference/title-main.jpg').convert('RGB')).astype(int)
bg = ref.min(2) > 238
lum = ref.mean(2)
im = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
ibg = np.abs(im - np.array([0xe4, 0xe2, 0xdd])).max(2) < 10
ilum = im.mean(2)
# split both titles into thirds of their bbox (≈ S / LAVA / VOLKOV)
def split(mask):
    xs = np.where(mask.any(0))[0]
    x0, x1 = xs.min(), xs.max()
    w = x1 - x0
    return [(x0, x0 + 0.22 * w), (x0 + 0.22 * w, x0 + 0.6 * w), (x0 + 0.6 * w, x1 + 1)]
P = [10, 25, 50, 75, 90]
for name, (a, b), (c, d) in zip(['S', 'LAVA', 'VOLKOV'], split(~bg), split(~ibg)):
    m = ~bg.copy(); m[:, :int(a)] = False; m[:, int(b):] = False
    n = ~ibg.copy(); n[:, :int(c)] = False; n[:, int(d):] = False
    print(f'{name:7s} ref {np.percentile(lum[m], P).astype(int)}  mine {np.percentile(ilum[n], P).astype(int)}')
