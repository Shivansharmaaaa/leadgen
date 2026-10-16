import json, urllib.request
LINE = ("Sorry to hear that. Can you tell me how long it's been blowing warm air? "
        "I've got Thursday at nine, or Friday at two.")
for speed, name in [(0.92, "a_092_current"), (0.80, "b_080"), (0.72, "c_072"), (0.65, "d_065")]:
    req = urllib.request.Request("http://127.0.0.1:8787/speak",
        data=json.dumps({"text": LINE, "speed": speed}).encode(),
        headers={"content-type": "application/json"})
    open(f"tts/speed_{name}.wav", "wb").write(urllib.request.urlopen(req, timeout=90).read())
    print(f"  wrote tts/speed_{name}.wav  (speed {speed})")
