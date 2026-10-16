"""
Round-trip accuracy: Kokoro speaks sentences with a known transcript,
Parakeet transcribes them, and word error rate is measured against the
original text. The sentences lean on what a home-services call actually
contains and what recognisers get wrong: numbers, times, brand names, a
street address, a spelled-out phone number.

Synthetic speech is cleaner than a real caller on a phone line, so treat the
WER as a floor, not a forecast — real accents, line noise and crosstalk will
raise it. Latency is the number that carries over.
"""
import io, json, re, time, urllib.request, wave
import numpy as np

# (what Kokoro says, what a correct transcript should read)
#
# Kept separate on purpose. The first version scored against the spoken form,
# so "six one seven, five five five, zero one eight eight" transcribed as
# "617-555-0188" counted as 77% wrong — penalising the model for writing a
# phone number the way a transcript should. Numbers are scored in written form.
SENTENCES = [
    ("Hi, my air conditioner is blowing warm air and the house is eighty four degrees.",
     "Hi, my air conditioner is blowing warm air and the house is 84 degrees."),
    ("Can someone come out tomorrow morning around nine?",
     "Can someone come out tomorrow morning around 9?"),
    ("My number is six one seven, five five five, zero one eight eight.",
     "My number is 617-555-0188."),
    ("It's a Carrier unit, installed in twenty nineteen.",
     "It's a Carrier unit, installed in 2019."),
    ("The furnace keeps short cycling, on and off every few minutes.",
     "The furnace keeps short cycling, on and off every few minutes."),
    ("I'm at fourteen eighty Dorchester Avenue in Quincy.",
     "I'm at 1480 Dorchester Avenue in Quincy."),
    ("Eighty nine dollars just to look at it seems a bit steep.",
     "$89 just to look at it seems a bit steep."),
    ("Actually, wait, can we do Thursday afternoon instead?",
     "Actually, wait, can we do Thursday afternoon instead?"),
]

def norm(t: str) -> list[str]:
    # Case and punctuation are not errors; "617-555-0188" and "617 555 0188"
    # are the same number.
    return re.sub(r"[^a-z0-9 ]", " ", t.lower().replace("-", " ")).split()

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
for spoken, expected in SENTENCES:
    pcm = speak(spoken)
    t0 = time.time()
    r = transcribe(pcm)
    rt = (time.time() - t0) * 1000
    ref, hyp = norm(expected), norm(r["text"])
    e = wer(ref, hyp)
    total_err += e * len(ref); total_words += len(ref)
    rows.append((e, r["ms"], rt, r["seconds"], expected, r["text"]))

print(f"{'WER':>5} {'model':>6} {'round':>6} {'audio':>6}")
for e, ms, rt, sec, ref, hyp in rows:
    flag = " " if e == 0 else "!"
    print(f"{e*100:4.0f}%{flag} {ms:5d}ms {rt:5.0f}ms {sec:5.1f}s  {hyp}")
print(f"\noverall WER {total_err/total_words*100:.1f}%  over {total_words} words")
print(f"median model time {sorted(r[1] for r in rows)[len(rows)//2]}ms "
      f"for ~{sorted(r[3] for r in rows)[len(rows)//2]:.1f}s of speech")
