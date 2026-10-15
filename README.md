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

## Switching to production quality

The local 8B model proves the plumbing but is not representative of reply
quality. Set a key and it switches:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # or: LLM_PROVIDER=anthropic
```

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

**Not built:** human takeover/reply from the inbox, real telephony media
pipeline, federated training with differential privacy.

## Things deliberately NOT built

- **Cross-tenant lead sharing.** Unlawful under TCPA, CASL, PECR and GDPR —
  consent is sender-specific. `features/referrals.ts` implements the lawful
  routes: same-tenant cross-sell, franchise groups, and consented referrals.
- **Automated Instagram accounts / auto-liking.** Breaches Meta Platform Terms
  and risks the app that the DM integration depends on.
- **Review gating** (only asking happy customers). Violates Google policy and
  the FTC rule on review suppression.
