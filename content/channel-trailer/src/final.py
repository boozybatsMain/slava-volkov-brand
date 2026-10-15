import subprocess, sys
S, out = sys.argv[1], sys.argv[2]
# (png, start, end, fade_in, fade_out)
OV = [("h1",.08,1.5,.08,.08),("h2",1.58,3.0,.08,.08),("h3",3.08,4.5,.08,.08),
      ("l1",4.7,7.3,.2,.2),("l2",7.7,10.3,.2,.2),("l3",10.7,13.3,.2,.2),
      ("l4",13.7,16.3,.2,.2),("l5",16.7,19.3,.2,.2),
      ("e1",31.5,37.5,.04,.01),("e2",32.25,37.5,.2,.01),("e3",33.0,37.5,.2,.01)]
cmd = ["ffmpeg","-v","error","-y","-i",f"{S}/base.mkv","-i",f"{S}/music.wav"]
fc, prev = [], "0:v"
for k,(n,a,b,fi,fo) in enumerate(OV, start=2):
    d = b - a
    cmd += ["-framerate","60","-loop","1","-t",f"{d}","-i",f"{S}/txt/{n}.png"]
    fc.append(f"[{k}:v]format=rgba,fade=t=in:st=0:d={fi}:alpha=1,fade=t=out:st={d-fo}:d={fo}:alpha=1,setpts=PTS-STARTPTS+{a}/TB[o{k}]")
    fc.append(f"[{prev}][o{k}]overlay=0:0:eof_action=pass[v{k}]"); prev = f"v{k}"
fc.append(f"[{prev}]fade=t=out:st=36.6:d=0.9,format=yuv420p[vout]")
fc.append("[0:a]volume=0.3[ga];[1:a][ga]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]")
cmd += ["-filter_complex", ";".join(fc), "-map","[vout]","-map","[aout]","-t","37.5",
        "-c:v","libx264","-preset","slow","-crf","18","-profile:v","high","-r","60","-c:a","aac","-b:a","192k","-movflags","+faststart", out]
r = subprocess.run(cmd, capture_output=True, text=True); print(r.returncode, r.stderr[-1500:])
