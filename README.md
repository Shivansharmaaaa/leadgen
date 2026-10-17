# Leadgen

AI lead generation and customer care for local service businesses.
One agent answers across phone, social DMs, email, SMS and web chat, qualifies
the lead, books the job, and hands off to a human when it should.

## Architecture

    IG / FB / WA ─┐
    Email ────────┤                                   ┌─→ CRM sync
    Voice ────────┼─→ INGRESS ──→ canonical Message ──┤
    SMS ──────────┤   adapters         │              ├─→ Agent runtime ─→ EGRESS
    Webchat ──────┘                    ▼              └─→ Analytics        adapters
                              Identity resolution
                          (one contact across channels)

Nothing downstream of ingest knows which platform a message came from. Adding a
channel means writing one adapter; the agent, guardrails, inbox and reporting
are untouched.

| Path | What lives there |
|---|---|
| `src/server/db/schema.ts` | Multi-tenant schema: contacts, identities, conversations, leads, appointments, consent, audit |
| `src/server/core/identity.ts` | The contact graph — collapses an IG handle and a phone number into one person |
| `src/server/core/extract.ts` | Deterministic phone/email harvesting (never trust the model with identity) |
| `src/server/core/ingest.ts` | The one pipeline every inbound message flows through |
| `src/server/core/guardrails.ts` | Gate 1 (should the AI answer?) and Gate 2 (is this safe to send?) |
| `src/server/core/knowledge.ts` | Verified facts vs. prose — the anti-hallucination split |
| `src/server/agent/runtime.ts` | Manual agentic loop with per-tool audit rows |
| `src/server/agent/tools.ts` | Availability, booking, qualification, consent, escalation |
| `src/server/agent/providers/` | Ollama (free, local) and Claude (production) behind one interface |

## Running locally, free

Requires Colima (or Docker) and Ollama.

```bash
colima start
docker run -d --name leadgen-pg -e POSTGRES_PASSWORD=leadgen \
  -e POSTGRES_USER=leadgen -e POSTGRES_DB=leadgen \
  -p 5433:5432 pgvector/pgvector:pg17
ollama serve &
ollama pull llama3.1

npm install
cp .env.example .env
npm run db:push
npm run seed
npm run smoke
```

`npm run smoke` drives a full conversation: a cold Instagram DM, a phone number
handed over mid-thread, a redelivered webhook, the same person phoning in, a
price question, and a legal escalation.

### Talking to it

```bash
npm run voice
```

Checks Ollama, pulls `llama3.2:3b` if it is missing (the voice model), also
builds the faster cache-friendly variant from `models/leadgen-llama3.2.Modelfile`,
confirms the model makes real tool calls and runs on the GPU, brings up
Postgres, seeds the demo tenant only if it is not there, and opens `/voice`.
`finetune/README.md` has the measured trade-off between the two and how a
LoRA fine-tune gets the speed without losing tool use. Use Chrome: the page uses its speech recognition.
On Apple Silicon Ollama runs on the GPU (Metal) by itself.
`npm run voice:check` re-runs just the model and database checks.

What changed in the voice agent and the local model, with every measurement:
[`CHANGES_REPORT.md`](CHANGES_REPORT.md). A fine-tuned voice adapter (built
with Llama) is in [`models/Llama-3.2-3B-Leadgen-Voice-LoRA`](models/Llama-3.2-3B-Leadgen-Voice-LoRA/).

## Switching to production quality

The local 8B model proves the plumbing but is not representative of reply
quality. Set a key and it switches:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # or: LLM_PROVIDER=anthropic
```

## Getting leads in, answering them, and handing them on

Everything below is configured per business at **`/settings`** (behind
sign-in), and each piece has its own test suite that runs without a model
(`LLM_PROVIDER=scripted`) and without sending anything real.

| Feature | Where | What it does |
|---|---|---|
| **Lead intake** | `POST /api/leads?tenant=<slug>`, header `x-intake-key` | Web forms, Zapier, Google LSA, Angi, Thumbtack, Facebook lead ads. Every lead gets the agent's reply in seconds: by text if the form's consent wording names the business, covers texts and says consent isn't a condition of purchase; otherwise by email, or held for a person. The dashboard says exactly what the form's wording is missing. |
| **Website chat** | `<script src="…/widget.js" data-tenant="…">` | A chat bubble on the client's own site, answered by the same agent. Says it is an AI; a reply a person sends from the inbox reaches the visitor. Rate-limited per session and per IP; only the client's own sites may embed it. Demo: `/widget-demo.html`. |
| **Email** | SMTP out; inbound parse → `/api/webhooks/email?token=…` | Threaded replies, quoted text stripped, never answers an auto-reply (no AI ↔ out-of-office loops). |
| **STOP / opt-out** | every channel | STOP, UNSUBSCRIBE or "please stop texting me" is honoured by rule, before the agent sees it; on a call only an explicit "don't call me again" counts. |
| **Reminders** | automatic on every booking | Day before and same day (never outside 8am–8pm local), plus a written confirmation for bookings made on a call. Reply C to confirm, R to reschedule (a person finds the new time). |
| **Team alerts** | automatic on every handover | Texts staff: emergencies (gas smell, CO alarm) to whoever is on call at any hour; other handovers during opening hours; after-hours non-urgent ones wait for opening. Someone who smells gas is first told to leave and call 911. |
| **Conversation scoring** | `/dashboard`, `/inbox?view=attention` | Every conversation's outcome and what was missed: asked for a time and never offered one, price question dodged, reply stuck in review, handover nobody answered, and more, each with the line that raised it. |
| **CRM webhooks** | `/settings` → Send to your CRM | New leads, bookings, confirmations, reschedules, handovers and opt-outs POSTed as signed JSON (`x-leadgen-signature`, HMAC-SHA256, replay-proof) to a CRM, Zapier or Make. Retries with backoff. |
| **Lead sources and cost per job** | `/dashboard`, spend in `/settings` | Booked rate, cost per lead and cost per booked job for each source; missed calls count as leads; paid sources with no bookings are flagged. |
| **Reactivation campaigns** | `/dashboard` → Start campaign | Messages the top dormant leads who agreed to hear from you, ranked by expected *incremental* value. Every campaign holds a random ~15% back first, so "Did it actually work?" can answer honestly. 10am–7pm only; a STOP after launch wins. |
| **Closing jobs** | `/dashboard` → How did these jobs go? | Done / No-show / Cancelled on past jobs. Done wins the lead and asks for a review three hours later. |
| **Morning summary** | email, 8am local | What happened in the last day and what needs the owner, with links. |
| **Calendar feed** | `/settings` → Jobs in your calendar | A private iCalendar link: every booking, with the customer's name and number, in Google, Apple or Outlook calendar. |
| **Erasure** | `/inbox` → erase | Deletes everything about a person on request (UK GDPR Art. 17, CCPA, PIPEDA), and keeps a hashed do-not-contact entry so they're never contacted again. |
| **Owner sign-in** | `/login` | `/dashboard`, `/inbox`, `/settings`, the `/voice` demo and their APIs need `ADMIN_PASSWORD`. Open in development; refused in production until it is set. |

### Setting them up

```bash
# .env
ADMIN_PASSWORD=...          # required in production
SUPPRESSION_SECRET=...      # set once, never change (keys the erasure do-not-contact list)
SMTP_HOST=... EMAIL_FROM=... # email out; EMAIL_INBOUND_TOKEN=... for email in
TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=...   # texts, alerts, calls
```

`npm run doctor` lists what is set up, what isn't, and how to fix each.
`npm run demo:seed` builds a demo business ("Harbor Heating & Cooling") with a
day of activity through the real pipelines and sends nothing; view it with
`TENANT_SLUG=demo-hvac npm run dev`.

Then at `/settings`: add the team's mobiles (and who is on call), create an
intake key, paste the chat snippet on the website and list the site, and add
a CRM endpoint. Run `npm run worker` so reminders, alerts, webhooks, campaigns,
the morning summary and the nightly retrain go out.

## Commands

| Command | What it does |
|---|---|
| `npm run seed` | Create the demo HVAC tenant |
| `npm run smoke` | Drive a full cross-channel conversation end to end |
| `npm run eval` | Score the agent against the graded scenario set |
| `npm run learn:test` | Train on synthetic data and verify the model recovers a known rule |
| `bash scripts/fetch-data.sh` | Download the UCI dataset used by `train:real` |
| `npm run index` | Chunk + embed the knowledge base, test hybrid retrieval |
| `npm run memory:test` | Extract durable facts from messages, verify supersession |
| `npm run uplift:test` | Prove uplift ranking beats conversion ranking |
| `npm run worker` | Drain the job queue (follow-ups, reviews, training) |
| `npm run dev` | App on :3100 — `/voice` to talk to the agent |
| `npm run voice` | Check the local model + database, start the app, open `/voice` |
| `npm run eval -- --voice` | Every scenario as a phone call, through the streaming voice path |
| `npm run finetune:data` | Build the LoRA set (SGD + in-domain); see `finetune/README.md` |
| `npm run intake:test` | Lead intake, consent wording, STOP handling, SLA (no model, no sends) |
| `npm run reminders:test` | Reminder scheduling, sending hours, C/R replies, double-booking guard |
| `npm run alerts:test` | Gate 1 matching, safety replies, who gets alerted when |
| `npm run scoring:test` | Every missed-opportunity flag on its case and its look-alike |
| `npm run webchat:test` | Chat API, polling, rate limits, CORS |
| `npm run webhooks:test` | Signing, the private-network guard, delivery to a real receiver |
| `npm run email:test` | Email in and out through a real SMTP conversation |
| `npm run auth:test` / `settings:test` | Sign-in, middleware, and every settings rule |
| `npm run erasure:test` / `campaigns:test` / `outcomes:test` / `digest:test` | Erasure, campaigns with holdouts, closing jobs, the morning summary |
| `npm test` | Typecheck plus every suite below; non-zero exit on any failure |
| `npm run imports:test` | Loads every entry point first, each in a fresh process (catches import cycles) |

## Status

**Proven end to end:** ingest, cross-channel identity resolution, threading,
webhook idempotency, the agent loop with 8 tools, both guardrail gates, lead
capture, booking, consent capture, escalation, the audit trail, hierarchical
cross-tenant lead scoring (AUC 0.835 on synthetic), hybrid RAG (9-11ms), the
eval harness, and browser voice.

**Coded, needs credentials:** Twilio voice/SMS, Meta IG/Messenger/WhatsApp,
comment-to-DM, Meta Conversions API.

**Also proven:** per-contact memory with supersession and provenance; a
Postgres-backed job worker (`FOR UPDATE SKIP LOCKED`, exponential backoff,
keyed dedupe, dead-lettering); and uplift-based outreach ranking, which beat
conversion ranking by **+517% incremental bookings** for the same call budget.

## Incrementality

Borrowed from how ad platforms measure themselves rather than how they rank.
Ranking a call-back list by P(convert) spends the budget on people who would
book anyway. The return is in the *persuadables*, so outreach ranks by
`uplift x job value` and every campaign withholds ~15% as a holdout. That
holdout is also the client's ROI proof, reported with a 95% confidence
interval that says "not yet proven" when it crosses zero.

**Not built yet:** per-user accounts across several businesses (one owner
password per deployment for now), calendar sync with ServiceTitan / Jobber /
Google Calendar (the webhooks and the read-only calendar feed bridge it until then), and billing.

## Things deliberately NOT built

- **Cross-tenant lead sharing.** Unlawful under TCPA, CASL, PECR and GDPR —
  consent is sender-specific. `features/referrals.ts` implements the lawful
  routes: same-tenant cross-sell, franchise groups, and consented referrals.
- **Automated Instagram accounts / auto-liking.** Breaches Meta Platform Terms
  and risks the app that the DM integration depends on.
- **Review gating** (only asking happy customers). Violates Google policy and
  the FTC rule on review suppression.
