# Llama-3.2-3B-Leadgen-Voice-LoRA

**Built with Llama.** A LoRA adapter for Meta's Llama 3.2 3B Instruct that
teaches the phone agent in this repo when to check availability, when to book,
and when to just talk. It contains only the adapter (24.3M parameters, fp32,
97 MB); the base model is not included.

> Experimental. Trained for 20 optimizer steps, about 4% of one epoch, on a
> CPU. It is measurably better than the base model on this product's eval set
> and also has known regressions, both listed below.

## Use

```bash
python finetune/fetch_base.py 3b          # or pass --base meta-llama/Llama-3.2-3B-Instruct below
python finetune/export_ollama.py --adapter models/Llama-3.2-3B-Leadgen-Voice-LoRA \
  --tag llama3.2-leadgen-voice:3b --llama-cpp ~/src/llama.cpp
# then in .env:  OLLAMA_VOICE_MODEL=llama3.2-leadgen-voice:3b
```

The export merges the adapter into the base, converts it to GGUF and
quantises it to Q4_K_M, the same format as Ollama's stock `llama3.2:3b`, and
serves it with `models/leadgen-llama3.2.Modelfile`'s template, which is the
prompt layout it was trained on. See `finetune/README.md` for prerequisites.

## Training

| | |
|---|---|
| Base | Llama 3.2 3B Instruct (Meta's F16 release) |
| Method | LoRA, rank 16, alpha 32, dropout 0.05, on q/k/v/o/gate/up/down projections |
| Optimizer | AdamW, lr 3e-4, 2 warmup steps, cosine decay, gradient clipping 1.0 |
| Steps | 20 optimizer steps × 2 packed dialogues (40 dialogues, ~116k tokens) |
| Loss | Only on the assistant's own turns (replies and tool calls) |
| Hardware | 4-core x86 CPU, bf16, 80 minutes |
| Held-out loss | 1.629 → 0.509 on assistant steps (same 4 rows before and after) |

Data (built by `finetune/build_dataset.py`; nothing from the eval set):

- **Schema-Guided Dialogue** (Rastogi et al., 2020; Google; CC BY-SA 4.0):
  the salon, dentist, doctor and therapist booking dialogues, mapped onto this
  product's tools. CC BY-SA 4.0 terms may apply to works derived from it.
- **Synthetic calls** to the repo's seeded HVAC tenant, written for this
  project, rendered with the production system prompt.

## Evaluation

On this repo's harnesses, Q4_K_M served through Ollama, against the untuned
model with the same template:

| | untuned | this adapter |
|---|---|---|
| Held-out next action (34 decisions) | 59% | 74% |
| ...with correct arguments | 59% | 71% |
| Voice scenarios passed (21) | 16 | 20 |

These are the exact fp32 weights that were measured (`adapter_model.safetensors`
sha256 `655b9a16…`). A bf16 copy, half the size, scored 22/34 instead of
25/34 on the held-out decisions: re-scoring the fp32 model reproduced 25/34
exactly, so the drop was the rounding, amplified by 4-bit quantisation. Keep
the fp32 file.

Known regressions: it books a requested time without reading it back first
on some SGD-style turns, and it reaches for a tool on unknown-price and
"are you a person?" questions. The product answers the latter
deterministically, so that one no longer reaches the model.

Full numbers and method: `CHANGES_REPORT.md` and `finetune/README.md`.

## License

Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright © Meta
Platforms, Inc. All Rights Reserved. This adapter is distributed under the
same agreement: see `LICENSE`, `NOTICE` and the Acceptable Use Policy in
`USE_POLICY.md`, which apply to any use of it.
