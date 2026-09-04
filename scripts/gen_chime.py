# 生成冥想结束提示音（磬/钵音色）-> miniprogram/audio/chime.wav
import math
import struct
import wave
import os

SR = 22050          # 采样率
DUR = 3.6           # 时长（秒）
N = int(SR * DUR)

# 磬/钵类音色：基频 + 非谐分音，分音越高衰减越快
PARTIALS = [
    (1.00, 0.90, 1.6),   # (频率比, 幅度, 衰减时间常数 s)
    (2.00, 0.42, 1.1),
    (2.92, 0.26, 0.8),
    (4.06, 0.14, 0.55),
    (5.37, 0.07, 0.4),
]
BASE = 523.25  # C5

OUT = os.path.join(os.path.dirname(__file__), "..", "miniprogram", "audio", "chime.wav")

samples = []
for i in range(N):
    t = i / SR
    v = 0.0
    for ratio, amp, tau in PARTIALS:
        v += amp * math.exp(-t / tau) * math.sin(2 * math.pi * BASE * ratio * t)
    # 轻微幅度颤动，模拟钵音的自然波动
    v *= 1.0 + 0.04 * math.sin(2 * math.pi * 5.2 * t)
    # 8ms 起音淡入，避免爆音
    attack = min(1.0, t / 0.008)
    samples.append(v * attack)

# 归一化到 0.85 峰值
peak = max(abs(s) for s in samples)
k = 0.85 / peak

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with wave.open(OUT, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(
        b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s * k)) * 32767)) for s in samples)
    )
print("written:", os.path.abspath(OUT))
