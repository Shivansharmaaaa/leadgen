"""
Serve a trained adapter from Ollama.

    python finetune/export_ollama.py --run r16-adamw
    # -> ollama model  leadgen-llama3.2-ft:r16-adamw

By default the LoRA adapter is attached to the stock llama3.2:3b with
Ollama's ADAPTER directive: tens of megabytes, no second copy of the model,
and the base stays the same Q4_K_M build the baseline was measured on. The
template is taken from models/leadgen-llama3.2.Modelfile, so the model sees
exactly the prompt layout it was trained on.

--merge folds the adapter into the weights instead (needs --base and room for
a full-precision copy). Use it for DoRA or rsLoRA runs, whose scaling the
ADAPTER path does not reproduce.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--base", help="base weights, required with --merge")
    ap.add_argument("--quantize", default="q4_K_M", help="with --merge")
    args = ap.parse_args()

    run = ROOT / "data/finetune/runs" / args.run
    adapter = run / "adapter"
    config = json.loads((adapter / "adapter_config.json").read_text())
    stock = (ROOT / "models/leadgen-llama3.2.Modelfile").read_text()
    tag = f"leadgen-llama3.2-ft:{args.run}"

    if args.merge:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        if not args.base:
            raise SystemExit("--merge needs --base")
        merged = run / "merged"
        model = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.bfloat16)
        PeftModel.from_pretrained(model, adapter).merge_and_unload().save_pretrained(merged, safe_serialization=True)
        AutoTokenizer.from_pretrained(args.base).save_pretrained(merged)
        modelfile = re.sub(r"^FROM .*$", f"FROM {merged}", stock, count=1, flags=re.M)
        cmd = ["ollama", "create", tag, "-f", str(run / "Modelfile"), "--quantize", args.quantize]
    else:
        if config.get("use_dora") or config.get("use_rslora"):
            raise SystemExit("DoRA / rsLoRA adapters change the scaling; export them with --merge")
        modelfile = stock.rstrip() + f"\n\nADAPTER {adapter}\n"
        cmd = ["ollama", "create", tag, "-f", str(run / "Modelfile")]

    (run / "Modelfile").write_text(modelfile)
    subprocess.run(cmd, check=True)
    print(f"✓ ollama model {tag}")
    if args.merge:
        shutil.rmtree(run / "merged")


if __name__ == "__main__":
    main()
