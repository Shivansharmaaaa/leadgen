"""
Serve a trained adapter from Ollama, quantised exactly like the stock model.

    python finetune/export_ollama.py --run r16-adamw --llama-cpp ~/src/llama.cpp
    # -> ollama model  leadgen-llama3.2-ft:r16-adamw  (Q4_K_M)

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
convert_hf_to_gguf.py, conversion/ and gguf-py/ is enough) and a
llama-quantize binary: Ollama's Linux build ships one, `brew install
llama.cpp` provides one on a Mac. Each intermediate is deleted as soon as the
next exists; peak extra disk is about two full-precision copies.
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


def find_quantizer(explicit: str | None) -> str:
    candidates = [explicit, shutil.which("llama-quantize"), "/usr/local/lib/ollama/llama-quantize"]
    for c in candidates:
        if c and Path(c).exists():
            return c
    raise SystemExit("llama-quantize not found — pass --quantizer, or `brew install llama.cpp`")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
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

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    run = ROOT / "data/finetune/runs" / args.run
    adapter = run / "adapter"
    base = args.base or json.loads((adapter / "adapter_config.json").read_text())["base_model_name_or_path"]
    base_path = (ROOT / base) if (ROOT / base).exists() else None
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

    # 3. quantise to the stock model's format
    qenv = {**os.environ, "LD_LIBRARY_PATH": str(Path(quantizer).parent)}
    subprocess.run([quantizer, str(f16), str(quantised), args.quant], check=True, env=qenv)
    f16.unlink()
    print(f"✓ {quantised.name}")

    # 4. serve with the template it was trained on
    stock = (ROOT / "models/leadgen-llama3.2.Modelfile").read_text()
    (run / "Modelfile").write_text(re.sub(r"^FROM .*$", f"FROM {quantised}", stock, count=1, flags=re.M))
    tag = f"leadgen-llama3.2-ft:{args.run}"
    subprocess.run(["ollama", "create", tag, "-f", str(run / "Modelfile")], check=True)
    quantised.unlink()
    print(f"✓ ollama model {tag}")


if __name__ == "__main__":
    main()
