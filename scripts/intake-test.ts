import { and, eq } from "drizzle-orm";
import { db, tenants, locations, contacts, leads, messages, events, conversations } from "@/server/db";
import { handleInbound, deliver } from "@/server/core/ingest";
import { detectConsentKeyword } from "@/server/core/opt-out";
import { evaluateFormConsent, intakeLead } from "@/server/features/lead-intake";
import { slaReport } from "@/server/features/sla";
import { ScriptedProvider } from "@/server/agent/providers";
import { POST as intakeRoute } from "@/app/api/leads/route";

/**
 * Lead intake, consent capture, STOP handling and the SLA fix, end to end
 * against Postgres — with no model (LLM_PROVIDER=scripted) and no SMS
 * provider, so it runs while the GPU is busy and can never text anyone.
 *
 *   npm run intake:test
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.SMTP_HOST;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const BUSINESS = "Intake Test Heating & Air";
const GOOD_CONSENT =
  `By checking this box I agree that ${BUSINESS} may contact me by text message, including ` +
  `automated texts, at the number provided. Consent is not a condition of purchase. Msg & data ` +
  `rates may apply. Reply STOP to opt out.`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const slug = "intake-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: BUSINESS, slug, country: "US", timezone: "America/New_York",
    settings: { businessName: BUSINESS, agentName: "Alex", intakeKey: "test-key-123" },
  }).returning();
  await db.insert(locations).values({
    tenantId: tenant.id, name: "Main", country: "US", timezone: "America/New_York", hours: [],
  });

  try {
    console.log("\nConsent wording");
    check("complete disclosure is valid", evaluateFormConsent({ sms: true, language: GOOD_CONSENT }, BUSINESS).sms);
    const unnamed = evaluateFormConsent({ sms: true, language: GOOD_CONSENT.replace(BUSINESS, "us") }, BUSINESS);
    check("disclosure that never names the business is rejected", !unnamed.sms, unnamed.problems[0]);
    const noCondition = evaluateFormConsent({ sms: true, language: GOOD_CONSENT.replace("Consent is not a condition of purchase. ", "") }, BUSINESS);
    check("missing 'not a condition of purchase' is rejected", !noCondition.sms, noCondition.problems[0]);
    check("unticked box is rejected", !evaluateFormConsent({ sms: false, language: GOOD_CONSENT }, BUSINESS).sms);
    check("short-name mention counts ('Intake' for the full name)",
      evaluateFormConsent({ sms: true, language: GOOD_CONSENT.replace(BUSINESS, "Intake") }, BUSINESS).sms);

    console.log("\nOpt-out keywords");
    const cases: [string, string | null][] = [
      ["STOP", "opt_out"], ["stop.", "opt_out"], ["Unsubscribe", "opt_out"], ["END", "opt_out"],
      ["Please stop texting me", "opt_out"], ["remove me from your list", "opt_out"],
      ["START", "opt_in"],
      ["My AC won't stop rattling", null], ["I want to cancel my appointment", null],
      ["Don't call me, text me instead", null], ["stop by tomorrow?", null],
    ];
    for (const [text, want] of cases) {
      const got = detectConsentKeyword(text, "sms")?.kind ?? null;
      check(`${JSON.stringify(text)} → ${want ?? "not a keyword"}`, got === want, got === want ? "" : `got ${got}`);
    }
    // On a call "stop" means stop talking; only an explicit request counts.
    const voiceCases: [string, string | null][] = [
      ["Stop.", null], ["End", null], ["Cancel", null], ["START", null],
      ["Don't call me again", "opt_out"], ["Take me off your list", "opt_out"],
    ];
    for (const [text, want] of voiceCases) {
      const got = detectConsentKeyword(text, "voice")?.kind ?? null;
      check(`on a call: ${JSON.stringify(text)} → ${want ?? "not a keyword"}`, got === want, got === want ? "" : `got ${got}`);
    }

    console.log("\nIntake with valid consent");
    ScriptedProvider.reset();
    const submittedAt = new Date(Date.now() - 4000).toISOString();
    const a = await intakeLead(tenant.id, {
      source: "website", externalId: "form-001", name: "Priya Patel", phone: "(617) 555-0142",
      service: "AC repair", message: "AC is blowing warm air", submittedAt,
      consent: { sms: true, language: GOOD_CONSENT, pageUrl: "https://example.com/contact", ip: "203.0.113.7" },
    });
    check("lead stored with its source", Boolean(a.leadId));
    const leadA = a.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, a.leadId) }) : null;
    check("lead.source = website", leadA?.source === "website", String(leadA?.source));
    const contactA = await db.query.contacts.findFirst({ where: eq(contacts.id, a.contactId!) });
    check("SMS consent recorded with its evidence", contactA?.smsConsent === true && Boolean(contactA?.consentSource?.includes("not a condition")));
    check("the agent saw the person's own words", ScriptedProvider.requests.some((r) =>
      JSON.stringify(r.history).includes("AC is blowing warm air")));
    check("and was told the greeting is already done (no double \"Hi Priya!\")", ScriptedProvider.requests.some((r) =>
      (r.context ?? "").includes("do not greet them")));
    // No SMS provider is configured, so a send that passed the consent gate fails at Twilio.
    check("consent gate passed (send reached the provider)", a.firstResponse === "failed", `${a.firstResponse}: ${a.reason}`);
    const out = await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, a.conversationId!), eq(messages.direction, "outbound")),
    });
    check("first text says who it is", Boolean(out?.body.startsWith(`Hi Priya, it's Alex at ${BUSINESS}`)), out?.body);
    check("first text says how to stop", Boolean(out?.body.endsWith("Reply STOP to opt out.")));
    const inbound = await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, a.conversationId!), eq(messages.direction, "inbound")),
    });
    check("SLA clock starts at submission, not receipt",
      inbound?.createdAt.toISOString() === new Date(submittedAt).toISOString());

    console.log("\nRedelivery");
    const leadsBefore = (await db.query.leads.findMany({ where: eq(leads.tenantId, tenant.id) })).length;
    const dup = await intakeLead(tenant.id, {
      source: "website", externalId: "form-001", name: "Priya Patel", phone: "(617) 555-0142",
      consent: { sms: true, language: GOOD_CONSENT },
    });
    const leadsAfter = (await db.query.leads.findMany({ where: eq(leads.tenantId, tenant.id) })).length;
    check("same source + id is a duplicate", dup.duplicate && dup.leadId === a.leadId);
    check("no second lead", leadsAfter === leadsBefore, `${leadsBefore} → ${leadsAfter}`);

    console.log("\nIntake without valid consent");
    const b = await intakeLead(tenant.id, {
      source: "angi", externalId: "angi-77", name: "Marcus Kim", phone: "617-555-0177",
      service: "Furnace tune-up",
      consent: { sms: true, language: "I agree to be contacted about my request." },
    });
    check("not texted: held for a person", b.firstResponse === "held_for_review", b.firstResponse);
    check("reason names what the form is missing", Boolean(b.reason?.includes("does not name")), b.reason);
    const contactB = await db.query.contacts.findFirst({ where: eq(contacts.id, b.contactId!) });
    check("no consent recorded", contactB?.smsConsent === false);

    console.log("\nConsent is never downgraded");
    await intakeLead(tenant.id, {
      source: "thumbtack", externalId: "tt-1", phone: "6175550142", message: "Also need a duct clean",
    });
    const again = await db.query.contacts.findFirst({ where: eq(contacts.id, a.contactId!) });
    check("earlier valid consent survives a form without one", again?.smsConsent === true);

    console.log("\nTimestamps and existing threads");
    const future = await intakeLead(tenant.id, { source: "website", externalId: "future-1", phone: "6175550160",
      submittedAt: new Date(Date.now() + 3600_000).toISOString() });
    const fIn = await db.query.messages.findFirst({ where: and(eq(messages.conversationId, future.conversationId!), eq(messages.direction, "inbound")) });
    check("a submittedAt in the future is clamped to now", Boolean(fIn) && fIn!.createdAt.getTime() <= Date.now());
    ScriptedProvider.enqueue("");
    const repeat = await intakeLead(tenant.id, { source: "website", externalId: "future-2", phone: "6175550160", message: "Also my thermostat" });
    check("an old reply in the same thread is not reported as this lead's reply", repeat.firstResponse === "not_sent", `${repeat.firstResponse}`);

    console.log("\nEmail-only lead");
    const c = await intakeLead(tenant.id, { source: "facebook_lead_ad", externalId: "fb-9", email: "Nora@Example.com", service: "Heat pump quote" });
    // No SMTP here: an email reply that passes the gate fails at the provider.
    check("answered by email at once (no SMTP here, so it fails at the provider, not the gate)",
      c.firstResponse === "failed" && Boolean(c.reason?.includes("Email not configured")) && Boolean(c.leadId), `${c.firstResponse}: ${c.reason}`);

    console.log("\nSTOP and START");
    const runsBefore = ScriptedProvider.requests.length;
    const stop = await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-stop-1", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550142" }, body: "STOP",
    });
    const stopped = await db.query.contacts.findFirst({ where: eq(contacts.id, a.contactId!) });
    check("STOP marks the contact do-not-contact", stopped?.doNotContact === true);
    check("the agent never saw the STOP", ScriptedProvider.requests.length === runsBefore);
    const confirm = await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, stop.conversationId), eq(messages.direction, "outbound")),
      orderBy: (m, { desc }) => desc(m.createdAt),
    });
    check("one confirmation drafted", Boolean(confirm?.body.includes("unsubscribed")), confirm?.body);
    const blocked = await deliver({
      tenantId: tenant.id, conversationId: stop.conversationId, channel: "sms",
      to: { channel: "sms", externalId: "+16175550142" }, body: "Special offer!", initiated: true,
    });
    const held = await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, stop.conversationId), eq(messages.body, "Special offer!")),
    });
    check("a business-initiated send after STOP is blocked", !blocked && held?.status === "held_for_review",
      String(held?.meta?.holdReason));
    await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-start-1", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550142" }, body: "START",
    });
    const restarted = await db.query.contacts.findFirst({ where: eq(contacts.id, a.contactId!) });
    check("START lifts it", restarted?.doNotContact === false);
    const optEvents = await db.query.events.findMany({ where: and(eq(events.tenantId, tenant.id), eq(events.type, "opt_out")) });
    check("opt-out logged as evidence", optEvents.length === 1);

    console.log("\nOpt-out on a call");
    const callStop = await handleInbound({
      tenantId: tenant.id, channel: "voice", externalId: "CA-1-1", externalThreadId: "CA-1",
      from: { channel: "voice", externalId: "+16175550188" }, body: "Stop.",
    });
    check("a bare 'Stop.' on a call goes to the agent", callStop.outcome?.provider === "scripted");
    const callDnc = await handleInbound({
      tenantId: tenant.id, channel: "voice", externalId: "CA-1-2", externalThreadId: "CA-1",
      from: { channel: "voice", externalId: "+16175550188" }, body: "Please don't call me again.",
    });
    const caller = await db.query.contacts.findFirst({ where: eq(contacts.id, callDnc.contactId) });
    check("'don't call me again' on a call is honoured", caller?.doNotContact === true);
    check("and the caller hears a spoken confirmation", Boolean(callDnc.outcome?.reply?.startsWith("Understood")), callDnc.outcome?.reply ?? "");

    console.log("\nInitiated send to a stranger");
    const [convo] = await db.insert(conversations).values({ tenantId: tenant.id, contactId: a.contactId!, channel: "sms" }).returning();
    const stranger = await deliver({
      tenantId: tenant.id, conversationId: convo.id, channel: "sms",
      to: { channel: "sms", externalId: "+16175550999" }, body: "Hello", initiated: true,
    });
    check("blocked: no contact record means no consent", !stranger);

    console.log("\nSLA counts replies that reached someone");
    const t0 = new Date(Date.now() - 600_000);
    const [slaConvo] = await db.insert(conversations).values({ tenantId: tenant.id, contactId: a.contactId!, channel: "webchat" }).returning();
    await db.insert(messages).values([
      { tenantId: tenant.id, conversationId: slaConvo.id, direction: "inbound", channel: "webchat", authorType: "contact", body: "hi", status: "received", createdAt: t0 },
      { tenantId: tenant.id, conversationId: slaConvo.id, direction: "outbound", channel: "webchat", authorType: "ai", body: "draft", status: "held_for_review", createdAt: new Date(t0.getTime() + 5_000) },
      { tenantId: tenant.id, conversationId: slaConvo.id, direction: "outbound", channel: "webchat", authorType: "human", body: "real", status: "sent", createdAt: new Date(t0.getTime() + 90_000) },
    ]);
    const sla = await slaReport(tenant.id, 1);
    const mine = sla.slowest.find((s) => s.conversationId === slaConvo.id);
    check("a held draft is not a first response (90s, not 5s)", mine?.seconds === 90, `${mine?.seconds}s`);

    console.log("\nHTTP route");
    const call = (body: unknown, key = "test-key-123", s = slug) => intakeRoute(new Request(
      `http://localhost/api/leads?tenant=${s}`,
      { method: "POST", headers: { "content-type": "application/json", "x-intake-key": key }, body: JSON.stringify(body) },
    ));
    check("wrong key → 401", (await call({ phone: "6175550100" }, "nope")).status === 401);
    check("unknown tenant → 401 (same as a wrong key)", (await call({ phone: "6175550100" }, "test-key-123", "no-such")).status === 401);
    check("no phone or email → 422", (await call({ name: "x" })).status === 422);
    check("bad source → 422", (await call({ phone: "6175550100", source: "craigslist" })).status === 422);
    const ok = await call({ source: "zapier", externalId: "z-1", phone: "6175550100", message: "Need a quote" });
    check("valid lead → 202", ok.status === 202, String(ok.status));
    const okAgain = await call({ source: "zapier", externalId: "z-1", phone: "6175550100", message: "Need a quote" });
    check("redelivered lead → 200, duplicate", okAgain.status === 200 && (await okAgain.json()).duplicate === true);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
