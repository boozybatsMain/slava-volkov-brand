# usage: grid.py out.jpg cols "label|file|t" ...
import sys, subprocess, io
from PIL import Image, ImageDraw, ImageFont
out, cols, items = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
W = 400; font = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 22, index=1)
tiles = []
for it in items:
    label, f, t = it.split("|")
    png = subprocess.run(["ffmpeg","-v","error","-ss",t,"-i",f,"-frames:v","1","-vf",f"scale={W}:-2","-f","image2pipe","-vcodec","png","-"],capture_output=True).stdout
    im = Image.open(io.BytesIO(png)).convert("RGB")
    im = im.crop((0,0,W,225)) if im.height>=225 else im.resize((W,225))
    d = ImageDraw.Draw(im); d.rectangle((0,0,W,30),fill=(0,0,0)); d.text((6,3),f"{label} @{t}",font=font,fill="yellow")
    tiles.append(im)
rows = (len(tiles)+cols-1)//cols
g = Image.new("RGB",(cols*(W+4),rows*229),"white")
for i,im in enumerate(tiles): g.paste(im,((i%cols)*(W+4),(i//cols)*229))
g.save(out, quality=85)
