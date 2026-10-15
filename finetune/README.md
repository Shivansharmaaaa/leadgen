# Fine-tuning the voice model

LoRA fine-tuning of Llama 3.2 Instruct for the phone agent, measured by the
same harness that grades the product.

```bash
python3 -m venv .venv && .venv/bin/pip install -r finetune/requirements.txt
npm run finetune:data                       # fetch SGD, export prompt+tools, build the set
.venv/bin/python finetune/fetch_base.py 3b  # only where huggingface.co is blocked
.venv/bin/python finetune/train_lora.py --base data/finetune/base/llama3.2-3b --name r16-adamw
.venv/bin/python finetune/export_ollama.py --run r16-adamw --llama-cpp ~/src/llama.cpp  # merge -> GGUF -> Q4_K_M -> Ollama
.venv/bin/python finetune/eval_actions.py --model leadgen-llama3.2-ft:r16-adamw
OLLAMA_VOICE_MODEL=leadgen-llama3.2-ft:r16-adamw npm run eval -- --voice --tag r16-adamw
```

Exporting needs llama.cpp's converter and `llama-quantize`, because current
Ollama accepts neither LoRA adapters nor Q4_K_M quantisation of safetensors,
and a fine-tune is only comparable to its baseline at the same quantisation:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/ggml-org/llama.cpp ~/src/llama.cpp
git -C ~/src/llama.cpp sparse-checkout set --no-cone /convert_hf_to_gguf.py /conversion/ /gguf-py/
brew install llama.cpp   # Mac: provides llama-quantize (Ollama's Linux build ships its own)
```

With Hugging Face access, skip `fetch_base.py` and pass
`--base meta-llama/Llama-3.2-3B-Instruct` (gated: accept Meta's licence on the
model page, then `hf auth login`).

On an Apple Silicon Mac the trainer runs on the GPU (`mps`) with no flags.

## Running it on a Mac

Apple Silicon runs this on the GPU through PyTorch's `mps` backend with no
flags. A full epoch over the packed set is ~3M tokens, most of it the ~2.4k-
token system prompt each dialogue carries. The CPU box these results came
from managed ~23 tokens/s, so it only ever trained on a slice. Mac throughput
was not measured here; the trainer prints tokens/s from the first step, so
start with a quarter epoch and a time cap and scale from what it reports:

```bash
.venv/bin/python finetune/train_lora.py --base meta-llama/Llama-3.2-3B-Instruct \
  --name 3b-full --epochs 0.25 --max-minutes 90 --grad-accum 8 --lr 2e-4 --eval-every 25
.venv/bin/python finetune/export_ollama.py --run 3b-full --llama-cpp ~/src/llama.cpp
.venv/bin/python finetune/eval_actions.py --model leadgen-llama3.2-ft:3b-full --per-kind 6
```

Then point the voice line at it: `OLLAMA_VOICE_MODEL=leadgen-llama3.2-ft:3b-full`
in `.env`, and re-run `npm run eval -- --voice` to compare with the stock build.

## What it learns from

| Source | What it teaches | Size |
|---|---|---|
| [Schema-Guided Dialogue](https://github.com/google-research-datasets/dstc8-schema-guided-dialogue) (Google, CC BY-SA 4.0): salon, dentist, doctor and therapist booking | Check availability before reading a time back; book only after a yes; re-confirm after a no; recover when the slot was taken | 762 dialogues |
| Synthetic calls to the seeded HVAC tenant | Acknowledge the caller's own details; a name and number is not a yes to a time; escalate, don't quote unknown prices, disclose being an AI | 400 dialogues |

Every example is rendered with the production system prompt
(`scripts/finetune-export.ts` calls `buildSystemPrompt`) and the production
voice tools, in the exact layout of `models/leadgen-llama3.2.Modelfile`. The
renderer was checked against Ollama byte for byte. The build refuses to run if
any eval-set utterance appears in the training text.

Splits are by dialogue: SGD's own train split trains; its dev and test splits
are held out. Loss is taken only on the assistant's steps. Dialogues are packed
so each one is read once with all its targets, rather than once per target.

### Considered and left out

- **Taskmaster** (Google, CC BY 4.0) has spoken two-person dialogues,
  including auto-repair appointments, but no tool calls. It could only teach
  style, and crowdsourced phrasing is the style the playbook is trying to
  avoid (see `src/server/agent/playbook.ts`).
- **MultiWOZ**: hotel and restaurant booking, further from the domain than
  SGD's services and with less consistent annotation.
- **Hugging Face / Kaggle** sets were unreachable from the environment this
  was built in. With access, the obvious next additions are a large
  function-calling corpus (e.g. `Salesforce/xlam-function-calling-60k`) mixed
  in at a low ratio to keep general tool-use from narrowing, and real call
  transcripts from the tenant's own inbox once there are enough of them —
  the only data a competitor cannot copy.

## Knobs

`train_lora.py` exposes the parts that change how the weights move:
`--optimizer adamw|lion|sgd|adafactor`, `--rank`, `--alpha`, `--targets
attn|mlp|all`, `--rslora`, `--dora`, `--loraplus <ratio>`, `--lr`, `--clip`,
`--grad-accum`, `--warmup`. Each run writes `metrics.json` with per-step loss,
gradient norm and held-out loss.

## Results

Every number here came from a run in this repo, on a 4-core x86 cloud CPU
with no GPU (Intel AMX in use). Latencies on Apple Silicon are far lower;
the ratios are what carry over.

### Before training: the fixes that needed no weights

`npm run eval`, llama3.2:3b, stock template, 20 scenarios:

| | Baseline | After prompt + tool-call fixes |
|---|---|---|
| Scenarios passed | 13/20 (65%) | 18/20 (90%) |
| Checks passed | 33/41 | 39/41 |
| First word, p50 (voice scenarios) | 55.6 s | 22.8 s |
| Turn latency, p50 | 53.1 s | 37.3 s |

What moved it: the per-turn context moved behind the cacheable prompt (KV
reuse went from 70 tokens to ~95% of the prompt), the playbook stopped
carrying lines a 3B model repeats verbatim, malformed tool-call JSON is
repaired instead of being sent, and a booking rule.

### The template trade-off

`npm run eval -- --voice` on the eight two-turn scenarios, turn-two first word:

| Template | Passed | First word p50 |
|---|---|---|
| stock llama3.2:3b (tools in the last user message) | 7/8 | 23.5 s |
| `models/leadgen-llama3.2.Modelfile` (tools in the system block) | 6/8 | 1.5 s |

On the seven scenarios where both behaved the same, the cache-friendly layout
spoke in 1.0-2.1 s against 22-29 s: the stock template moves ~1k tokens of
tool schemas to the newest message every turn, so the whole conversation is
re-read. The price is that the untuned model calls `check_availability` less
often in that layout — which is exactly what the fine-tuning set teaches, in
exactly that layout.

### The fine-tune

One LoRA run on the 3B, time-boxed for a CPU: AdamW, lr 3e-4 with warmup and
cosine decay, rank 16, alpha 32, all seven projection matrices (24.3M
trainable parameters, 0.75%), gradient clipping at 1.0, 20 optimizer steps of
2 packed dialogues each. That is 40 dialogues, about 4% of one epoch, in 80
minutes. Held-out loss on assistant steps (same four rows, before and after):
**1.629 → 0.509**. Served from Ollama as Q4_K_M, the same quantisation as the
stock model, with the cache-friendly template.

Held-out next action (`eval_actions.py`, 34 decisions, 2 per kind, through
`/api/chat` exactly as the app calls it):

| | stock | cache-friendly | cache-friendly + LoRA |
|---|---|---|---|
| Right next step (tool vs. reply, which tool) | 59% | 59% | **74%** |
| ...with the right arguments (exact slot, date, details) | 47% | 59% | **71%** |
| Premature bookings | 2 | 0 | 2 |

The untuned models fail in opposite directions. Stock over-calls: it
booked when the caller only gave a name and number. The cache-friendly
layout under-calls: it never booked after an explicit yes. The LoRA fixed
booking the exact chosen slot (0/4 → 4/4), recording the lead first
(0/2 → 2/2) and saving details without booking (0/2 → 2/2). It also became
more tool-eager where it saw few examples: SGD read-backs turned into
bookings (2/2) and it stopped answering AI-disclosure and unknown-price
questions in prose. With 2 rows per kind, single-kind swings are noise; the
totals are 5 more correct decisions out of 34.

All 21 scenarios as live calls (`npm run eval -- --voice`):

| | stock | cache-friendly | cache-friendly + LoRA |
|---|---|---|---|
| Scenarios passed | 19/21 (90%)* | 16/21 (76%) | **20/21 (95%)** |
| ...with the disclosure fix applied to all three | 19/21 | 17/21 | **21/21** |
| First word, p50 | 21.7 s | 1.1 s | 12.7 s |

\* The stock run came after the disclosure fix below, so its disclosure pass
is Gate 1's. One of its two failures is the new invented-slot guard working:
it offered two times without checking availability.

The LoRA fixed every tool failure of the untuned layout (lead recorded on
repair and emergency calls, availability checked before offering times). Its
one failure was the worst kind: asked "am I talking to a real person?", it
said yes. That question is now answered by Gate 1 with a fixed disclosure on
every model, and the scenario passes. Its first word is slower than the
untuned layout's because it now makes the tool call it should, then speaks;
the untuned model was fast largely by skipping it.

What a longer run should change: the set has only 27 disclosure, 35
unknown-price and 48 escalation examples, so a 4%-of-an-epoch run barely sees
them. A full epoch on a GPU, and more of those branches (`--hvac-dialogues`),
is the next experiment.
