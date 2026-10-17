#!/usr/bin/env bash
# Keep the Parakeet STT service up. Restarts it if it dies.
cd "$(dirname "$0")/.."
export VIRTUAL_ENV="$PWD/stt/.venv"
PORT="${STT_PORT:-8789}"
listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }

# One copy only. A second loop can never bind the port, so it reloaded the
# model onto the GPU every ~90 s for five hours on 17 Oct and slowed every
# live call (synthesis 4-6 s a sentence).
if listening; then
  echo "[stt] already running on :$PORT, not starting a second copy (log: /tmp/stt.log)"
  exit 0
fi
echo "[stt] starting on :$PORT (log: /tmp/stt.log)"

while true; do
  stt/.venv/bin/python stt/server.py >> /tmp/stt.log 2>&1
  # Another copy took the port while this one was down: stop, don't spin.
  if listening; then
    echo "[stt] :$PORT is served by another copy, stopping this loop" >> /tmp/stt.log
    exit 0
  fi
  echo "[stt] exited, restarting in 2s" >> /tmp/stt.log
  sleep 2
done
