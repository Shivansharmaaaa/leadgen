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

# Kokoro's default lands above a conversational pace. Natural conversational
# English runs 130-150 words per minute; this brings it into that band without
# sounding laboured.
DEFAULT_SPEED = float(os.environ.get("TTS_SPEED", "0.85"))

# Openers the agent says constantly. Synthesised once at startup so the first
# thing a caller hears costs a dictionary lookup rather than ~800ms of GPU.
# Must stay in step with PREFIX_RULES in src/server/agent/fast-path.ts.
WARM_PHRASES = [
    "Ah, that's no fun.",
    "Bear with me.",
    "Good call ringing about that.",
    "Good question.",
    "Good that you called about it.",
    "Got it, let's get that looked at.",
    "Got it, that needs sorting today.",
    "Got it.",
    "Happy to help with that.",
    "Happy to talk that through.",
    "Hello.",
    "Hi there.",
    "Hi, thanks for calling.",
    "Hmm, let me check that.",
    "Hmm, let's get a technician on that.",
    "I can hear you.",
    "Just a sec.",
    "Let me check that for you.",
    "Let me check.",
    "Let me help with that.",
    "Let me just have a look.",
    "Let me pull that up.",
    "Let me see.",
    "Mm-hmm.",
    "No problem at all.",
    "Of course, let me look at the diary.",
    "Of course.",
    "Oh no, let's sort that out.",
    "Okay, a leak we want to catch early.",
    "Okay, happy to go through that.",
    "Okay, let me check on that.",
    "Okay, let's check that.",
    "Okay, let's get that sorted.",
    "Okay, let's not leave that one.",
    "Okay, let's work out what's going on.",
    "Okay, one moment.",
    "Okay, sorry you're dealing with that.",
    "Okay, that's one we prioritise.",
    "Okay, that's worth checking out.",
    "Okay, that's worth looking at properly.",
    "Okay, we'll move quickly on that.",
    "Okay.",
    "One second.",
    "Sorry to hear that.",
    "Sure, let me check what we have.",
    "Sure, let me explain how that works.",
    "Sure, let me see.",
    "Sure, let's look at that.",
    "Sure, we can sort that.",
    "Sure.",
    "Take care.",
    "Thanks for calling.",
    "That's worth looking at.",
    "Understood, let's treat that as urgent.",
    "Understood.",
    "Yes, I'm here.",
    "You're welcome.",
    "Sorry, could you say that again?",
    "Let me get a colleague to call you back about that — someone will be in touch shortly.",
    "Great — I'll have a colleague call you back shortly.",
    "Okay, so.",
    "Let me be straight with you.",
]

CACHE: dict[tuple[str, str, float], bytes] = {}
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


def synth(text: str, voice: str, speed: float = DEFAULT_SPEED) -> bytes:
    key = (text, voice, round(speed, 2))
    hit = CACHE.get(key)
    if hit is not None:
        return hit

    with _GPU_LOCK:
        chunks = [c[2] for c in PIPELINE(text, voice=voice, speed=speed)]
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
                               "speed": DEFAULT_SPEED, "cached": len(CACHE)}).encode()
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
            speed = float(payload.get("speed") or DEFAULT_SPEED)
            if not text:
                self.send_response(400); self._cors(); self.end_headers(); return

            t0 = time.time()
            wav = synth(text, voice, speed)
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
        synth(phrase, DEFAULT_VOICE, DEFAULT_SPEED)
    print(f"[tts] pre-rendered {len(WARM_PHRASES)} openers in {time.time() - _w:.1f}s", flush=True)
    print(f"[tts] listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
