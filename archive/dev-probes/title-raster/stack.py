#!/usr/bin/env python3
"""Stack several screenshots vertically (or horizontally with --h) with labels: stack.py out.png a.png b.png ..."""
import sys
from PIL import Image, ImageDraw
args = sys.argv[1:]
horiz = '--h' in args
args = [a for a in args if a != '--h']
out, files = args[0], args[1:]
ims = [Image.open(f).convert('RGB') for f in files]
if horiz:
    W = sum(i.width for i in ims); H = max(i.height for i in ims)
else:
    W = max(i.width for i in ims); H = sum(i.height for i in ims)
o = Image.new('RGB', (W, H), (17, 17, 17))
d = ImageDraw.Draw(o)
x = y = 0
for f, im in zip(files, ims):
    o.paste(im, (x, y))
    d.text((x + 6, y + 4), f.split('/')[-1], fill=(255, 0, 255))
    if horiz: x += im.width
    else: y += im.height
o.save(out)
print('saved', out)
