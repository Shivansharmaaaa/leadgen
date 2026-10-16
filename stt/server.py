"""
Parakeet speech-to-text as a local service.

The browser's built-in recogniser was the weakest link in the voice pipeline:
it misheard words and, worse, lost whatever was said while it restarted its
session every few seconds. Parakeet (NVIDIA's TDT 0.6B, MLX port) runs on the
Apple GPU and sees the whole utterance at once.

Chrome is still used for what it is good at — deciding WHEN the caller has
stopped, and streaming interim text for speculation. Parakeet decides WHAT
they said. The browser posts the raw audio of the finished utterance here.

Input is 16 kHz mono little-endian int16 PCM, which is what the model
consumes, so there is no decode step, no temp file and no ffmpeg subprocess
on every turn — the library's own transcribe() path does all three.
"""
import json, os, sys, threading, time, warnings
from http.server import BaseHTTPRequestHandler, HTTPServer

warnings.filterwarnings("ignore")
import numpy as np
import mlx.core as mx
from parakeet_mlx import from_pretrained
from parakeet_mlx.audio import get_logmel

PORT = int(os.environ.get("STT_PORT", "8789"))
MODEL_PATH = os.environ.get("STT_MODEL", "models/parakeet")
SAMPLE_RATE = 16000

print(f"[stt] loading Parakeet from {MODEL_PATH} …", flush=True)
_t = time.time()
MODEL = from_pretrained(MODEL_PATH)
assert MODEL.preprocessor_config.sample_rate == SAMPLE_RATE, "model expects a different rate"



def logmel(pcm32: "mx.array") -> "mx.array":
    """
    Mel features, computed in float32 and only then cast for the model.

    get_logmel views the STFT's complex64 output as the INPUT dtype and pairs
    adjacent values back into magnitudes. That is only correct for float32:
    with bfloat16 input the view quadruples the width and the pairing leaves
    514 bins against a 257-bin filterbank, and the matmul fails.
    """
    return get_logmel(pcm32, MODEL.preprocessor_config).astype(mx.bfloat16)


# Warm the graph on a second of silence so the first real call is not slow.
MODEL.generate(logmel(mx.zeros((SAMPLE_RATE,), dtype=mx.float32)))
print(f"[stt] ready in {time.time() - _t:.1f}s", flush=True)

# MLX streams are thread-local: the model must be called from the thread that
# loaded it, or every request fails with "There is no Stream(cpu, 1) in current
# thread". So this service is deliberately single-threaded (HTTPServer, not
# ThreadingHTTPServer) and serves from the main thread. That costs nothing —
# GPU work is serial regardless — and the lock below stays as a guard.
_GPU_LOCK = threading.Lock()


def transcribe_pcm(raw: bytes) -> dict:
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    seconds = len(pcm) / SAMPLE_RATE
    if len(pcm) < MODEL.preprocessor_config.hop_length:
        return {"text": "", "seconds": seconds, "ms": 0}

    t0 = time.time()
    with _GPU_LOCK:
        result = MODEL.generate(logmel(mx.array(pcm, dtype=mx.float32)))[0]
    ms = int((time.time() - t0) * 1000)
    return {"text": result.text.strip(), "seconds": round(seconds, 2), "ms": ms}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "model": "parakeet-tdt-0.6b-v2", "rate": SAMPLE_RATE})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            self._json(404, {"error": "not found"}); return
        try:
            n = int(self.headers.get("content-length", "0"))
            if n <= 0 or n > SAMPLE_RATE * 2 * 120:  # cap at two minutes of audio
                self._json(400, {"error": "audio missing or too long"}); return
            self._json(200, transcribe_pcm(self.rfile.read(n)))
        except Exception as e:  # noqa: BLE001 — reported, never fatal
            print(f"[stt] error: {e}", file=sys.stderr, flush=True)
            self._json(500, {"error": str(e)})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    print(f"[stt] listening on http://127.0.0.1:{PORT}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
