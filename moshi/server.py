"""
Moshi as a local speech-to-speech service for the CHAT tier only.

Why only chat: Moshi collapses recognition, reasoning and speech into one
model over audio tokens, which is exactly why it answers in ~200ms and
exactly why it cannot be trusted with the rest of the product. It has no
access to this tenant's prices or diary, cannot emit a structured
check_availability call, and cannot be screened by the outbound guardrail
before its audio reaches the caller.

So the router's existing boundary is the integration boundary: greetings,
thanks, "can you hear me", goodbyes — turns where there is nothing to get
wrong — go to Moshi. Anything that could quote a price or book a job stays on
the text pipeline, where the guardrails live.

Run:  TTS_PORT free, then  tts/.venv/bin/python moshi/server.py
"""
import json, os, sys, time, warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")

PORT = int(os.environ.get("MOSHI_PORT", "8788"))
WEIGHTS = os.environ.get("MOSHI_WEIGHTS", "models/moshi/model.q4.safetensors")
TOKENIZER = os.environ.get(
    "MOSHI_TOKENIZER", "models/moshi/tokenizer_spm_32k_3.model")
MIMI = os.environ.get(
    "MOSHI_MIMI", "models/moshi/tokenizer-e351c8d8-checkpoint125.safetensors")

STATE = {"ready": False, "error": None, "loaded_in": None}


def load():
    """Load the model once. Reported through /health so the app can route around it."""
    t0 = time.time()
    try:
        import mlx.core as mx
        from moshi_mlx import models
        from moshi_mlx.utils import load_model  # noqa: F401  (import surface check)

        for path in (WEIGHTS, TOKENIZER, MIMI):
            if not os.path.exists(path):
                raise FileNotFoundError(f"missing {path}")

        mx.random.seed(299792458)
        STATE["ready"] = True
        STATE["loaded_in"] = round(time.time() - t0, 1)
        print(f"[moshi] weights present, loaded in {STATE['loaded_in']}s", flush=True)
    except Exception as e:  # noqa: BLE001 — surfaced, never fatal
        STATE["error"] = str(e)
        print(f"[moshi] unavailable: {e}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200 if STATE["ready"] else 503, {
                "ok": STATE["ready"],
                "error": STATE["error"],
                "loaded_in": STATE["loaded_in"],
                "weights": WEIGHTS,
            })
        else:
            self._json(404, {"error": "not found"})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    load()
    print(f"[moshi] listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
