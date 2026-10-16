"""Measure words per minute at a few speeds, against the 130-150 target."""
import json, urllib.request, wave, io

LINE = "Sorry to hear that. Can you tell me how long it has been blowing warm air, and whether you hear any unusual noises from the unit?"
words = len(LINE.split())
for speed in (0.85, 0.80, 0.75, 0.70, 0.65):
    req = urllib.request.Request("http://127.0.0.1:8787/speak",
        data=json.dumps({"text": LINE, "speed": speed}).encode(),
        headers={"content-type": "application/json"})
    wav = urllib.request.urlopen(req, timeout=60).read()
    with wave.open(io.BytesIO(wav)) as w:
        dur = w.getnframes() / w.getframerate()
    wpm = words / dur * 60
    band = "✓ conversational" if 130 <= wpm <= 150 else ("fast" if wpm > 150 else "slow")
    print(f"  speed {speed:.2f}  {dur:.2f}s  {wpm:5.1f} wpm   {band}")
