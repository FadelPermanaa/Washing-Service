"""Music and sound effects for the 30-second promo, synthesised from scratch
(Python standard library only). Cue times match stage.html.

    python3 audio.py            -> audio.wav (44.1 kHz, 16-bit stereo)
"""
import math
import random
import struct
import wave
from array import array

SR = 44100
DUR = 30.0
N = int(SR * DUR)
L = array('d', bytes(8 * N))
R = array('d', bytes(8 * N))
rng = random.Random(7)
TAU = 2 * math.pi


def put(t0, samples, gain=1.0, pan=0.0, delay_r=0):
    """Mix a list of mono samples in at time t0 (seconds). pan -1..1."""
    i0 = int(t0 * SR)
    gl = gain * math.sqrt((1 - pan) / 2) * math.sqrt(2)
    gr = gain * math.sqrt((1 + pan) / 2) * math.sqrt(2)
    for k, v in enumerate(samples):
        i = i0 + k
        if 0 <= i < N:
            L[i] += v * gl
        j = i + delay_r
        if 0 <= j < N:
            R[j] += v * gr


def env_adsr(n, a, d, s, r, sustain_len):
    """Attack/decay/sustain/release envelope, all times in seconds."""
    out = []
    A, D, S, Rl = int(a * SR), int(d * SR), int(sustain_len * SR), int(r * SR)
    for k in range(n):
        if k < A:
            e = k / max(A, 1)
        elif k < A + D:
            e = 1 - (1 - s) * (k - A) / max(D, 1)
        elif k < A + D + S:
            e = s
        else:
            e = s * max(0.0, 1 - (k - A - D - S) / max(Rl, 1))
        out.append(e)
    return out


def tone(freq, length, harmonics=((1, 1.0),), a=0.01, d=0.1, s=0.7, r=0.3, detune=0.0, vib=0.0):
    n = int((length + r) * SR)
    e = env_adsr(n, a, d, s, r, max(0.0, length - a - d))
    out = []
    ph = [0.0] * len(harmonics)
    for k in range(n):
        f = freq * (1 + detune) * (1 + vib * math.sin(TAU * 5 * k / SR))
        v = 0.0
        for h, (mul, amp) in enumerate(harmonics):
            ph[h] += TAU * f * mul / SR
            v += amp * math.sin(ph[h])
        out.append(v * e[k])
    return out


def pluck(freq, length=0.6, bright=0.5):
    n = int(length * SR)
    out = []
    for k in range(n):
        t = k / SR
        e = math.exp(-t * 7)
        v = math.sin(TAU * freq * t) + bright * math.exp(-t * 18) * math.sin(TAU * freq * 2 * t) + 0.25 * bright * math.exp(-t * 30) * math.sin(TAU * freq * 3 * t)
        out.append(v * e * min(1.0, k / 60))
    return out


def noise(length, lp_from=8000, lp_to=8000, hp=0.0, decay=None, rise=False):
    """Filtered noise burst: one-pole low-pass sweeping lp_from -> lp_to, optional high-pass."""
    n = int(length * SR)
    out = []
    y = 0.0
    lo = 0.0
    for k in range(n):
        x = rng.uniform(-1, 1)
        frac = k / max(n - 1, 1)
        fc = lp_from * (lp_to / lp_from) ** frac
        a = 1 - math.exp(-TAU * fc / SR)
        y += a * (x - y)
        v = y
        if hp:
            ah = 1 - math.exp(-TAU * hp / SR)
            lo += ah * (v - lo)
            v = v - lo
        if decay:
            v *= math.exp(-k / SR * decay)
        if rise:
            v *= frac ** 2
        out.append(v)
    return out


def fade_edges(s, fi=0.01, fo=0.05):
    n = len(s)
    a, b = int(fi * SR), int(fo * SR)
    for k in range(min(a, n)):
        s[k] *= k / a
    for k in range(min(b, n)):
        s[n - 1 - k] *= k / b
    return s


def whoosh(length=0.7, up=True):
    s = noise(length, 400 if up else 5000, 5000 if up else 400, hp=150)
    n = len(s)
    for k in range(n):
        x = k / n
        s[k] *= math.sin(math.pi * x) ** 1.5
    return s


def kick():
    n = int(0.28 * SR)
    out, ph = [], 0.0
    for k in range(n):
        t = k / SR
        f = 48 + 90 * math.exp(-t * 28)
        ph += TAU * f / SR
        out.append(math.sin(ph) * math.exp(-t * 11) + 0.08 * math.exp(-t * 300) * rng.uniform(-1, 1))
    return out


def hat():
    return noise(0.06, 9000, 9000, hp=6000, decay=60)


def clap():
    s = noise(0.18, 2500, 1500, hp=700, decay=22)
    for k in range(min(len(s), int(0.02 * SR))):  # little double-hit
        if int(0.008 * SR) < k < int(0.011 * SR):
            s[k] *= 0.2
    return s


def ding(freq, length=1.2):
    n = int(length * SR)
    out = []
    for k in range(n):
        t = k / SR
        out.append((math.sin(TAU * freq * t) + 0.45 * math.sin(TAU * freq * 2.76 * t) * math.exp(-t * 6) + 0.2 * math.sin(TAU * freq * 5.4 * t) * math.exp(-t * 12)) * math.exp(-t * 4.5) * min(1.0, k / 40))
    return out


def blip(f0, f1, length=0.09):
    n = int(length * SR)
    out, ph = [], 0.0
    for k in range(n):
        x = k / n
        f = f0 + (f1 - f0) * x
        ph += TAU * f / SR
        out.append(math.sin(ph) * math.sin(math.pi * x) ** 0.6)
    return out


def bubble_pop():
    n = int(0.22 * SR)
    out, ph = [], 0.0
    for k in range(n):
        t = k / SR
        f = 300 + 1500 * math.exp(-t * 35)
        ph += TAU * f / SR
        out.append(math.sin(ph) * math.exp(-t * 22) + 0.35 * rng.uniform(-1, 1) * math.exp(-t * 90))
    return out


# ---------------------------------------------------------------------------
# 0 – 4.6 s: tension. Low drone, a clock that ticks faster and faster, riser.
for f, g in ((55.0, 0.13), (82.41, 0.08), (110.0 * 1.003, 0.05)):
    put(0.0, fade_edges(tone(f, 4.4, ((1, 1), (2, .35), (3, .12)), a=0.6, d=0.2, s=1.0, r=0.4, vib=0.002), 0.3, 0.3), g, 0.0, 300)
t, gap = 0.15, 0.5
while t < 4.4:
    put(t, blip(2600, 2400, 0.012), 0.16, -0.3 if int(t * 10) % 2 else 0.3)
    t += gap
    gap = max(0.12, gap * 0.9)
for bt in (0.4, 1.6, 2.8, 3.6, 4.0):  # heartbeat-ish thumps
    put(bt, kick(), 0.32)
put(3.3, noise(1.3, 300, 7000, hp=120, rise=True), 0.22, 0.0, 500)

# 4.6 s: bubble pop + sparkle splash
put(4.58, bubble_pop(), 0.5)
for i, f in enumerate((1568, 2093, 2637, 3136)):
    put(4.66 + i * 0.045, ding(f, 0.6), 0.05, (-0.5, 0.5, -0.2, 0.3)[i])

# ---------------------------------------------------------------------------
# 4.6 – 30 s: bright, friendly loop at 110 BPM — C G Am F.
BPM = 110
BEAT = 60 / BPM
BAR = 4 * BEAT
START = 4.6
CHORDS = {
    'C': ((261.63, 329.63, 392.00), 65.41),
    'G': ((246.94, 293.66, 392.00), 98.00),
    'Am': ((261.63, 329.63, 440.00), 110.00),
    'F': ((261.63, 349.23, 440.00), 87.31),
}
PROG = ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'F', 'C']
PAD_H = ((1, 1.0), (2, 0.28), (3, 0.12), (4, 0.05))
ARP = [0, 1, 2, 1, 2, 1, 0, 1]
for b, name in enumerate(PROG):
    t0 = START + b * BAR
    if t0 >= DUR:
        break
    notes, bass = CHORDS[name]
    last = b == len(PROG) - 1
    length = min(BAR + (1.6 if last else 0.0), DUR - t0)
    for i, f in enumerate(notes):
        put(t0, tone(f, length, PAD_H, a=0.25, d=0.4, s=0.75, r=0.6 if not last else 0.2, detune=(-0.002, 0.0, 0.002)[i]), 0.055, (-0.4, 0.0, 0.4)[i], 400)
    # bass: root on 1 and the "and" of 2, octave pop on 3
    for off, mul, ln in ((0, 1, 0.45), (1.5, 1, 0.25), (2, 2, 0.35), (3, 1, 0.4)):
        if last and off > 0:
            break
        put(t0 + off * BEAT, tone(bass * mul, ln if not last else 1.4, ((1, 1), (2, .3)), a=0.005, d=0.12, s=0.6, r=0.12), 0.2)
    # pluck arpeggio in eighths (sparser in the first bar)
    if not last:
        for k, idx in enumerate(ARP):
            if b == 0 and k % 2:
                continue
            put(t0 + k * BEAT / 2, pluck(notes[idx] * 2, 0.5), 0.085, (-0.35, 0.35)[k % 2])
    # drums
    for beat in range(4):
        tb = t0 + beat * BEAT
        if last and beat > 0:
            break
        put(tb, kick(), 0.42)
        if b >= 1 and not last:
            put(tb + BEAT / 2, hat(), 0.09, 0.25)
            if beat in (1, 3):
                put(tb, clap(), 0.1, -0.1, 200)
    if b in (4, 8):  # little lift into the next section
        put(t0 + 3 * BEAT, noise(BEAT, 800, 9000, hp=400, rise=True), 0.09)

# ---------------------------------------------------------------------------
# Sound effects on the visual cues
for t in (8.55, 13.3, 18.9, 24.15):
    put(t, whoosh(0.7), 0.2, 0.0, 600)
put(22.05, whoosh(0.6), 0.11, 0.4, 400)          # report laptop slides in
put(10.5, ding(1318.5, 1.0), 0.16, 0.3)           # coin: ka-
put(10.58, ding(1975.5, 1.2), 0.14, 0.3)          #       -ching
put(9.9, blip(700, 900, 0.07), 0.12)              # ring around "Dicuci"
put(11.9, blip(500, 900, 0.08), 0.14, -0.2)       # loyalty chip
put(15.0, blip(1800, 1200, 0.03), 0.22)           # tap on 10:30
put(15.6, blip(880, 880, 0.08), 0.18, 0.2)        # WhatsApp: two-tone
put(15.7, blip(1320, 1320, 0.11), 0.18, 0.2)
for t in (16.7, 17.7):                            # tracking page updates
    put(t, blip(1046, 1568, 0.06), 0.09, 0.4)
for i, t in enumerate((20.5, 21.05, 21.6)):       # checklist ticks
    put(t, blip(1800, 1200, 0.03), 0.18)
    put(t + 0.09, pluck(1046.5 * (1.0, 1.26, 1.5)[i], 0.35), 0.16, -0.2)
put(22.85, ding(1568, 0.9), 0.1, 0.3)             # ring around profit
put(24.8, whoosh(1.2, up=False), 0.17, -0.2, 300) # car drives in
put(24.8, tone(70, 1.2, ((1, 1), (2, .5), (3, .3)), a=0.2, d=0.3, s=0.5, r=0.4), 0.08)
put(26.1, bubble_pop(), 0.28)                     # CTA button pops in
for i in range(9):                                # sparkle shimmer
    f = (2093, 2637, 3136, 3520, 4186)[i % 5]
    put(26.4 + i * 0.07, ding(f, 0.5), 0.045, (-0.6, -0.2, 0.2, 0.6)[i % 4])

# ---------------------------------------------------------------------------
# Master: gentle fade out, soft clip, normalise, write.
fo0 = int(28.9 * SR)
for i in range(fo0, N):
    g = 1 - (i - fo0) / (N - fo0)
    L[i] *= g
    R[i] *= g
for i in range(int(0.02 * SR)):
    L[i] *= i / (0.02 * SR)
    R[i] *= i / (0.02 * SR)
peak = max(max(abs(x) for x in L), max(abs(x) for x in R))
drive = 1.15 / peak
with wave.open('audio.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    frames = bytearray()
    for i in range(N):
        a = math.tanh(L[i] * drive) * 0.89
        b = math.tanh(R[i] * drive) * 0.89
        frames += struct.pack('<hh', int(a * 32767), int(b * 32767))
    w.writeframes(bytes(frames))
print('audio.wav written, peak before drive %.3f' % peak)
