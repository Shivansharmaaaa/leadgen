"""
Chatterbox TTS as a drop-in for the Kokoro service: same /health and /speak.

The user chose this voice on 18 Oct 2026, from a side-by-side test: Chatterbox's
own built-in voice with "more feeling" (exaggeration 0.7, cfg_weight 0.4). It
carries emotion Kokoro cannot, but on the M3 Pro it takes 10-39 s per line, so
it is for a machine with an NVIDIA GPU. Point the app at it with:

    TTS_URL=http://<gpu-host>:8788   (the voice route proxies /speak to it)

Set up (its own environment; never in tts/.venv, which serves Kokoro):

    python3.12 -m venv tts/chatterbox/.venv
    tts/chatterbox/.venv/bin/pip install -r tts/chatterbox/requirements.txt
    tts/chatterbox/.venv/bin/python tts/chatterbox/server.py

The model downloads from huggingface.co/ResembleAI/chatterbox (MIT, ~3.2 GB)
on first start. Every clip carries Resemble's inaudible Perth watermark, which
marks the audio as AI-generated; it is left on.

Request fields beyond Kokoro's: `exaggeration` and `cfg_weight`, which the
delivery planner's toChatterbox() fills from each sentence's style. A request
without them gets the chosen voice's settings. `speed` (a pace from the
planner, 1 = normal) maps to cfg_weight, Chatterbox's pacing control, since it
has no speed of its own.
"""
import io, json, os, sys, threading, time, warnings, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")
import numpy as np
import torch

PORT = int(os.environ.get("TTS_PORT", "8788"))
# The user's pick: Chatterbox's own voice, more feeling.
DEFAULT_EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.7"))
DEFAULT_CFG = float(os.environ.get("CHATTERBOX_CFG", "0.4"))
# Sampling is random; one seed keeps the same voice from sentence to sentence.
SEED = int(os.environ.get("CHATTERBOX_SEED", "7"))

device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
if device != "cuda":
    # The checkpoints were saved on CUDA.
    _load = torch.load
    torch.load = lambda *a, **k: _load(*a, **{"map_location": torch.device(device), **k})

from chatterbox.tts import ChatterboxTTS  # noqa: E402  (after the torch.load patch)

print(f"[chatterbox] loading on {device} …", flush=True)
_t = time.time()
MODEL = ChatterboxTTS.from_pretrained(device=device)
SAMPLE_RATE = MODEL.sr
print(f"[chatterbox] ready in {time.time() - _t:.1f}s on {device}", flush=True)

# One generation at a time on the GPU (Metal crashes on concurrent command buffers).
_GPU_LOCK = threading.Lock()
CACHE: dict[tuple, bytes] = {}
CACHE_LIMIT = 256


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def cfg_for(speed: float | None, cfg: float | None) -> float:
    """A planned pace becomes Chatterbox's pacing control: lower cfg_weight is slower and more deliberate."""
    if cfg is not None:
        return clamp(cfg, 0.2, 0.8)
    if speed is None:
        return DEFAULT_CFG
    return clamp(DEFAULT_CFG + (speed - 1.0) * 1.0, 0.25, 0.55)


def synth(text: str, exaggeration: float, cfg_weight: float) -> bytes:
    key = (text, round(exaggeration, 2), round(cfg_weight, 2))
    if key in CACHE:
        return CACHE[key]
    with _GPU_LOCK:
        torch.manual_seed(SEED)
        wav = MODEL.generate(text, exaggeration=exaggeration, cfg_weight=cfg_weight)
    audio = wav.squeeze().detach().cpu().numpy()
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SAMPLE_RATE); w.writeframes(pcm.tobytes())
    data = buf.getvalue()
    if len(CACHE) >= CACHE_LIMIT:
        CACHE.pop(next(iter(CACHE)))
    CACHE[key] = data
    return data


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            # speed 1.0: the planner's rate is sent as-is and mapped to cfg_weight here.
            body = json.dumps({"ok": True, "engine": "chatterbox", "device": device, "voice": "chatterbox-default",
                               "speed": 1.0, "exaggeration": DEFAULT_EXAGGERATION, "cfg_weight": DEFAULT_CFG,
                               "cached": len(CACHE)}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self._cors()
            self.end_headers(); self.wfile.write(body); return
        self.send_response(404); self._cors(); self.end_headers()

    def do_POST(self):
        if not self.path.startswith("/speak"):
            self.send_response(404); self._cors(); self.end_headers(); return
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
            text = (payload.get("text") or "").strip()
            if not text:
                self.send_response(400); self._cors(); self.end_headers(); return
            exaggeration = clamp(float(payload.get("exaggeration", DEFAULT_EXAGGERATION)), 0.25, 1.0)
            speed = payload.get("speed")
            cfg = payload.get("cfg_weight")
            cfg_weight = cfg_for(float(speed) if speed is not None else None, float(cfg) if cfg is not None else None)
            t0 = time.time()
            wav = synth(text, exaggeration, cfg_weight)
            ms = int((time.time() - t0) * 1000)
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("x-generation-ms", str(ms))
            self._cors(); self.send_header("content-length", str(len(wav)))
            self.end_headers(); self.wfile.write(wav)
        except Exception as e:  # noqa: BLE001 — surface, do not crash the service
            print(f"[chatterbox] error: {e}", file=sys.stderr, flush=True)
            self.send_response(500); self._cors(); self.end_headers()

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    print(f"[chatterbox] listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
