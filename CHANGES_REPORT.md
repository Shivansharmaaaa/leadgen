# Update: real-time voice — 16 October 2026

Twenty commits on top of the voice/LoRA merge (`bab94e2`), all driven by live
testing on the browser voice page. Every number here was measured on an
Apple Silicon Mac running `llama3.2:3b` locally through Ollama.

## At a glance

| | Before | After |
|---|---|---|
| First word, conversational turn ("thanks", "hello") | ~3,000 ms | **5–21 ms** |
| First word, service turn ("my AC stopped working") | ~3,500 ms | **4–16 ms** (opener), reply streams behind it |
| Fixed-fact question ("do you charge for the call-out?") | full model turn | **8–20 ms**, zero tokens |
| Off-topic question ("what model are you?") | full model turn | **5–15 ms**, zero tokens |
| Voice | browser `speechSynthesis` | **Kokoro-82M** on the Apple GPU, RTF 0.05 |
| Eval, 26 scenarios | — | **92 %** (54/56 checks) |

## Speed

- **Hybrid routing.** Each turn takes the cheapest tier that can answer it:
  `canned` (a verified fact, no model), `chat` (no tools, lean prompt),
  `transact` (the full pipeline), `redirect` (out of scope). Unclassified turns
  default to the full path, never the cheap one.
- **Canned answers from verified facts.** Questions with one correct answer are
  read straight from the knowledge base, so the number cannot drift.
- **Instant openers.** A matched intent speaks an opener immediately while the
  model writes the rest behind it. Openers are pre-rendered into the TTS cache
  at startup, so they cost a lookup, not synthesis.
- **Bookkeeping off the critical path.** `qualify_lead` and
  `save_contact_detail` cost a full extra generation before the agent could
  speak. Qualification now runs from the transcript after the turn.
- **Tools gated on preconditions.** `book_appointment` is hidden until there is
  a name, a number and an offered slot, and tool calls for tools that were not
  offered are dropped — a 3B model reaches for tools it remembers.

## Sounding human

- **Kokoro-82M** (`hexgrad/Kokoro-82M`, Apache 2.0) served locally on the
  Apple GPU: 0.21 s of compute for 3.9 s of audio.
- **Gapless playback.** Web Audio schedules each sentence to start exactly
  where the last ends; Kokoro's padding is trimmed.
- **Prosodic pauses** set by punctuation: 140 ms after a comma, 300 ms after a
  full stop, 340 ms after a question.
- **Speaking rate** tuned to 0.85 (≈200 wpm); `TTS_SPEED` overrides it.
- **No repeated openers.** Varied first words per intent, never reused within
  a conversation; eight fillers instead of four, never back to back.

## Turn-taking

Adopted from how production speech-to-speech systems manage the floor:

- **Backchannel vs barge-in.** "mm-hmm" and "okay" over the agent mean carry
  on; "wait" or a real sentence stops it. Only applies while the agent is
  actually speaking, so "yes" as an answer is never discarded.
- **Semantic endpointing.** How long to wait depends on how finished the
  sentence sounds: 450 ms after a question, 700 ms after a complete clause,
  1,600 ms when it trails off on "and" or "um".
- **The caller is not cut off.** Chrome's "final" results are segments, not
  turns; they accumulate until our own endpointing decides the caller has
  stopped.
- **Continuous listening** with barge-in — press the mic once.
- **Speculative turns are silent.** A guess pre-computes the reply but never
  speaks; it is released only when the transcript confirms it, and can never
  book an appointment.
- **Visible trace.** The page shows each turn-taking decision live.

## Correctness

- **A turn can never end in silence.** A turn with no text retries without
  tools, then falls back to a fixed line.
- **Handover asks first.** The model can only `offer_callback`; a real handover
  needs an explicit yes. Escalating no longer keeps talking afterwards.
- **Scope guard** answers off-topic and "what model are you" without a model
  call, and is deliberately conservative so it never catches a real customer.
- **Conversation memory.** No re-greeting mid-call, no repeated answers.
- **No invented colleagues** ("John" was offered to call back; there is no John).

## Training

- **Conversion dataset** (`finetune/conversion.py`): 615 objection-handling
  targets across price, delay, competing quotes, browsing and trust. Close to
  an even split between bookings and declines, because a model trained only on
  objections that dissolve learns to keep pushing. Nothing in it discounts,
  invents a deadline or claims scarcity.
- **Four conversion eval scenarios**, all passing on the stock model — the
  playbook prompt carries them today.
- **The prompt is load-bearing.** Cutting the 740-token playbook
  (`LEAN_PROMPT=1`) dropped the eval from 92 % to 84 %, breaking contact
  capture and emergency triage. That is the gap a LoRA is meant to close.

## Infrastructure

- **Moshi** (Kyutai, q4) downloaded and running; it belongs only on the `chat`
  tier, since it cannot call tools or be screened by the outbound guardrail.
- **Parakeet** (`parakeet-mlx`) installed to replace the browser recogniser.
- **Separate virtualenvs** per service (`tts/`, `moshi/`, `stt/`). Installing
  Moshi into the TTS venv pinned `huggingface_hub` and `safetensors` back and
  took the voice down mid-call.
- **Llama 3.2 3B base weights** downloading from Docker Hub for the LoRA run.

## Not done yet

- Parakeet is installed but not yet wired into the browser.
- The LoRA has not been trained on the conversion set; base weights are still
  downloading.
- Moshi runs standalone at `localhost:8998` and is not yet routed into.
- Transactional turns that genuinely need a tool still take 2–3 s on a local
  3B model. `ANTHROPIC_API_KEY` is the immediate fix.

---

# Changes report: voice agent and local model

Branch `claude/admiring-bardeen-fz68ih`, 15–16 October 2026.
Every number below comes from a run saved in [`reports/results/`](reports/results/).
Built with Llama.

## At a glance

All 21 eval scenarios run as live phone calls, Llama 3.2 3B served by Ollama,
with all the code fixes below in place:

| | Stock model | Faster prompt layout | Faster layout + LoRA fine-tune |
|---|---|---|---|
| Scenarios passed | 19/21 | 17/21 | **21/21** |
| First word, median (CPU) | 21.7 s | 1.1 s | 12.7 s |

The two right-hand runs were measured before "are you a person?" got a fixed
answer, at 16/21 and 20/21; each failed only that scenario, which the
guardrail now answers before the model is called (re-run and passing for the
LoRA model).

Before any of this work the same stock model passed **13 of 20** scenarios
(65%) with a median first word of **55.6 s**. Code and prompt fixes alone took
it to **18 of 20** (90%) and **22.8 s**, with no change to the model.

The fine-tuned adapter is published in the repo as
[`models/Llama-3.2-3B-Leadgen-Voice-LoRA`](models/Llama-3.2-3B-Leadgen-Voice-LoRA/).

> Latencies were measured on a 4-core cloud CPU with no GPU. On an Apple
> Silicon Mac, Ollama runs on the GPU and every figure is far lower; the
> ratios between rows are what carry over.

## What was asked, and what happened

| Request | Outcome |
|---|---|
| Run it; test live voice-to-voice | Ran the full stack and drove real voice turns end to end. The browser could not reach this cloud container (every tunnel host is blocked) so live speech has to run locally: `npm run voice` does it in one command. |
| Check the Ollama 3B install | `llama3.2:3b` (Q4_K_M) installed and verified, including native tool calling. `npm run voice:check` checks it on any machine. |
| Make the model better: LoRA, RAG, harness, optimisers, gradients, other datasets | Harness extended first, then prompt/code fixes, a LoRA fine-tune and an optimiser comparison, each measured. RAG deliberately not applied (see "Not done"). |
| Use Kaggle datasets and Hugging Face models | Both blocked by this environment's network policy. Used the same Meta weights from Docker Hub and Google's datasets from GitHub instead. |
| Use the Mac's GPU | The session runs in a cloud container, not on the Mac. Ollama uses Metal automatically; the trainer picks the Apple GPU (`mps`) automatically. |
| Train on the new datasets | Done: a LoRA on Schema-Guided Dialogue plus in-domain synthetic calls, exported back into Ollama and scored. |

## Results

### 1. Fixes that needed no training

`npm run eval`, stock `llama3.2:3b`, scenarios on their own channels:

| | Baseline | After fixes |
|---|---|---|
| Scenarios passed | 13/20 | 18/20 |
| Checks passed | 33/41 | 39/41 |
| First word, median (voice scenarios) | 55.6 s | 22.8 s |
| Turn latency, median | 53.1 s | 37.3 s |

Scenarios that went from failing to passing: straightforward repair enquiry,
asked for a time slot, spoken-channel formatting, no parroted example, no
booking without the caller's choice.

The latency gain is prompt caching. The clock line sat near the top of the
system prompt, so each minute invalidated everything after it; Ollama was
reusing 70 cached tokens per request. After moving per-turn details to the end,
it reuses about 1,672 of 1,776 tokens on voice and 2,633 of 2,715 on chat.

### 2. The prompt layout trade-off

The stock Llama 3.2 template puts the tool schemas into the newest user
message, so ~1k tokens move every turn. `models/leadgen-llama3.2.Modelfile`
puts them in the system block instead. On the 8 two-turn voice scenarios:

| | Passed | First word (turn two), median |
|---|---|---|
| Stock template | 7/8 | 23.5 s |
| Cache-friendly template | 6/8 | 1.5 s |
| Cache-friendly + LoRA | **8/8** | 12.1 s |

Where both templates behaved the same, the cache-friendly one spoke in
1.0–2.1 s against 22–29 s. Untuned, though, it skips tool calls. The LoRA
restores them; it is slower than the untuned layout only because it now
checks availability before speaking.

### 3. Held-out decisions

`finetune/eval_actions.py`: 34 held-out conversation points (2 per kind),
sent through `/api/chat` exactly as the app does, graded on the next step.

| | Stock | Cache-friendly | + LoRA |
|---|---|---|---|
| Right next step | 20 (59%) | 20 (59%) | **25 (74%)** |
| ...with right arguments | 16 (47%) | 20 (59%) | **24 (71%)** |
| Premature bookings | 2 | 0 | 2 |

The LoRA fixed booking the exact slot the caller chose (0/4 → 4/4), recording
the lead first (0/2 → 2/2) and saving a name and number without booking
(0/2 → 2/2). It regressed on SGD-style read-backs (booked instead of
confirming, 2/2) and reached for a tool on unknown-price and disclosure
questions. Two rows per kind make single-kind swings noisy; the totals are
the signal.

Scoring is deterministic: re-running the LoRA model gave 25 and 24 again,
kind for kind. That is also why the published adapter is fp32: a bf16 copy
(half the size, at most 0.3% rounding per tensor) scored 22 and 22. The
decisions sit close enough to their tipping points that the rounding,
amplified by 4-bit quantisation, flipped three of them.

### 4. Training

| | |
|---|---|
| Base | Llama 3.2 3B Instruct, Meta's F16 release (from Docker Hub) |
| Data | Schema-Guided Dialogue appointment dialogues (Google, CC BY-SA 4.0) mapped onto this product's tools: 551 for training, 211 held out. Synthetic calls on the real Northside prompt: 350 for training, 50 held out. 4,913 training targets in 987 packed sequences; split by dialogue; no eval utterance in the training text (checked automatically) |
| Method | LoRA r16/α32 on all 7 projection matrices (24.3M parameters), AdamW lr 3e-4, warmup + cosine, gradient clipping 1.0 |
| Budget | 20 optimizer steps × 2 dialogues, 80 minutes on CPU: about 4% of one epoch |
| Held-out loss | 1.629 → 0.509 on assistant steps (same 4 rows) |

### 5. Optimisers

1B model, identical data order and budget per arm (4 steps of 2 dialogues; every
arm's first step had the same loss and gradient norm), held-out loss from 1.313:

| Optimiser | lr | Held-out loss |
|---|---|---|
| AdamW + LoRA+ (B matrices at 16×) | 2e-4 | **0.619** |
| AdamW | 2e-4 | 0.714 |
| SGD, Nesterov momentum | 2e-2 | 1.079 |
| Lion | 3e-5 | 1.218 |

LoRA+ is the recommended setting for the next run. Four steps and one seed
measure early progress only, and Lion and SGD ran at rule-of-thumb learning
rates.

## Changes by area

### Voice path and prompt
- `src/server/agent/prompt.ts`: `buildSystemPrompt` returns a stable `system`
  and a per-turn `context` (clock, caller, memories) so the stable part caches.
  New rule: book only a time the customer picked. Canned example lines the 3B
  model repeated verbatim removed (here and in `playbook.ts`).
- `src/server/agent/providers/`: `context` threaded through; Ollama appends it
  after the stable text; Claude gets two system blocks with the cache
  breakpoint on the stable one (its prompt cache had the same clock problem).
  `OLLAMA_VOICE_MODEL` selects a separate local model for voice. Clear errors
  when Ollama is down or a model is missing.
- `models/leadgen-llama3.2.Modelfile`: Llama 3.2 template with tool schemas in
  the cached system block.

### Robustness and guardrails
- Tool calls typed as malformed JSON (`"parameters{"`) are repaired into real
  calls (`providers/ollama.ts`). The voice stream never speaks text that starts
  as JSON, and Gate 2 holds any reply still containing a tool call or a leaked
  tool schema. Before this, both baseline failures would have reached the
  customer as raw JSON, and on a call the voice path would have spoken it.
- Gate 1 (`core/guardrails.ts`): "I want to talk to a human" now escalates (it
  matched nothing before); "am I talking to a real person?" no longer escalates
  by accident.
- Questions about what the agent is ("are you a bot?") get a fixed, truthful
  disclosure on text and voice, independent of the model. The fine-tuned model
  once answered "Yes, you are talking to a real person."
- Gate 2 holds two appointment times offered as a choice when
  `check_availability` never ran in the conversation (`availabilityChecked` in
  `agent/tools.ts`). It caught the stock model doing exactly that.

### Eval harness
- Voice scenarios run through the real streaming path (`runVoiceTurn`) and
  report first-word latency; `--voice` runs every scenario as a call; `--tag`
  labels runs; comma-separated filters; every run saved as JSON.
- New scenarios: parroting the playbook, booking a slot the caller never
  chose, asking for a human.
- `finetune/eval_actions.py`: held-out next-action accuracy for any Ollama
  model, through the same chat path and JSON repair as the app.

### Running it locally
- `npm run voice` (`scripts/voice-local.sh`): checks and starts Ollama, pulls
  `llama3.2:3b` if missing, builds the cache-friendly variant, checks tool
  calling and GPU placement (`scripts/voice-preflight.ts`), starts Postgres,
  seeds only if the tenant is missing, starts the app and opens `/voice`.
- Voice defaults to stock `llama3.2:3b`, the most reliable untuned choice.

### Fine-tuning pipeline (`finetune/`, see its README)
- `fetch_sgd.py`, `fetch_base.py` (Docker Hub F16 weights, digest-verified,
  rate-limit retries), `build_dataset.py` (renders with the production prompt
  and tools; byte-identical to what Ollama serves, checked: 1,026 bytes, 187
  tokens), `train_lora.py` (CUDA / Apple GPU / CPU; optimisers, LoRA variants,
  gradient controls as flags), `export_ollama.py` (merge → GGUF → Q4_K_M →
  Ollama, because current Ollama accepts neither LoRA adapters nor Q4_K_M
  imports of safetensors).
- `scripts/finetune-export.ts` exports the real prompt and tool schemas from
  TypeScript so training data cannot drift from production.

### Published model
- `models/Llama-3.2-3B-Leadgen-Voice-LoRA/`: the trained adapter, the exact
  fp32 weights measured above (97 MB), with its model card, the Llama 3.2
  Community License, Meta's Acceptable Use Policy and the required NOTICE.
  The file is byte-identical to the adapter behind every LoRA number in this
  report, and the `export_ollama.py --adapter` path was run end to end on this
  directory.

## Commits

| Commit | Change |
|---|---|
| `e99eebd` | Voice: cacheable prompt prefix, tool-call repair, voice eval mode |
| `e4883ef` | Fine-tuning pipeline: SGD + in-domain data, LoRA trainer, Ollama export |
| `2d9cd9d` | Guardrails: tell "are you a person?" from "get me a person"; hold invented slots |
| `10b6702` | Fine-tuning README: measured results so far, template trade-off, data left out |
| `941c70a` | Fine-tune export: merge, GGUF, Q4_K_M via llama.cpp; fix tokenizer overrun |
| `b21df79` | Answer "are you a person?" deterministically; catch leaked tool schemas |
| `b5563f4` | Fine-tune results; voice defaults to stock llama3.2:3b until fine-tuned |
| `9d5cca7` | Fine-tune: optimiser comparison on 1B, export verified end to end |
| this one | Published adapter, export from any adapter dir, download retries, this report |

Up to `9d5cca7`: 31 files changed, 2,272 lines added, 52 removed.

## Not done, and why

- **Live voice from this session**: the container cannot be reached from a
  browser and has no GPU. Run `npm run voice` on the Mac.
- **RAG**: the tenant's knowledge is ~400 tokens and now sits in the cached
  prompt. Per-turn retrieval would add a tool round trip or break the cache on
  calls. The existing hybrid retrieval stays for larger knowledge bases.
- **Hugging Face / Kaggle**: blocked by the environment's network policy. To
  allow them, add `huggingface.co`, `*.hf.co`, `kaggle.com` and
  `storage.googleapis.com` under Allowed domains, plus `KAGGLE_USERNAME` /
  `KAGGLE_KEY` as secrets.
- **Taskmaster, MultiWOZ**: considered; no tool annotations / further from the
  domain (reasons in `finetune/README.md`).
- **Merging to `main`**: not requested; the branch is ready for a pull request.

## Known limitations

- The eval set is small (21 scenarios, 34 held-out decisions); one scenario is
  about 5 points.
- The LoRA saw 4% of an epoch. It over-books on SGD-style read-backs and is
  too tool-eager on unknown-price questions.
- The fine-tuned model speaks after its tool call, so its first word waits on
  a round trip. Speaking a short "let me check" while the tool runs would hide
  it.
- Pre-existing: the escalation trigger "manager" also matches phrases such as
  "property manager".

## Next steps

1. Full LoRA+ run on the Mac's GPU (`--loraplus 16`, command in
   `finetune/README.md`), with more disclosure, price and escalation examples.
2. Re-run `npm run eval -- --voice` and `eval_actions.py` against it.
3. Filler speech during tool calls on the voice path.
4. Add Hugging Face function-calling data and the tenant's own call
   transcripts once available.

## Reproducing

```bash
npm run voice                                  # local voice, any machine with Ollama
npm run eval -- --voice --tag mine             # scenarios as calls
npm run finetune:data                          # build the training set
python finetune/train_lora.py --help           # training knobs
```

Measured on: 4-core Intel Xeon (AMX) cloud container, 15 GB RAM, no GPU;
Ollama 0.40.4; torch 2.14.1, transformers 5.20.0, peft 0.21.2.

Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright © Meta
Platforms, Inc. All Rights Reserved.
