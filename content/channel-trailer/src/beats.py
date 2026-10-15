import sys, wave, numpy as np
from scipy.signal import stft
w = wave.open(sys.argv[1]); sr = w.getframerate()
y = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(float)/32768
hop=128; f, tt, Z = stft(y, sr, nperseg=1024, noverlap=1024-hop)
low = np.abs(Z[f < 150]).mean(0); full = np.abs(Z).mean(0)
P, ph = 0.7546, 0.234
# уточнить период/фазу по низкочастотным пикам в зоне 12–84 с
def score(P, ph):
    bt = np.arange(ph, 157, P); bt = bt[(bt>12)&(bt<84)]
    return low[np.clip((bt*sr/hop).astype(int),0,len(low)-1)].sum()
best = max(((score(p, q), p, q) for p in np.linspace(0.750, 0.760, 41) for q in np.linspace(0, 0.76, 153)))
_, P, ph = best; print(f"refined period {P:.4f} ({60/P:.2f} BPM), phase {ph:.3f}")
for lo, hi in [(8, 14), (52, 62), (82, 88)]:
    print(f"--- {lo}-{hi}s")
    for k in range(int((lo-ph)/P), int((hi-ph)/P)+1):
        b = ph + k*P; i = int(b*sr/hop); seg = slice(max(i-3,0), i+20)
        print(f"beat {k:3d} t={b:7.3f} low={low[seg].max():.4f} full={full[seg].max():.4f}")
