#!/usr/bin/env bash
# Export a finished run (and, optionally, one more checkpoint of it) to Ollama
# at the stock model's quantisation, then score held-out next actions for the
# stock build, the untuned cache-friendly build and the fine-tunes on the same
# sample, so the numbers are comparable.
#
#   bash finetune/after_training.sh 3b-conv-lp16 ckpt-75
#
# PER_KIND (default 3) decisions per kind; results land in data/eval/.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN=${1:?usage: after_training.sh <run> [extra-checkpoint-dir]}
EXTRA=${2:-}
PY=finetune/.venv/bin/python
LLAMA_CPP=${LLAMA_CPP_DIR:-$HOME/src/llama.cpp}
PER_KIND=${PER_KIND:-3}

models=(llama3.2:3b leadgen-llama3.2:3b)

echo "== export $RUN"
$PY finetune/export_ollama.py --run "$RUN" --llama-cpp "$LLAMA_CPP"
models+=("leadgen-llama3.2-ft:$RUN")

if [ -n "$EXTRA" ]; then
  echo "== export $RUN/$EXTRA"
  $PY finetune/export_ollama.py --adapter "data/finetune/runs/$RUN/$EXTRA" \
    --tag "leadgen-llama3.2-ft:$RUN-$EXTRA" --llama-cpp "$LLAMA_CPP"
  models+=("leadgen-llama3.2-ft:$RUN-$EXTRA")
fi

for m in "${models[@]}"; do
  echo "== next action: $m"
  # Every decision to a log; the per-kind table to the screen.
  log="data/finetune/runs/$RUN/actions_${m//[:\/]/_}.log"
  $PY finetune/eval_actions.py --model "$m" --per-kind "$PER_KIND" --tag "$RUN" > "$log" 2>&1
  sed -n '/^kind /,$p' "$log"
  ollama stop "$m" >/dev/null 2>&1 || true   # free the GPU for the next one
done
echo "== done; results in data/eval/actions_chat_*_${RUN}.json"
