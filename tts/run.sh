#!/usr/bin/env bash
# Keep the Kokoro TTS service up. Restarts it if it dies.
cd "$(dirname "$0")/.."
export VIRTUAL_ENV="$PWD/tts/.venv"
PORT="${TTS_PORT:-8787}"
listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }

# One copy only. A second loop can never bind the port, so it reloaded the
# model onto the GPU every ~90 s for five hours on 17 Oct and slowed every
# live call (synthesis 4-6 s a sentence).
if listening; then
  echo "[tts] already running on :$PORT, not starting a second copy (log: /tmp/tts.log)"
  exit 0
fi
echo "[tts] starting on :$PORT (log: /tmp/tts.log)"

while true; do
  tts/.venv/bin/python tts/server.py >> /tmp/tts.log 2>&1
  # Another copy took the port while this one was down: stop, don't spin.
  if listening; then
    echo "[tts] :$PORT is served by another copy, stopping this loop" >> /tmp/tts.log
    exit 0
  fi
  echo "[tts] exited, restarting in 2s" >> /tmp/tts.log
  sleep 2
done
