"""Compare paper texture statistics of a screenshot region against the references.
usage: python3 scripts/paper/stats.py shot.png x0 y0 x1 y1 [scale]
scale = device px per CSS px of the shot (2 for @2x) -> stats are computed at a
comparable feature scale to the mobile ref (~2.57 px per CSS px)."""
import sys
from PIL import Image
import numpy as np
from scipy import ndimage as nd

def stats(name, arr, s=1.0):
    a = arr.astype(float)
    m = a.reshape(-1, 3).mean(0)
    L = a.mean(2)
    lo = nd.gaussian_filter(L, 40 * s)
    mid = nd.gaussian_filter(L, 6 * s) - lo
    hi = L - nd.gaussian_filter(L, 1.5 * s)
    print(f"{name:14s} mean #{int(m[0]):02x}{int(m[1]):02x}{int(m[2]):02x}  std {L.std():.2f}  low {lo.std():.2f}  mid {mid.std():.2f}  hi {hi.std():.2f}")

if __name__ == '__main__':
    p = np.array(Image.open('reference/paper-mobile.png').convert('RGB'))
    stats('ref mobile', p[1100:1480, 20:980], 1.0)
    im = np.array(Image.open(sys.argv[1]).convert('RGB'))
    x0, y0, x1, y1 = map(int, sys.argv[2:6])
    sc = float(sys.argv[6]) if len(sys.argv) > 6 else 2
    stats('shot', im[y0:y1, x0:x1], sc / 2.57)
