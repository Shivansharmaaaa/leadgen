#!/usr/bin/env bash
# Keep the Kokoro TTS service up. Restarts it if it dies.
cd "$(dirname "$0")/.."
export VIRTUAL_ENV="$PWD/tts/.venv"
while true; do
  tts/.venv/bin/python tts/server.py >> /tmp/tts.log 2>&1
  echo "[tts] exited, restarting in 2s" >> /tmp/tts.log
  sleep 2
done
