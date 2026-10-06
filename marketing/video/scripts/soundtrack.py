"""Synthesize the launch video's soundtrack: 120 BPM, cut to the video's timeline.

Everything is generated here (no samples), so the track is free to use anywhere.
Run: python3 scripts/soundtrack.py  ->  public/soundtrack.wav
"""
import os
import wave

import numpy as np

SR = 48000
BPM = 120
BEAT = 60 / BPM  # 0.5 s, 30 frames at 60 fps
LENGTH = 51.0
rng = np.random.default_rng(7)

# Video timeline in seconds (frames / 60), see src/Video.tsx.
CHAOS = (0.0, 10.0)
BREAK = (10.0, 12.0)
IMPACT_LOGO = 13.333
GROOVE = (15.0, 43.0)
HITS = [16.5, 32.0, 33.5]  # F2 slam, F3 slam, merge shockwave
OUTRO = (43.0, LENGTH)

t_all = np.arange(int(LENGTH * SR)) / SR
mix = np.zeros_like(t_all)


def place(sig, at, gain=1.0):
    i = int(at * SR)
    if i >= len(mix):
        return
    n = min(len(sig), len(mix) - i)
    mix[i : i + n] += sig[:n] * gain


def env(n, attack=0.002, decay=0.2):
    t = np.arange(n) / SR
    a = np.clip(t / attack, 0, 1)
    return a * np.exp(-t / decay)


def _lp(x, fc):
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(np.fft.rfft(x) / (1 + 1j * f / fc), len(x))


def lowpass(x, cutoff):
    """First-order low-pass via FFT. A per-sample cutoff is applied in short blocks."""
    if np.isscalar(cutoff):
        return _lp(x, float(cutoff))
    c = np.asarray(cutoff, dtype=float)
    y = np.zeros_like(x)
    block, hop = 4096, 2048
    win = np.hanning(block)
    padded = np.concatenate([x, np.zeros(block)])
    for i in range(0, len(x), hop):
        seg = padded[i : i + block] * win
        y_seg = _lp(seg, float(c[min(i + hop // 2, len(c) - 1)]))
        n = min(block, len(y) - i)
        y[i : i + n] += y_seg[:n]
    return y


def kick(gain=1.0):
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t / 0.045)
    phase = 2 * np.pi * np.cumsum(f) / SR
    click = rng.normal(0, 1, n) * np.exp(-t / 0.004) * 0.3
    return (np.sin(phase) * env(n, 0.001, 0.22) + click) * gain


def clap():
    n = int(0.3 * SR)
    noise = rng.normal(0, 1, n)
    e = np.zeros(n)
    for d in (0.0, 0.011, 0.022):
        i = int(d * SR)
        e[i:] += env(n - i, 0.001, 0.06)
    return lowpass(noise * e, 3500) * 0.5


def hat(open_=False):
    n = int((0.25 if open_ else 0.06) * SR)
    noise = rng.normal(0, 1, n)
    hp = noise - lowpass(noise, 7000)
    return hp * env(n, 0.001, 0.09 if open_ else 0.018) * 0.35


def saw(freq, dur, detune=0.0):
    t = np.arange(int(dur * SR)) / SR
    out = np.zeros_like(t)
    for d in (-detune, 0.0, detune):
        f = freq * (1 + d)
        out += 2 * ((t * f) % 1.0) - 1
    return out / 3


def note(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def impact(gain=1.0):
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    boom = np.sin(2 * np.pi * (38 + 60 * np.exp(-t / 0.08)) * t) * np.exp(-t / 0.7)
    noise = lowpass(rng.normal(0, 1, n), 2500) * np.exp(-t / 0.35) * 0.6
    return (boom + noise) * gain


def riser(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    cutoff = 300 + 9000 * (t / dur) ** 2
    sweep = lowpass(noise, cutoff) * (t / dur) ** 1.5
    tone = np.sin(2 * np.pi * np.cumsum(200 + 900 * (t / dur) ** 2) / SR) * (t / dur) * 0.25
    return sweep + tone


def whoosh(dur=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    shape = np.sin(np.pi * t / dur) ** 2
    return lowpass(noise, 800 + 5000 * shape) * shape * 0.4


# --- chaos: a ticking, tense build --------------------------------------------
for b in np.arange(CHAOS[0] + 2.0, CHAOS[1], BEAT):
    place(kick(0.8), b)
    place(hat(), b + BEAT / 2)
for b in np.arange(CHAOS[0] + 4.0, CHAOS[1], BEAT / 2):
    place(hat(), b, 0.6)
drone_t = np.arange(int((CHAOS[1] - CHAOS[0]) * SR)) / SR
drone = saw(note(33), CHAOS[1] - CHAOS[0], 0.01) + 0.5 * saw(note(40), CHAOS[1] - CHAOS[0], 0.012)
drone *= np.clip(drone_t / 8, 0, 1) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * drone_t))
place(lowpass(drone, 200 + 900 * drone_t / drone_t[-1]) * 0.35, CHAOS[0])
for s in (2.0, 4.0, 6.0, 8.0):  # word slams
    place(impact(0.35), s)

# --- break + vortex: silence, then a riser into the logo impact -----------------
place(riser(IMPACT_LOGO - BREAK[0]) * 0.55, BREAK[0])
place(impact(1.0), IMPACT_LOGO)
pad_t = np.arange(int(1.8 * SR)) / SR
pad = sum(saw(note(m), 1.8, 0.004) for m in (57, 60, 64, 69)) / 4
place(lowpass(pad, 1500) * np.exp(-pad_t / 1.0) * 0.4, IMPACT_LOGO)

# --- groove: Am F C G, four on the floor -----------------------------------------
chords = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
bass_roots = [33, 29, 36, 31]
bar = 4 * BEAT
for i, start in enumerate(np.arange(GROOVE[0], GROOVE[1], bar)):
    c = chords[i % 4]
    root = bass_roots[i % 4]
    p = sum(saw(note(m), bar, 0.005) for m in c) / 3
    pt = np.arange(len(p)) / SR
    place(lowpass(p, 900 + 500 * np.sin(np.pi * pt / bar)) * 0.16, start)
    for k in range(8):  # eighth-note bass
        n = int(BEAT / 2 * SR)
        bt = np.arange(n) / SR
        bs = saw(note(root + (12 if k % 4 == 3 else 0)), BEAT / 2, 0.003)
        place(lowpass(bs, 600) * np.exp(-bt / 0.18) * 0.35, start + k * BEAT / 2)
    for k in range(4):
        place(kick(1.0), start + k * BEAT)
        place(hat(open_=True), start + k * BEAT + BEAT / 2, 0.5)
        if k in (1, 3):
            place(clap(), start + k * BEAT)
    for k in range(8):
        place(hat(), start + k * BEAT / 2, 0.5)
for h in HITS:
    place(impact(0.8), h)
    place(whoosh(0.4), h - 0.4)
for s in np.arange(37.0, 43.0, BEAT):  # montage cuts
    place(whoosh(0.25), s - 0.12, 0.6)

# --- outro: pad and a last soft kick, then fade -----------------------------------
ot = np.arange(int((OUTRO[1] - OUTRO[0]) * SR)) / SR
op = sum(saw(note(m), OUTRO[1] - OUTRO[0], 0.004) for m in (45, 57, 60, 64, 71)) / 5
place(lowpass(op, 1200) * np.clip(ot / 0.3, 0, 1) * np.exp(-ot / 5.0) * 0.35, OUTRO[0])
place(impact(0.6), OUTRO[0])

# --- master: soft clip, fade out, normalize ---------------------------------------
fade = np.clip((LENGTH - t_all) / 2.5, 0, 1)
mix = np.tanh(mix * 0.9) * fade
mix /= np.max(np.abs(mix)) + 1e-9
mix *= 0.89
stereo = np.stack([mix, np.roll(mix, int(0.0004 * SR))], axis=1)

out = os.path.join(os.path.dirname(__file__), '..', 'public', 'soundtrack.wav')
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype('<i2').tobytes())
print('wrote', os.path.normpath(out), f'{LENGTH:.0f}s')
