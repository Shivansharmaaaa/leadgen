"""
Serve a trained adapter from Ollama, quantised exactly like the stock model.

    python finetune/export_ollama.py --run r16-adamw --llama-cpp ~/src/llama.cpp
    # -> ollama model  leadgen-llama3.2-ft:r16-adamw  (Q4_K_M)

    # the adapter published in this repo:
    python finetune/export_ollama.py --adapter models/Llama-3.2-3B-Leadgen-Voice-LoRA \
        --tag llama3.2-leadgen-voice:3b --llama-cpp ~/src/llama.cpp

Current Ollama refuses LoRA adapters ("LoRA adapters are no longer
supported") and its safetensors import only offers its own formats (int4,
int8, mxfp4...), not the Q4_K_M that llama3.2:3b ships as. A fine-tune scored
on a different quantisation than its baseline proves nothing, so this takes
the llama.cpp route:

  1. merge the adapter into the base weights        (safetensors, bf16)
  2. llama.cpp convert_hf_to_gguf.py                 (GGUF, f16)
  3. llama-quantize ... Q4_K_M                       (GGUF, Q4_K_M)
  4. ollama create with models/leadgen-llama3.2.Modelfile's template

Needs a llama.cpp checkout for the converter (a sparse clone of
convert_hf_to_gguf.py, conversion/ and gguf-py/ is enough). Quantising uses
llama-quantize when there is one (Ollama's Linux build ships it, `brew install
llama.cpp` provides it on a Mac); without it, Ollama quantises the f16 GGUF
itself (`ollama create --quantize`, llama.cpp's quantiser inside Ollama),
which is the route on a Mac where Homebrew is unavailable. Each intermediate
is deleted as soon as the next exists; peak extra disk is about two
full-precision copies.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
from fetch_base import drop_tokens_beyond_vocab  # noqa: E402


def find_quantizer(explicit: str | None) -> str | None:
    """llama-quantize if there is one; None means let Ollama quantise."""
    if explicit:
        if not Path(explicit).exists():
            raise SystemExit(f"--quantizer {explicit} not found")
        return explicit
    for c in [shutil.which("llama-quantize"), "/usr/local/lib/ollama/llama-quantize"]:
        if c and Path(c).exists():
            return c
    return None


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--run", help="a training run under data/finetune/runs/")
    src.add_argument("--adapter", help="any PEFT adapter directory, e.g. one published in models/")
    ap.add_argument("--tag", help="Ollama model name (default leadgen-llama3.2-ft:<run>)")
    ap.add_argument("--base", help="defaults to the base recorded in the adapter config")
    ap.add_argument("--llama-cpp", default=os.environ.get("LLAMA_CPP_DIR", "/opt/src/llama.cpp"),
                    help="llama.cpp checkout containing convert_hf_to_gguf.py")
    ap.add_argument("--quantizer", help="path to llama-quantize")
    ap.add_argument("--quant", default="Q4_K_M")
    ap.add_argument("--drop-base", action="store_true", help="delete local base weights after merging")
    args = ap.parse_args()

    converter = Path(args.llama_cpp).expanduser() / "convert_hf_to_gguf.py"
    if not converter.exists():
        raise SystemExit(f"{converter} not found — pass --llama-cpp <llama.cpp checkout>")
    quantizer = find_quantizer(args.quantizer)
    print(f"quantising with {quantizer or 'ollama create --quantize'}")

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if args.run:
        run = ROOT / "data/finetune/runs" / args.run
        adapter = run / "adapter"
        tag = args.tag or f"leadgen-llama3.2-ft:{args.run}"
    else:
        adapter = Path(args.adapter).resolve()
        # Intermediates go to a scratch dir, never next to the published files.
        run = ROOT / "data/finetune/export" / adapter.name
        run.mkdir(parents=True, exist_ok=True)
        tag = args.tag or f"{adapter.name.lower()}:latest"
    base = args.base or json.loads((adapter / "adapter_config.json").read_text())["base_model_name_or_path"]
    base_path = (ROOT / base) if (ROOT / base).exists() else None
    if base_path is None and (base.startswith(("data/", "/", ".")) or base.count("/") != 1):
        raise SystemExit(f"base weights not found at {base} — run `python finetune/fetch_base.py 3b`, "
                         "or pass --base meta-llama/Llama-3.2-3B-Instruct")
    merged, f16, quantised = run / "merged", run / "ft-f16.gguf", run / f"ft-{args.quant.lower()}.gguf"

    # 1. merge
    model = AutoModelForCausalLM.from_pretrained(base_path or base, dtype=torch.bfloat16)
    PeftModel.from_pretrained(model, adapter).merge_and_unload().save_pretrained(merged, safe_serialization=True)
    AutoTokenizer.from_pretrained(base_path or base).save_pretrained(merged)
    drop_tokens_beyond_vocab(merged)
    del model
    print(f"✓ merged -> {merged}")
    if args.drop_base and base_path:
        shutil.rmtree(base_path)
        print(f"  removed {base_path} (python finetune/fetch_base.py restores it)")

    # 2. GGUF f16
    llama_cpp = Path(args.llama_cpp).expanduser()
    env = {**os.environ, "PYTHONPATH": f"{llama_cpp / 'gguf-py'}{os.pathsep}{llama_cpp}"}
    subprocess.run([sys.executable, str(converter), str(merged), "--outtype", "f16", "--outfile", str(f16)],
                   check=True, env=env)
    shutil.rmtree(merged)

    stock = (ROOT / "models/leadgen-llama3.2.Modelfile").read_text()
    if quantizer:
        # 3. quantise to the stock model's format
        qenv = {**os.environ, "LD_LIBRARY_PATH": str(Path(quantizer).parent)}
        subprocess.run([quantizer, str(f16), str(quantised), args.quant], check=True, env=qenv)
        f16.unlink()
        print(f"✓ {quantised.name}")

        # 4. serve with the template it was trained on
        (run / "Modelfile").write_text(re.sub(r"^FROM .*$", f"FROM {quantised}", stock, count=1, flags=re.M))
        subprocess.run(["ollama", "create", tag, "-f", str(run / "Modelfile")], check=True)
        quantised.unlink()
    else:
        # 3+4. Ollama quantises the f16 GGUF on import, with the same template.
        (run / "Modelfile").write_text(re.sub(r"^FROM .*$", f"FROM {f16}", stock, count=1, flags=re.M))
        subprocess.run(["ollama", "create", "--quantize", args.quant.lower(), tag, "-f", str(run / "Modelfile")],
                       check=True)
        f16.unlink()
    print(f"✓ ollama model {tag}")


if __name__ == "__main__":
    main()
