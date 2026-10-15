#!/usr/bin/env python3
"""Compare mean colours of matching regions: reference/title-main.jpg vs a ?layers=title render.
   python3 scripts/title-mesh/sample.py <render.png>   (regions mapped through the title bounding boxes)"""
import sys
import numpy as np
from PIL import Image

ref = np.asarray(Image.open('reference/title-main.jpg').convert('RGB')).astype(int)
im = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
bg = np.array([0xe4, 0xe2, 0xdd])
d = np.abs(im - bg).max(2)
ys, xs = np.where(d > 14)
mb = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
rd = (254 - ref).max(2)
ys, xs = np.where(rd > 18)
rb = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)

def mp(x, y):
    return (int(mb[0] + (x - rb[0]) * (mb[2] - mb[0]) / (rb[2] - rb[0])),
            int(mb[1] + (y - rb[1]) * (mb[3] - mb[1]) / (rb[3] - rb[1])))

R = [('S top bar', 160, 65, 290, 95), ('S middle bar', 150, 150, 260, 175), ('S bottom bar', 140, 225, 270, 255),
     ('S left side', 95, 100, 125, 200), ('S bottom side', 110, 262, 250, 280), ('L stem face', 345, 100, 380, 230),
     ('L left side', 300, 100, 330, 230), ('A1 left leg face', 455, 170, 490, 260), ('V2 face', 830, 200, 860, 280),
     ('V2 side', 790, 190, 820, 300), ('K face', 1080, 250, 1100, 320), ('last V face', 1160, 270, 1185, 330)]
tot = 0
for n, x0, y0, x1, y1 in R:
    a = np.median(ref[y0:y1, x0:x1].reshape(-1, 3), 0)
    p, q = mp(x0, y0), mp(x1, y1)
    b = np.median(im[p[1]:q[1], p[0]:q[0]].reshape(-1, 3), 0)
    tot += abs(a.mean() - b.mean())
    print(f'{n:18s} ref {a.astype(int)}  mine {b.astype(int)}  Δlum {int(b.mean() - a.mean()):+d}')
print('mean |Δlum|', round(tot / len(R), 1))
