import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
S = sys.argv[1]; W, H = 1920, 1080
HN = "/System/Library/Fonts/HelveticaNeue.ttc"
BLACK_C = lambda s: ImageFont.truetype(HN, s, index=9)   # Condensed Black
BOLD    = lambda s: ImageFont.truetype(HN, s, index=1)
MED     = lambda s: ImageFont.truetype(HN, s, index=10)
ORANGE = (255, 138, 31, 255)
def layer(items, name, bar=None):
    """items: [(text, font, (x|'c', y), color)]"""
    txt = Image.new("RGBA", (W, H)); sh = Image.new("RGBA", (W, H))
    dt, ds = ImageDraw.Draw(txt), ImageDraw.Draw(sh)
    for text, font, (x, y), col in items:
        bb = dt.textbbox((0, 0), text, font=font)
        if x == "c": x = (W - (bb[2]-bb[0]))//2 - bb[0]
        if bar == "auto": bar = (x-34, y+8, x-23, y+80)
        dt.text((x, y), text, font=font, fill=col)
        ds.text((x+3, y+5), text, font=font, fill=(0, 0, 0, 200))
    if bar:
        dt.rectangle(bar, fill=ORANGE); ds.rectangle((bar[0]+3, bar[1]+5, bar[2]+3, bar[3]+5), fill=(0,0,0,200))
    out = Image.alpha_composite(sh.filter(ImageFilter.GaussianBlur(10)), txt)
    out.save(f"{S}/txt/{name}.png")
W_ = (255, 255, 255, 255)
for name, s in [("h1", "I BUILD"), ("h2", "WHATEVER GAME"), ("h3", "POPS INTO MY HEAD.")]:
    layer([(s, BLACK_C(190), ("c", 420), W_)], name)
labels = ["Drift through a neon city", "Roll through fresh snow.", "Survive a sandstorm",
          "Burn a forest as a dragon", "A living savanna on one island"]
for i, s in enumerate(labels, 1):
    layer([(s, BOLD(72), ("c", 900), W_)], f"l{i}", bar="auto")
layer([("CAN'T STOP SHIPPING", BLACK_C(150), ("c", 330), W_), ("NEW ONES.", BLACK_C(150), ("c", 500), W_)], "ship")
layer([("SLAVA VOLKOV", BLACK_C(230), ("c", 330), W_)], "e1")
layer([("I just build games. Can't stop shipping new ones.", MED(58), ("c", 612), W_)], "e2")
layer([("Subscribe to see the next one", BOLD(48), ("c", 720), ORANGE)], "e3")
