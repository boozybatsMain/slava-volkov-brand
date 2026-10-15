#!/usr/bin/env python3
"""A/B grid: rows = poses, cols = sets. ab.py out.png "x0,y0,x1,y1" scale  colA:fileA1;fileA2.. colB:fileB1,..."""
import sys
from PIL import Image, ImageDraw
out, box, sc = sys.argv[1], tuple(int(v) for v in sys.argv[2].split(',')), float(sys.argv[3])
cols = [a.split(':', 1) for a in sys.argv[4:]]
cols = [(n, f.split(';')) for n, f in cols]
cw, ch = int((box[2] - box[0]) * sc), int((box[3] - box[1]) * sc)
rows = len(cols[0][1])
o = Image.new('RGB', (cw * len(cols), ch * rows + 16), (17, 17, 17))
d = ImageDraw.Draw(o)
for ci, (name, files) in enumerate(cols):
    d.text((ci * cw + 4, 2), name, fill=(255, 0, 255))
    for ri, f in enumerate(files):
        im = Image.open(f).convert('RGB').crop(box).resize((cw, ch), Image.NEAREST)
        o.paste(im, (ci * cw, 16 + ri * ch))
        d.text((ci * cw + 4, 18 + ri * ch), f.split('/')[-1], fill=(255, 0, 255))
o.save(out)
print('saved', out)
