# Fine-tuning the voice model

LoRA fine-tuning of Llama 3.2 Instruct for the phone agent, measured by the
same harness that grades the product.

```bash
python3 -m venv .venv && .venv/bin/pip install -r finetune/requirements.txt
npm run finetune:data                       # export kit, script calls, replay them through the voice route, build
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

## Using the published adapter

The 3B adapter trained below is in
[`models/Llama-3.2-3B-Leadgen-Voice-LoRA`](../models/Llama-3.2-3B-Leadgen-Voice-LoRA/)
(fp32, built with Llama). To serve it without training:

```bash
.venv/bin/python finetune/fetch_base.py 3b
.venv/bin/python finetune/export_ollama.py --adapter models/Llama-3.2-3B-Leadgen-Voice-LoRA \
  --tag llama3.2-leadgen-voice:3b --llama-cpp ~/src/llama.cpp
```

## Running it on a Mac

Apple Silicon runs this on the GPU through PyTorch's `mps` backend with no
flags. Measured on an M3 Pro with 18 GB (17 Oct 2026), the 3B trains at
**~128 tokens/s** with an **11 GB** footprint. The set is 3.33M tokens (most
of it the ~2.7k-token system prompt each dialogue carries), so an epoch is
~7 hours; the overnight run below took 0.65 of one.

What it took to get there, all now in `train_lora.py`:

- Weights load straight onto the GPU. Loading to CPU then `.to("mps")` held
  two copies (~13 GB) and macOS killed the process before step 1.
- The allocator's cache is handed back after every backward. PyTorch keeps
  freed GPU blocks for reuse, and with ~1,200 different sequence lengths the
  cache only grew: 17 GB footprint on an 18 GB machine, swapping, 57 tok/s.
- The vocabulary projection runs only where there's a label (~3 GB of fp32
  logits saved at 4k tokens), matching HF's loss to 6e-8.
- Checkpoints every `--save-every` steps, and `--resume` continues on the same
  data order; Ctrl-C or `kill` saves first. Leave `--resume` on the command
  and re-running it is always safe.
- `best/` keeps the adapter with the lowest held-out loss. The overnight run
  bottomed out at step 50 and its weights were gone by morning.

Nothing else should hold the GPU while it trains: Ollama with `llama3.1`
loaded is 11 GB on its own, and that combination was OOM-killed.

```bash
.venv/bin/python finetune/train_lora.py --base data/finetune/base/llama3.2-3b --name 3b-run \
  --loraplus 16 --lr 2e-4 --epochs 0.5 --grad-accum 8 --warmup 8 \
  --eval-every 25 --save-every 5 --max-minutes 345 --resume
bash finetune/after_training.sh 3b-run best     # export final + best, score against stock
```

Exporting needs no `llama-quantize` on a Mac: when it is missing,
`export_ollama.py` lets Ollama quantise the f16 GGUF itself, and the result
is Q4_K_M like stock (verified). Then point the voice line at the winner
(`OLLAMA_VOICE_MODEL=...` in `.env`) and run `npm run eval -- --voice`.

## What it learns from

Since 17 Oct 2026 every training prompt is one production rendered. The
overnight set below was assembled in Python and had drifted: 853 targets
called tools voice no longer offers, every tool was always on offer, tool
results carried across turns. The pipeline now is:

1. `scripts/finetune-export.ts`: prompt kit (tools, each tenant's facts, Gate 2's hold patterns).
2. `finetune/dialogues.py --real-callers`: scripted calls for the three seeded
   tenants (HVAC, immigration, admissions): booking, urgent, objections,
   questions, services not offered, callbacks, outbound. Prices and policies
   come from the tenant's facts; times are filled from the slots the
   calendar note actually offered. About 35% of name turns are real caller
   lines from Taskmaster (below), refilled with names from each market.
3. `scripts/finetune-render.ts`: replays each call through `POST
   /api/voice/stream` with a scripted provider and records what the model is
   handed on every turn: system, per-turn context, history, the tools offered
   on that turn. A planned reply production could not have produced (an
   unoffered tool, a held reply, a turn answered by rule) gives no row, and
   `rendered.report.json` says why.
4. `finetune/build_dataset.py --max-per-kind 40`: Llama text exactly as
   Ollama renders it (`llama_format.py`), three hard checks (no eval
   utterance verbatim or paraphrased, no Gate 2 phrase, no tool the turn did
   not offer), split by dialogue, at most 40 rows of one kind per tenant so
   the booking steps don't swamp objections and facts, packed.

The set built for the next run (600 calls): 2,622 rendered rows, 596 calls
complete (4 "what times do you have?" turns routed without the calendar note,
6 questions the fast path answers by rule); 1,356 train rows (1,267 sequences, 3.05M tokens, longest 3,451) and
324 held-out rows from 71 calls held out by a hash of their id.

Loss is taken only on the assistant's steps. Schema-Guided Dialogue (Google,
CC BY-SA 4.0) and the Python HVAC/conversion generators trained the overnight
run; they were dropped because their prompts were not production's (git
history before this change has them).

### Considered and left out

- **Taskmaster's assistant turns** (Google, CC BY 4.0) have spoken two-person dialogues,
  including auto-repair appointments, but no tool calls. They could only teach
  style, and crowdsourced phrasing is the style the playbook is trying to
  avoid (see `src/server/agent/playbook.ts`). Its *caller* turns are used:
  `python3 finetune/fetch_taskmaster.py` writes `data/finetune/real_callers.json`,
  258 transcribed ways real callers gave a name (and sometimes a number) —
  spelled out, surname first, "under the name…", "area code…" — from the
  train side of a hash split of the woz dialogues. Each row has the caller's
  words, the name and number they gave, and a template for reuse with other
  names. Taskmaster-1: Byrne et al. 2019, CC BY 4.0,
  https://github.com/google-research-datasets/Taskmaster.
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
gradient norm and held-out loss. Keep gradient checkpointing on for these
~3k-token sequences: without it the 1B was killed for memory at ~9 GB.

## Results

Every number here came from a run in this repo, on a 4-core x86 cloud CPU
with no GPU (Intel AMX in use). Latencies on Apple Silicon are far lower;
the ratios are what carry over.

### The overnight conversion run (17 Oct 2026, M3 Pro)

`3b-conv-lp16`: Llama 3.2 3B, LoRA+ (B at 16x), lr 2e-4 with warmup and
cosine decay, rank 16, all seven projections, 97 steps of 8 packed dialogues
(0.65 epoch, 286 minutes at 128 tok/s). The set adds the conversion dialogues
(objections answered with facts, and "no" accepted without a second pitch)
to SGD and the HVAC calls: 1,205 sequences, 5,466 targets.

Held-out loss (24 rows): 1.685 → 0.627 (step 25) → **0.588 (step 50)** →
0.619 (step 75) → 0.599 (step 97), while train loss fell to ~0.1–0.3. It
starts to overfit around half an epoch; the trainer now keeps `best/`.

Held-out next action (`eval_actions.py`, 74 decisions, 3 per kind, through
`/api/chat` exactly as the app calls it):

| | stock | cache-friendly | cache-friendly + LoRA |
|---|---|---|---|
| Right next step | 49% | 65% | **97%** |
| …with the right arguments | 35% | 65% | **96%** |
| Premature bookings | 9 | 3 | **0** |

Stock calls a tool in the middle of almost every objection and books after
2 of 3 price and trust objections; the untuned layout under-calls (never
books after a yes, never qualifies, never escalates). The LoRA gets every
conversion and HVAC kind right; its misses are generic SGD replies that it
turned into tool calls. **These rows come from the same generators as the
training set** (held out by dialogue), so this measures how well it learnt
the behaviour, not how a stranger on the phone will find it.

That is what the live-call eval measures (`npm run eval -- --voice`, 27
hand-written scenarios, leak-checked against the set): **stock 55/60 checks,
LoRA 55/60, a tie**, with the LoRA's turns slower (p50 4.5 s vs 2.7 s).
Both fail two scenarios for routing reasons, not weights (on voice
`qualify_lead` is not offered, and the scheduling gate can withhold
`check_availability`). The LoRA's own misses: it said "definitely", which
Gate 2 holds — 44 training targets taught it that, now impossible (the
build refuses any target Gate 2 would hold) — and it answered a no-heat
emergency kindly but without urgency words.

What the next run should change: about half an epoch, `best/` by held-out
loss, the rebuilt set (no held phrases), emergency replies that say it's
being prioritised, and a live-call score above stock before it replaces
`OLLAMA_VOICE_MODEL`.

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

### Optimisers

The same budget for each on the 1B (4 steps of 2 packed dialogues, identical
data order — every arm's first step had loss 1.2617 and gradient norm 3.875),
scored on the same 8 held-out rows. Untrained: 1.313.

| Optimiser | lr | Held-out loss after 4 steps |
|---|---|---|
| AdamW + LoRA+ (B matrices at 16x) | 2e-4 | **0.619** |
| AdamW | 2e-4 | 0.714 |
| SGD, Nesterov momentum 0.9 | 2e-2 | 1.079 |
| Lion | 3e-5 | 1.218 |

LoRA+ beat plain AdamW by 13% at equal compute, so it is the setting for the
next 3B run (`--loraplus 16`). Four steps and one seed measure how fast each
gets going, not where it ends up, and Lion and SGD ran at rule-of-thumb
learning rates rather than tuned ones — their gap says as much about the lr
as about the optimiser. The LoRA+ adapter, exported through
`export_ollama.py` (merge → GGUF → Q4_K_M → Ollama, 807 MB), called
`check_availability` on the booking probe in `npm run voice:check` that both
untuned 3B builds had failed.

What a longer run should change: the set has only 27 disclosure, 35
unknown-price and 48 escalation examples, so a 4%-of-an-epoch run barely sees
them. A full epoch on a GPU, and more of those branches (`--hvac-dialogues`),
is the next experiment.
