"""
LoRA fine-tune Llama 3.2 on the packed voice-agent set.

    python finetune/train_lora.py --base data/finetune/base/llama3.2-3b --name r16-adamw
    python finetune/train_lora.py --base meta-llama/Llama-3.2-3B-Instruct --name r16-adamw

Device is picked automatically: CUDA, then Apple's GPU (mps), then CPU. On an
M-series Mac this runs on the GPU with no flags.

Every knob that changes how the weights move is a flag, so optimiser and
adapter comparisons are runs, not code edits:

  --optimizer adamw | lion | sgd | adafactor
  --rank / --alpha / --dropout / --targets attn|mlp|all
  --rslora        scale by alpha/sqrt(r) so higher ranks still learn
  --dora          weight-decomposed LoRA (magnitude + direction)
  --loraplus 16   B matrices at 16x the learning rate of A (LoRA+)
  --clip / --grad-accum / --warmup / --lr

Loss is taken only on the assistant's own steps (the spans recorded by
build_dataset.py), never on the prompt, the caller, or tool results.
Writes the adapter and a metrics history to data/finetune/runs/<name>/.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data/finetune"
TARGETS = {
    "attn": ["q_proj", "k_proj", "v_proj", "o_proj"],
    "mlp": ["gate_proj", "up_proj", "down_proj"],
    "all": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
}


def pick_device(requested: str) -> torch.device:
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class Lion(torch.optim.Optimizer):
    """Sign-of-momentum update (Chen et al. 2023). Wants ~3-10x lower lr than AdamW."""

    def __init__(self, params, lr=1e-4, betas=(0.9, 0.99), weight_decay=0.0):
        super().__init__(params, dict(lr=lr, betas=betas, weight_decay=weight_decay))

    @torch.no_grad()
    def step(self):
        for group in self.param_groups:
            b1, b2 = group["betas"]
            for p in group["params"]:
                if p.grad is None:
                    continue
                state = self.state[p]
                if "m" not in state:
                    state["m"] = torch.zeros_like(p)
                m = state["m"]
                update = (m * b1 + p.grad * (1 - b1)).sign_()
                if group["weight_decay"]:
                    p.mul_(1 - group["lr"] * group["weight_decay"])
                p.add_(update, alpha=-group["lr"])
                m.mul_(b2).add_(p.grad, alpha=1 - b2)


def build_optimizer(name: str, groups: list[dict], lr: float):
    if name == "adamw":
        return torch.optim.AdamW(groups, lr=lr, betas=(0.9, 0.999), weight_decay=0.0)
    if name == "lion":
        return Lion(groups, lr=lr)
    if name == "sgd":
        return torch.optim.SGD(groups, lr=lr, momentum=0.9, nesterov=True)
    if name == "adafactor":
        from transformers.optimization import Adafactor
        return Adafactor(groups, lr=lr, relative_step=False, scale_parameter=False, warmup_init=False)
    raise ValueError(name)


def encode(tokenizer, text: str, spans: list[list[int]], max_len: int):
    """Token ids plus labels that are -100 everywhere except the target spans."""
    enc = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    ids, offsets = enc["input_ids"], enc["offset_mapping"]
    if len(ids) > max_len:
        return None
    labels = [-100] * len(ids)
    for i, (s, _e) in enumerate(offsets):
        if any(a <= s < b for a, b in spans):
            labels[i] = ids[i]
    return torch.tensor(ids), torch.tensor(labels)


def lr_at(step: int, total: int, warmup: int, peak: float) -> float:
    if step < warmup:
        return peak * (step + 1) / warmup
    progress = (step - warmup) / max(1, total - warmup)
    return peak * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * progress)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--optimizer", default="adamw", choices=["adamw", "lion", "sgd", "adafactor"])
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--alpha", type=float, default=32)
    ap.add_argument("--dropout", type=float, default=0.05)
    ap.add_argument("--targets", default="all", choices=sorted(TARGETS))
    ap.add_argument("--rslora", action="store_true")
    ap.add_argument("--dora", action="store_true")
    ap.add_argument("--loraplus", type=float, default=1.0, help="lr multiplier for lora_B (LoRA+)")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--max-steps", type=int, default=0, help="optimizer steps; overrides --epochs")
    ap.add_argument("--max-minutes", type=float, default=0, help="stop early on a wall-clock budget")
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--clip", type=float, default=1.0)
    ap.add_argument("--warmup", type=int, default=10)
    ap.add_argument("--max-len", type=int, default=4096)
    ap.add_argument("--limit-train", type=int, default=0, help="use only the first N packed sequences")
    ap.add_argument("--eval-rows", type=int, default=48)
    ap.add_argument("--eval-every", type=int, default=25)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--no-grad-checkpoint", action="store_true")
    ap.add_argument("--no-initial-eval", action="store_true", help="skip the step-0 eval (same for every run on a base)")
    ap.add_argument("--eval-only", action="store_true", help="report the base model's held-out loss and exit")
    args = ap.parse_args()

    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = pick_device(args.device)
    dtype = torch.bfloat16 if device.type in ("cpu", "cuda", "mps") else torch.float32
    if device.type == "cpu":
        torch.set_num_threads(max(1, torch.get_num_threads()))
    out = DATA / "runs" / args.name
    out.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    train_rows = [json.loads(l) for l in open(DATA / "train_packed.jsonl")]
    if args.limit_train:
        train_rows = train_rows[: args.limit_train]
    train = [e for r in train_rows if (e := encode(tokenizer, r["text"], r["spans"], args.max_len))]
    print(f"train: {len(train)} sequences ({len(train_rows) - len(train)} over {args.max_len} tokens dropped), "
          f"{sum(int((l != -100).sum()) for _, l in train)} target tokens")

    valid_rows = [json.loads(l) for l in open(DATA / "valid.jsonl")]
    random.Random(1).shuffle(valid_rows)
    valid = []
    for r in valid_rows:
        e = encode(tokenizer, r["prompt"] + r["completion"], [[len(r["prompt"]), len(r["prompt"]) + len(r["completion"])]],
                   args.max_len)
        if e:
            valid.append(e)
        if len(valid) >= args.eval_rows:
            break

    model = AutoModelForCausalLM.from_pretrained(args.base, dtype=dtype).to(device)
    model.config.use_cache = False
    if not args.no_grad_checkpoint:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(
        r=args.rank, lora_alpha=args.alpha, lora_dropout=args.dropout, target_modules=TARGETS[args.targets],
        use_rslora=args.rslora, use_dora=args.dora, task_type="CAUSAL_LM",
    ))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"device {device}  dtype {dtype}  trainable {trainable / 1e6:.1f}M params "
          f"({100 * trainable / sum(p.numel() for p in model.parameters()):.2f}%)")

    a_params = [p for n, p in model.named_parameters() if p.requires_grad and "lora_B" not in n]
    b_params = [p for n, p in model.named_parameters() if p.requires_grad and "lora_B" in n]
    groups = [{"params": a_params, "lr_scale": 1.0}, {"params": b_params, "lr_scale": args.loraplus}]
    opt = build_optimizer(args.optimizer, groups, args.lr)

    total = args.max_steps or max(1, int(len(train) * args.epochs / args.grad_accum))
    order = [i for _ in range(math.ceil(args.epochs) + 1) for i in random.sample(range(len(train)), len(train))]

    def evaluate() -> float:
        model.eval()
        losses = []
        with torch.no_grad():
            for ids, labels in valid:
                losses.append(model(input_ids=ids[None].to(device), labels=labels[None].to(device)).loss.item())
        model.train()
        return sum(losses) / len(losses)

    history = {"args": vars(args), "steps": [], "evals": []}
    if args.eval_only:
        print(f"step    0  valid {evaluate():.4f}")
        return
    if not args.no_initial_eval:
        v0 = evaluate()
        history["evals"].append({"step": 0, "valid_loss": v0})
        print(f"step    0  valid {v0:.4f}")

    model.train()
    t0, seen_tokens, cursor, ewma = time.time(), 0, 0, None
    for step in range(total):
        lr = lr_at(step, total, args.warmup, args.lr)
        for g in opt.param_groups:
            g["lr"] = lr * g["lr_scale"]

        step_loss = 0.0
        for _ in range(args.grad_accum):
            ids, labels = train[order[cursor % len(order)]]
            cursor += 1
            loss = model(input_ids=ids[None].to(device), labels=labels[None].to(device)).loss / args.grad_accum
            loss.backward()
            step_loss += loss.item()
            seen_tokens += len(ids)

        grad_norm = torch.nn.utils.clip_grad_norm_([p for g in groups for p in g["params"]], args.clip).item()
        opt.step()
        opt.zero_grad(set_to_none=True)

        ewma = step_loss if ewma is None else 0.9 * ewma + 0.1 * step_loss
        elapsed = time.time() - t0
        history["steps"].append({"step": step + 1, "loss": step_loss, "grad_norm": grad_norm, "lr": lr,
                                 "elapsed_s": elapsed})
        print(f"step {step + 1:4d}/{total}  loss {step_loss:.4f} (ewma {ewma:.4f})  |g| {grad_norm:.3f}  "
              f"lr {lr:.2e}  {seen_tokens / elapsed:.0f} tok/s  {elapsed / 60:.1f} min", flush=True)

        out_of_time = args.max_minutes and elapsed > args.max_minutes * 60
        if (step + 1) % args.eval_every == 0 or step + 1 == total or out_of_time:
            v = evaluate()
            history["evals"].append({"step": step + 1, "valid_loss": v, "elapsed_s": elapsed})
            print(f"step {step + 1:4d}  valid {v:.4f}", flush=True)
            (out / "metrics.json").write_text(json.dumps(history, indent=2))
        if out_of_time:
            print(f"stopping: {args.max_minutes} minute budget reached")
            break

    model.save_pretrained(out / "adapter")
    tokenizer.save_pretrained(out / "adapter")
    (out / "metrics.json").write_text(json.dumps(history, indent=2))
    print(f"✓ adapter -> {out / 'adapter'}   valid {history['evals'][0]['valid_loss']:.4f} -> "
          f"{history['evals'][-1]['valid_loss']:.4f}" if len(history["evals"]) > 1
          else f"✓ adapter -> {out / 'adapter'}   valid {history['evals'][-1]['valid_loss']:.4f}")


if __name__ == "__main__":
    main()
