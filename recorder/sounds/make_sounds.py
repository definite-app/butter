# /// script
# requires-python = ">=3.10"
# ///
"""Synthesizes butter-rec's start/stop/error sounds: soft sine chimes with a
gentle attack, low register, no clicks. Run: uv run sounds/make_sounds.py"""
import math
import struct
import wave
from pathlib import Path

RATE = 44100


def note(freq, start, length=0.22, amp=0.32):
    """(start_sample, samples) for one soft bell-ish tone."""
    n = int(length * RATE)
    out = []
    for i in range(n):
        t = i / RATE
        attack = min(1.0, t / 0.012)                 # 12 ms fade-in: no click
        decay = math.exp(-t / 0.07)                  # quick, soft tail
        release = min(1.0, (n - i) / (0.02 * RATE))  # fade to exact zero
        tone = math.sin(2 * math.pi * freq * t) + 0.12 * math.sin(2 * math.pi * freq * 2 * t)
        out.append(amp * attack * decay * release * tone)
    return int(start * RATE), out


def render(name, notes):
    total = max(s + len(x) for s, x in notes)
    mix = [0.0] * total
    for s, samples in notes:
        for i, v in enumerate(samples):
            mix[s + i] += v
    path = Path(__file__).parent / f"{name}.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 32767)) for v in mix))
    print(path)


D5, A5, E5, A4 = 587.33, 880.0, 659.25, 440.0
render("butter-start", [note(D5, 0), note(A5, 0.075)])    # rising fifth
render("butter-stop", [note(A5, 0), note(D5, 0.075)])     # falling fifth
render("butter-error", [note(A4, 0, amp=0.28), note(A4, 0.13, amp=0.28)])  # two low taps
