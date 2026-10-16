"""
Kokoro TTS as a small local HTTP service.

The model takes ~4s to load, so it is loaded once and kept resident; each
request is then ~0.2s for a sentence on the Apple GPU (RTF 0.05). Speech is
synthesised per sentence rather than per turn, so the first sentence starts
playing while the rest of the reply is still being generated.

Standard library only on the serving side — this listens on localhost for one
app, and a framework would be a dependency without a job.
"""
import io, json, os, sys, threading, time, warnings, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")
import numpy as np
import torch
from kokoro import KPipeline

PORT = int(os.environ.get("TTS_PORT", "8787"))
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
SAMPLE_RATE = 24000

# Openers the agent says constantly. Synthesised once at startup so the first
# thing a caller hears costs a dictionary lookup rather than ~800ms of GPU.
# Must stay in step with PREFIX_RULES in src/server/agent/fast-path.ts.
WARM_PHRASES = [
    "Sorry to hear that.",
    "Okay, sorry you're dealing with that.",
    "Right, let's get that sorted.",
    "Okay, that's one we prioritise.",
    "Right, let's treat that as urgent.",
    "Okay, worth looking at properly.",
    "Right, let's get a technician on that.",
    "Okay, a leak we want to catch early.",
    "Right, let's get that looked at.",
    "Sure, let me check what we have.",
    "Of course, let me look at the diary.",
    "Happy to help with that.",
    "Sure, let me explain how that works.",
    "Sorry, could you say that again?",
    # Thinking fillers — played only when a turn is slow and nothing has been
    # said yet, so the line never goes quiet while the model works.
    "Let me see.",
    "One second.",
    "Mm, okay.",
    "Right.",
    "Let me get a colleague to help you with that — someone will call you right back.",
]

CACHE: dict[tuple[str, str], bytes] = {}
CACHE_LIMIT = 256

device = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"[tts] loading Kokoro on {device} …", flush=True)
_t = time.time()
PIPELINE = KPipeline(lang_code="a", device=device)
# Warm the graph so the first real request is not the slow one.
list(PIPELINE("Ready.", voice=DEFAULT_VOICE))
print(f"[tts] model ready in {time.time() - _t:.1f}s on {device}", flush=True)


# Metal command buffers cannot be driven from several threads at once: two
# concurrent requests crashed the process with
# "failed assertion _status < MTLCommandBufferStatusCommitted".
# Requests stay concurrent at the socket; only the GPU section is serialised,
# which costs nothing here because synthesis is ~200ms and single-user.
_GPU_LOCK = threading.Lock()


def trim_silence(audio: "np.ndarray", threshold: float = 0.0025) -> "np.ndarray":
    """
    Drop near-silent head and tail.

    Kokoro pads each clip with a little silence. Harmless on its own, but when
    a reply is spoken as several clips in a row those pads stack into an
    audible gap at every comma and full stop, which is what makes the agent
    sound hesitant rather than fluent.
    """
    loud = np.abs(audio) > threshold
    if not loud.any():
        return audio
    first, last = int(np.argmax(loud)), len(loud) - int(np.argmax(loud[::-1]))
    # Leave ~15ms so words are not clipped at the edges.
    pad = int(0.015 * SAMPLE_RATE)
    return audio[max(0, first - pad):min(len(audio), last + pad)]


def synth(text: str, voice: str) -> bytes:
    key = (text, voice)
    hit = CACHE.get(key)
    if hit is not None:
        return hit

    with _GPU_LOCK:
        chunks = [c[2] for c in PIPELINE(text, voice=voice)]
    if not chunks:
        return b""
    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    audio = trim_silence(audio)
    pcm = np.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767).astype("<i2")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
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
            body = json.dumps({"ok": True, "device": device, "voice": DEFAULT_VOICE,
                               "cached": len(CACHE)}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self._cors(); self.send_header("content-length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self._cors(); self.end_headers()

    def do_POST(self):
        if not self.path.startswith("/speak"):
            self.send_response(404); self._cors(); self.end_headers(); return
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = (payload.get("text") or "").strip()
            voice = payload.get("voice") or DEFAULT_VOICE
            if not text:
                self.send_response(400); self._cors(); self.end_headers(); return

            t0 = time.time()
            wav = synth(text, voice)
            ms = int((time.time() - t0) * 1000)

            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("x-generation-ms", str(ms))
            self.send_header("x-cache", "hit" if ms < 5 else "miss")
            self._cors(); self.send_header("content-length", str(len(wav)))
            self.end_headers(); self.wfile.write(wav)
        except Exception as e:  # noqa: BLE001 — surface, do not crash the service
            print(f"[tts] error: {e}", file=sys.stderr, flush=True)
            self.send_response(500); self._cors(); self.end_headers()

    def log_message(self, *_):
        pass  # the access log is noise for a localhost service


if __name__ == "__main__":
    _w = time.time()
    for phrase in WARM_PHRASES:
        synth(phrase, DEFAULT_VOICE)
    print(f"[tts] pre-rendered {len(WARM_PHRASES)} openers in {time.time() - _w:.1f}s", flush=True)
    print(f"[tts] listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
