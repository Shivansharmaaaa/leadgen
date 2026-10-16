"""
Fetch Llama 3.2 Instruct base weights for fine-tuning.

    python finetune/fetch_base.py 3b        # -> data/finetune/base/llama3.2-3b/

LoRA needs unquantised weights. Where Hugging Face is reachable, skip this and
pass `--base meta-llama/Llama-3.2-3B-Instruct` to train_lora.py instead (the
repo is gated: accept Meta's licence on the model page and `hf auth login`).

Where it is not, Docker Hub hosts the same Meta release as F16 GGUF under
ai/llama3.2. This pulls that blob, checks its digest against the manifest, and
converts it to the Hugging Face layout with transformers' GGUF loader.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAGS = {"1b": "1B-F16", "3b": "3B-F16"}
GGUF_MEDIA_TYPE = "application/vnd.docker.ai.gguf.v3"


def _open(req: urllib.request.Request | str, timeout: int = 60):
    """Docker Hub rate-limits anonymous pulls per IP (100/hour); wait out a 429."""
    for attempt in range(6):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as err:
            if err.code != 429 or attempt == 5:
                raise
            wait = int(err.headers.get("Retry-After") or 0) or 30 * 2 ** attempt
            print(f"  Docker Hub rate limit (429), retrying in {wait}s")
            time.sleep(wait)
    raise AssertionError("unreachable")


def _get(url: str, token: str, accept: str | None = None):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", **({"Accept": accept} if accept else {})})
    return _open(req)


def download(size: str, dest: Path) -> Path:
    path = dest / f"llama3.2-{size}-f16.gguf"
    marker = dest / f"{path.name}.verified"
    if path.exists() and marker.exists():
        print(f"already downloaded and verified {path}")
        return path

    tok_url = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:ai/llama3.2:pull"
    token = json.loads(_open(tok_url, timeout=30).read())["token"]
    manifest = json.loads(_get(
        f"https://registry-1.docker.io/v2/ai/llama3.2/manifests/{TAGS[size]}", token,
        "application/vnd.oci.image.manifest.v1+json").read())
    layer = next(l for l in manifest["layers"] if l["mediaType"] == GGUF_MEDIA_TYPE)
    digest = layer["digest"].split(":", 1)[1]

    print(f"downloading {TAGS[size]} ({layer['size'] / 1e9:.1f} GB)")
    sha = hashlib.sha256()
    with _get(f"https://registry-1.docker.io/v2/ai/llama3.2/blobs/{layer['digest']}", token) as res, open(path, "wb") as f:
        done = 0
        while chunk := res.read(1 << 22):
            f.write(chunk)
            sha.update(chunk)
            done += len(chunk)
            print(f"\r  {done / layer['size']:6.1%}", end="", flush=True)
    print()
    if sha.hexdigest() != digest:
        path.unlink()
        raise SystemExit("digest mismatch — download corrupted, removed")
    print(f"✓ sha256 matches manifest ({digest[:12]}…)")
    marker.write_text(digest)
    return path


def drop_tokens_beyond_vocab(path: Path) -> None:
    """
    transformers' GGUF loader appends an `<|endoftext|>` at id 128256, one past
    Llama 3.2's 128,256-row embedding. Nothing ever emits it, but llama.cpp's
    converter rightly refuses a tokenizer that outruns the model, so drop it.
    """
    vocab_size = json.loads((path / "config.json").read_text())["vocab_size"]
    tok_file = path / "tokenizer.json"
    tok = json.loads(tok_file.read_text())
    kept = [t for t in tok["added_tokens"] if t["id"] < vocab_size]
    if len(kept) != len(tok["added_tokens"]):
        tok["added_tokens"] = kept
        tok_file.write_text(json.dumps(tok, ensure_ascii=False))


def convert(gguf: Path, out: Path, keep_gguf: bool) -> None:
    import gc

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"converting {gguf.name} -> {out}")
    tok = AutoTokenizer.from_pretrained(gguf.parent, gguf_file=gguf.name)
    model = AutoModelForCausalLM.from_pretrained(gguf.parent, gguf_file=gguf.name, dtype=torch.bfloat16)
    # transformers tags GGUF-loaded models as quantised and refuses to save
    # them, though the F16 weights are already plain tensors at this point.
    model.hf_quantizer = None
    model.config.quantization_config = None
    model.save_pretrained(out, safe_serialization=True)
    tok.save_pretrained(out)
    drop_tokens_beyond_vocab(out)

    # Only drop the source once the copy reloads.
    del model
    gc.collect()
    AutoModelForCausalLM.from_pretrained(out, dtype=torch.bfloat16)
    print(f"✓ {out}")
    if not keep_gguf:
        gguf.unlink()
        gguf.with_name(gguf.name + ".verified").unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("size", choices=sorted(TAGS))
    ap.add_argument("--download-only", action="store_true")
    ap.add_argument("--keep-gguf", action="store_true")
    args = ap.parse_args()

    base = ROOT / "data/finetune/base"
    base.mkdir(parents=True, exist_ok=True)
    gguf = download(args.size, base)
    if args.download_only:
        return
    convert(gguf, base / f"llama3.2-{args.size}", args.keep_gguf)


if __name__ == "__main__":
    sys.exit(main())
