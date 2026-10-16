"""
Objection-handling dialogues for the conversion fine-tune.

There is essentially no public corpus for this. MultiWOZ, Taskmaster and
Schema-Guided Dialogue all cover BOOKING — a cooperative caller who already
wants the thing — and nothing covers a caller who hesitates. Objection
handling lives in proprietary sales recordings, so it is generated here from
the taxonomy the product already encodes in `src/server/agent/playbook.ts`.

Two properties matter more than volume:

1. BOTH OUTCOMES. Half of these dialogues end without a booking. A model
   trained only on objections that melt away learns to keep pushing, which is
   the behaviour that loses the lead and embarrasses the client. Accepting a
   no gracefully — capture the details, leave the door open, stop — is a
   trained skill, not an absence of one.

2. NOTHING INVENTED. No target discounts, invents a deadline, or claims
   scarcity. Those are deceptive practices under the FTC Act and UK CPUTR,
   and a model that learned them would produce them on a real call.
"""
import random

from build_dataset import (
    HVAC_TZ, PROBLEMS, context_block, hvac_slots, iso_utc, slot_label,
    spoken_time, short, FIRST, LAST, DIGITS,
)
from datetime import datetime

# ─── Objections, in the caller's words ───────────────────────────────────────

PRICE = [
    "Eighty-nine just for someone to look at it? That seems steep.",
    "That's more than I was expecting, honestly.",
    "Hmm, that's a bit pricey for a call-out.",
    "Is there any way to do it cheaper?",
    "That's quite a lot just for a diagnosis.",
]
DELAY = [
    "Let me think about it and get back to you.",
    "I'll need to talk to my husband first.",
    "Can I call you back? I want to think it over.",
    "I'm not ready to commit to anything today.",
]
COMPETITION = [
    "I'm getting a couple of other quotes as well.",
    "I've got someone else coming out Thursday to look at it.",
    "How do you compare to the other companies around here?",
    "I've had two other estimates already.",
]
BROWSING = [
    "I'm just looking into options at this point.",
    "Honestly I'm just gathering information for now.",
    "I'm not ready to book anything, just researching.",
]
TRUST = [
    "How do I know you're legitimate?",
    "Are your technicians actually licensed?",
    "I've been burned by a contractor before, so I'm cautious.",
    "Are you insured? I've had problems before.",
]

# ─── Agent targets: acknowledge -> reframe -> re-offer ───────────────────────
# Reframes cite only facts seeded in the knowledge base: $89 diagnostic waived
# on repair, 1 year labour warranty, financing over $3,000, EPA 608 certified,
# licensed and insured in Massachusetts, trading since 2004.

PRICE_REPLY = [
    "That's a fair point. The eighty-nine covers a full diagnosis, and it's waived "
    "if you go ahead with the repair, so it only costs you anything if we don't fix it. "
    "Does {a} still work for you?",
    "I understand. It's eighty-nine for the visit, and that comes off the bill if you "
    "proceed with the repair. Shall I hold {a}?",
    "Completely fair. The diagnostic's eighty-nine and it's waived when you go ahead "
    "with the work, so you're not paying twice. Would {a} suit?",
]
DELAY_REPLY = [
    "Of course, no rush. Is it the cost you want to weigh up, or the timing?",
    "That's fine. What would you want to think over — I might be able to answer it now.",
    "Absolutely. Can I ask what's giving you pause? It might be something I can clear up.",
]
COMPETITION_REPLY = [
    "That's sensible, I'd do the same. We've been going since two thousand four and "
    "every tech is EPA certified, and there's a year's warranty on our labour. "
    "Would it help to have us out first so you've got something to compare against?",
    "Good — worth comparing. We're licensed and insured in Massachusetts and we "
    "warranty our labour for a year. Happy to come out and give you a number for the pile.",
]
BROWSING_REPLY = [
    "That's completely fine, no pressure at all. Can I take your name and number so "
    "I can send you what we'd charge, and you can come back to us whenever suits?",
    "No problem at all. Shall I take a number so you've got ours, and you can call "
    "when you're ready?",
]
TRUST_REPLY = [
    "Totally fair to ask. We're licensed and insured in Massachusetts, every "
    "technician is EPA six-oh-eight certified and background checked, and we've been "
    "trading since two thousand four. Would {a} work for you?",
    "Good question. We're fully licensed and insured here in Massachusetts, all our "
    "techs are EPA certified, and we warranty our labour for a year. Shall I book {a}?",
]

# ─── Caller's second move ────────────────────────────────────────────────────

CONVERT = [
    "Okay, that's fair. Let's do {a_short}.",
    "Alright, that makes sense. {a_short} works.",
    "Okay, go on then. {a_short} is fine.",
    "That's reasonable. Let's book {a_short}.",
]
DECLINE = [
    "No, I think I'll leave it for now, thanks.",
    "I'd still rather hold off, if that's alright.",
    "No, I'm going to wait and see. Thanks though.",
    "Not just yet, but thanks for your time.",
]

# Accepting a no. No second pitch, no "are you sure", no parting offer.
ACCEPT_NO = [
    "That's absolutely fine. I've got your details, so give us a ring whenever you're "
    "ready and we'll pick it up from there.",
    "No problem at all. We're here when you need us — just call and ask for the team.",
    "Of course. I'll leave it with you, and we'll be here if it gets worse.",
    "Understood, no pressure at all. Give us a call whenever suits.",
]

# (name, caller lines, agent replies, P(converts after the reframe))
#
# The rates are deliberate, not uniform. A price or trust objection often does
# come round once it is answered with a fact; someone who says they are just
# browsing usually means it. Weighted to land near an even split overall, so
# the model learns neither to give up early nor to keep pushing.
OBJECTIONS = [
    ("price", PRICE, PRICE_REPLY, 0.60),
    ("delay", DELAY, DELAY_REPLY, 0.35),
    ("competition", COMPETITION, COMPETITION_REPLY, 0.55),
    ("browsing", BROWSING, BROWSING_REPLY, 0.20),
    ("trust", TRUST, TRUST_REPLY, 0.65),
]


def conversion_dialogue(kit: dict, rng: random.Random) -> list[dict]:
    h = kit["hvac"]
    now = datetime(2026, rng.choice([1, 2, 3, 6, 7, 8, 10, 11, 12]), rng.randint(1, 26),
                   rng.randint(8, 16), rng.choice([0, 15, 30, 45]), tzinfo=HVAC_TZ)
    service, urgency, problem, echo, value = rng.choice(
        [p for p in PROBLEMS if "{temp}" not in p[2]])

    first, last = rng.choice(FIRST), rng.choice(LAST)
    digits = f"617555{rng.randint(1000, 9999)}"
    context = context_block(now, "America/New_York", f"{first} {last}", f"+1{digits}")

    slots = hvac_slots(now, rng)
    a = slots[0]
    a_spoken, a_short_s = spoken_time(a), short(a)

    examples: list[dict] = []
    messages: list[dict] = [
        {"role": "user", "content": f"Hi, {problem}."},
        {"role": "assistant", "content":
            f"Okay, {echo}. I've got {a_spoken} free — shall I put you down for that?"},
    ]

    def emit(target: dict, kind: str):
        examples.append({"system": h["system"], "context": context,
                         "messages": list(messages), "target": target, "kind": kind})
        messages.append({"role": "assistant", **target})

    name, pool, replies, convert_rate = rng.choice(OBJECTIONS)
    messages.append({"role": "user", "content": rng.choice(pool)})

    reply = rng.choice(replies).format(a=a_spoken)
    emit({"content": reply}, f"objection_{name}")

    # Roughly half convert. The declines are the point: a model trained only on
    # objections that dissolve learns to keep pushing.
    if rng.random() < convert_rate:
        messages.append({"role": "user", "content": rng.choice(CONVERT).format(a_short=a_short_s)})
        emit({"tool_calls": [{"name": "book_appointment", "arguments": {
            "service": service, "starts_at": iso_utc(a),
            "notes": problem[0].upper() + problem[1:]}}]}, "book_after_objection")
        messages.append({"role": "tool", "content":
            '{"ok":true,"confirmed_for":"' + slot_label(a) + '"}'})
        emit({"content": f"Brilliant, you're booked in for {a_spoken}. "
                         f"We'll see you then, {first}."}, "confirm_after_objection")
    else:
        messages.append({"role": "user", "content": rng.choice(DECLINE)})
        # The trained behaviour: stop. One line, no second pitch.
        emit({"content": rng.choice(ACCEPT_NO)}, "accept_no_gracefully")

    return examples
