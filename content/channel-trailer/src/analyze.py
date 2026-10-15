# Темп, фаза доли и карта энергии трека без librosa (numpy/scipy).
import sys, wave, numpy as np
from scipy.signal import stft
w = wave.open(sys.argv[1]); sr = w.getframerate()
y = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(float)/32768
print("duration", round(len(y)/sr, 2))
hop = 256
f, tt, Z = stft(y, sr, nperseg=1024, noverlap=1024-hop); M = np.log1p(100*np.abs(Z))
flux = np.maximum(0, np.diff(M, axis=1)).sum(0); flux = np.concatenate([[0], flux])
fps = sr/hop
env = flux - np.convolve(flux, np.ones(int(fps))/int(fps), "same"); env = np.maximum(env, 0)
# темп: автокорреляция огибающей в диапазоне 70–180 BPM
ac = np.correlate(env, env, "full")[len(env)-1:]
lags = np.arange(len(ac)); bpm = 60*fps/np.maximum(lags, 1)
rng = (bpm > 70) & (bpm < 180)
best = lags[rng][np.argmax(ac[rng])]; tempo = 60*fps/best
from scipy.signal import find_peaks
pk, _ = find_peaks(ac[:int(fps*2)]); pk = [k for k in pk if 60*fps/k > 60]
top = sorted(pk, key=lambda k: -ac[k])[:6]
print("tempo candidates:", [(round(60*fps/k,1), round(ac[k]/ac[0],3)) for k in top])
# уточнение темпа параболой
period = 60/tempo
# фаза: где гребёнка с этим периодом набирает максимум
phases = np.linspace(0, period, 200, endpoint=False)
score = [env[np.clip(((np.arange(0, len(y)/sr - period, period) + p)*fps).astype(int), 0, len(env)-1)].sum() for p in phases]
ph = phases[int(np.argmax(score))]
print(f"tempo {tempo:.2f} BPM, beat period {period:.4f}s, first beat at {ph:.3f}s")
# энергия по 2-с окнам: RMS, низ (<150 Гц), верх (>4 кГц)
low = np.abs(Z[f < 150]).mean(0); hi = np.abs(Z[f > 4000]).mean(0)
rms = np.sqrt((np.abs(Z)**2).mean(0))*40
for sec in range(0, int(tt[-1])+1, 2):
    m = (tt >= sec) & (tt < sec+2)
    print(f"{sec:4d}s rms={rms[m].mean():.3f} low={low[m].mean():.4f} hi={hi[m].mean():.5f} " + "#"*int(rms[m].mean()*150))
