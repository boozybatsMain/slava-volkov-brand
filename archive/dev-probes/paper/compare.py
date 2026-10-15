"""Side-by-side crops: mockup (scaled to the shot's CSS width) vs our screenshot.
usage: python3 scripts/paper/compare.py shot.png out.png [dpr]
Elements are matched by their own anchor (mockup px coords are in 1280x538 space,
ours come from the same relative position rules), so offsets in y are expected."""
import sys
from PIL import Image

shot = Image.open(sys.argv[1]).convert('RGB')
dpr = float(sys.argv[3]) if len(sys.argv) > 3 else 2
W = shot.width / dpr
H = shot.height / dpr
s = W / 1280
mock = Image.open('reference/hero-mockup.jpg').convert('RGB')
mock = mock.resize((round(1280 * s * 2), round(538 * s * 2)), Image.LANCZOS)  # 2 px per css px
ours = shot.resize((round(W * 2), round(H * 2)), Image.LANCZOS)

def mcrop(x0, y0, x1, y1):  # mockup coords (1280 space)
    return mock.crop(tuple(round(v * s * 2) for v in (x0, y0, x1, y1)))

def ocrop(x0, y0, x1, y1):  # css px in our shot
    return ours.crop(tuple(round(v * 2) for v in (x0, y0, x1, y1)))

# (mockup box, our box) — our boxes are the same x span; y from our layout rules.
pairs = [
    ((860, 25, 1240, 62), (W * 860 / 1280, H * 0.08 - 21, W * 1240 / 1280, H * 0.08 + 21)),
    ((70, 45, 245, 250), (W * 70 / 1280, H * 0.11 - 25, W * 245 / 1280, H * 0.11 + 210)),
    ((70, 435, 260, 500), (W * 70 / 1280, H * 0.892 - 52, W * 260 / 1280, H * 0.892 + 22)),
    ((900, 465, 1260, 500), (W * 900 / 1280, H * 0.892 - 20, W * 1260 / 1280, H * 0.892 + 20)),
]
rows = []
for m, o in pairs:
    a, b = mcrop(*m), ocrop(*o)
    rows.append((a, b))
Wout = max(a.width + b.width for a, b in rows) + 30
Hout = sum(max(a.height, b.height) for a, b in rows) + 10 * len(rows)
out = Image.new('RGB', (Wout, Hout), (255, 0, 0))
y = 0
for a, b in rows:
    out.paste(a, (0, y))
    out.paste(b, (a.width + 20, y))
    y += max(a.height, b.height) + 10
out.save(sys.argv[2])
print(out.size)
