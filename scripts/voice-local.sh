#!/usr/bin/env bash
# Talk to the agent on your own machine:  npm run voice
#
# Checks and, where it safely can, fixes everything a live voice call needs,
# then opens /voice. On Apple Silicon, Ollama runs the model on the GPU
# (Metal) by itself — nothing to configure.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_MODEL="llama3.2:3b"
# Stock is the most reliable untuned voice model; the cache-friendly build is
# made too so it can be tried, and is what fine-tuned models are served with.
VOICE_MODEL="llama3.2:3b"
FAST_MODEL="leadgen-llama3.2:3b"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

step() { printf "\n\033[1m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}

step "Ollama"
command -v ollama >/dev/null || die "Ollama is not installed. Mac: brew install ollama  (or the app from ollama.com/download)"
if ! curl -sf "$OLLAMA_URL/api/version" >/dev/null; then
  echo "  starting ollama serve (log: /tmp/leadgen-ollama.log)"
  nohup ollama serve >/tmp/leadgen-ollama.log 2>&1 &
  wait_for "$OLLAMA_URL/api/version" 30 || die "ollama serve did not come up — see /tmp/leadgen-ollama.log"
fi
ok "Ollama $(curl -s "$OLLAMA_URL/api/version" | sed -E 's/.*"version":"([^"]+)".*/\1/') at $OLLAMA_URL"

if ollama list | awk 'NR>1 {print $1}' | grep -x "$BASE_MODEL" >/dev/null; then
  ok "$BASE_MODEL installed"
else
  echo "  pulling $BASE_MODEL (2.0 GB)…"
  ollama pull "$BASE_MODEL"
  ok "$BASE_MODEL installed"
fi
ollama create "$FAST_MODEL" -f models/leadgen-llama3.2.Modelfile >/dev/null 2>&1 \
  || die "could not build $FAST_MODEL from models/leadgen-llama3.2.Modelfile"
ok "built $FAST_MODEL too (faster first word, needs fine-tuning for tool use)"

step ".env"
if [ ! -f .env ]; then cp .env.example .env; ok "created .env from .env.example"; fi
if ! grep -q '^OLLAMA_VOICE_MODEL=' .env; then
  printf '\nOLLAMA_VOICE_MODEL=%s\n' "$VOICE_MODEL" >> .env
  ok "added OLLAMA_VOICE_MODEL=$VOICE_MODEL to .env"
else
  ok "OLLAMA_VOICE_MODEL=$(grep '^OLLAMA_VOICE_MODEL=' .env | tail -1 | cut -d= -f2)"
fi

step "Dependencies"
if [ ! -d node_modules ]; then npm install --no-audit --no-fund; fi
ok "node_modules present"

step "Database"
# 0 ready, 2 unreachable, 3 not seeded. `&& ||` keeps set -e from firing.
db_status() { npx tsx --env-file=.env scripts/voice-preflight.ts --db >/dev/null 2>&1 && echo 0 || echo $?; }
db=$(db_status)
if [ "$db" = 2 ]; then
  command -v docker >/dev/null || die "Postgres is not reachable and Docker is not installed — see README"
  if command -v colima >/dev/null && ! colima status >/dev/null 2>&1; then colima start; fi
  docker start leadgen-pg >/dev/null 2>&1 || docker run -d --name leadgen-pg \
    -e POSTGRES_PASSWORD=leadgen -e POSTGRES_USER=leadgen -e POSTGRES_DB=leadgen \
    -p 5433:5432 pgvector/pgvector:pg17 >/dev/null
  for _ in $(seq 1 30); do db=$(db_status); [ "$db" != 2 ] && break; sleep 1; done
fi
if [ "$db" = 3 ]; then
  npm run -s db:push
  npm run -s seed
  db=$(db_status)
fi
[ "$db" = 0 ] || die "database not ready — run: npx tsx --env-file=.env scripts/voice-preflight.ts --db"
ok "database ready, demo tenant seeded"

step "Voice model check"
npx tsx --env-file=.env scripts/voice-preflight.ts --model || die "voice model check failed"

step "Voice (Kokoro TTS)"
if curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1; then
  ok "Kokoro already running"
elif [ -x tts/.venv/bin/python ]; then
  if ! tts/.venv/bin/python -c "import kokoro" >/dev/null 2>&1; then
    printf "  \033[33m!\033[0m Kokoro venv is broken — repair with: uv pip install --python tts/.venv/bin/python -r tts/requirements.txt\n"
  fi
  nohup bash tts/run.sh >/dev/null 2>&1 &
  if wait_for http://127.0.0.1:8787/health 60; then
    ok "Kokoro started on the GPU (log: /tmp/tts.log)"
  else
    printf "  \033[33m!\033[0m Kokoro did not start — the browser voice will be used instead\n"
  fi
else
  printf "  \033[33m!\033[0m Kokoro not installed — see tts/README.md. Browser voice will be used.\n"
fi

step "Transcription (Parakeet STT)"
if curl -sf http://127.0.0.1:8789/health >/dev/null 2>&1; then
  ok "Parakeet already running"
elif [ -x stt/.venv/bin/python ] && [ -f models/parakeet/.complete ]; then
  nohup bash stt/run.sh >/dev/null 2>&1 &
  if wait_for http://127.0.0.1:8789/health 90; then
    ok "Parakeet started on the GPU (log: /tmp/stt.log)"
  else
    printf "  \033[33m!\033[0m Parakeet did not start — the browser recogniser will be used\n"
  fi
elif [ -x stt/.venv/bin/python ]; then
  printf "  \033[33m!\033[0m Parakeet weights missing — run: npm run stt:fetch\n"
else
  printf "  \033[33m!\033[0m Parakeet not installed — see stt/requirements.txt. Browser recogniser will be used.\n"
fi

step "Starting the app"
if curl -sf http://localhost:3100/voice >/dev/null 2>&1; then
  ok "already running on :3100"
else
  nohup npm run dev >/tmp/leadgen-dev.log 2>&1 &
  wait_for http://localhost:3100/voice 90 || die "dev server did not start — see /tmp/leadgen-dev.log"
  ok "dev server on :3100 (log: /tmp/leadgen-dev.log)"
fi
URL=http://localhost:3100/voice
if command -v open >/dev/null; then open "$URL"; elif command -v xdg-open >/dev/null; then xdg-open "$URL"; fi
printf "\n  Open %s in Chrome, press the mic, and talk.\n\n" "$URL"
