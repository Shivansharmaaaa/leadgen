# Overnight work list

Started Sat 17 Oct 2026, 00:50 IST. Updated as work happens: every task is
marked with what actually happened, not what was intended.

`[x]` done and verified · `[~]` in progress · `[!]` interrupted or blocked (reason given) · `[ ]` not started

## 1. Conversion training + LoRA fine-tune

- [x] Finish the SGD download (train 551 / dev 44 / test 167 appointment dialogues; the earlier fetch had stopped at 70/127 train files, no dev or test)
- [x] Fetch llama.cpp's GGUF converter (`~/src/llama.cpp`, sparse clone)
- [!] `llama-quantize` via `brew install llama.cpp` — **blocked**: Homebrew refuses to run while untrusted third-party taps are installed (mongodb/brew, dart-lang/dart, steipete/tap). Trusting them is your call. Not needed any more: export falls back to Ollama 0.5.4's own quantiser, verified to produce Q4_K_M like stock (`e675760`).
- [x] Fix: the voice prompt told *every* tenant "this is a heating and cooling business". Now per-tenant (`settings.asrContext`); HVAC prompt verified byte-identical, generic template no longer HVAC-specific
- [x] Re-export the production prompt (3 commits had changed it since the last export)
- [x] Fix: eval lines had leaked into training — one verbatim ("Let me think about it and get back to you.") and three paraphrased (0.84–0.92 similar). Leak guard now catches paraphrases; lines reworded
- [x] Build the set: 1,205 packed sequences, 5,466 targets (553 from conversion dialogues)
- [x] Trainer: checkpoint + `--resume`, SIGINT/SIGTERM save-and-exit, vocabulary projection only on loss positions, weights loaded straight onto the GPU (the old load held two copies and got killed for memory) — `a3cf761`
- [x] Verified: new loss matches HF's to 6e-8; a resumed run reproduces the uninterrupted run's per-step losses exactly; `kill` mid-run saves and resumes
- [x] Throughput on the M3 Pro: ~110 tok/s. Set is 3.33M tokens, so one epoch would take ~8.4 h. Run sized to 0.65 epoch (~99 steps of 8 dialogues, ~5.5 h) so the cosine schedule completes before morning
- [x] Fix: the first launch ran at 57 tok/s — the trainer's footprint was **17 GB on an 18 GB Mac** (PyTorch's GPU cache never handed memory back), so it swapped. Stopped with Ctrl-C (checkpointed at step 1), patched to release the cache after every backward, resumed: **11 GB, 128 tok/s** — `ff0bdcc`
- [x] Overnight LoRA+ run on the 3B: `3b-conv-lp16` — 97 steps, LoRA+ 16, lr 2e-4, rank 16, all projections, checkpoint every 5 steps. Terminal tab **LoRA training (3B)**; log `data/finetune/runs/3b-conv-lp16/train.log`. Held-out loss **1.685 → 0.627 (step 25) → 0.588 (step 50) → 0.619 (step 75) → 0.599 (step 97, final)**; train loss ~0.1–0.3. Ran uninterrupted through the night at 128 tok/s; **finished 06:09 IST** (286 min). Metrics in `reports/results/train_3b-conv-lp16.json`. To continue after any stop: rerun the same command, it has `--resume`
- [x] Exported as `leadgen-llama3.2-ft:3b-conv-lp16` (Q4_K_M, via Ollama's quantiser). Step 75 not exported: the final (0.599) beat it (0.619)
- [x] Held-out next action, 74 decisions: **stock 49% / untuned layout 65% / LoRA 97%**; with arguments 35% / 65% / 96%; premature bookings **9 / 3 / 0** (but these rows come from the training generators — see below)
- [x] Live-call eval, 27 scenarios: **stock 55/60, LoRA 55/60 — a tie**, LoRA turns slower (p50 4.5 s vs 2.7 s). Two shared failures are the voice router's, not the weights'. **Found: the LoRA said "definitely" (held by Gate 2) because 44 of my training targets did** — the build now refuses any target Gate 2 would hold — `b656fd5`. Verdict: don't switch the voice model yet. Full write-up: `CHANGES_REPORT.md`, `finetune/README.md`
- [x] GPU handed back to the voice session at 06:24 (it can restart Kokoro/Parakeet and run its evals)

## 2. Test every existing feature, fix what breaks

- [x] typecheck — clean
- [x] `learn:test` (hot 95 vs cold 18), `uplift:test` (+499% bookings vs conversion ranking), `feature:test`, `fed:test` (AUC 0.803 at ε≈8) — all pass
- [~] `npm run smoke` — **fixed first**: it began by deleting every contact of the demo tenant (and could text via live Twilio). Now runs on its own copy (`northside-hvac-smoke`) with sending off — `74c38b7`; verified with the scripted provider (northside kept all 93 contacts). Real-model run after training
- [x] `memory:test` — needs no model after all: facts extracted, a corrected gate code supersedes the old one (old row kept for audit)
- [ ] `npm run eval` (text channels) — needs Ollama, after training
- [ ] voice preflight — needs Ollama, after training

## 3. Research: what a complete lead-gen product needs

- [x] Survey of shipping products (Avoca, Sameday, Jobber AI Receptionist, Frontdesk, Nextiva). Common core: answer every call, missed-call text-back, book into the calendar, **confirmation + reminder texts**, emergency routing to the on-call tech with address and transcript, nurture/reactivation campaigns, **call scoring ("Coach")**, CRM/lead-source integrations (Google LSA, ServiceTitan). Speed matters most: 5-minute responders are 21x likelier to qualify; 78% of customers buy from the first company to respond
- [x] Gap list. Already built: voice, SMS, webchat, Meta egress, missed-call text-back, speed-to-lead SLA, reactivation (uplift-ranked), reviews, ad-conversion feedback, referrals, follow-up, dashboard. **Missing:**
  1. Lead intake API for web forms / LSA / Angi / Thumbtack / Zapier, with instant first response and TCPA-grade consent capture — the "lead gen" in lead gen
  2. Appointment confirmations and reminders (24 h, 2 h), with C/R replies handled — no-shows are lost revenue
  3. Conversation scoring: outcome + missed-opportunity flags on every call and chat, on the dashboard
  4. On-call dispatch: emergencies text the on-call tech with address, problem and a summary

## 4. New features (from the gap list), each built, tested, measured

- [x] **Lead intake** `POST /api/leads?tenant=<slug>` (web forms, Zapier, LSA, Angi, Thumbtack, FB lead ads). Instant agent reply; consent *wording* checked (names the seller, covers texts, "not a condition of purchase"), stored with evidence, never downgraded; dedupe on source + id; SLA clock from submission — `990858b`. `npm run intake:test` ✓
- [x] **Found while building it — STOP was not handled at all**: "STOP"/"unsubscribe"/"please stop texting me" got an AI reply and no do-not-contact. Now decided by rule before the agent, one confirmation, START lifts it; on calls only an explicit "don't call me again" counts (a bare "stop" means stop talking) — `63d36f3`, `b57bace`
- [x] **Found: the SMS consent gate never ran** — it only checks business-initiated sends and nothing ever flagged one. Fixed; an initiated send to an unknown number is refused — `63d36f3`
- [x] **Found: SLA bugs** — a draft held for review counted as a first response; after-hours was judged in UTC (4am–2pm for Boston) — `990858b`
- [x] `LLM_PROVIDER=scripted` — run any pipeline with no model, so features are testable while the GPU trains
- [x] **Appointment reminders**: day before + same day (+ written confirmation for bookings made on a call), never outside 8am–8pm local, C confirms / R holds the slot and hands to a person, moved/cancelled jobs stand down, STOP wins — `1cf3078`. `npm run reminders:test` ✓ (24 checks)
- [x] **Found: double-booking** — a cancelled appointment could hide a confirmed one in the same slot, and back-to-back slots counted as clashes — `1cf3078`
- [x] **Found: Gate 1 matched substrings** — "sue" fired on every "issue" (so "I have an issue with my AC" was handed off), "manager" on "property manager", "hurt" on "it hurts my ears"; and bare "emergency" handed off "do you do emergency repairs?". Whole-word matching now; 0 of 35 eval verdicts change — `42727e1`
- [x] **Found: a Gate 1 handover sent nothing** — the texter got silence while the AI paused. Now a fixed handover line; for a gas smell / CO alarm, the standard "leave the house, call 911 or the gas company from outside" first. Twilio voice speaks it — `42727e1`
- [x] **On-call dispatch / team alerts**: every handover texts staff — emergencies to on-call at any hour, others during opening hours, after-hours non-urgent held until opening; one per thread per 30 min — `f7e472d`. `npm run alerts:test` ✓ (29 checks)
- [!] **My bug, fixed**: `1cf3078` added an import cycle (tools → reminders → ingest → runtime → tools) that crashed `/api/voice/stream` on every request; the voice session caught it. `deliver()` moved to `core/deliver.ts` — `1643d02`. Added `npm run imports:test` (loads all 24 entry points first, each in a fresh process) so it can't recur — `952cb6b`
- [x] **Conversation scoring ("coach")**: outcome + missed-opportunity flags per conversation (time asked/never offered, no contact details, stuck in review, handover unanswered, emergency unbooked, price dodged, slow reply, no follow-up, repetition) — `f508c37`. `npm run scoring:test` ✓ (31 checks)
- [x] **Found: follow-up "only once" guard could never fire** (nothing set the flag it checks) — `f508c37`
- [x] **Dashboard**: needs-your-attention list, outcomes + flags, lead sources by booked rate, consent problems on the client's forms, appointment confirmations/reschedules, team alerts and why they fail, opt-outs; after-hours by the business's own hours. Inbox opens `?c=<thread>` from alerts — `8543948`. Rendered on :3100 against 109 real conversations
- [x] **Website chat**: one `<script>` tag on the client's site (`public/widget.js`), `POST/GET /api/chat`. AI disclosure in the header, a person's inbox reply reaches the visitor by poll, rate-limited per session and per IP, CORS only for the tenant's sites, idempotent double-submits — `b45446c`. `npm run webchat:test` ✓ (20); tested in the browser: send, staff reply by poll, reload without duplicates, phone width
- [x] **Found in browser testing**: on a phone, a host page that overflows sideways pushed the bubble off-screen; now pinned to the visual viewport — `b45446c`
- [x] **Found: clock skew** — Postgres (in the Colima VM) runs 63 ms ahead of the app; inbound messages were stamped by the app and replies by Postgres, and the SLA subtracts them. Replies are now app-stamped — `b45446c`
- [x] **Outbound webhooks** (CRM / Zapier / Make): lead created/qualified, booked, confirmed, reschedule requested, escalated, opted out — signed (Stripe-style HMAC, replay-proof), queued as jobs with backoff, https-to-public-addresses only (SSRF guard on resolved IPs, no redirects) — `e6ae1e0`. `npm run webhooks:test` ✓ (29, against a real local receiver)
- [x] **Found: no authentication anywhere** — `/dashboard`, `/inbox` (every customer's details) and `/api/inbox` (send texts as the business, release held drafts) were open to anyone with the URL. Owner sign-in with `ADMIN_PASSWORD`, signed httpOnly cookie, middleware; open in dev, fails closed in production — `6d2579a`. `npm run auth:test` ✓ (27). `/voice` + `/api/voice/*` are still open (local demo) and need the same before going public
- [x] **Settings page** `/settings` (behind sign-in): business + speech hints, team phones / alerts / on-call (warns when nobody can be alerted), intake key create/replace/off, website-chat snippet + allowed sites, CRM endpoints (secret shown once, SSRF-checked at save) — `87fc3a3`. `npm run settings:test` ✓ (24); rendered and round-tripped on :3100. Inbox API re-checks the owner itself — `4af74ae`
- [x] **Email channel**: SMTP out (threaded "Re:", In-Reply-To), inbound-parse webhook in (quoted text and signatures stripped, deduped on Message-ID), never answers auto-replies/bounces/lists (no AI ↔ out-of-office loops), email-only form leads get an instant email reply, reminders by email when there's no mobile, "unsubscribe" opts out — `daa0ae5`. `npm run email:test` ✓ (34, real SMTP conversation)
- [x] **Emergency jobs reach the on-call tech** without a handover (the AI keeps the call) — `c321c36`
- [x] **Erasure on request** (UK GDPR Art. 17 / CCPA / PIPEDA): deletes everything incl. call records and raw webhook payloads a plain contact delete left behind; keyed-hash suppression list so they're never contacted again; CRM told via `contact.erased`; erase button in the inbox — `40b3cc5`. `npm run erasure:test` ✓ (17)
- [x] README: every new feature, its setup, and its test suite — `dcb5cb3`
- [x] **Reactivation campaigns that send**: "Start campaign" on the dashboard; each one an experiment with a ~15% random holdout before anything is sent; marketing consent re-checked at send time (a STOP after launch wins); 10am–7pm only, staggered — `fac8a16`. `npm run campaigns:test` ✓ (19, injected clock)
- [x] **Found: nothing ever marked a job done or a no-show**, so review requests never went out and no-shows were always 0. Dashboard now lists past jobs with Done / No-show / Cancelled; Done wins the lead and queues the review request — `cb6489c`. `npm run outcomes:test` ✓ (12)
- [x] **Found: recurring jobs never recurred** — the nightly retrain and reactivation digest had handlers but nothing scheduled them. The worker now ensures each day's jobs (date-keyed, safe across workers). First use: an **8am morning summary** emailed to the team — what happened, who needs them and why, jobs to close — `ba89055`. `npm run digest:test` ✓ (13)
- [x] First texts to form leads no longer double-greet (model told the intro is done) — `7129992`; intake reports this lead's reply, not an older one in the thread, and clamps future timestamps — `fdf34e3`; inbox one-tap call link — `8139d84`
- [x] **Cost per booked job by lead source**: monthly spend per source in Settings → spend, cost per lead, cost per booked job on the dashboard; paid sources with no bookings flagged — `e029cbe`
- [x] Dashboard load with 111 conversations scored: 0.25–0.7 s (scoring capped at 200)
- [x] Worker health: dashboard banner + `GET /api/health` (503) when jobs are overdue — `ef38fa1`; `npm run doctor` setup checklist — `a8bb76b`; webhooks SSRF-checked at connect time (DNS rebinding) — `2fb7e94`; recent leads show their source — `c6a742e`
- [x] Browser voice demo guarded like the dashboard once `ADMIN_PASSWORD` is set (closes the voice session's deploy item; dev unchanged) — `484a14e`
- [x] Settings shows consent wording that passes the check + an example request — `5848908`; inbox **Needs attention** view with what was missed per thread — `21f5a79`; **a missed call is now a lead** (was invisible to sources, CRM, reactivation) — `9c6c4cd`; redelivered staff texts handled once — `1e26131`
- [x] `npm run demo:seed`: a demo business with a day of activity through the real pipelines, sends nothing (`TENANT_SLUG=demo-hvac`) — found the form-fix panel miscounting email-only leads — `94c1c30`; **calendar feed**: private iCalendar link of every booking for Google/Apple/Outlook — `a3200e9` (`calendar:test` ✓ 11); dashboard/inbox follow `TENANT_SLUG` — `c3a7071`; `finetune/after_training.sh` — `e6e53f4`
- [x] **`npm test`**: typecheck + 14 feature suites + import-order test in one command — **437 checks, all passing**; its first run caught a flaky holdout check (now seeded) — `9b442fc`
- [x] A paid lead the AI couldn't text (incomplete consent wording) now alerts the team instead of sitting in the inbox — `ed74842`
- [x] Viewed the demo tenant on an isolated dev server (:3200, no Twilio, scripted model): every dashboard section renders with data. **Found: times showed in the server's zone** (a Boston job at 12:07 AM read "9:37 AM") — fixed for jobs, inbox and campaigns — `f54bf70`
- [x] Won / Lost on open leads (labels the models learn from; CRM told); a finished job labels its lead converted — `88f7e62`
- [x] **`next build` passes** (run in an isolated copy so the voice session's dev server, which shares `.next`, was untouched): all routes, server actions and the Edge middleware compile, no warnings
- [x] **Found in my own alerts feature**: a tech replying "on it" to an alert became a "customer" and the AI chatted to them. Staff texts now never reach the agent; "1" / "on it" claims the alerted conversation (takes it off the AI) — `d5b3102`
- [~] **Training finding**: held-out loss bottomed at step 50 (0.588) and rose to 0.619 by step 75 (train ~0.2) — early overfitting. The step-50 weights had been overwritten (trainer kept only the latest). Saved step 75 as `ckpt-75/` to compare with the final; trainer now keeps `best/` by held-out loss for future runs — tested on a tiny CPU Llama — `76cc4b2`
- [x] Export: falls back to Ollama's own quantiser when `llama-quantize` is missing — verified end to end on a tiny Llama, served model reports **Q4_K_M** like stock — `e675760`

## Needs you

- ~~Plug in the charger~~ — done, it's charging. Keep the lid open: a closed lid sleeps the Mac whatever else is running.
- Homebrew taps: `brew trust` decision (see above), only if you want `llama-quantize`.
- **Staff phone numbers**: team alerts need `staff.phone` (and `on_call = true` for whoever takes emergencies). None are set, so the dashboard says alerts are not reaching anyone.
- **Intake key**: set `settings.intakeKey` on the tenant to turn on `POST /api/leads` (off until then).
- The voice session pushed `main` (including my commits) to origin.

## 5. Voice agent: unfinished (added by the voice session, 17 Oct 2026)

Voice commits tonight: `8ff9a87` (hear in context, echo, products), `955ba52` (fault opens scheduling), `b9341e9` (opt-out), `52659ec` (gas/handoff replies), `3222aec` + `d913e00` (booking actually books, at a real time).

**Still HVAC-only, so these break for other trades** (the same kind of bug section 1 fixed in the prompt):
- [x] Chat tier, `voice-turn.ts`: hardcoded "heating and cooling line" replaced with `settings.asrContext` (`03caae8`)
- [ ] `router.ts` `DOMAIN` regex lists HVAC words only, so a dentist's "do you do crowns?" goes to the chat tier, which has no facts. Build the list per tenant from its knowledge facts, or add a `settings.domainTerms`
- [ ] `fast-path.ts` product FAQ looks up facts under HVAC key names (`products/AC system types` …). Another trade gets no fast answer and falls back to the model, which is safe but slower. Make it read the tenant's whole `products` category

**Correctness**
- [x] Booking on a call actually books (`3222aec`, `d913e00`). Before, a replayed call said "I've got you booked" with nothing booked, and the next one booked 5 AM. Fixed: answers to a booking question get the booking tools, a stated name is saved before the turn, and `book_appointment` only takes offered times. Verified end to end: Sat 9:00 AM and 10:00 AM booked exactly as said
- [ ] 3B model quirks still heard on replays: "My name is Alex, and I'll be the one servicing your heat pump", "Saturday of next week" for tomorrow. These are wording problems, not wrong bookings, and need a stronger model or the LoRA
- [x] `/voice` and `/api/voice/*` now require sign-in once `ADMIN_PASSWORD` is set (`484a14e`, training session). APIs get a JSON 401 and pages redirect to `/login`; production with no password fails closed; the Twilio voice webhook stays public, protected by its signature check. Dev without a password is unchanged (checked on :3100)
- [x] Voice route crash (import cycle from `1cf3078`) fixed in `1643d02` by the training session. Gas, handoff and opt-out replies verified through the HTTP route, and everything is pushed (`1643d02`)
- [x] Each sentence is screened before it is spoken (`3222aec`): a claimed booking with no successful `book_appointment` is dropped, "definitely"/"certainly" are removed, and "[Name]" template placeholders are cut. Times come from a calendar read done before the model runs, and `book_appointment` refuses times outside business hours. **Still open:** a spoken time is not yet checked against the slot list inside the sentence itself; the backstop is that booking refuses a time that isn't offered
- [ ] Echo: the mic is captured raw so Parakeet hears clean speech. Echo is handled in software: capture starts after the agent's audio ends, and anything ≥60% like the agent's last 20 s of speech is dropped. If it still fires on laptop speakers, try `echoCancellation: true` and measure the WER cost (headphones avoid it entirely)
- [x] `npm run eval` on `8ff9a87`: 88% (53/56) vs 92% (54/56) baseline. Voice `emergency_urgency` was our regression (the scheduling gate withheld the tool), fixed in `955ba52`
- [x] Eval A/B on `d913e00`, 3 runs each, 60 checks: product facts ON 56/58/60 (mean 58.0), OFF 57/58/54 (mean 56.3). The facts don't cause the webchat failures; those happen as often without them. Facts stay
- [x] `emergency_urgency` failed 4 of 6 A/B runs (sympathy, no urgency). Urgency is now recognised by rule and told to the model (`b0d9595`): 5/5
- [ ] Webchat `contact_capture` (4/6) and `objection_other_quotes` (4/6): the text pipeline's 3B model offers times without calling check_availability, and Gate 2 holds the reply. Same cause as voice; the fix there was reading the calendar before generation (`3222aec`). `runtime.ts` is shared, so the training session has been asked before porting

**Needs you to test live** (`localhost:3100/voice`)
- [ ] A full booking: "I need someone to service my heat pump", pick one of the two times, give your name and number. You should hear the same time back, and an appointment should appear at that time (`3222aec`, `d913e00`)
- [ ] Say "AC" or "what AC options do you have"; you should get product types and brands, not "bases" or appointment times
- [ ] "okay can someone come out tomorrow" should get a booking, not a handover to a human
- [ ] Talk over the agent mid-sentence; it should stop. Say "mm-hm" while it talks; it should keep going
- [ ] "I can smell gas" should immediately say to leave the house and call 911 or the gas company, then hand over to a human (`52659ec`)
- [ ] "Please don't call me again" should get the opt-out confirmation (`b9341e9`), and a bare "stop" while it talks should only interrupt it. Then "don't call me, text me instead" should go to the agent, not opt you out

**Not started / parked**
- [x] Kokoro TTS (:8787) and Parakeet STT (:8789) are running again now that the LoRA run is done (`npm run tts`, `npm run stt`)
- [ ] Moshi in the chat tier: model is in `models/moshi/` (q4), standalone demo works on :8998 (`moshi/.venv`), not wired into the app. Not running now
- [ ] PDF with diagrams explaining everything built (you parked this)
- [ ] Production latency: `ANTHROPIC_API_KEY` for the transact tier. Local models are dev-only: llama3.1:8b passes the key eval 1 time in 3
- [ ] Twilio: the tunnel URL changes on every run, so the webhook has to be pointed again; outbound calls need a verified caller ID. **Rotate the Twilio auth token** that was pasted into chat, then put the new one in `.env` yourself
