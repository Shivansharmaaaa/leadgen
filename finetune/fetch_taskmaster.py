"""
Fetch Google's Taskmaster-1 and keep how real callers give their name and number.

    python finetune/fetch_taskmaster.py   # -> data/finetune/real_callers.json

Byrne et al. 2019, CC BY 4.0.
https://github.com/google-research-datasets/Taskmaster

Only the caller's side is used. Taskmaster's assistant turns are crowd
workers improvising, which is the style the playbook steers away from, and
there are no tool calls to learn from (see finetune/README.md). Its spoken
two-person dialogues ("woz") are different on the caller's side: transcribed
speech from people booking auto-repair appointments and restaurant tables,
giving their details in ways a template never does:

    "Tori t o r i." / "Last name Smith s m i t h and first name Linda l i n d a."
    "It'd be under the name John Doe." / "And my phone number is area code 937-767-1605."

Each row is the caller's words, the name and number they gave, and a
template with {first} {last} {first_spelled} {last_spelled} {spoken} for
reuse with other names. A name turn followed by a bare number turn is also
kept joined, as one utterance. On voice the number is usually on file from
caller ID, so name-only rows are the majority and the ones that matter most.

Lines that mention another business (cars, tables), a day or a time, or a
name the annotators missed are dropped, so a row can be dropped into any
tenant's call. Woz has no official split, so dialogues are split by a hash
of their id: real_callers.json holds the train side only; the held-out side
goes to data/raw/taskmaster/held_out_callers.json for evals.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data/raw/taskmaster"
OUT = ROOT / "data/finetune/real_callers.json"
URL = "https://raw.githubusercontent.com/google-research-datasets/Taskmaster/master/TM-1-2019/woz-dialogs.json"
PER_TEMPLATE = 5
NAME_LABELS = {"auto_repair.name.customer", "restaurant_reservation.name.reservation"}

PHONE = re.compile(r"(?:\b1-)?\(?\b\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b")
SPELLED = re.compile(r"\b(?:[A-Za-z] ){1,}[A-Za-z]\b")
# A lone name word is a first name only when introduced as one; "Harris."
# on its own is usually the surname, given after the first name.
CUE = re.compile(r"\b(?:name is|name's|i'm|i am|it's|this is|under|first name)\s+$", re.I)
# A number turn joined to a name turn must say nothing else, or the join reads
# as two replies to two different questions.
NUMBER_ONLY = re.compile(
    r"^(?:(?:yes|yeah|sure|okay|ok|oh|um|uh)[,.]?\s+)?(?:and\s+)?(?:it's\s+|it is\s+)?"
    r"(?:(?:my|the)\s+)?(?:(?:phone|mobile|cell)\s+)?(?:number|phone)?(?:\s+number)?"
    r"(?:\s+(?:is|here is|is going to be|would be))?\s*(?:area code\s+)?\{spoken\}\.?$", re.I)
# Anything that would contradict the call the line is dropped into: another
# business's details, or a day/time the offered slots would ignore.
OFF_TOPIC = re.compile(
    r"\b(?:car|vehicle|nissan|honda|toyota|ford|chevy|reservation|table|party|people|guests|drop|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|morning|"
    r"afternoon|evening|o'clock|am|pm|appointment|repeat|email)\b", re.I)
NOT_NAMES = {"it's", "area", "code", "number", "phone", "name", "my", "yes", "yeah", "the", "is", "sure"}
CUT_OFF = re.compile(r"\b(?:is|and|the|my|name)\W*$", re.I)
ALLOWED_CAPS = {"I", "I'm", "I'd", "It's", "It'd", "It", "My", "Yes", "Yeah", "Sure", "Okay", "Ok", "Oh",
                "And", "That's", "The", "This", "Phone", "Name", "Last", "First", "Um", "Uh", "So", "Just",
                "You", "Hi", "Well", "Mine", "Absolutely", "Of", "No"}


def split_of(conversation_id: str) -> str:
    return "held_out" if int(hashlib.sha1(conversation_id.encode()).hexdigest(), 16) % 10 == 0 else "train"


def name_words(segments: list[str]) -> list[str]:
    """Distinct name words in order, without the spelled-out letters."""
    out: list[str] = []
    for seg in segments:
        for w in re.findall(r"[A-Za-z][A-Za-z'-]+", SPELLED.sub(" ", seg)):
            if w.lower() not in (x.lower() for x in out):
                out.append(w)
    return out


def row(text: str, segments: list[str]) -> dict | None:
    """The caller's line with its name, number and template, or None if it can't travel."""
    words = name_words(segments)
    numbers = PHONE.findall(text)
    if not 1 <= len(words) <= 2 or len(numbers) > 1 or "?" in text:
        return None
    if any(w.isupper() or not re.search(r"[aeiouy]", w, re.I) or w.lower() in NOT_NAMES for w in words):
        return None                                # "AA an.", or "It's area" annotated as a name
    if CUT_OFF.search(text):
        return None                                # "...Last name is": the rest is in the next turn
    roles = ["first", "last"]
    if len(words) == 2 and re.search(rf"last name\W+{re.escape(words[0])}", text, re.I):
        roles = ["last", "first"]
    if len(words) == 1:
        at = re.search(rf"\b{re.escape(words[0])}\b", text)
        if not at or not CUE.search(text[:at.start()]):
            return None

    def spelled(m: re.Match) -> str:
        letters = m.group(0).replace(" ", "").lower()
        for w, role in zip(words, roles):
            if letters == w.lower():
                return "{" + role + "_spelled}"
        return m.group(0)                          # spells something else: rejected below

    t = SPELLED.sub(spelled, text)
    for w, role in zip(words, roles):
        t = re.sub(rf"\b{re.escape(w)}\b", "{" + role + "}", t)
    t = re.sub(r"\s+", " ", PHONE.sub("{spoken}", t)).strip()

    bare = re.sub(r"\{\w+\}", "", t)
    if "{first}" not in t or re.search(r"\d", bare) or SPELLED.search(bare) or OFF_TOPIC.search(bare):
        return None
    if len(bare.split()) > 22:
        return None
    if any(tok[0].isupper() and tok not in ALLOWED_CAPS for tok in re.findall(r"[A-Za-z][A-Za-z'-]*", bare)):
        return None                                # an unannotated name, or another business

    by_role = {role: w[0].upper() + w[1:] for w, role in zip(words, roles)}
    name = " ".join(by_role[r] for r in ("first", "last") if r in by_role)
    phone = None
    if numbers:
        digits = re.sub(r"\D", "", numbers[0])[-10:]
        phone = f"+1{digits}"
    return {"text": re.sub(r"\s+", " ", text).strip(), "name": name, "phone": phone, "template": t}


def main():
    path = RAW / "woz-dialogs.json"
    if not path.exists():
        RAW.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(URL, timeout=600) as res:
            path.write_bytes(res.read())
    dialogues = json.loads(path.read_text())

    rows: dict[str, dict] = {}
    for d in dialogues:
        turns = d["utterances"]
        for i, u in enumerate(turns):
            if u["speaker"] != "USER":
                continue
            segments = [s["text"] for s in u.get("segments", [])
                        if any(a["name"] in NAME_LABELS for a in s["annotations"])]
            if not segments:
                continue
            texts = [u["text"]]
            if not PHONE.search(u["text"]):
                nxt = next((v for v in turns[i + 1:i + 5] if v["speaker"] == "USER"), None)
                if nxt and NUMBER_ONLY.match(PHONE.sub("{spoken}", nxt["text"].strip(), count=1)):
                    texts.append(f"{u['text'].rstrip()} {nxt['text'].strip()}")
            for text in texts:
                r = row(text, segments)
                if r and r["text"] not in rows:
                    rows[r["text"]] = {**r, "split": split_of(d["conversation_id"])}

    # A quarter of the rows are a bare "{first} {last}."; a few of each shape
    # is enough, the rest would only crowd out the unusual ones.
    per_template: dict[tuple[str, str], int] = {}
    kept = []
    for r in rows.values():
        key = (r["split"], r["template"])
        per_template[key] = per_template.get(key, 0) + 1
        if per_template[key] <= PER_TEMPLATE:
            kept.append(r)
    train = [{k: v for k, v in r.items() if k != "split"} for r in kept if r["split"] == "train"]
    held = [{k: v for k, v in r.items() if k != "split"} for r in kept if r["split"] == "held_out"]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(train, indent=1, ensure_ascii=False))
    (RAW / "held_out_callers.json").write_text(json.dumps(held, indent=1, ensure_ascii=False))
    with_phone = sum(1 for r in train if r["phone"])
    spelled = sum(1 for r in train if "_spelled}" in r["template"])
    print(f"{len(train)} train rows, {len({r['template'] for r in train})} shapes "
          f"({len(train) - with_phone} name only, {with_phone} with a number, {spelled} spelled out), "
          f"{len(held)} held out")
    print(f"✓ {OUT}  (Taskmaster-1, CC BY 4.0)")


if __name__ == "__main__":
    main()
