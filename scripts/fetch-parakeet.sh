#!/usr/bin/env bash
# Resumable Parakeet download. Same approach as fetch-moshi.sh: the Hugging
# Face downloader has no stall detection and froze at 408 MB, so this aborts
# whenever throughput drops below 20 KB/s for 30s and resumes where it was.
set -u
cd "$(dirname "$0")/.."
mkdir -p models/parakeet
BASE="https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v2/resolve/main"
TOTAL=2471000000

get() {
  for attempt in $(seq 1 200); do
    curl -L --fail --silent --show-error --continue-at - \
         --speed-limit 20000 --speed-time 30 --connect-timeout 20 \
         -o "$2" "$1" && return 0
    echo "  attempt $attempt stalled, resuming in 5s"
    sleep 5
  done
  return 1
}

for f in config.json tokenizer.model tokenizer.vocab vocab.txt; do
  get "$BASE/$f" "models/parakeet/$f" || exit 1
done
echo "  small files done; fetching model.safetensors (2.3 GB)"

( get "$BASE/model.safetensors" models/parakeet/model.safetensors && touch models/parakeet/.complete ) &
PID=$!
while kill -0 $PID 2>/dev/null; do
  S=$(stat -f%z models/parakeet/model.safetensors 2>/dev/null || echo 0)
  echo "  parakeet  $(echo "scale=2; $S/1073741824" | bc) GB / 2.30 GB  ($(echo "scale=1; $S*100/$TOTAL" | bc)%)"
  sleep 10
done
[ -f models/parakeet/.complete ] && echo "  download complete" || echo "  download failed"
