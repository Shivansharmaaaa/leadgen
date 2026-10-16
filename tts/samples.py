import json, urllib.request, wave, io
LINE = ("Sorry to hear that. Can you tell me how long it's been blowing warm air? "
        "I've got Thursday at nine, or Friday at two.")
words = len(LINE.split())
for speed, name in [(0.78, "prev_078"), (0.85, "new_085"), (0.90, "faster_090")]:
    req = urllib.request.Request("http://127.0.0.1:8787/speak",
        data=json.dumps({"text": LINE, "speed": speed}).encode(),
        headers={"content-type": "application/json"})
    wav = urllib.request.urlopen(req, timeout=90).read()
    open(f"tts/spd_{name}.wav", "wb").write(wav)
    with wave.open(io.BytesIO(wav)) as w:
        dur = w.getnframes() / w.getframerate()
    print(f"  {name:<12} speed {speed}  {words/dur*60:5.0f} wpm")
