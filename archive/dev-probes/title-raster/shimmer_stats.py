#!/usr/bin/env python3
"""Frame-to-frame instability on a fixed-pose shimmer sheet (from shimmer_set.sh).
   shimmer_stats.py sheet.png [cols=4 frames=12]
   Reports per consecutive pair: % of pixels changed (>40 levels), split into silhouette flips
   (title↔background) and interior changes; plus 'outside pops' (title pixels appearing where both
   neighbours-in-time were background) and the longest horizontal run of changed pixels in a row
   (row-slip width), all in render px (device px / 3)."""
import sys
import numpy as np
from PIL import Image
f = sys.argv[1]
cols, n = 4, 12
im = np.asarray(Image.open(f).convert('RGB')).astype(int)
fw, fh = im.shape[1] // cols, im.shape[0] // (n // cols)
fr = [im[(i // cols) * fh:(i // cols + 1) * fh, (i % cols) * fw:(i % cols + 1) * fw] for i in range(n)]
fr = [a[20:, :] for a in fr]  # skip the frame-number label
def bgmask(a):
    paper = np.abs(a - np.array([0xE4, 0xE2, 0xDD])).max(2) < 14
    sky = (a[..., 2] - a[..., 0]) > 35
    return paper | sky
tot = []
for i in range(n - 1):
    a, b = fr[i], fr[i + 1]
    ch = np.abs(a - b).max(2) > 40
    if ch.mean() == 0:
        continue
    ba, bb = bgmask(a), bgmask(b)
    sil = ba != bb
    run = 0
    for row in ch:
        r = c = 0
        for v in row:
            c = c + 1 if v else 0
            r = max(r, c)
        run = max(run, r)
    tot.append((ch.mean() * 100, sil.mean() * 100, (ch & ~sil).mean() * 100, run / 3))
t = np.array(tot) if tot else np.zeros((1, 4))
print(f'{f}: pairs changed {len(tot)}/{n-1}  changed% {t[:,0].mean():.2f}  silhouette% {t[:,1].mean():.2f}  interior% {t[:,2].mean():.2f}  max run(render px) {t[:,3].max():.0f}  median run {np.median(t[:,3]):.0f}')
