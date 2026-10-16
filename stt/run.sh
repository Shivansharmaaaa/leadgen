#!/usr/bin/env bash
# Keep the Parakeet STT service up. Restarts it if it dies.
cd "$(dirname "$0")/.."
export VIRTUAL_ENV="$PWD/stt/.venv"
while true; do
  stt/.venv/bin/python stt/server.py >> /tmp/stt.log 2>&1
  echo "[stt] exited, restarting in 2s" >> /tmp/stt.log
  sleep 2
done
