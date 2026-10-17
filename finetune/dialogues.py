"""
Scripted voice dialogues for the fine-tune: plans, not prompts.

Each line of the output is one phone call, written as what the caller says
and what the agent should produce on each turn. scripts/finetune-render.ts
replays it through the production voice route and records what the model is
actually shown on every turn: the system prompt, the per-turn context (clock,
caller, the calendar note, "your previous reply", the urgent and outbound
notes), the history and the tools offered on that turn. So nothing here
decides which tools exist or what the prompt says; production does.

What the agent says is held to three rules:
  - Every price, policy or service it states is a seeded fact. Each fact a
    reply relies on is looked up in the prompt kit when the generator starts,
    with the substrings the reply depends on, so a reseeded tenant fails the
    build instead of training a stale price.
  - Times are never written here. {a} and {b} are filled from the slots the
    calendar note actually offered, {pick_iso} is that slot's exact start.
  - No outcome is promised: no visa, no offer, no repair result.

    python3 finetune/dialogues.py                 # data/finetune/dialogues.jsonl
    python3 finetune/dialogues.py --per-tenant 50 --out /tmp/d.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT_PATH = ROOT / "data/finetune/prompt-kit.json"
REAL_CALLERS = ROOT / "data/finetune/real_callers.json"

# ─── Building blocks ────────────────────────────────────────────────────────


def reply(kind: str, text: str) -> dict:
    return {"kind": kind, "content": text}


def offer(kind: str, text: str, i: int, j: int) -> dict:
    """A reply naming two slots from the calendar note: {a} is slot i, {b} slot j."""
    return {"kind": kind, "content": text, "offer": [i, j]}


def call(kind: str, name: str, **arguments) -> dict:
    return {"kind": kind, "tool_calls": [{"name": name, "arguments": arguments}]}


def turn(caller: str, *agent: dict, pick: str | None = None, expect_rule: bool = False) -> dict:
    t: dict = {"caller": caller, "agent": list(agent)}
    if pick:
        t["pick"] = pick
    if expect_rule:
        t["expect_rule"] = True
    return t


class Facts:
    """The tenant's seeded facts, checked when a reply is written from one."""

    def __init__(self, slug: str, facts: dict[str, str]):
        self.slug, self.facts = slug, facts

    def need(self, key: str, *must: str) -> str:
        value = self.facts.get(key)
        if value is None:
            raise SystemExit(f"{self.slug}: no seeded fact {key!r}; reseed, or change finetune/dialogues.py")
        for m in must:
            if m.lower() not in value.lower():
                raise SystemExit(f"{self.slug}: fact {key!r} no longer says {m!r}: {value!r}")
        return value


# ─── Callers ────────────────────────────────────────────────────────────────

NAMES = {
    "US": [("Dana", "Reyes"), ("Marcus", "Kim"), ("Priya", "Shah"), ("Tom", "Walsh"), ("Keisha", "Brown"),
           ("Luis", "Ortega"), ("Megan", "Doyle"), ("Sam", "Carter"), ("Angela", "Russo"), ("Kevin", "Nguyen"),
           ("Rachel", "Cohen"), ("Omar", "Haddad"), ("Jen", "Patel"), ("Mike", "Sullivan"), ("Tasha", "Green"),
           ("Carlos", "Mendes"), ("Erin", "Murphy"), ("Brian", "Lee"), ("Grace", "Fontaine"), ("Derek", "Owens")],
    "CA": [("Arjun", "Mehta"), ("Harpreet", "Gill"), ("Wei", "Zhang"), ("Maria", "Santos"), ("Chidi", "Okeke"),
           ("Fatima", "Khan"), ("Rohan", "Iyer"), ("Mei", "Lin"), ("Jasmine", "Dhillon"), ("Ana", "Cruz"),
           ("Kwame", "Mensah"), ("Simran", "Kaur"), ("Daniel", "Tremblay"), ("Sofia", "Rossi"), ("Ali", "Rezaei"),
           ("Joseph", "Mwangi"), ("Nadia", "Haddad"), ("Vikram", "Rao"), ("Leila", "Ahmadi"), ("Thanh", "Tran")],
    "GB": [("Oliver", "Hughes"), ("Amelia", "Clarke"), ("Priya", "Patel"), ("Mohammed", "Ali"), ("Chloe", "Evans"),
           ("Harry", "Wilson"), ("Aisha", "Begum"), ("Jack", "Thompson"), ("Sophie", "Bennett"), ("Ravi", "Sharma"),
           ("Emily", "Davies"), ("Kofi", "Asante"), ("Hannah", "Price"), ("Tom", "Fletcher"), ("Zara", "Hussain"),
           ("Lucy", "Morgan"), ("Daniel", "Okafor"), ("Grace", "Murphy"), ("Ethan", "Shaw"), ("Isla", "Campbell")],
}

NAME_LINES = [
    "My name's {first} {last}.", "It's {first} {last}.", "I'm {first} {last}.", "This is {first} {last}.",
    "My name is {first}.", "Yeah, it's {first}.", "Sure, my name's {first} {last}.", "Name's {first}.",
]

PICKS_A = ["{a_short} works.", "Let's do {a_short}.", "{a_short} is good for me.", "The first one, please.",
           "I'll take {a_short}.", "{a_short}, please.", "Yeah, {a_short} is fine.", "The earlier one works."]
PICKS_B = ["{b_short} works better.", "Can we do {b_short}?", "The second one, please.", "I'll take {b_short}.",
           "{b_short} would be better for me.", "Let's go with the later one.", "Make it {b_short}."]

THANKS_BYE = ["Great, thanks so much. Bye.", "Perfect, thank you. Bye now.", "Lovely, thanks. Bye.",
              "That's great, thank you.", "Thanks, that's all I needed."]


def phone_spoken(country: str, rng: random.Random) -> str:
    if country == "GB":
        return f"07700 900{rng.randint(100, 999)}"
    area = {"US": "617", "CA": "416"}[country]
    return f"{area} 555 01{rng.randint(10, 99)}"


class Caller:
    def __init__(self, country: str, rng: random.Random, bank: list[dict] | None):
        self.first, self.last = rng.choice(NAMES[country])
        self.country, self.rng, self.bank = country, rng, bank

    def name_line(self) -> str:
        r = self.rng
        if self.bank and r.random() < 0.35:
            t = r.choice(self.bank)["template"]
            return t.format(first=self.first, last=self.last, spoken=phone_spoken(self.country, r),
                            first_spelled=" ".join(self.first.lower()), last_spelled=" ".join(self.last.lower()))
        return r.choice(NAME_LINES).format(first=self.first, last=self.last)


# ─── A business, as dialogue material ───────────────────────────────────────


class Pack:
    """Everything one tenant's calls are made of. Subclasses fill it from seeded facts."""

    slug = ""
    source = ""
    country = "US"
    needs: list[dict] = []
    questions: list[dict] = []
    objections: list[dict] = []
    not_offered: list[dict] = []
    out_of_depth: list[dict] = []
    outbound_interest: list[dict] = []

    def __init__(self, kit: dict):
        t = kit["tenants"][self.slug]
        self.business, self.agent, self.noun = t["business"], t["agent"], t["bookingNoun"]
        self.facts = Facts(self.slug, t["facts"])
        self.build()

    def build(self) -> None:
        raise NotImplementedError

    def confirm(self, caller: Caller, need: dict, rng: random.Random) -> str:
        raise NotImplementedError


ACKS = ["Got it.", "Okay.", "Right.", "Okay, thanks.", "Sure."]


class Northside(Pack):
    slug, source, country = "northside-hvac", "hvac", "US"

    def build(self) -> None:
        f = self.facts
        diag = f.need("pricing/Diagnostic visit", "$89", "waived")
        f.need("policy/Warranty", "1 year on labour")
        f.need("policy/Payment", "Financing available on replacements over $3,000")
        f.need("policy/Cancellation", "more than 2 hours")
        f.need("pricing/Full AC system replacement", "$6,500 to $12,500", "on site")
        f.need("pricing/Annual maintenance plan", "$219", "two tune-ups")
        f.need("products/Brands installed", "Carrier", "Trane", "Mitsubishi")
        f.need("products/AC system types", "ductless mini-splits")
        f.need("services/Not offered", "plumbing", "electrical panel", "roofing", "appliance repair")
        f.need("policy/Emergency response", "Same-day emergency slots")
        assert "$89" in diag
        # Each opening carries its own acknowledgement, and each question the
        # answers that fit it: an echo of a detail the caller never gave is
        # exactly what the prompt forbids.
        self.needs = [
            {"service": "AC repair", "notes": "AC running but not cooling",
             "open": [("My AC is blowing warm air.", "Warm air out of the AC is no fun."),
                      ("Hi, my air conditioner stopped cooling.", "An AC that's stopped cooling needs looking at."),
                      ("The AC's running but it's not cooling the house.", "Running but not cooling usually means something specific."),
                      ("My central air isn't cooling, it's {temp} in here.", "{temp} degrees inside is a lot.")],
             "diag": [("Is the outdoor unit running at all?", ["Yeah, the outside unit's running.", "I don't think so, it's quiet out there."]),
                      ("Is any air coming out of the vents?", ["Air's coming out, it's just warm.", "Barely, it's really weak."]),
                      ("Is the thermostat set to cool?", ["Yeah, it's on cool.", "Yes, set to seventy."])]},
            {"service": "Furnace repair", "notes": "Furnace cycling or noisy",
             "open": [("My furnace is making a loud banging noise when it kicks on.", "Banging when it starts up isn't something to leave."),
                      ("The furnace keeps shutting off after a few minutes.", "A furnace that keeps cutting out needs a technician."),
                      ("My heat isn't working properly, the furnace keeps cycling on and off.", "Cycling on and off like that is worth checking.")],
             "diag": [("How old is the furnace, roughly?", ["It's maybe twelve years old.", "No idea, it came with the house."]),
                      ("Is the house still getting some heat?", ["A bit, not much.", "Some, yeah, but it's chilly."]),
                      ("Has it had a tune-up in the last year?", ["Not in a couple of years, no.", "Yeah, last fall."])]},
            {"service": "Heat pump service", "notes": "Heat pump fault",
             "open": [("My heat pump is making a grinding noise.", "A grinding noise is worth catching early."),
                      ("The heat pump's iced over and not heating well.", "Ice building up like that means something's off."),
                      ("Hi, our heat pump isn't heating the upstairs anymore.", "The upstairs going cold is a clear sign something's off.")],
             "diag": [("Is it running constantly, or turning on and off?", ["It's running pretty much all the time.", "On and off, every few minutes."]),
                      ("Do you know what brand it is?", ["I think it's a Mitsubishi.", "It's a Trane, I'm pretty sure."])]},
            {"service": "AC tune-up", "notes": "Pre-season AC tune-up",
             "open": [("I'd like to get my AC serviced before summer.", "Getting it checked before the heat hits is smart."),
                      ("Can I book an AC tune-up?", "Happy to set up a tune-up."),
                      ("I want someone to check my air conditioning before it gets hot.", "A check before it gets hot is a good call.")],
             "diag": [("Is it a central system or a mini-split?", ["Central air.", "It's a mini-split in the bedroom."]),
                      ("When was it last serviced?", ["Maybe two years ago.", "Honestly, never."])]},
            {"service": "AC replacement estimate", "replacement": True, "notes": "Replacement estimate",
             "open": [("My AC is about twenty years old and I'm thinking about replacing it.", "Twenty years is a good run for an AC."),
                      ("I'm looking at replacing my central air, can someone give me a quote?", "Happy to help with a replacement."),
                      ("We want to put in a new air conditioning system.", "A new system, sure.")],
             "diag": [("Is it a single-storey house or two floors?", ["Two floors, about two thousand square feet.", "Just one floor."]),
                      ("Are you thinking central air again, or a heat pump?", ["Probably central air again.", "I'm open to a heat pump."])]},
            {"service": "Furnace repair", "urgent": True, "notes": "No heat, vulnerable person at home",
             "open": [("Our furnace stopped working and we have a newborn at home.", "With no heat and a newborn at home, I'll treat this as urgent."),
                      ("There's no heat at all and my mother's ninety, she lives with us.", "No heat with your mother at home, I'll treat this as urgent."),
                      ("The heating's not working and my kids are freezing.", "With the kids at home and no heat, I'll treat this as urgent.")]},
            {"service": "AC repair", "urgent": True, "notes": "AC out, vulnerable person at home",
             "open": [("My AC died and it's an emergency, my dad has a heart condition.", "With your dad's heart condition, I'll treat this as urgent."),
                      ("Our air conditioning stopped working, I need someone as soon as possible, my elderly mom is here.",
                       "With your mom at home, I'll treat this as urgent.")]},
        ]
        self.questions = [
            {"q": ["Before I book, is there a charge to come out, and does it go away if you fix it?",
                   "What's the call-out fee, and do I still pay it if you do the repair?"],
             "a": "There's an eighty-nine dollar diagnostic visit, and it's waived if you go ahead with the repair.",
             "kind": "fact_price"},
            {"q": ["And what kind of warranty do you give on repairs?", "If you fix it and it breaks again, is that covered?"],
             "a": "Labour's covered for a year, and parts carry the manufacturer's warranty.", "kind": "fact_warranty"},
            {"q": ["Do you do financing on a new system? I don't want to pay it all at once.",
                   "Is there any financing if we replace the whole system?"],
             "a": "Yes, financing's available on replacements over three thousand dollars, subject to approval.",
             "kind": "fact_financing"},
            {"q": ["What brands do you put in? I've heard good things about Trane.",
                   "Do you install Carrier, or other brands too?"],
             "a": "We're a Carrier Factory Authorized Dealer, and we also install and service Trane, Lennox, Rheem and Mitsubishi.",
             "kind": "fact_brands"},
            {"q": ["Roughly what does a whole new AC system run, ballpark?", "How much is a full replacement, just a rough number?"],
             "a": "Typically somewhere between six and a half and twelve and a half thousand dollars, depending on the size of the system, "
                  "and we only quote it in writing after a free in-home visit.",
             "kind": "fact_replacement_range"},
            {"q": ["If something comes up, can I cancel the appointment?", "What if I need to cancel later on?"],
             "a": "Yes, cancelling is free as long as it's more than two hours before the appointment.", "kind": "fact_cancellation"},
        ]
        self.objections = [
            {"kind": "objection_price",
             "say": ["Eighty-nine dollars just to come and look? That's a lot.", "Hmm, eighty-nine bucks before you've even fixed anything?"],
             "answer": ["I hear you, it's real money. It's waived if you go ahead with the repair, so you're only paying it if you don't. "
                        "Want me to hold {a} for you?",
                        "Fair enough. The eighty-nine dollars is waived if you go ahead with the repair, and repairs come with a year on labour. "
                        "Shall I put you down for {a}?"]},
            {"kind": "objection_delay",
             "say": ["Let me think about it and call you back.", "I'm not sure yet, I want to talk it over with my wife."],
             "answer": ["No problem. Is it the cost you want to weigh up, or the timing?",
                        "Of course. What's the main thing you want to think over, the price or the timing?"]},
            {"kind": "objection_competition",
             "say": ["I'm getting a couple of other quotes first.", "I've got another company coming out tomorrow, honestly."],
             "answer": ["That's sensible. We're a Carrier Factory Authorized Dealer with fully licensed technicians, "
                        "and a diagnosis from us gives you something to compare. Want me to book {a}?",
                        "Good idea to compare. We've been in Boston since 2004 and our labour's covered for a year. "
                        "I can still hold {a} if you'd like a second opinion."]},
            {"kind": "objection_trust",
             "say": ["How do I know you guys are legit?", "Are your technicians actually licensed?"],
             "answer": ["Fair question. We're fully licensed and insured in Massachusetts, every technician is EPA 608 certified "
                        "and background checked, and we've been around since 2004. Shall I book {a}?"]},
            {"kind": "objection_discount",
             "say": ["Can you do it any cheaper?", "Is there any discount if I book today?"],
             "answer": ["I can't change prices myself, but the technician can go through options with you on site. "
                        "Would {a} work for the visit?"]},
        ]
        self.not_offered = [
            {"q": ["Do you guys do plumbing too? My water heater's leaking.", "Can you also fix a leaky pipe while you're here?"],
             "a": "We don't do plumbing, sorry, just heating and cooling. Is there anything with your heating or AC I can help with?"},
            {"q": ["Can you look at my electrical panel? It keeps tripping.", "Do you do electrical work?"],
             "a": "Electrical panel work isn't something we do, sorry. We're heating and cooling only. Anything on that side I can help with?"},
            {"q": ["Do you fix fridges?", "My dishwasher's broken, is that something you do?"],
             "a": "We don't do appliance repair, I'm afraid, just heating and cooling. Is there anything with your HVAC I can help with?"},
        ]
        self.out_of_depth = [
            {"q": ["My system uses R-22, can it be converted to a newer refrigerant?",
                   "Can you tell me what SEER rating my current unit is?"],
             "reason": "technical question about the customer's existing system",
             "ask": "That's one for a technician. Would you like someone from the team to call you back about it?"},
            {"q": ["I had a question about the invoice from my last visit.", "I think I was billed twice for my last service."],
             "reason": "question about a past invoice",
             "ask": "I can't see invoices from here. Would you like someone from the team to call you back about it?"},
        ]
        self.outbound_interest = [
            {"interest": "ac_replacement", "service": "AC replacement estimate",
             "about": "For a replacement we start with a free in-home visit, where a technician sizes the system to your home and quotes in writing."},
            {"interest": "heat_pump", "service": "Heat pump estimate",
             "about": "A heat pump heats and cools, and a technician sizes it to your home on a free in-home visit, then quotes in writing."},
            {"interest": "furnace_tuneup", "service": "Furnace tune-up",
             "about": "A tune-up before winter catches problems early, and our maintenance plan covers two tune-ups a year for two hundred and nineteen dollars."},
        ]

    def confirm(self, caller: Caller, need: dict, rng: random.Random) -> str:
        tail = rng.choice([
            "There's an eighty-nine dollar diagnostic, waived if you go ahead with the repair.",
            "If anything changes, cancelling is free up to two hours before.",
            "The technician will check everything over when they arrive.",
        ]) if not need.get("replacement") else "The technician will size the system and give you a written quote."
        return rng.choice([
            f"You're booked for {{pick}}, {caller.first}. {tail}",
            f"All set, {caller.first}, that's {{pick}}. {tail}",
            f"Done. You're booked for {{pick}}. {tail}",
        ])


class Maple(Pack):
    slug, source, country = "maple-immigration", "maple", "CA"

    def build(self) -> None:
        f = self.facts
        f.need("pricing/Consultation", "$150", "45-minute", "credited in full")
        f.need("pricing/Express Entry application", "$2,500", "government fees extra")
        f.need("pricing/Study permit application", "$1,200")
        f.need("pricing/Spousal sponsorship", "$3,500")
        f.need("policy/Who advises", "Regulated Canadian Immigration Consultant", "College of Immigration and Citizenship Consultants",
               "general information only")
        f.need("policy/Outcomes", "No one can guarantee", "IRCC")
        f.need("policy/Payment", "e-transfer", "three instalments")
        f.need("policy/Languages", "Hindi", "Punjabi", "Tamil", "French")
        f.need("services/Not offered", "criminal defence", "Federal Court", "other than Canada")
        f.need("products/How it works", "written quote")
        self.needs = [
            {"service": "Express Entry consultation", "notes": "Express Entry, new profile",
             "open": [("Hi, I want to apply for permanent residency through Express Entry.", "Express Entry for permanent residency."),
                      ("I'm on a post-graduation work permit and I want to get my PR.", "You're on a PGWP and looking at PR."),
                      ("I'd like some help with Express Entry, I haven't started yet.", "Starting fresh on Express Entry.")],
             "diag": [("Have you taken a language test yet, like IELTS or CELPIP?", ["I took IELTS last year.", "Not yet, I'm booked for CELPIP next month."]),
                      ("Do you already have a profile in the Express Entry pool?", ["No, I haven't made one yet.", "Yes, since last year."])]},
            {"service": "Study permit consultation", "notes": "Study permit application",
             "open": [("My son got into a college in Toronto and needs a study permit.", "Congratulations to your son on getting in."),
                      ("I need help applying for a study permit, I start in January.", "A study permit for a January start."),
                      ("I've been accepted to a university here and I need a study permit.", "Congratulations on the acceptance.")],
             "diag": [("Do you have the letter of acceptance yet?", ["Yes, it came last week.", "Not yet, it should come soon."]),
                      ("Which country will you be applying from?", ["From India.", "From the Philippines."])]},
            {"service": "Work permit consultation", "notes": "Work permit",
             "open": [("My employer wants to hire me but I need a work permit.", "A job offer is a good place to start."),
                      ("I've got a job offer in Mississauga and I need to sort out a work permit.", "A work permit for the Mississauga job."),
                      ("I'd like to ask about open work permits.", "Open work permits, sure.")],
             "diag": [("Do you know if the employer is getting an LMIA?", ["I don't think they've done that yet.", "They said they're applying for one."]),
                      ("Are you in Canada right now, or outside?", ["I'm in Canada on a visitor record.", "Outside, I'm in Dubai."])]},
            {"service": "Spousal sponsorship consultation", "notes": "Spousal sponsorship",
             "open": [("I want to sponsor my wife, she's in India.", "Sponsoring your wife from India."),
                      ("I'd like to sponsor my husband to come to Canada.", "Sponsoring your husband."),
                      ("How does spousal sponsorship work? My partner's in Brazil.", "Sponsoring your partner from Brazil.")],
             "diag": [("Are you a Canadian citizen or a permanent resident?", ["I'm a permanent resident.", "I'm a citizen."]),
                      ("Are you married, or common-law?", ["We got married last year.", "Common-law, three years."])]},
            {"service": "Visitor visa consultation", "notes": "Visitor visa",
             "open": [("My parents want to visit for my graduation, they need visitor visas.", "Having your parents here for graduation would be lovely."),
                      ("Can you help with a visitor visa for my mother?", "A visitor visa for your mother.")],
             "diag": [("Have they been to Canada before?", ["No, it'd be the first time.", "Once, about five years ago."]),
                      ("When are they hoping to travel?", ["Around June.", "In the summer."])]},
            {"service": "Work permit consultation", "urgent": True, "notes": "Permit expiring soon",
             "open": [("My work permit expires in three weeks and I need to see someone as soon as possible.",
                       "With your permit running out in three weeks, I'll treat this as urgent."),
                      ("It's urgent, my PGWP runs out next month and I don't know what to do.",
                       "With your PGWP ending next month, I'll treat this as urgent.")]},
        ]
        self.questions = [
            {"q": ["Before we go further, how much is it to sit down with one of your consultants?",
                   "What does the consultation cost, and how long is it?"],
             "a": "It's a hundred and fifty dollars for a forty-five-minute consultation with a licensed consultant, "
                  "and it's credited in full if you go on to retain us.",
             "kind": "fact_price"},
            {"q": ["Roughly what do you charge for the whole Express Entry application?",
                   "And if I go ahead, what's the fee for Express Entry?"],
             "a": "Express Entry starts from twenty-five hundred dollars in professional fees, with government fees on top. "
                  "The consultant gives you a written quote after the consultation.",
             "kind": "fact_fee"},
            {"q": ["Can I pay the fees in parts? It's a lot at once.", "Do I have to pay everything up front?"],
             "a": "No, professional fees can be paid in up to three instalments, by card or e-transfer.", "kind": "fact_payment"},
            {"q": ["My mother speaks Punjabi, can the consultation be in Punjabi?", "Do you have anyone who speaks French?"],
             "a": "Yes, we do consultations in English, Hindi, Punjabi, Tamil and French.", "kind": "fact_languages"},
            {"q": ["Who would I actually be talking to? Are they licensed?", "Is the person I'd meet licensed?"],
             "a": "Every case is handled by a Regulated Canadian Immigration Consultant, licensed by the College of Immigration "
                  "and Citizenship Consultants.",
             "kind": "fact_who_advises"},
            {"q": ["Do I have to come in, or can we do it online?", "I'm in Calgary, can you still help me?"],
             "a": "We work online across Canada, so you don't need to come in.", "kind": "fact_online"},
        ]
        self.objections = [
            {"kind": "objection_price",
             "say": ["A hundred and fifty dollars just to talk to someone? That's steep.", "Hmm, that's a lot for a consultation."],
             "answer": ["I understand. It's forty-five minutes with a licensed consultant, and the full hundred and fifty is credited "
                        "if you go on to retain us. Would {a} work?",
                        "Fair enough. The fee's credited in full if you retain us, so it isn't extra on top. Shall I hold {a} for you?"]},
            {"kind": "objection_diy",
             "say": ["Can't I just do it myself on the IRCC website?", "My friend did his application himself, why would I pay?"],
             "answer": ["Lots of people do apply themselves. A consultation is a chance to have a licensed consultant check your options "
                        "before you file. Would you like me to find a time?"]},
            {"kind": "objection_guarantee",
             "say": ["Can you guarantee I'll get approved?", "If I pay you, will my visa definitely go through?"],
             "answer": ["No one can promise an approval, because IRCC makes the decision. In the consultation you'll get an honest "
                        "assessment of your chances. Would {a} work for that?"]},
            {"kind": "objection_delay",
             "say": ["I need to think about it first.", "Let me talk to my family and get back to you."],
             "answer": ["Of course. Is it the cost you want to weigh up, or something about the process?",
                        "No problem. What's the main thing you'd want to think through?"]},
            {"kind": "objection_competition",
             "say": ["I'm also talking to another consultant.", "Someone else quoted me less for the application."],
             "answer": ["That makes sense, it's worth comparing. Our consultants are all licensed RCICs, and the consultation fee is "
                        "credited if you retain us. Would you like me to hold {a}?"]},
        ]
        self.not_offered = [
            {"q": ["Can you help me get a visa for Australia?", "Do you do UK visas as well?"],
             "a": "We only handle immigration to Canada, sorry. Is there anything on the Canadian side I can help with?"},
            {"q": ["I want to appeal my refusal at the Federal Court.", "Can you represent me in Federal Court?"],
             "a": "We don't handle Federal Court appeals. A licensed consultant can look at your refusal and talk through your other "
                  "options in a consultation, if that would help."},
            {"q": ["I've got a criminal charge, can you defend me?", "Do you do criminal defence?"],
             "a": "We don't do criminal defence, I'm afraid. We handle immigration applications to Canada."},
        ]
        self.out_of_depth = [
            {"q": ["With a CRS of four sixty, will I get an invitation in the next draw?",
                   "Should I apply for the spousal open work permit now, or wait for the sponsorship?"],
             "reason": "case-specific immigration advice",
             "ask": "That depends on your full situation, and only a licensed consultant can advise on it. Would you like someone to call you back about it?"},
            {"q": ["I already have a file open with you and want an update.", "My consultant was supposed to send me a document, has it gone out?"],
             "reason": "update on an existing file",
             "ask": "I can't see client files from here. Would you like someone from the team to call you back about it?"},
        ]
        self.outbound_interest = [
            {"interest": "express_entry", "service": "Express Entry consultation",
             "about": "We start with a forty-five-minute consultation with a licensed consultant, who looks at your profile and tells you which programs fit."},
            {"interest": "study_permit", "service": "Study permit consultation",
             "about": "We start with a consultation with a licensed consultant, then give you a written quote, and we only start once you retain us."},
            {"interest": "sponsorship", "service": "Spousal sponsorship consultation",
             "about": "A licensed consultant reviews your situation in a forty-five-minute consultation, then you get a written quote."},
        ]

    def confirm(self, caller: Caller, need: dict, rng: random.Random) -> str:
        tail = rng.choice([
            "It's forty-five minutes with a licensed consultant.",
            "The hundred and fifty dollars is credited in full if you go on to retain us.",
            "You'll speak with a licensed consultant, and you can do it online.",
        ])
        return rng.choice([
            f"You're booked for {{pick}}, {caller.first}. {tail}",
            f"All set, {caller.first}, that's {{pick}}. {tail}",
            f"Done, you're booked for {{pick}}. {tail}",
        ])


class BrightPath(Pack):
    slug, source, country = "brightpath-admissions", "brightpath", "GB"

    def build(self) -> None:
        f = self.facts
        f.need("pricing/Counselling session", "free", "30-minute")
        f.need("pricing/Undergraduate application package", "£1,450", "five universities", "one mock interview")
        f.need("pricing/Master's application package", "£1,250", "four programmes")
        f.need("pricing/Personal statement review", "£180", "two rounds")
        f.need("pricing/Interview coaching", "£95 per hour", "£340")
        f.need("policy/Outcomes", "never guarantee")
        f.need("policy/Integrity", "we never write them")
        f.need("policy/Payment", "three monthly payments")
        f.need("services/Not offered", "visa applications", "A-level")
        f.need("products/How it works", "nothing is charged")
        self.needs = [
            {"service": "Undergraduate counselling session", "notes": "UCAS undergraduate",
             "open": [("Hi, my son's applying to university next year and we don't know where to start.", "Applying next year gives time to do it properly."),
                      ("I'm in year twelve and I need help with my UCAS application.", "A UCAS application from year twelve, that's good timing."),
                      ("My daughter wants to apply to uni, can you help with UCAS?", "Happy to help with UCAS.")],
             "diag": [("Do you know which subject is in mind?", ["Economics, probably.", "Computer science.", "Law, we think."]),
                      ("Have the predicted grades come through yet?", ["Yes, A A B.", "Not yet, next month."])]},
            {"service": "Interview coaching session", "notes": "Interview coaching",
             "open": [("My daughter has an Oxford interview for medicine and needs coaching.", "A medicine interview at Oxford, that's a big one."),
                      ("I've got a Cambridge interview coming up and I'm really nervous.", "Nerves before a Cambridge interview are completely normal."),
                      ("Do you do interview prep for medicine?", "Yes, we coach for medicine interviews.")],
             "diag": [("When is the interview?", ["Early December.", "In about three weeks."]),
                      ("Has there been any mock interview practice yet?", ["No, none yet.", "Just one at school."])]},
            {"service": "Personal statement session", "notes": "Personal statement coaching",
             "open": [("I need help with my personal statement.", "The personal statement is worth getting right."),
                      ("My son's personal statement needs work, can you help?", "Happy to help with his statement."),
                      ("I've written a draft personal statement and I'm not happy with it.", "A draft is a good place to start.")],
             "diag": [("Which course is it for?", ["History.", "Medicine."]),
                      ("What deadline is it for?", ["The October one, for Oxford.", "January, I think."])]},
            {"service": "Master's counselling session", "notes": "Master's applications",
             "open": [("I'm applying for a master's in the UK and want some help.", "A master's in the UK, sure."),
                      ("I'd like help with master's applications, I'm applying from Nigeria.", "Applying for a master's from Nigeria."),
                      ("Can you help with a postgraduate application?", "A postgraduate application, sure.")],
             "diag": [("What subject are you looking at?", ["Data science.", "Public health."]),
                      ("How many programmes are you thinking of applying to?", ["Probably three or four.", "Maybe five."])]},
            {"service": "Interview coaching session", "urgent": True, "notes": "Interview within days",
             "open": [("It's urgent, my son has a medicine interview on Friday and needs coaching as soon as possible.",
                       "With the interview on Friday, I'll treat this as urgent."),
                      ("I need interview help as soon as possible, mine's next week.", "With the interview next week, I'll treat this as urgent.")]},
        ]
        self.questions = [
            {"q": ["What does it cost to have a first chat with you?", "Is there a fee for the first session, and how long is it?"],
             "a": "The first counselling session is free, and it's thirty minutes.", "kind": "fact_price"},
            {"q": ["And how much is the full undergraduate package?", "What's included in the undergraduate package, and what's the price?"],
             "a": "It's fourteen hundred and fifty pounds, for a shortlist of five universities, personal statement coaching, "
                  "an application review and one mock interview.",
             "kind": "fact_package"},
            {"q": ["How much is interview coaching by itself?", "If I just want interview practice, what does that cost?"],
             "a": "It's ninety-five pounds an hour, or three hundred and forty for a block of four.", "kind": "fact_interview_price"},
            {"q": ["Could I pay in instalments?", "Can the package be split up? Paying it all at once is hard."],
             "a": "Yes, packages can be split into three monthly payments, by card or bank transfer.", "kind": "fact_payment"},
            {"q": ["Do I have to come to London, or can we do it online?", "We live in Manchester, can you still help?"],
             "a": "We work online across the UK and internationally, so you don't need to come in.", "kind": "fact_online"},
            {"q": ["Could you just review my statement, without the whole package?", "Do you do a statement review on its own?"],
             "a": "Yes, a personal statement review is a hundred and eighty pounds for two rounds of written feedback.",
             "kind": "fact_statement_review"},
        ]
        self.objections = [
            {"kind": "objection_price",
             "say": ["Fourteen hundred and fifty pounds is a lot of money.", "That's more than I expected, to be honest."],
             "answer": ["I understand, it's a real amount. It can be split into three monthly payments, and the first session is free, "
                        "so you can see if it's right first. Would {a} work?",
                        "Fair enough. Nothing's charged until you choose a package, and the first thirty minutes are free. "
                        "Shall I book {a}?"]},
            {"kind": "objection_write_it",
             "say": ["Can you just write the personal statement for him?", "Could you write my statement if I send you my grades?"],
             "answer": ["We don't write statements, the student always writes their own. What we do is coach them so it's the strongest "
                        "it can be. Would you like a free first session to start?"]},
            {"kind": "objection_guarantee",
             "say": ["Can you guarantee she'll get an offer?", "Will this get me into Cambridge?"],
             "answer": ["No one can promise an offer, because the universities decide. We help students make the strongest application "
                        "they can. Would {a} work for a free first session?"]},
            {"kind": "objection_school",
             "say": ["His school already has a careers adviser.", "My sixth form helps with UCAS already."],
             "answer": ["That's great, and a lot of students use both. The free first session is a chance to see if a second pair of eyes "
                        "would help. Shall I find a time?"]},
            {"kind": "objection_delay",
             "say": ["Let me speak to my husband first.", "I'll have a think and come back to you."],
             "answer": ["Of course. Is it the cost you want to think over, or the timing?",
                        "No problem. What would you want to think through, the price or something else?"]},
        ]
        self.not_offered = [
            {"q": ["Can you help with her student visa as well?", "Do you do student visa applications?"],
             "a": "We don't do visa applications, I'm afraid. We help with the university side, from shortlists to interviews."},
            {"q": ["Do you do A-level tutoring? He's struggling with chemistry.", "Can you tutor her for her maths A-level?"],
             "a": "We don't tutor for A-levels, sorry. We help with university applications, personal statements and interviews."},
        ]
        self.out_of_depth = [
            {"q": ["With an A star, A, B prediction, will she get into Imperial for medicine?",
                   "Is it better to apply to Durham or St Andrews for history?"],
             "reason": "advice on a specific student's chances",
             "ask": "That really depends on the whole application, and it's one for a counsellor. Would you like someone to call you back about it?"},
            {"q": ["I'm already a client and wanted to move my next session.", "My counsellor was meant to email me feedback, has it gone out?"],
             "reason": "existing client query",
             "ask": "I can't see client sessions from here. Would you like someone from the team to call you back about it?"},
        ]
        self.outbound_interest = [
            {"interest": "undergrad", "service": "Undergraduate counselling session",
             "about": "We start with a free thirty-minute counselling session to understand goals and grades, then recommend a package with a written price."},
            {"interest": "personal_statement", "service": "Personal statement session",
             "about": "We coach students on their personal statement so it's the strongest it can be, and they always write it themselves."},
            {"interest": "interview", "service": "Interview coaching session",
             "about": "Interview coaching is ninety-five pounds an hour, or three hundred and forty for a block of four, and the first counselling session is free."},
        ]

    def confirm(self, caller: Caller, need: dict, rng: random.Random) -> str:
        tail = rng.choice([
            "The first session is free, and nothing's charged unless you choose a package.",
            "It's thirty minutes, and it's free.",
            "You can do it online, and it's free.",
        ])
        return rng.choice([
            f"You're booked for {{pick}}, {caller.first}. {tail}",
            f"All set, {caller.first}, that's {{pick}}. {tail}",
            f"Lovely, you're booked for {{pick}}. {tail}",
        ])


PACKS = [Northside, Maple, BrightPath]

# ─── Calls ──────────────────────────────────────────────────────────────────

ASK_TIMES = ["What times do you have?", "When could you fit me in?", "Can I book something?",
             "Okay, when's the next appointment?", "What's your availability this week?", "Can we book a time?"]
OFFER_LINES = ["I have {a} or {b}. Which works better?", "I can do {a} or {b}. Which suits you?",
               "There's {a}, or {b}. Which would you prefer?", "The next openings are {a} and {b}. Which is better for you?"]
# Each names the booking: the router keeps the caller's answer on the
# booking path only when the question did (see the render report).
ASK_NAME = ["Great. Can I get your name for the booking?", "Perfect. What name should I put the booking under?",
            "Sure. What's your name, for the booking?"]
BOOK_OFFER = ["Would you like me to book you in?", "Shall I book a time for you?", "Want me to book you in?"]
DECLINE_FINAL = ["No, I think I'll pass for the moment.", "I'm going to hold off, thanks anyway.", "Not right now, thank you."]
CLOSE_GRACEFUL = ["No problem at all. If anything changes, just give us a call.",
                  "That's fine. You're welcome to call back any time.",
                  "Of course. If you change your mind, we're here."]
DELAY_REASON = ["Mostly the cost, if I'm honest.", "Just the timing really.", "Probably the price."]


def opening(pack: Pack, need: dict, caller: Caller, rng: random.Random, name_first: bool) -> tuple[str, str]:
    temp = str(rng.choice([84, 86, 88, 90]))
    said, ack = (x.replace("{temp}", temp) for x in rng.choice(need["open"]))
    if name_first:
        said = rng.choice(["Hi, this is {first}. ", "Hi, my name's {first} {last}. ", "Hello, it's {first}. "]).format(
            first=caller.first, last=caller.last) + said
    return said, ack


def diagnose(need: dict, rng: random.Random) -> tuple[str, str]:
    """One diagnostic question and an answer that fits it."""
    question, answers = rng.choice(need["diag"])
    return question, rng.choice(answers)


def booking_tail(pack: Pack, need: dict, caller: Caller, rng: random.Random, named: bool) -> list[dict]:
    """From two times on the table to a confirmed booking, the production way."""
    pick = "a" if rng.random() < 0.6 else "b"
    pick_line = rng.choice(PICKS_A if pick == "a" else PICKS_B)
    book = call("book_after_choice", "book_appointment", service=need["service"], starts_at="{pick_iso}", notes=need["notes"])
    confirm = reply("confirm_booked", pack.confirm(caller, need, rng))
    turns: list[dict] = []
    if named:
        turns.append(turn(pick_line, book, confirm, pick=pick))
    elif rng.random() < 0.5:
        # Time and name together: the name is saved before the turn, so booking is offered on it.
        turns.append(turn(f"{pick_line} {caller.name_line()}", book, confirm, pick=pick))
    else:
        # A time with no name yet: production does not offer booking, so ask.
        turns.append(turn(pick_line, reply("ask_name", rng.choice(ASK_NAME)), pick=pick))
        turns.append(turn(caller.name_line(), book, confirm))
    if rng.random() < 0.35:
        turns.append(turn(rng.choice(THANKS_BYE), reply("goodbye", rng.choice(
            [f"You're welcome, {caller.first}. Bye now.", "Thanks for calling. Bye.", f"No problem, {caller.first}. Take care."]))))
    return turns


def offer_turn(caller_line: str, rng: random.Random, urgent: bool, prefix: str = "") -> dict:
    i, j = (0, 1) if urgent else rng.choice([(0, 1), (0, 2), (0, 3), (1, 3), (0, 4), (2, 5)])
    text = (prefix + " " if prefix else "") + rng.choice(OFFER_LINES)
    return turn(caller_line, offer("offer_two_times", text, i, j))


def inbound_booking(pack: Pack, rng: random.Random, caller: Caller) -> list[dict]:
    need = rng.choice([n for n in pack.needs if not n.get("urgent")])
    named = rng.random() < 0.25
    said, ack = opening(pack, need, caller, rng, named)
    question, answer = diagnose(need, rng)
    turns = [turn(said, reply("acknowledge", f"{rng.choice(ACKS)} {ack} {question}"))]
    if rng.random() < 0.4 and pack.questions:
        q = rng.choice(pack.questions)
        turns.append(turn(f"{answer} {rng.choice(q['q'])}", reply(q["kind"], f"{q['a']} {rng.choice(BOOK_OFFER)}")))
        turns.append(offer_turn(rng.choice(["Yes please.", "Yeah, go on.", "Okay, what times have you got?"]), rng, False))
    else:
        turns.append(offer_turn(f"{answer} {rng.choice(ASK_TIMES)}", rng, False, rng.choice(["Okay.", "Thanks.", ""])))
    return turns + booking_tail(pack, need, caller, rng, named)


def inbound_urgent(pack: Pack, rng: random.Random, caller: Caller) -> list[dict]:
    need = rng.choice([n for n in pack.needs if n.get("urgent")])
    said, ack = opening(pack, need, caller, rng, False)
    first = turn(said, offer("urgent_earliest", f"{ack} The earliest I have is {{a}}, or there's {{b}}. Which can you do?", 0, 1))
    return [first] + booking_tail(pack, need, caller, rng, False)


def inbound_objection(pack: Pack, rng: random.Random, caller: Caller) -> list[dict]:
    need = rng.choice([n for n in pack.needs if not n.get("urgent")])
    said, ack = opening(pack, need, caller, rng, False)
    question, answer = diagnose(need, rng)
    turns = [turn(said, reply("acknowledge", f"{rng.choice(ACKS)} {ack} {question}")),
             offer_turn(f"{answer} {rng.choice(ASK_TIMES)}", rng, False)]
    obj = rng.choice(pack.objections)
    answer = rng.choice(obj["answer"])
    turns.append(turn(rng.choice(obj["say"]), reply(obj["kind"], answer)))
    if obj["kind"] == "objection_delay":
        turns.append(turn(rng.choice(DELAY_REASON), reply("delay_reason", rng.choice([
            "That's fair. Holding a time costs nothing, and cancelling is free up to two hours before. Shall I keep {a} for you?",
            "Understood. You can book now and cancel later if it doesn't work out. Would {a} suit you?",
        ]) if pack.slug == "northside-hvac" else rng.choice([
            "That's fair. Booking now doesn't commit you to anything beyond the session itself. Would {a} work?",
            "Understood. Would it help to book {a} and decide after you've spoken to someone?",
        ]))))
    if rng.random() < 0.6:
        return turns + booking_tail(pack, need, caller, rng, False)
    turns.append(turn(rng.choice(DECLINE_FINAL), reply("accept_no", rng.choice(CLOSE_GRACEFUL))))
    return turns


def inbound_question(pack: Pack, rng: random.Random, caller: Caller) -> list[dict]:
    q1, q2 = rng.sample(pack.questions, 2)
    turns = [turn(f"Hi, I've got a couple of questions. {rng.choice(q1['q'])}",
                  reply(q1["kind"], f"{rng.choice(['Sure.', 'Of course.', 'Happy to help.'])} {q1['a']}")),
             turn(rng.choice(q2["q"]), reply(q2["kind"], f"{q2['a']} Would you like me to book you in?"))]
    if rng.random() < 0.5:
        need = rng.choice([n for n in pack.needs if not n.get("urgent")])
        turns.append(offer_turn(rng.choice(["Yes, let's book something.", "Okay, what times do you have?"]), rng, False))
        return turns + booking_tail(pack, need, caller, rng, False)
    turns.append(turn(rng.choice(["Not yet, I'm just looking into it.", "No, that's all for now, thanks."]),
                      reply("accept_no", rng.choice(CLOSE_GRACEFUL))))
    return turns


def inbound_not_offered(pack: Pack, rng: random.Random, caller: Caller) -> list[dict]:
    item = rng.choice(pack.not_offered)
    turns = [turn(rng.choice(item["q"]), reply("not_offered", item["a"]))]
    if rng.random() < 0.5:
        turns.append(turn(rng.choice(["No, that was it, thanks.", "Okay, never mind then. Thanks."]),
                          reply("goodbye", rng.choice(["No problem. Thanks for calling.", "Okay, thanks for calling. Bye."]))))
    return turns


def inbound_callback(pack: Pack, rng: random.Random, caller: Caller) -> list[dict]:
    item = rng.choice(pack.out_of_depth)
    gens = [call("offer_callback", "offer_callback", reason=item["reason"]), reply("ask_callback", item["ask"])]
    turns = [turn(rng.choice(item["q"]), *gens)]
    if rng.random() < 0.5:
        # Accepting is handled by rule: no model call, no row.
        turns.append(turn(rng.choice(["Yes please.", "Yeah, that'd be great."]), expect_rule=True))
    else:
        turns.append(turn(rng.choice(["No, it's fine, I'll call back later.", "No thanks, I'll sort it out."]),
                          reply("callback_declined", rng.choice(CLOSE_GRACEFUL))))
    return turns


def outbound(pack: Pack, rng: random.Random, caller: Caller) -> tuple[dict, list[dict]]:
    item = rng.choice(pack.outbound_interest)
    need = {"service": item["service"], "notes": "Website enquiry, outbound follow-up"}
    meta = {"name": caller.first, "interest": item["interest"]}
    r = rng.random()
    if r < 0.15:
        busy = rng.choice(["I'm driving right now, can you call me later?", "Sorry, I'm at work, it's not a good time."])
        return meta, [turn(busy, call("offer_callback", "offer_callback", reason="call back at a better time"),
                           reply("ask_callback", "No problem. Would you like someone to call you back at a better time?")),
                      turn("Yes please.", expect_rule=True)]
    if r < 0.25:
        return meta, [turn(rng.choice(["Not really interested anymore, sorry.", "I've already sorted it, thanks."]),
                           reply("accept_no", rng.choice(["No problem at all. Thanks for your time, and take care.",
                                                          "That's fine, thanks for letting me know. Have a good day."])))]
    turns = [turn(rng.choice(["Yeah, sure, I've got a few minutes.", "Oh, hi. Yes, go ahead.", "Yes, that's fine."]),
                  reply("outbound_pitch", f"Great. {item['about']} What made you start looking into it?"))]
    turns.append(offer_turn(rng.choice(need_answers(pack)), rng, False, rng.choice(["That makes sense.", "Okay, thanks.", "Got it."])))
    if rng.random() < 0.3:
        obj = rng.choice([o for o in pack.objections if "{a}" in " ".join(o["answer"])])
        turns.append(turn(rng.choice(obj["say"]), reply(obj["kind"], rng.choice([a for a in obj["answer"] if "{a}" in a]))))
    return meta, turns + booking_tail(pack, need, caller, rng, True)


def need_answers(pack: Pack) -> list[str]:
    return {
        "northside-hvac": ["The old one's getting expensive to run.", "Our system's about eighteen years old.",
                           "We just want to be ready before it gets cold."],
        "maple-immigration": ["I finish my program next spring and want to stay.", "My wife and I want to settle here long term.",
                              "I want to know what my options are."],
        "brightpath-admissions": ["We just want to make sure she applies to the right places.", "He's not sure where to start.",
                                  "I want a stronger application this time."],
    }[pack.slug]


FLOWS = [(inbound_booking, 0.36), (inbound_urgent, 0.10), (inbound_objection, 0.22), (inbound_question, 0.12),
         (inbound_not_offered, 0.06), (inbound_callback, 0.06)]
OUTBOUND_SHARE = 0.08


def dialogue(pack: Pack, rng: random.Random, n: int, bank: list[dict] | None, tz_hours: tuple[int, int]) -> dict:
    caller = Caller(pack.country, rng, bank)
    d: dict = {"id": f"{pack.source}-{n:05d}", "tenant": pack.slug, "source": pack.source, "group": f"{pack.source}-{n:05d}",
               "clock": {"days": rng.randint(1, 40), "hour": rng.randint(*tz_hours), "minute": rng.choice([0, 5, 12, 20, 33, 41, 50])},
               "busy": round(rng.choice([0, 0.15, 0.3, 0.45]), 2)}
    if rng.random() < OUTBOUND_SHARE:
        d["outbound"], d["turns"] = outbound(pack, rng, caller)
        d["kind"] = "outbound"
        return d
    flow = rng.choices([f for f, _ in FLOWS], weights=[w for _, w in FLOWS])[0]
    d["turns"], d["kind"] = flow(pack, rng, caller), flow.__name__
    return d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-tenant", type=int, default=700)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=ROOT / "data/finetune/dialogues.jsonl")
    ap.add_argument("--real-callers", action="store_true", help="draw some name turns from data/finetune/real_callers.json")
    args = ap.parse_args()

    kit = json.loads(KIT_PATH.read_text())
    bank = json.loads(REAL_CALLERS.read_text()) if args.real_callers and REAL_CALLERS.exists() else None
    out = []
    for cls in PACKS:
        pack = cls(kit)
        # Its own stream per tenant: adding a flow to one leaves the others as they were.
        rng = random.Random(f"{args.seed}:{pack.slug}")
        for n in range(args.per_tenant):
            out.append(dialogue(pack, rng, n, bank, (8, 19)))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in out))
    kinds: dict[str, int] = {}
    for d in out:
        kinds[d["kind"]] = kinds.get(d["kind"], 0) + 1
    print(f"✓ {len(out)} dialogues → {args.out}  {kinds}")


if __name__ == "__main__":
    main()
