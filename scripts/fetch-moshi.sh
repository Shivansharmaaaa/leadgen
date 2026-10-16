#!/usr/bin/env bash
# Resumable Moshi download. Aborts and retries whenever the transfer stalls,
# because a silent hang is indistinguishable from a slow link otherwise.
set -u
cd "$(dirname "$0")/.."
mkdir -p models/moshi
BASE="https://huggingface.co/kyutai/moshiko-mlx-q4/resolve/main"

get() { # url, dest
  for attempt in $(seq 1 200); do
    curl -L --fail --silent --show-error \
         --continue-at - \
         --speed-limit 20000 --speed-time 30 \
         --connect-timeout 20 \
         -o "$2" "$1" && return 0
    echo "[moshi] attempt $attempt stalled or failed, resuming in 5s" >&2
    sleep 5
  done
  return 1
}

get "$BASE/model.q4.safetensors" models/moshi/model.q4.safetensors || exit 1
get "$BASE/tokenizer-e351c8d8-checkpoint125.safetensors" models/moshi/tokenizer-e351c8d8-checkpoint125.safetensors || exit 1
get "$BASE/tokenizer_spm_32k_3.model" models/moshi/tokenizer_spm_32k_3.model || exit 1
echo DONE > models/moshi/.complete
echo "[moshi] all files downloaded"
