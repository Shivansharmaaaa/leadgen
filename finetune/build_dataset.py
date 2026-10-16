"""
Build the voice-agent fine-tuning set.

    npx tsx --env-file=.env scripts/finetune-export.ts   # real prompt + tools
    python finetune/build_dataset.py

Two sources, both rendered into the production prompt and tool layout:

  sgd   Google's Schema-Guided Dialogue (CC BY-SA 4.0), the four appointment
        services: salons, dentists, doctors, therapists. Real dialogues where
        the system reads a time back and books only after a yes, re-confirms
        after a no, and recovers when the slot turns out to be taken. Mapped
        onto our tools: check_availability before every read-back,
        book_appointment only after the caller affirms.

  hvac  Synthetic calls to the seeded HVAC tenant on its real system prompt,
        aimed at what the 3B model got wrong on live calls: echoing a detail
        the caller never gave, booking when the caller only gave a name and
        number, plus escalation, unknown prices and AI disclosure.

Each example is one decision point: the conversation so far, and the single
next assistant step (a reply or a tool call). Loss is taken on that step only.
Splits are by dialogue, never by example, so a conversation cannot sit on both
sides. Every eval utterance is checked against the training text.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
from llama_format import render_prompt, render_target  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "finetune"

# ─── SGD ─────────────────────────────────────────────────────────────────────

SGD_TODAY = datetime(2019, 3, 1, 10, 15)          # "day after tomorrow" == 2019-03-03
SGD_TZ = ZoneInfo("America/Los_Angeles")          # every SGD city is in California

SERVICES = {
    "Services_1": {"slot": "stylist_name", "service": "haircut", "kind": "salon"},
    "Services_2": {"slot": "dentist_name", "service": "dental appointment", "kind": "dental office"},
    "Services_3": {"slot": "doctor_name", "service": "doctor's appointment", "kind": "medical office"},
    "Services_4": {"slot": "therapist_name", "service": "therapy session", "kind": "therapy practice"},
}

AGENTS = ["Alex", "Sam", "Jordan", "Taylor", "Riley", "Casey", "Morgan", "Jamie"]
FIRST = ["Priya", "Marcus", "Elena", "Daniel", "Aisha", "Tom", "Grace", "Luis", "Mei", "Owen",
         "Fatima", "Ben", "Chloe", "Ravi", "Hannah", "Diego", "Nora", "Sean", "Yuki", "Leah"]
LAST = ["Patel", "Johnson", "Garcia", "Kim", "Okafor", "Nguyen", "Murphy", "Rossi", "Cohen",
        "Silva", "Walsh", "Ahmed", "Brooks", "Lindqvist", "Moreau"]

OPENERS = [
    "Hi, I'd like to book an appointment.",
    "Hi there, can I make an appointment?",
    "Hello, I'm calling to schedule a {service}.",
    "Hi, I need to book a {service}.",
    "Yeah hi, I want to set up an appointment please.",
]


def phone(rng: random.Random) -> str:
    return f"+1{rng.choice(['408', '415', '510', '650', '925'])}555{rng.randint(1000, 9999)}"


def sgd_business(service: str, provider: str) -> str:
    if service == "Services_1" or re.search(r"dental|salon|clinic|center", provider, re.I):
        return provider
    return f"{provider}'s office"


def slot_label(local: datetime) -> str:
    # Mirrors checkAvailability: formatInTimeZone(cursor, tz, "EEEE d MMM, h:mm a")
    return local.strftime("%A %-d %b, %-I:%M %p")


def booked_label(local: datetime) -> str:
    # Mirrors bookAppointment: "EEEE d MMMM 'at' h:mm a"
    return local.strftime("%A %-d %B at %-I:%M %p")


def iso_utc(local: datetime) -> str:
    return local.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def context_block(now: datetime, tz: str, name: str | None, phone_no: str | None) -> str:
    # Mirrors the `context` half of buildSystemPrompt().
    stamp = now.strftime("%A %-d %B %Y, %-I:%M %p ") + now.strftime("%Z")
    known = "\n".join(x for x in [f"name: {name}" if name else "", f"phone: {phone_no}" if phone_no else ""] if x)
    return (
        f"# Right now\nCurrent time: {stamp} ({tz})\n\n# Who you are talking to\n"
        + (known or "Unknown — you have no details on this person yet.")
    )


def sgd_facts(service_key: str, business: str, provider: str, results: list[dict]) -> str:
    spec = SERVICES[service_key]
    row = next((r for r in results if r.get(spec["slot"]) == provider), None)
    lines = ["[services]", f"  Offered: {spec['service']}s"]
    if row:
        addr = row.get("street_address") or row.get("address")
        lines += ["[location]"]
        if addr:
            lines.append(f"  {business}: {addr}, {row.get('city', '')}".rstrip(", "))
        if row.get("phone_number"):
            lines.append(f"  {business} phone: {row['phone_number']}")
    return "\n".join(lines)


def canonical(actions: list[dict], act: str, slot: str) -> str | None:
    for a in actions:
        if a["act"] == act and a["slot"] == slot and a.get("canonical_values"):
            return a["canonical_values"][0]
    return None


def nearby_slots(local: datetime, rng: random.Random) -> list[datetime]:
    """The requested time plus a couple of real-looking neighbours, in order."""
    offsets = sorted({0, *rng.sample([-90, -60, -30, 30, 60, 90, 120], 2)})
    return [local + timedelta(minutes=o) for o in offsets]


def convert_sgd(dialogue: dict, kit: dict, rng: random.Random) -> list[dict]:
    service_key = dialogue["services"][0]
    spec = SERVICES[service_key]
    turns = dialogue["turns"]

    book_frames = [f for t in turns for f in t["frames"]
                   if f.get("service_call", {}).get("method") == "BookAppointment"]
    if not book_frames:
        return []
    provider = book_frames[0]["service_call"]["parameters"][spec["slot"]]
    business = sgd_business(service_key, provider)
    finds = [r for t in turns for f in t["frames"]
             if f.get("service_call", {}).get("method") == "FindProvider"
             for r in f.get("service_results", [])]

    start = next((i for i, t in enumerate(turns)
                  if t["speaker"] == "USER" and t["frames"][0]["state"]["active_intent"] == "BookAppointment"), None)
    if start is None:
        return []

    caller = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    system = (kit["template"]["system"]
              .replace("{{BUSINESS}}", business)
              .replace("{{AGENT}}", rng.choice(AGENTS))
              .replace("{{FACTS}}", sgd_facts(service_key, business, provider, finds)))
    now = SGD_TODAY.replace(tzinfo=SGD_TZ) + timedelta(minutes=rng.randint(-90, 300))
    context = context_block(now, "America/Los_Angeles", caller, phone(rng))
    service = spec["service"]

    first = turns[start]
    acts = {a["act"] for a in first["frames"][0]["actions"]}
    # A bare "yes, book it" only made sense after the dropped search phase.
    opener = first["utterance"] if acts - {"AFFIRM_INTENT", "SELECT", "THANK_YOU"} else \
        rng.choice(OPENERS).format(service=service)

    messages: list[dict] = [{"role": "user", "content": opener}]
    examples: list[dict] = []
    cur_date = cur_time = None
    checked: set[tuple[str, str]] = set()

    def emit(target: dict, kind: str, keep: float = 1.0):
        if rng.random() <= keep:
            examples.append({"system": system, "context": context, "messages": list(messages),
                             "target": target, "kind": kind})
        messages.append({"role": "assistant", **target})

    for turn in turns[start + 1:]:
        frame = turn["frames"][0]
        if turn["speaker"] == "USER":
            messages.append({"role": "user", "content": turn["utterance"]})
            continue

        call = frame.get("service_call")
        if call and call["method"] == "FindProvider":
            break  # a second search mid-booking does not map onto one business

        confirm_date = canonical(frame["actions"], "CONFIRM", "appointment_date")
        confirm_time = canonical(frame["actions"], "CONFIRM", "appointment_time")

        if confirm_date or confirm_time:
            cur_date = confirm_date or cur_date
            cur_time = confirm_time or cur_time
            if not (cur_date and cur_time):
                return []
            local = datetime.fromisoformat(f"{cur_date}T{cur_time}").replace(tzinfo=SGD_TZ)
            if (cur_date, cur_time) not in checked:
                checked.add((cur_date, cur_time))
                emit({"tool_calls": [{"name": "check_availability",
                                      "arguments": {"service": service, "from_date": cur_date, "days": 1}}]},
                     "check_before_readback")
                slots = [{"starts_at": iso_utc(s), "label": slot_label(s)} for s in nearby_slots(local, rng)]
                messages.append({"role": "tool", "content": json.dumps(
                    {"ok": True, "timezone": "America/Los_Angeles", "slots": slots}, separators=(",", ":"))})
            emit({"content": turn["utterance"]}, "readback_no_booking")

        elif call and call["method"] == "BookAppointment":
            p = call["parameters"]
            local = datetime.fromisoformat(f"{p['appointment_date']}T{p['appointment_time']}").replace(tzinfo=SGD_TZ)
            emit({"tool_calls": [{"name": "book_appointment",
                                  "arguments": {"service": service, "starts_at": iso_utc(local)}}]},
                 "book_after_yes")
            result = ({"ok": True, "appointment_id": str(uuid.UUID(int=rng.getrandbits(128))),
                       "confirmed_for": booked_label(local)}
                      if frame.get("service_results")
                      else {"ok": False, "error": "that slot was just taken — call check_availability again"})
            messages.append({"role": "tool", "content": json.dumps(result, separators=(",", ":"), ensure_ascii=False)})
            emit({"content": turn["utterance"]}, "after_booking" if result["ok"] else "booking_failed")

        else:
            # Ordinary turns (asking for a date, answering a question) are
            # plentiful; keep a share so the model still learns to just talk.
            emit({"content": turn["utterance"]}, "reply", keep=0.35)

    return examples


# ─── In-domain HVAC ──────────────────────────────────────────────────────────

HVAC_TZ = ZoneInfo("America/New_York")
# Seeded Northside hours: Mon-Fri 08:00-17:00, Sat 09:00-14:00.
HOURS = {0: (8, 17), 1: (8, 17), 2: (8, 17), 3: (8, 17), 4: (8, 17), 5: (9, 14)}

PROBLEMS = [
    # (service, urgency, opener, echo, value)
    ("AC repair", "this_week", "my air conditioner's running but the air coming out is warm", "warm air out of the AC", 450),
    ("AC repair", "emergency", "the AC quit completely and it's {temp} degrees inside", "{temp} degrees with no AC", 450),
    ("AC repair", "this_week", "there's water pooling under the indoor AC unit", "water pooling under the unit", 300),
    ("AC repair", "this_week", "the outside unit is making a loud rattling noise", "a rattle from the outside unit", 350),
    ("furnace repair", "emergency", "the furnace won't kick on and it's {temp} in the house", "the furnace not firing with the house at {temp}", 500),
    ("furnace repair", "this_week", "the furnace keeps short cycling, on and off every few minutes", "the furnace cycling on and off", 400),
    ("furnace repair", "this_week", "there's a burning dust smell every time the heat comes on", "that burning smell when the heat comes on", 250),
    ("heat pump service", "this_week", "the heat pump has ice all over the outdoor coil", "ice on the heat pump coil", 350),
    ("heat pump service", "this_month", "my heat pump's due for a service", "a heat pump service", 200),
    ("annual maintenance", "this_month", "I'd like to get the system tuned up before winter", "a tune-up before winter", 219),
    ("ductwork", "this_month", "a couple of rooms barely get any airflow", "rooms with barely any airflow", 900),
    ("AC installation", "researching", "our AC is twenty years old and I'm thinking about replacing it", "replacing a twenty-year-old AC", 9000),
]
WHO = ["", " and my mom's staying with us, she's in her eighties", " and I work from home",
       " and we've got a newborn", " and the dog is miserable", ""]
OPEN_FRAMES = [
    "Hi, {problem}{who}.", "Hey there, {problem}{who}. Can someone take a look?",
    "Hi, um, {problem}{who}. Do you guys handle that?", "Good morning. So {problem}{who}.",
    "Hi, I'm calling because {problem}{who}.", "Yeah hi, {problem}{who}. How soon can you get someone out?",
]
ACKS = [
    "Okay, {echo}, I'm sorry, that's no fun.", "Got it, {echo}. We can definitely help with that.",
    "Right, {echo}. That's something our techs see a lot.", "Okay, {echo}. Let's get someone out to you.",
    "Oh no, {echo}. Let's get that sorted.", "Got it, {echo}, we'll get that looked at.",
]
# Routine work gets a plain acknowledgement, not sympathy.
PLANNED_ACKS = [
    "Sure, {echo}, we can do that.", "Great, {echo}, happy to help with that.",
    "Okay, {echo}. We do those all the time.", "Sounds good, {echo}. Let's get you on the schedule.",
]
ACK_WHO = {
    " and my mom's staying with us, she's in her eighties": " With your mom there, we'll treat it as a priority.",
    " and we've got a newborn": " With a newborn in the house, we'll treat it as a priority.",
}
NEXT_Q = [
    " Want me to check the next open times?", " Would you like me to see what we've got this week?",
    " Should I look up the earliest appointment?", " Do you want me to find you a time?",
]
ASK_TIMES = ["Yes please, what times do you have?", "Sure, when can someone come?", "Yeah, what's the earliest?",
             "Please. Mornings are better for me.", "Yes, anything this week?"]
OFFER = [
    "I've got {a} or {b}. Which works better?", "The earliest I have is {a}, or there's {b}. Either of those work?",
    "I can do {a}, or {b}. Which would you like?", "There's {a} open, and {b}. Do either of those suit you?",
]
GIVE_DETAILS = [
    "It's {name}, and my number's {spoken}.", "My name is {name}, number is {spoken}.",
    "Sure, {name}. You can reach me on {spoken}.", "Okay, it's {name}, {spoken}.",
]
AFTER_DETAILS = [
    "Thanks, {first}. And which time did you want, {a} or {b}?",
    "Got it, thanks {first}. So, {a} or {b}?", "Perfect, thanks {first}. Which of those two works, {a} or {b}?",
]
PICK = ["The first one.", "{a_short} works.", "Let's do {a_short}.", "I'll take {a_short}.", "The earlier one please."]
PICK_SECOND = ["The second one.", "{b_short} is better.", "Let's go with {b_short}."]
CONFIRM_BOOKED = [
    "You're all set for {when}. The tech will call when they're on the way.",
    "Done, you're booked for {when}. Anything else I can help with?",
    "Great, that's booked for {when}. We'll see you then.",
]
ESCALATE = [
    ("I want to speak to a real person.", "caller asked for a human", "soon"),
    ("Can I talk to a manager please?", "caller asked for a manager", "soon"),
    ("Your tech scratched my floor last time and I want it paid for.", "damage claim from a previous visit", "now"),
    ("I smell gas near the furnace.", "possible gas leak — safety", "now"),
    ("Honestly I'm getting frustrated, this is the third time I've called about this.", "repeated frustration", "soon"),
]
UNKNOWN_PRICE = [
    ("How much to replace a capacitor?", "capacitor replacement"),
    ("What do you charge to clean ducts?", "duct cleaning"),
    ("How much is a new thermostat installed?", "a thermostat install"),
    ("Ballpark, what does a blower motor cost?", "a blower motor"),
]
PRICE_REPLY = [
    "I don't have a set price for {thing}, it depends on what the tech finds. The diagnostic visit is $89, and that's waived if you go ahead with the repair. Want me to find you a time?",
    "I can't give you a number for {thing} without the tech seeing it. What I can tell you is the diagnostic is $89, waived if you proceed. Should I check availability?",
]
AI_Q = ["Am I talking to a real person?", "Wait, is this a robot?", "Are you an actual human?"]
AI_REPLY = [
    "I'm an AI assistant for {biz}. I can book you in, or get a person to call you back if you'd rather.",
    "No, I'm {biz}'s AI assistant. Happy to keep going, or I can have someone from the team call you.",
]

DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def hvac_slots(now: datetime, rng: random.Random) -> list[datetime]:
    """What checkAvailability returns: 30-minute starts, an hour's notice, up to 8."""
    out, day = [], now.replace(hour=0, minute=0, second=0, microsecond=0)
    while len(out) < 8:
        if day.weekday() in HOURS:
            o, c = HOURS[day.weekday()]
            t = day.replace(hour=o)
            while t + timedelta(hours=1) <= day.replace(hour=c) and len(out) < 8:
                if t >= now + timedelta(hours=1) and rng.random() > 0.35:  # some already booked
                    out.append(t)
                t += timedelta(minutes=30)
        day += timedelta(days=1)
    return out


def short(local: datetime) -> str:
    return local.strftime("%A at %-I") + ("" if local.minute == 0 else local.strftime(":%M"))


def spoken_time(local: datetime) -> str:
    return local.strftime("%A at %-I:%M %p").replace(":00", "")


def hvac_dialogue(kit: dict, rng: random.Random) -> list[dict]:
    h = kit["hvac"]
    now = datetime(2026, rng.choice([1, 2, 3, 6, 7, 8, 10, 11, 12]), rng.randint(1, 26),
                   rng.randint(7, 19), rng.choice([0, 10, 25, 40, 55]), tzinfo=HVAC_TZ)
    context_unknown = context_block(now, "America/New_York", None, None)
    service, urgency, problem, echo, value = rng.choice(PROBLEMS)
    temp = rng.choice([52, 55, 58, 61] if service.startswith("furnace") else [84, 87, 90, 93]) \
        if "{temp}" in problem else None
    who = rng.choice(WHO)
    problem_t, echo_t = problem.format(temp=temp), echo.format(temp=temp)

    examples: list[dict] = []
    messages: list[dict] = [{"role": "user", "content": rng.choice(OPEN_FRAMES).format(problem=problem_t, who=who)}]
    context = context_unknown

    def emit(target: dict, kind: str):
        examples.append({"system": h["system"], "context": context, "messages": list(messages),
                         "target": target, "kind": kind})
        messages.append({"role": "assistant", **target})

    # 1. Record the lead, then acknowledge with THEIR details only.
    emit({"tool_calls": [{"name": "qualify_lead", "arguments": {
        "service": service, "intent": problem_t[0].upper() + problem_t[1:], "urgency": urgency,
        "score": {"emergency": 85, "this_week": 70, "this_month": 55, "researching": 30}[urgency],
        "estimated_value": value}}]}, "qualify_first")
    messages.append({"role": "tool", "content": '{"ok":true,"lead_id":"' + str(uuid.UUID(int=rng.getrandbits(128))) + '"}'})
    urgent = urgency in ("emergency", "this_week")
    ack = rng.choice(ACKS if urgent else PLANNED_ACKS).format(echo=echo_t)
    ack = ack[0].upper() + ack[1:] + (ACK_WHO.get(who, "") if urgent else "") + rng.choice(NEXT_Q)
    emit({"content": ack}, "acknowledge_own_details")

    # Side branches that end the scripted flow.
    branch = rng.random()
    if branch < 0.12:
        line, reason, urg = rng.choice(ESCALATE)
        messages.append({"role": "user", "content": line})
        emit({"tool_calls": [{"name": "escalate_to_human", "arguments": {"reason": reason, "urgency": urg}}]}, "escalate")
        return examples
    if branch < 0.22:
        q, thing = rng.choice(UNKNOWN_PRICE)
        messages.append({"role": "user", "content": q})
        emit({"content": rng.choice(PRICE_REPLY).format(thing=thing)}, "unknown_price")
        return examples
    if branch < 0.30:
        messages.append({"role": "user", "content": rng.choice(AI_Q)})
        emit({"content": rng.choice(AI_REPLY).format(biz=h["business"])}, "ai_disclosure")
        return examples

    # 2. Times come from the tool, never from memory.
    messages.append({"role": "user", "content": rng.choice(ASK_TIMES)})
    emit({"tool_calls": [{"name": "check_availability", "arguments": {"service": service}}]}, "check_before_offer")
    slots = hvac_slots(now, rng)
    messages.append({"role": "tool", "content": json.dumps({"ok": True, "timezone": "America/New_York", "slots": [
        {"starts_at": iso_utc(s), "label": slot_label(s)} for s in slots]}, separators=(",", ":"))})
    a, b = slots[0], slots[rng.choice([2, 3, 4])]
    emit({"content": rng.choice(OFFER).format(a=spoken_time(a), b=spoken_time(b))}, "offer_two_times")

    # 3. A name and number is not a yes to a time.
    first, last = rng.choice(FIRST), rng.choice(LAST)
    digits = f"617555{rng.randint(1000, 9999)}"
    spoken = " ".join(DIGITS[int(d)] for d in digits[:3]) + ", " + " ".join(DIGITS[int(d)] for d in digits[3:6]) + \
        ", " + " ".join(DIGITS[int(d)] for d in digits[6:]) if rng.random() < 0.3 else \
        f"{digits[:3]} {digits[3:6]} {digits[6:]}"
    messages.append({"role": "user", "content": rng.choice(GIVE_DETAILS).format(name=f"{first} {last}", spoken=spoken)})
    emit({"tool_calls": [{"name": "save_contact_detail", "arguments": {"field": "name", "value": f"{first} {last}"}},
                         {"name": "save_contact_detail", "arguments": {"field": "phone", "value": f"+1{digits}"}}]},
         "save_details_not_book")
    messages += [{"role": "tool", "content": '{"ok":true}'}, {"role": "tool", "content": '{"ok":true}'}]
    context = context_block(now, "America/New_York", f"{first} {last}", f"+1{digits}")
    emit({"content": rng.choice(AFTER_DETAILS).format(first=first, a=spoken_time(a), b=spoken_time(b))},
         "ask_which_time")

    # 4. Book only the time they picked.
    chosen = a if rng.random() < 0.6 else b
    pick = rng.choice(PICK if chosen is a else PICK_SECOND).format(a_short=short(a), b_short=short(b))
    messages.append({"role": "user", "content": pick})
    emit({"tool_calls": [{"name": "book_appointment", "arguments": {
        "service": service, "starts_at": iso_utc(chosen), "notes": problem_t[0].upper() + problem_t[1:]}}]},
         "book_after_choice")
    messages.append({"role": "tool", "content": json.dumps({"ok": True, "appointment_id": str(uuid.UUID(int=rng.getrandbits(128))),
                                                            "confirmed_for": booked_label(chosen)}, separators=(",", ":"))})
    emit({"content": rng.choice(CONFIRM_BOOKED).format(when=spoken_time(chosen))}, "confirm_booked")
    return examples


# ─── Assembly ────────────────────────────────────────────────────────────────

def eval_utterances() -> list[str]:
    src = (ROOT / "src/server/eval/scenarios.ts").read_text()
    block = src[src.index("export const SCENARIOS"):]
    turns = re.findall(r"turns:\s*\[(.*?)\]", block, re.S)
    return [s for t in turns for s in re.findall(r'"((?:[^"\\]|\\.)*)"', t)]


def finalize(ex: dict, tools: list[dict], source: str, group: str) -> dict:
    prompt = render_prompt(ex["system"], ex["context"], tools, ex["messages"])
    return {"source": source, "kind": ex["kind"], "group": group,
            "prompt": prompt, "completion": render_target(ex["target"]), "target": ex["target"],
            "system": ex["system"], "context": ex["context"], "messages": ex["messages"]}


def pack(rows: list[dict]) -> list[dict]:
    """
    One sequence per stretch of dialogue with a constant context, carrying the
    character span of every target in it.

    Training on decision points one at a time re-reads the same ~2.5k-token
    prefix for each of them. Packing reads a dialogue once and takes the loss
    on all of its targets together: same supervision, a quarter of the compute.
    Context changes (a name gets saved mid-call) start a new sequence so no
    turn ever sees information from its future.
    """
    groups: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        groups.setdefault((r["group"], r["context"]), []).append(r)

    packed = []
    for items in groups.values():
        items.sort(key=lambda r: len(r["prompt"]))
        last = items[-1]
        text = last["prompt"] + last["completion"]
        spans = []
        for r in items:
            start = len(r["prompt"])
            assert text.startswith(r["prompt"]) and \
                text[start:start + len(r["completion"])] == r["completion"], r["kind"]
            spans.append([start, start + len(r["completion"])])
        packed.append({"source": last["source"], "group": last["group"],
                       "kinds": [r["kind"] for r in items], "text": text, "spans": spans})
    return packed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hvac-dialogues", type=int, default=400)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    kit = json.loads((OUT / "prompt-kit.json").read_text())
    tools = kit["tools"]
    sgd = json.loads((ROOT / "data/raw/sgd/services_single_domain.json").read_text())

    rows = {"train": [], "valid": []}
    for split, dialogues in sgd.items():
        dest = "train" if split == "train" else "valid"
        for d in dialogues:
            for ex in convert_sgd(d, kit, rng):
                rows[dest].append(finalize(ex, tools, "sgd", d["dialogue_id"]))

    for i in range(args.hvac_dialogues):
        dest = "valid" if i % 8 == 0 else "train"
        for ex in hvac_dialogue(kit, rng):
            rows[dest].append(finalize(ex, tools, "hvac", f"hvac_{i}"))

    leaks = [u for u in eval_utterances() if any(u in r["prompt"] for r in rows["train"])]
    if leaks:
        raise SystemExit(f"eval utterances leaked into training data: {leaks}")

    for split, items in rows.items():
        rng.shuffle(items)
        with open(OUT / f"{split}.jsonl", "w") as f:
            for r in items:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    packed = pack(rows["train"])
    rng.shuffle(packed)
    with open(OUT / "train_packed.jsonl", "w") as f:
        for r in packed:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"train_packed: {len(packed)} sequences carrying {sum(len(p['spans']) for p in packed)} targets")

    from collections import Counter
    for split, items in rows.items():
        kinds = Counter(f"{r['source']}:{r['kind']}" for r in items)
        print(f"{split}: {len(items)} examples")
        for k, v in sorted(kinds.items()):
            print(f"    {k:40s} {v}")
    print(f"✓ wrote {OUT}/train.jsonl and valid.jsonl  (no eval utterances in training text)")


if __name__ == "__main__":
    main()
