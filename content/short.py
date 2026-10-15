"""Сборка вертикального шорта 1080x1920 по JSON-спеке.
layout: "fullbleed" — центральный кроп 9:16; "square" — квадрат по центру на размытом фоне.
segments: [[src_start, out_dur, speed]], тексты: [[text, start, end]] (верхняя плашка),
music: {file, offset, fade}, game_audio: громкость звука игры (0 = выкл)."""
import json, subprocess, sys, os, textwrap
from PIL import Image, ImageDraw, ImageFont
spec = json.load(open(sys.argv[1])); work = sys.argv[2]; os.makedirs(f"{work}/seg", exist_ok=True)
W, H, FPS = 1080, 1920, 60
src = os.path.expanduser(spec["source"]); crop = spec.get("crop")  # "w:h:x:y" — область исходника
def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: sys.exit(r.stderr[-1500:])
has_audio = bool(subprocess.run(["ffprobe","-v","error","-select_streams","a","-show_entries","stream=index","-of","csv=p=0",src],capture_output=True,text=True).stdout.strip())
# 1) куски
parts = []; cum = 0.0
for i, (ss, dur, sp) in enumerate(spec["segments"]):
    out = f"{work}/seg/{i:02d}.mkv"; frames = round((cum+dur)*FPS) - round(cum*FPS); cum += dur; dur = frames/FPS
    vf = (f"crop={crop}," if crop else "") + f"setpts=(PTS-STARTPTS)/{sp},fps={FPS},format=yuv420p"
    cmd = ["ffmpeg","-v","error","-y","-ss",str(ss),"-t",str(dur*sp+0.2),"-i",src]
    if has_audio and spec.get("game_audio", 0) > 0 and sp == 1:
        cmd += ["-filter_complex", f"[0:v]{vf}[v];[0:a]atrim=0:{dur},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=0.01,afade=t=out:st={dur-0.01}:d=0.01[a]", "-map","[v]","-map","[a]"]
    else:
        cmd += ["-f","lavfi","-t",str(dur),"-i","anullsrc=r=48000:cl=stereo","-filter_complex",f"[0:v]{vf}[v]","-map","[v]","-map","1:a"]
    cmd += ["-frames:v",str(frames),"-t",str(dur),"-c:v","libx264","-preset","fast","-crf","14","-c:a","pcm_s16le",out]
    run(cmd); parts.append(out)
with open(f"{work}/list.txt","w") as fh: fh.writelines(f"file '{p}'\n" for p in parts)
run(["ffmpeg","-v","error","-y","-f","concat","-safe","0","-i",f"{work}/list.txt","-c","copy",f"{work}/base.mkv"])
total = round(sum(d for _, d, _ in spec["segments"])*FPS)/FPS; tail = spec.get("tail", 0.6); T = total + tail
# 2) тексты
font = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", spec.get("font_size", 76), index=1)
pngs = []
for k, (txt, a, b) in enumerate(spec["texts"]):
    img = Image.new("RGBA", (W, 520)); d = ImageDraw.Draw(img); y = 10
    for ln in sum((textwrap.wrap(p, spec.get("wrap", 24)) for p in txt.split("\n")), []):
        bb = d.textbbox((0, 0), ln, font=font, stroke_width=7)
        d.text(((W-(bb[2]-bb[0]))//2-bb[0], y-bb[1]), ln, font=font, fill="white", stroke_width=7, stroke_fill="black")
        y += bb[3]-bb[1] + 18
    p = f"{work}/t{k}.png"; img.save(p); pngs.append((p, a, min(b, T)))
# 3) раскладка + тексты + звук
lay = spec.get("layout", "fullbleed")
if lay == "fullbleed":
    fc = [f"[0:v]scale={W}:{H}:flags=lanczos,tpad=stop_mode=clone:stop_duration={tail}[bg]"]
else:  # square: квадрат по центру, фон — тот же кадр, размытый и затемнённый
    sq, top = spec.get("square_size", 1080), spec.get("square_y", 400)
    fc = [f"[0:v]tpad=stop_mode=clone:stop_duration={tail},split[a][b]",
          f"[a]scale=-2:{H},crop={W}:{H},gblur=sigma=30,eq=brightness=-0.25[blur]",
          f"[b]scale={sq}:{sq}:flags=lanczos[sq]", f"[blur][sq]overlay=(W-w)/2:{top}[bg]"]
cmd = ["ffmpeg","-v","error","-y","-i",f"{work}/base.mkv"]
prev = "bg"
for k, (p, a, b) in enumerate(pngs):
    cmd += ["-framerate",str(FPS),"-loop","1","-t",str(T),"-i",p]; n = k+1; dd = b-a
    fc.append(f"[{n}:v]format=rgba,trim=0:{dd},fade=t=in:st=0:d=0.15:alpha=1,fade=t=out:st={max(dd-0.15,0)}:d=0.15:alpha=1,setpts=PTS-STARTPTS+{a}/TB[t{n}]")
    fc.append(f"[{prev}][t{n}]overlay=0:{spec.get('text_y', 250)}:eof_action=pass[o{n}]"); prev = f"o{n}"
fc.append(f"[{prev}]format=yuv420p[vout]")
mi = len(pngs)+1; m = spec.get("music"); ga = spec.get("game_audio", 0)
fc.append(f"[0:a]apad=pad_dur={tail},volume={ga}[ga]")
if m:
    cmd += ["-ss",str(m["offset"]),"-t",str(T),"-i",os.path.expanduser(m["file"])]
    fc.append(f"[{mi}:a]volume={m.get('volume',1.0)},afade=t=out:st={T-tail}:d={tail}[mus]")
    fc.append("[mus][ga]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]")
elif ga > 0 and has_audio:
    fc.append("[ga]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]")
else:
    fc.append("[ga]aresample=48000[aout]")
cmd += ["-filter_complex",";".join(fc),"-map","[vout]","-map","[aout]","-t",str(T),
        "-c:v","libx264","-preset","slow","-crf","18","-profile:v","high","-r",str(FPS),"-c:a","aac","-b:a","192k","-movflags","+faststart",spec["out"]]
run(cmd)
# 4) версия ≤10 МБ для загрузки через расширение
if not spec.get("small", True): print("ok", spec["out"], f"{T:.2f}s"); sys.exit(0)
vk = int((9_300_000*8/T - 128_000)/1000); small = spec["out"].replace("_master.mp4", "_10mb.mp4")
for ps in (1, 2):
    c = ["ffmpeg","-v","error","-y","-i",spec["out"],"-c:v","libx264","-preset","slower","-b:v",f"{vk}k","-pass",str(ps),"-passlogfile",f"{work}/p"]
    c += (["-an","-f","mp4","/dev/null"] if ps == 1 else ["-profile:v","high","-c:a","aac","-b:a","128k","-movflags","+faststart",small])
    run(c)
print("ok", spec["out"], f"{T:.2f}s", f"10mb@{vk}k")
