"""
Build the voice-agent fine-tuning set from prompts production rendered.

    npx tsx --env-file=.env scripts/finetune-export.ts   # prompt kit: tools, facts, Gate 2 patterns
    python3 finetune/dialogues.py --real-callers         # scripted calls (data/finetune/dialogues.jsonl)
    npx tsx --env-file=.env scripts/finetune-render.ts   # replayed through POST /api/voice/stream
    python3 finetune/build_dataset.py                    # this: render to Llama text, check, split, pack

The overnight set was assembled here in Python and drifted from production:
853 targets called tools voice no longer offers, every tool was always on
offer and tool results carried across turns. Now finetune-render.ts records
what production hands the model on each turn (system, per-turn context,
history, the tools offered on that turn) and this file only turns those rows
into text the way Ollama renders them (llama_format.py), refuses anything
production could not have produced, and packs.

Three checks, each a build failure:
  - no eval utterance (src/server/eval/scenarios.ts) in the training text,
    verbatim or paraphrased
  - no target Gate 2 would hold (holdPatterns, exported from guardrails.ts)
  - every tool a target calls was offered on that row's turn

Splits are by dialogue, never by row. Loss is taken only on the target.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from llama_format import render_prompt, render_target  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "finetune"


# ─── Production rows → Llama text ───────────────────────────────────────────

def to_messages(history: list[dict]) -> list[dict]:
    """LlmHistory in the shape OllamaProvider's toOllamaMessages sends it."""
    out = []
    for h in history:
        if h["role"] == "user":
            out.append({"role": "user", "content": h["content"]})
        elif h["role"] == "assistant":
            m = {"role": "assistant", "content": h.get("content") or ""}
            if h.get("toolCalls"):
                m["tool_calls"] = [{"name": c["name"], "arguments": c["input"]} for c in h["toolCalls"]]
            out.append(m)
        else:
            out.append({"role": "tool", "content": h["content"]})
    return out


def to_tools(tools: list[dict]) -> list[dict]:
    """ToolSpec as OllamaProvider sends it: {type, function: {name, description, parameters}}."""
    return [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                              "parameters": t["inputSchema"]}} for t in tools]


def finalize(row: dict) -> dict:
    messages = to_messages(row["history"])
    target = row["target"]
    return {"source": row["source"], "kind": row["kind"], "group": row["group"], "tenant": row["tenant"],
            "tier": row["tier"], "offered": [t["name"] for t in row["tools"]],
            "prompt": render_prompt(row["system"], row["context"], to_tools(row["tools"]), messages),
            "completion": render_target(target), "target": target,
            "system": row["system"], "context": row["context"], "messages": messages}


# ─── Checks ─────────────────────────────────────────────────────────────────

def eval_utterances() -> list[str]:
    src = (ROOT / "src/server/eval/scenarios.ts").read_text()
    block = src[src.index("export const SCENARIOS"):]
    turns = re.findall(r"turns:\s*\[(.*?)\]", block, re.S)
    return [s for t in turns for s in re.findall(r'"((?:[^"\\]|\\.)*)"', t)]


def held_phrase(text: str, patterns: list[dict]) -> str | None:
    """
    The Gate 2 pattern this text would be held for, if any.

    44 targets of the overnight set said "we can definitely help", and Gate 2
    always holds "definitely" as an unauthorised promise: the fine-tune learnt
    to write replies production refuses to send. The patterns come from
    guardrails.ts via the prompt kit, so the two cannot drift apart.
    """
    for p in patterns:
        if re.search(p["source"], text, re.I if "i" in p.get("flags", "") else 0):
            return p["source"]
    return None


def _norm(s: str) -> str:
    s = s.lower().replace("$89", "eighty-nine").replace("-", " ")
    return re.sub(r"[^a-z ]", "", s).strip()


def find_leaks(evals: list[str], train: list[dict], threshold: float = 0.8):
    """
    Eval utterances found in the training text, verbatim or paraphrased.

    An exact-substring check alone let "Eighty-nine just for someone to look at
    it? That seems steep." through against the eval's "Eighty-nine just to look
    at it? That seems steep." — the model would be graded on a line it had
    effectively memorised. Caller lines carrying digits (names and numbers) are
    exempt from the fuzzy pass: they share a template, not content, and that
    template is the behaviour being taught.
    """
    from difflib import SequenceMatcher
    callers = {m["content"] for r in train for m in r["messages"] if m["role"] == "user"}
    callers = {c: _norm(c) for c in callers if not re.search(r"\d", c)}
    leaks = []
    for e in sorted(set(evals)):
        if any(e in r["prompt"] for r in train):
            leaks.append((1.0, e, "(verbatim in a prompt)"))
            continue
        if re.search(r"\d", e):
            continue
        ne = _norm(e)
        for c, nc in callers.items():
            ratio = SequenceMatcher(None, ne, nc).ratio()
            if ratio >= threshold:
                leaks.append((ratio, e, c))
    return leaks


def check(rows: list[dict], patterns: list[dict]) -> None:
    for r in rows:
        for c in r["target"].get("tool_calls") or []:
            if c["name"] not in r["offered"]:
                raise SystemExit(f"{r['group']}:{r['kind']} calls {c['name']}, offered only {r['offered']}")
        hit = held_phrase(r["target"].get("content") or "", patterns)
        if hit:
            raise SystemExit(f"{r['group']}:{r['kind']} target would be held by Gate 2 ({hit}): {r['completion'][:120]!r}")


# ─── Split, cap, pack ───────────────────────────────────────────────────────

def split_of(group: str) -> str:
    """One dialogue in eight is held out, by a hash of its id: stable as the set grows."""
    return "valid" if int(hashlib.sha1(group.encode()).hexdigest(), 16) % 8 == 0 else "train"


def cap_kinds(rows: list[dict], cap: int, rng: random.Random) -> tuple[list[dict], Counter]:
    """
    At most `cap` rows of one kind per tenant. Every booking call ends in
    offer_two_times, book_after_choice and confirm_booked, so uncapped they
    swamp the objections and facts the model sees a handful of times.
    """
    by: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        by.setdefault((r["tenant"], r["kind"]), []).append(r)
    kept, dropped = [], Counter()
    for (tenant, kind), items in sorted(by.items()):
        rng.shuffle(items)
        kept += items[:cap]
        if len(items) > cap:
            dropped[kind] += len(items) - cap
    return kept, dropped


def pack(rows: list[dict]) -> list[dict]:
    """
    One sequence per run of rows whose prompts extend each other, carrying the
    character span of every target in it.

    Each turn's context (clock, calendar note, previous reply) sits in the
    system block, so most turns start a new sequence; rows that do share a
    prefix are read once with all their targets, and no turn ever sees
    information from its future.
    """
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(r["group"], []).append(r)

    packed = []
    for items in groups.values():
        chains: list[tuple[str, list[dict], list[list[int]]]] = []
        for r in sorted(items, key=lambda r: -len(r["prompt"])):
            start, end = len(r["prompt"]), len(r["prompt"]) + len(r["completion"])
            for text, members, spans in chains:
                if text.startswith(r["prompt"]) and text[start:end] == r["completion"]:
                    members.append(r)
                    spans.append([start, end])
                    break
            else:
                chains.append((r["prompt"] + r["completion"], [r], [[start, end]]))
        for text, members, spans in chains:
            packed.append({"source": members[0]["source"], "group": members[0]["group"],
                           "kinds": [m["kind"] for m in members], "text": text, "spans": sorted(spans)})
    return packed


def token_counts(packed: list[dict], tokenizer_path: str | None) -> str:
    chars = sum(len(p["text"]) for p in packed)
    if not tokenizer_path:
        return f"{chars:,} characters (pass --tokenizer for tokens)"
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(tokenizer_path)
    n = [len(tok(p["text"], add_special_tokens=False)["input_ids"]) for p in packed]
    return f"{sum(n):,} tokens (max {max(n):,} per sequence, {chars / sum(n):.2f} chars/token)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rendered", type=Path, default=OUT / "rendered.jsonl")
    ap.add_argument("--max-per-kind", type=int, default=120, help="cap per tenant and kind, train split only")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--tokenizer", help="model dir, to report the packed set's token count")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    patterns = json.loads((OUT / "prompt-kit.json").read_text()).get("holdPatterns")
    if not patterns:
        raise SystemExit("prompt-kit.json has no holdPatterns — re-run scripts/finetune-export.ts")
    rendered = [json.loads(l) for l in open(args.rendered)]
    if not rendered:
        raise SystemExit(f"{args.rendered} is empty — run scripts/finetune-render.ts")

    rows: dict[str, list[dict]] = {"train": [], "valid": []}
    for r in rendered:
        rows[split_of(r["group"])].append(finalize(r))
    check(rows["train"] + rows["valid"], patterns)

    leaks = find_leaks(eval_utterances(), rows["train"] + rows["valid"])
    if leaks:
        raise SystemExit("eval utterances leaked into training data:\n" +
                         "\n".join(f"  {r:.2f}  eval {e!r}\n        train {t!r}" for r, e, t in leaks))

    rows["train"], dropped = cap_kinds(rows["train"], args.max_per_kind, rng)

    args.out.mkdir(parents=True, exist_ok=True)
    for split, items in rows.items():
        rng.shuffle(items)
        with open(args.out / f"{split}.jsonl", "w") as f:
            for r in items:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    packed = pack(rows["train"])
    rng.shuffle(packed)
    with open(args.out / "train_packed.jsonl", "w") as f:
        for r in packed:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    for split, items in rows.items():
        groups = {r["group"] for r in items}
        print(f"{split}: {len(items)} rows from {len(groups)} dialogues  " +
              "  ".join(f"{t} {n}" for t, n in sorted(Counter(r["tenant"] for r in items).items())))
    kinds = Counter(r["kind"] for r in rows["train"])
    print("train kinds: " + ", ".join(f"{k} {v}" for k, v in kinds.most_common()))
    if dropped:
        print("capped at %d per tenant: " % args.max_per_kind + ", ".join(f"{k} -{v}" for k, v in dropped.most_common()))
    print(f"train_packed: {len(packed)} sequences carrying {sum(len(p['spans']) for p in packed)} targets, "
          f"{token_counts(packed, args.tokenizer)}")
    print(f"✓ wrote {args.out}/train.jsonl, valid.jsonl, train_packed.jsonl  "
          "(no eval utterances, no Gate 2 phrases, no unoffered tools)")


if __name__ == "__main__":
    main()
