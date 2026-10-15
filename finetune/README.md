# Fine-tuning the voice model

LoRA fine-tuning of Llama 3.2 Instruct for the phone agent, measured by the
same harness that grades the product.

```bash
python3 -m venv .venv && .venv/bin/pip install -r finetune/requirements.txt
npm run finetune:data                       # fetch SGD, export prompt+tools, build the set
.venv/bin/python finetune/fetch_base.py 3b  # only where huggingface.co is blocked
.venv/bin/python finetune/train_lora.py --base data/finetune/base/llama3.2-3b --name r16-adamw
.venv/bin/python finetune/export_ollama.py --run r16-adamw   # attaches the adapter to llama3.2:3b
.venv/bin/python finetune/eval_actions.py --model leadgen-llama3.2-ft:r16-adamw
OLLAMA_VOICE_MODEL=leadgen-llama3.2-ft:r16-adamw npm run eval -- --voice --tag r16-adamw
```

With Hugging Face access, skip `fetch_base.py` and pass
`--base meta-llama/Llama-3.2-3B-Instruct` (gated: accept Meta's licence on the
model page, then `hf auth login`).

On an Apple Silicon Mac the trainer runs on the GPU (`mps`) with no flags.

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

## Knobs

`train_lora.py` exposes the parts that change how the weights move:
`--optimizer adamw|lion|sgd|adafactor`, `--rank`, `--alpha`, `--targets
attn|mlp|all`, `--rslora`, `--dora`, `--loraplus <ratio>`, `--lr`, `--clip`,
`--grad-accum`, `--warmup`. Each run writes `metrics.json` with per-step loss,
gradient norm and held-out loss.

## Results

See the bottom of this file; every number there came from a run in this repo.
