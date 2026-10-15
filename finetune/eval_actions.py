"""
Held-out next-action accuracy, scored on the model as Ollama serves it.

    python finetune/eval_actions.py --model leadgen-llama3.2:3b --per-kind 6
    python finetune/eval_actions.py --model llama3.2:3b --mode chat   # any template

Each validation row is a conversation stopped at a decision point. The model
writes its next step and it is graded against what should happen there:

  action     tool call vs. spoken reply, and which tools
  args       the booked slot, the date checked, the details saved
  premature  booked when it should have read the time back or asked which
             time they wanted — the failure that costs a truck roll

Two ways in, both against the quantised model that will actually take calls:

  chat   (default) /api/chat with tools, exactly as the app calls it: Ollama's
         own template and tool parser, then the app's JSON repair. Works for
         any model, so the stock template can be compared with ours.
  raw    /api/generate with the exact training text. Isolates the weights
         from template and parser differences.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOS = "<|begin_of_text|>"
NO_BOOK_KINDS = {"readback_no_booking", "save_details_not_book", "ask_which_time", "offer_two_times"}


def generate(base: str, model: str, prompt: str) -> str:
    body = json.dumps({
        "model": model, "prompt": prompt.removeprefix(BOS), "raw": True, "stream": False,
        "options": {"temperature": 0, "num_predict": 96, "num_ctx": 8192, "stop": ["<|eot_id|>"]},
    }).encode()
    req = urllib.request.Request(f"{base}/api/generate", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as res:
        return json.loads(res.read())["response"]


def chat(base: str, model: str, row: dict, tools: list[dict]) -> tuple[list[dict] | None, str]:
    messages = [{"role": "system", "content": f"{row['system']}\n\n{row['context']}"}]
    for m in row["messages"]:
        if m["role"] == "assistant" and m.get("tool_calls"):
            messages.append({"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": c["name"], "arguments": c["arguments"]}} for c in m["tool_calls"]]})
        else:
            messages.append({"role": m["role"], "content": m["content"]})
    body = json.dumps({
        "model": model, "messages": messages, "tools": tools, "stream": False,
        "options": {"temperature": 0, "num_predict": 96, "num_ctx": 8192},
    }).encode()
    req = urllib.request.Request(f"{base}/api/chat", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as res:
        msg = json.loads(res.read())["message"]
    content = msg.get("content") or ""
    if msg.get("tool_calls"):
        return [{"name": c["function"]["name"], "arguments": c["function"].get("arguments") or {}}
                for c in msg["tool_calls"]], content
    # Same salvage the app does (OllamaProvider.salvageTextToolCall).
    allowed = {t["function"]["name"] for t in tools}
    repaired = re.sub(r'"(parameters|arguments|input)\s*(?:"\s*)?:?\s*\{', '"\\1":{', content)
    salvaged = [c for c in (parse(repaired) or []) if c["name"] in allowed]
    return (salvaged or None), content


def parse(output: str) -> list[dict] | None:
    """Tool calls in Llama's JSON form, or None for a spoken reply."""
    calls = []
    for line in output.strip().splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and "name" in obj:
            calls.append({"name": obj["name"], "arguments": obj.get("parameters") or obj.get("arguments") or {}})
    return calls or None


def digits(s: object) -> str:
    return re.sub(r"\D", "", str(s))[-10:]


def args_match(want: dict, got: dict) -> bool:
    a, b = want["arguments"], got["arguments"]
    if want["name"] == "book_appointment":
        return a.get("starts_at") == b.get("starts_at")
    if want["name"] == "check_availability" and "from_date" in a:
        return a.get("from_date") == b.get("from_date")
    if want["name"] == "save_contact_detail":
        if a.get("field") != b.get("field"):
            return False
        return digits(a["value"]) == digits(b.get("value")) if a["field"] == "phone" \
            else str(a["value"]).lower() == str(b.get("value", "")).lower()
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--ollama", default="http://localhost:11434")
    ap.add_argument("--per-kind", type=int, default=6)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--tag", default="")
    ap.add_argument("--mode", default="chat", choices=["chat", "raw"])
    ap.add_argument("--kinds", help="comma-separated kinds to score, e.g. ai_disclosure,unknown_price")
    ap.add_argument("--show", action="store_true", help="print each full output")
    args = ap.parse_args()
    tools = json.loads((ROOT / "data/finetune/prompt-kit.json").read_text())["tools"]

    rows = [json.loads(l) for l in open(ROOT / "data/finetune/valid.jsonl")]
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_kind[f"{r['source']}:{r['kind']}"].append(r)
    rng = random.Random(args.seed)
    sample = [r for k in sorted(by_kind) for r in rng.sample(by_kind[k], min(args.per_kind, len(by_kind[k])))]
    if args.kinds:
        wanted = set(args.kinds.split(","))
        sample = [r for r in sample if r["kind"] in wanted]
    # Neighbours that share a prefix let Ollama reuse its KV cache.
    sample.sort(key=lambda r: r["prompt"])

    stats: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    t0 = time.time()
    for i, r in enumerate(sample, 1):
        kind = f"{r['source']}:{r['kind']}"
        if args.mode == "chat":
            got, out = chat(args.ollama, args.model, r, tools)
        else:
            out = generate(args.ollama, args.model, r["prompt"])
            got = parse(out)
        want = r["target"].get("tool_calls")
        s = stats[kind]
        s["n"] += 1

        if want:
            names_ok = got is not None and [c["name"] for c in got] == [c["name"] for c in want]
            s["action"] += names_ok
            s["args"] += names_ok and all(args_match(w, g) for w, g in zip(want, got))
        else:
            s["action"] += got is None
            s["args"] += got is None
        if r["kind"] in NO_BOOK_KINDS:
            s["premature"] += any(c["name"] == "book_appointment" for c in (got or []))
        shown = " + ".join(c["name"] for c in got) if got else out[:90]
        print(f"  [{i}/{len(sample)}] {kind:34s} {shown!r}", flush=True)
        if args.show:
            last_user = next(m["content"] for m in reversed(r["messages"]) if m["role"] == "user")
            print(f"      caller: {last_user!r}\n      wanted: {r['completion'][:160]!r}\n      got:    "
                  f"{json.dumps(got) if got else out!r}")

    total = defaultdict(int)
    print(f"\n{'kind':38s} {'n':>3s} {'action':>7s} {'args':>6s} {'premature':>9s}")
    for kind in sorted(stats):
        s = stats[kind]
        for k, v in s.items():
            total[k] += v
        prem = f"{s['premature']}/{s['n']}" if kind.split(":")[1] in NO_BOOK_KINDS else ""
        print(f"{kind:38s} {s['n']:3d} {s['action'] / s['n']:7.0%} {s['args'] / s['n']:6.0%} {prem:>9s}")
    print(f"{'TOTAL':38s} {total['n']:3d} {total['action'] / total['n']:7.0%} {total['args'] / total['n']:6.0%} "
          f"{total['premature']:>6d} premature bookings   ({time.time() - t0:.0f}s)")

    out_dir = ROOT / "data/eval"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"actions_{args.mode}_{args.model.replace(':', '_').replace('/', '_')}{'_' + args.tag if args.tag else ''}.json"
    (out_dir / name).write_text(json.dumps({"model": args.model, "mode": args.mode, "tag": args.tag, "per_kind": args.per_kind,
                                            "stats": stats, "total": total}, indent=2))
    print(f"saved data/eval/{name}")


if __name__ == "__main__":
    main()
