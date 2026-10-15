#!/usr/bin/env python3
"""
Side-by-side check: our render (screenshot crop) vs reference/title-main.jpg at the same scale.

    python3 scripts/title-raster/compare.py <render.png> <out.png> [--zoom 2]

<render.png> must be a screenshot whose clip starts so that the title bbox is inside it.
The reference is scaled so its title span matches the span found in the render and
pasted below it (on its own white background — the client's original).
"""
import sys
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith('--')]
zoom = 1
if '--zoom' in sys.argv:
    zoom = int(sys.argv[sys.argv.index('--zoom') + 1])
    args = [a for a in args if a != str(zoom)]
render_p, out_p = args[0], args[1]
ren = Image.open(render_p).convert('RGB')
r = np.asarray(ren).astype(int)
paper = np.median(r.reshape(-1, 3), axis=0)
diff = np.abs(r - paper).sum(2) > 40
ys, xs = np.nonzero(diff)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
ref = Image.open('reference/title-main.jpg').convert('RGB')
a = np.asarray(ref).astype(int)
m = a.min(2) < 235
rys, rxs = np.nonzero(m)
rx0, rx1, ry0, ry1 = rxs.min(), rxs.max(), rys.min(), rys.max()
s = (x1 - x0) / (rx1 - rx0)
refc = ref.crop((rx0 - 10, ry0 - 10, rx1 + 10, ry1 + 10))
refc = refc.resize((round(refc.width * s), round(refc.height * s)), Image.LANCZOS)
renc = ren.crop((x0 - 10, y0 - 10, x1 + 10, y1 + 10))
W = max(refc.width, renc.width)
o = Image.new('RGB', (W, renc.height + refc.height + 6), (255, 0, 255))
o.paste(renc, (0, 0))
o.paste(refc, (0, renc.height + 6))
if zoom > 1:
    o = o.resize((o.width * zoom, o.height * zoom), Image.NEAREST)
o.save(out_p)
print('render span', x1 - x0, 'scale', round(s, 3), 'saved', out_p)
