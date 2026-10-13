"""Генерирует стандартные мелодии будильника в assets/audio/ (WAV, моно, 22 кГц).
Запуск: python3 scripts/gen-audio.py"""
import math, os, struct, wave

RATE = 22050
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'audio')


def tone(freq, dur, vol=0.5, decay=0.0, shape='sine'):
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        if shape == 'square':
            s = 1.0 if math.sin(2 * math.pi * freq * t) >= 0 else -1.0
            s *= 0.35
        else:
            s = math.sin(2 * math.pi * freq * t) + 0.3 * math.sin(4 * math.pi * freq * t)
            s /= 1.3
        env = math.exp(-decay * t) if decay else 1.0
        attack = min(1.0, i / (RATE * 0.005))
        release = min(1.0, (n - i) / (RATE * 0.01))
        out.append(s * vol * env * attack * release)
    return out


def sweep(f0, f1, dur, vol=0.4):
    n = int(RATE * dur)
    out, phase = [], 0.0
    for i in range(n):
        f = f0 + (f1 - f0) * i / n
        phase += 2 * math.pi * f / RATE
        env = min(1.0, i / (RATE * 0.01)) * min(1.0, (n - i) / (RATE * 0.02))
        out.append(math.sin(phase) * vol * env)
    return out


silence = lambda d: [0.0] * int(RATE * d)


def write(name, samples):
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, name), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s)) * 32000)) for s in samples))


classic = []
for _ in range(3):
    for _ in range(4):
        classic += tone(1000, 0.07, 0.5, shape='square') + silence(0.05)
    classic += silence(0.3)
write('alarm-classic.wav', classic)

chime = []
for f in (1318.5, 1046.5, 1568.0):
    chime += tone(f, 0.7, 0.6, decay=4.5)
write('chime.wav', chime)

jackpot = []
for f in (523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5):
    jackpot += tone(f, 0.12, 0.45, decay=6)
jackpot += tone(1568.0, 0.6, 0.5, decay=3)
write('jackpot.wav', jackpot)

neon = []
for _ in range(2):
    neon += sweep(400, 1200, 0.35) + sweep(1200, 600, 0.25) + silence(0.15)
write('neon.wav', neon)
