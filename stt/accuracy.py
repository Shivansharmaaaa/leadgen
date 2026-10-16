"""
Round-trip accuracy: Kokoro speaks sentences with a known transcript,
Parakeet transcribes them, and word error rate is measured against the
original text. The sentences lean on what a home-services call actually
contains and what recognisers get wrong: numbers, times, brand names, a
street address, a spelled-out phone number.

Synthetic speech is cleaner than a real caller on a phone line, so treat the
WER as a floor, not a forecast. Latency is the real number.
"""
import io, json, re, time, urllib.request, wave
import numpy as np

SENTENCES = [
    "Hi, my air conditioner is blowing warm air and the house is eighty four degrees.",
    "Can someone come out tomorrow morning around nine?",
    "My number is six one seven, five five five, zero one eight eight.",
    "It's a Carrier unit, installed in twenty nineteen.",
    "The furnace keeps short cycling, on and off every few minutes.",
    "I'm at fourteen eighty Dorchester Avenue in Quincy.",
    "Eighty nine dollars just to look at it seems a bit steep.",
    "Actually, wait, can we do Thursday afternoon instead?",
]

def norm(t: str) -> list[str]:
    return re.sub(r"[^a-z0-9 ]", " ", t.lower()).split()

def wer(ref: list[str], hyp: list[str]) -> float:
    d = np.zeros((len(ref) + 1, len(hyp) + 1), dtype=int)
    d[:, 0] = np.arange(len(ref) + 1)
    d[0, :] = np.arange(len(hyp) + 1)
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + cost)
    return d[-1, -1] / max(1, len(ref))

def speak(text: str) -> np.ndarray:
    req = urllib.request.Request("http://127.0.0.1:8787/speak",
        data=json.dumps({"text": text}).encode(), headers={"content-type": "application/json"})
    with wave.open(io.BytesIO(urllib.request.urlopen(req, timeout=60).read())) as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
    # 24 kHz -> 16 kHz, the rate Parakeet consumes.
    n = int(len(pcm) * 16000 / sr)
    return np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype("<i2")

def transcribe(pcm: np.ndarray) -> dict:
    req = urllib.request.Request("http://127.0.0.1:8789/transcribe", data=pcm.tobytes(),
        headers={"content-type": "application/octet-stream"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())

total_err, total_words, rows = 0.0, 0, []
for s in SENTENCES:
    pcm = speak(s)
    t0 = time.time()
    r = transcribe(pcm)
    rt = (time.time() - t0) * 1000
    ref, hyp = norm(s), norm(r["text"])
    e = wer(ref, hyp)
    total_err += e * len(ref); total_words += len(ref)
    rows.append((e, r["ms"], rt, r["seconds"], s, r["text"]))

print(f"{'WER':>5} {'model':>6} {'round':>6} {'audio':>6}")
for e, ms, rt, sec, ref, hyp in rows:
    flag = " " if e == 0 else "!"
    print(f"{e*100:4.0f}%{flag} {ms:5d}ms {rt:5.0f}ms {sec:5.1f}s  {hyp}")
print(f"\noverall WER {total_err/total_words*100:.1f}%  over {total_words} words")
print(f"median model time {sorted(r[1] for r in rows)[len(rows)//2]}ms "
      f"for ~{sorted(r[3] for r in rows)[len(rows)//2]:.1f}s of speech")
