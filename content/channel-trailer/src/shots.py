import subprocess, os, sys
from concurrent.futures import ThreadPoolExecutor
D = os.path.expanduser("~/Desktop")
S = sys.argv[1]
SRC = {
 "apex":  (f"{D}/2026-10-05 16-30-40.mp4", "scale=1920:1080", True),
 "storm": (f"{D}/genex_sandstorm.mp4", "scale=1920:1080", True),
 "fire":  (f"{D}/fire-spread.mp4", "crop=1920:1080:103:0", True),
 "snow":  (f"{D}/Screen Recording 2026-10-09 at 00.22.07.mov", "crop=3600:2025:0:113,scale=1920:1080:flags=lanczos", False),
 "sav":   (f"{D}/7909700747234323367.MP4", "crop=1200:675:40:0,scale=1920:1080:flags=lanczos", False),
}
# (source, src_start, out_dur, speed)  speed<1 = slow-mo
SHOTS = [
 # заставка на тихом вступлении трека (3 × 2 доли)
 ("sav", 0.5, 1.5, 1), ("storm", 33.0, 1.5, 1), ("fire", 39.0, 1.5, 1),
 # дроп: по такту (3 с) на игру
 ("apex", 59.0, 3.0, 1), ("snow", 0.5, 3.0, 1), ("storm", 9.5, 3.0, 1), ("fire", 6.0, 3.0, 1), ("sav", 7.5, 3.0, 1),
 # быстрая нарезка: такт по долям, такт по половинкам
 ("storm", 45.0, .75, 1), ("apex", 80.0, .75, 1), ("fire", 21.0, .75, 1), ("sav", 55.0, .75, 1),
 ("storm", 56.5, 0.38333333333333336, 1), ("apex", 9.2, 0.36666666666666664, 1), ("fire", 41.0, 0.38333333333333336, 1), ("sav", 28.0, 0.36666666666666664, 1),
 ("storm", 62.0, 0.38333333333333336, 1), ("apex", 76.0, 0.36666666666666664, 1), ("fire", 50.5, 0.38333333333333336, 1), ("apex", 66.0, 0.36666666666666664, 1),
 # последний удар перед провалом, снежок в провале, имя на втором дропе
 ("apex", 34.0, 1.5, 1), ("snow", 4.0, 4.5, 1), ("sav", 78.0, 6.0, 1.5),
]
def run(i_shot):
    i, (src, ss, dur, sp) = i_shot
    f, vf, has_a = SRC[src]
    src_dur = dur * sp
    vfx = f"{vf},setpts=(PTS-STARTPTS)/{sp},fps=60,format=yuv420p"
    if src == "sav" and sp > 1:  # end card: darken over first second
        vfx += ",eq=brightness='-0.22*min(1\\,t/0.25)':eval=frame"
    out = f"{S}/shots/{i:02d}.mkv"
    cmd = ["ffmpeg","-v","error","-y","-ss",str(ss),"-t",str(src_dur+0.1),"-i",f]
    if has_a:
        af = f"atrim=0:{dur},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=0.01,afade=t=out:st={dur-0.01}:d=0.01"
        cmd += ["-filter_complex", f"[0:v]{vfx}[v];[0:a]{af}[a]", "-map","[v]","-map","[a]"]
    else:
        cmd += ["-f","lavfi","-t",str(dur),"-i","anullsrc=r=48000:cl=stereo",
                "-filter_complex", f"[0:v]{vfx}[v]", "-map","[v]","-map","1:a"]
    cmd += ["-frames:v", str(round(dur*60)), "-t", str(dur), "-c:v","libx264","-preset","fast","-crf","14","-c:a","pcm_s16le", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return i, r.returncode, r.stderr[-400:]
with ThreadPoolExecutor(4) as ex:
    for i, rc, err in ex.map(run, enumerate(SHOTS)):
        print(i, "ok" if rc == 0 else f"FAIL {err}")
with open(f"{S}/shots/list.txt","w") as fh:
    for i in range(len(SHOTS)): fh.write(f"file '{S}/shots/{i:02d}.mkv'\n")
