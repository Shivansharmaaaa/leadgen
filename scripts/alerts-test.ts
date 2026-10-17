import { and, eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db, tenants, locations, staff, events, jobs, messages, conversations, contacts } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { screenInbound } from "@/server/core/guardrails";
import { alertStaff, alertText, isOpen, nextOpening, pickRecipients } from "@/server/features/staff-alerts";
import { executeTool } from "@/server/agent/tools";
import { ScriptedProvider } from "@/server/agent/providers";
import { testSlug } from "./test-tenant";

/**
 * Gate 1 matching, escalation replies, and staff alerts end to end against
 * Postgres, with no model and no SMS provider.
 *
 *   npm run alerts:test
 */
process.env.LLM_PROVIDER = "scripted";
process.env.APP_URL = "https://app.example.com";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const TZ = "America/New_York";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" }));
const weekdayNow = Number(formatInTimeZone(new Date(), TZ, "i")) % 7;
// Open only on a day that is not today: guaranteed after hours right now.
const CLOSED_TODAY = [{ day: (weekdayNow + 2) % 7, open: "08:00", close: "17:00" }];

async function main() {
  console.log("\nGate 1 matches words, not fragments");
  const s = (t: string) => screenInbound(t, { escalationTriggers: ["insurance claim"] });
  check("'I have an issue with my AC' is not a lawsuit", !s("I have an issue with my AC").escalate);
  check("'I'm the property manager' is not a demand for one", !s("I'm the property manager for the building").escalate);
  check("'do you do emergency repairs?' is a sales question", !s("Do you do emergency repairs?").escalate);
  check("'it hurts my ears' is not an injury", !s("It hurts my ears, the noise").escalate);
  check("'I want to sue' still escalates", s("I want to sue you").escalate);
  check("'get me your manager' still escalates", s("Get me your manager now").escalate);
  check("'how much does it cost to talk to someone?' is a price question", !s("How much does it cost to talk to someone?").escalate);
  check("'what do you charge to speak to someone about…?' is too", !s("What do you charge to speak to someone about a study permit?").escalate);
  check("'I want to talk to someone' still escalates", s("I want to talk to someone").escalate);
  check("'a hundred and fifty dollars just to talk to someone?' is a price objection",
    !s("A hundred and fifty dollars just to talk to someone? That's steep.").escalate);
  check("'$150 just to talk to someone?' is a price objection", !s("$150 just to talk to someone?").escalate);
  check("'that much to speak to someone?' is a price objection", !s("That much to speak to someone?").escalate);
  check("'too expensive, let me talk to a person' still escalates",
    s("It's too expensive, let me talk to a person.").escalate);
  check("'can I talk to someone' still escalates", s("Can I talk to someone about the price?").escalate);
  check("'it costs too much, let me talk to a person' still escalates", s("It costs too much, let me talk to a person").escalate);
  check("tenant trigger 'insurance claim' still escalates", s("this is an insurance claim").escalate);
  check("'I smell gas' is a safety escalation", s("I smell gas in the basement").safety === true);
  check("a CO alarm is a safety escalation", s("the CO alarm keeps going off").safety === true);

  console.log("\nFiller certainty is dropped, real guarantees are not");
  const { softenIntensifiers, screenOutbound } = await import("@/server/core/guardrails");
  check("'We can definitely help with that.' → 'We can help with that.'", softenIntensifiers("We can definitely help with that.") === "We can help with that.");
  check("'Definitely! What time suits?' → 'Sure. What time suits?'", softenIntensifiers("Definitely! What time suits?") === "Sure. What time suits?");
  check("'We certainly can, yes.' → 'We can, yes.'", softenIntensifiers("We certainly can, yes.") === "We can, yes.", softenIntensifiers("We certainly can, yes."));
  check("softened text passes Gate 2", screenOutbound(softenIntensifiers("We can definitely help with that."), {}).allow);
  check("'I guarantee it'll be fixed' is still held", !screenOutbound(softenIntensifiers("I guarantee it'll be fixed today."), {}).allow);
  check("'no charge' is still held", !screenOutbound(softenIntensifiers("The visit is no charge."), {}).allow);

  console.log("\nRecipients and hours (pure)");
  const mk = (o: Partial<typeof staff.$inferSelect>) => ({
    id: crypto.randomUUID(), tenantId: "t", email: `${Math.random()}@x`, name: "x", role: "tech",
    phone: "+16175550000", alerts: true, onCall: false, createdAt: new Date(), ...o,
  });
  const team = [mk({ name: "Dana" }), mk({ name: "Sam", onCall: true }), mk({ name: "NoPhone", phone: null }), mk({ name: "Muted", alerts: false })];
  check("emergency → on-call only", pickRecipients(team, { emergency: true, withinHours: false }).map((r) => r.name).join() === "Sam");
  check("emergency, nobody on call → everyone with alerts", pickRecipients(team.filter((t) => !t.onCall), { emergency: true, withinHours: false }).map((r) => r.name).join() === "Dana");
  check("normal, open → everyone with a phone and alerts", pickRecipients(team, { emergency: false, withinHours: true }).map((r) => r.name).join() === "Dana,Sam");
  check("normal, closed → nobody woken", pickRecipients(team, { emergency: false, withinHours: false }).length === 0);
  const sat10 = new Date("2026-10-17T14:00:00Z"); // Saturday 10:00 EDT
  const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, open: "08:00", close: "17:00" }));
  check("closed on Saturday with weekday hours", !isOpen(sat10, weekdays, TZ));
  check("next opening after Saturday is Monday 8:00", formatInTimeZone(nextOpening(sat10, weekdays, TZ)!, TZ, "EEE HH:mm") === "Mon 08:00");
  const txt = alertText({ emergency: true, businessName: "Biz", who: "Priya", phone: "+16175550142",
    said: "I smell gas", reason: "safety: smell gas", service: null, link: "https://app.example.com/inbox?c=1" });
  check("alert says what, who, how to reach them, and where", txt.startsWith("EMERGENCY") && txt.includes("+16175550142") && txt.includes('"I smell gas"') && txt.includes("/inbox?c=1"), txt.replace(/\n/g, " | "));

  const slug = await testSlug("alerts-test");
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Alert Test HVAC", slug, country: "US", timezone: TZ,
    settings: { businessName: "Alert Test HVAC", agentName: "Alex", escalationTriggers: ["insurance claim"] },
  }).returning();
  const [location] = await db.insert(locations).values({
    tenantId: tenant.id, name: "Main", country: "US", timezone: TZ, hours: ALL_DAY,
  }).returning();
  await db.insert(staff).values([
    { tenantId: tenant.id, email: "owner@x", name: "Dana", role: "owner", phone: "+16175550101" },
    { tenantId: tenant.id, email: "tech@x", name: "Sam", role: "tech", phone: "+16175550102", onCall: true },
  ]);
  const inbound = (n: number, body: string, from = "+16175550190") => handleInbound({
    tenantId: tenant.id, channel: "sms", externalId: `SM-a${n}`, externalThreadId: null,
    from: { channel: "sms", externalId: from }, body,
  });
  const alertsFor = (conversationId: string) => db.query.events.findMany({
    where: and(eq(events.conversationId, conversationId), eq(events.type, "staff_alert")),
  });

  try {
    console.log("\nEscalation always answers");
    ScriptedProvider.reset();
    const issue = await inbound(1, "I have an issue with my AC, it's blowing warm");
    check("'issue' reaches the agent", issue.outcome?.provider === "scripted" && !issue.outcome.escalated);
    ScriptedProvider.enqueue("We can definitely help with that. Is it blowing warm air?");
    const filler = await inbound(9, "my AC stopped working", "+16175550189");
    check("a reply with 'definitely' goes out softened instead of being held",
      !filler.outcome?.holdReason && filler.outcome?.reply === "We can help with that. Is it blowing warm air?", filler.outcome?.reply ?? filler.outcome?.holdReason ?? "");
    const refund = await inbound(2, "I want a refund for last week's visit", "+16175550191");
    check("a Gate 1 handover now replies instead of going silent", Boolean(refund.outcome?.reply?.includes("passing this to a member")), refund.outcome?.reply ?? "null");
    const sentRow = await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, refund.conversationId), eq(messages.direction, "outbound")),
    });
    check("and the reply goes out, not held", sentRow?.status === "failed" && sentRow.error === "Twilio not configured", `${sentRow?.status}`);

    console.log("\nStaff alerts");
    const refundAlerts = await alertsFor(refund.conversationId);
    const r0 = refundAlerts[0]?.payload as { emergency?: boolean; recipients?: { staffId: string; error?: string }[] };
    check("open hours, not an emergency → both staff alerted", r0?.recipients?.length === 2 && r0.emergency === false, JSON.stringify(r0?.recipients?.map((r) => r.error)));
    const again = await alertStaff({ tenantId: tenant.id, conversationId: refund.conversationId, reason: "still upset", urgency: "now" });
    check("no second alert for the same thread within 30 minutes", again.skipped?.startsWith("already alerted") === true, again.skipped);

    const gas = await inbound(3, "I smell gas in the basement", "+16175550192");
    check("gas: told to leave and call 911 first", Boolean(gas.outcome?.reply?.includes("leave the house now")) && Boolean(gas.outcome?.reply?.includes("911")), gas.outcome?.reply ?? "");
    const gasAlert = (await alertsFor(gas.conversationId))[0]?.payload as { emergency?: boolean; recipients?: { staffId: string }[]; body?: string };
    const sam = await db.query.staff.findFirst({ where: and(eq(staff.tenantId, tenant.id), eq(staff.name, "Sam")) });
    check("gas: only the on-call tech is woken", gasAlert?.emergency === true && gasAlert.recipients?.length === 1 && gasAlert.recipients[0].staffId === sam?.id);
    check("gas: alert carries the inbox link", Boolean(gasAlert?.body?.includes("https://app.example.com/inbox?c=")));

    console.log("\nAfter hours");
    await db.update(locations).set({ hours: CLOSED_TODAY }).where(eq(locations.id, location.id));
    const night = await inbound(4, "I want a refund please", "+16175550193");
    const deferredJob = await db.query.jobs.findFirst({
      where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "staff_alert")),
    });
    check("a non-urgent handover after hours waits for opening", Boolean(deferredJob) && deferredJob!.runAt > new Date(),
      deferredJob ? formatInTimeZone(deferredJob.runAt, TZ, "EEE HH:mm") : "no job");
    const nightAlert = (await alertsFor(night.conversationId))[0]?.payload as { recipients?: unknown[]; deferredUntil?: string };
    check("and nobody is texted now", nightAlert?.recipients?.length === 0 && Boolean(nightAlert.deferredUntil));
    const fired = await alertStaff({ ...(deferredJob!.payload as { conversationId: string; reason: string }), tenantId: tenant.id, deferred: true });
    check("at opening time the held alert goes to the team", fired.failed === 2 && !fired.skipped, JSON.stringify(fired));

    const nightGas = await inbound(5, "there's a gas smell coming from the furnace", "+16175550194");
    const ngAlert = (await alertsFor(nightGas.conversationId))[0]?.payload as { emergency?: boolean; recipients?: unknown[] };
    check("an emergency after hours still wakes the on-call tech", ngAlert?.emergency === true && ngAlert.recipients?.length === 1);

    console.log("\nAn emergency job reaches the on-call tech without a handover");
    await db.update(locations).set({ hours: CLOSED_TODAY }).where(eq(locations.id, location.id));
    const noHeat = await inbound(7, "No heat at all and there's a baby in the house", "+16175550196");
    const ctx = { tenant, contactId: noHeat.contactId, conversationId: noHeat.conversationId, location: { ...location, hours: CLOSED_TODAY } };
    await executeTool(ctx, "qualify_lead", { service: "Furnace repair", intent: "no heat, infant at home", urgency: "emergency", score: 95 });
    const ems = (await alertsFor(noHeat.conversationId)).map((e) => e.payload as { emergency?: boolean; recipients?: { staffId: string }[] });
    check("triaged as an emergency → on-call alerted, after hours", ems.length === 1 && ems[0].emergency === true && ems[0].recipients?.[0]?.staffId === sam?.id);
    const stillAi = await db.query.conversations.findFirst({ where: eq(conversations.id, noHeat.conversationId) });
    check("…and the AI keeps the conversation (not a handover)", stillAi?.aiPaused === false);
    await executeTool(ctx, "qualify_lead", { service: "Furnace repair", intent: "no heat", urgency: "emergency", score: 96 });
    check("re-qualifying the same emergency doesn't alert again", (await alertsFor(noHeat.conversationId)).length === 1);
    // The same person on a second channel: still one lead.
    const [secondChannel] = await db.insert(conversations).values({ tenantId: tenant.id, contactId: noHeat.contactId, channel: "voice" }).returning();
    await executeTool({ ...ctx, conversationId: secondChannel.id }, "qualify_lead", { service: "Furnace repair", intent: "called about the same no-heat", urgency: "emergency", score: 97 });
    const { leads } = await import("@/server/db");
    const theirLeads = await db.query.leads.findMany({ where: eq(leads.contactId, noHeat.contactId) });
    check("someone who texts and then calls is one lead, not two", theirLeads.length === 1, String(theirLeads.length));
    const routine = await inbound(8, "Can I get a tune-up sometime next month?", "+16175550197");
    await executeTool({ ...ctx, contactId: routine.contactId, conversationId: routine.conversationId }, "qualify_lead",
      { service: "Tune-up", intent: "annual service", urgency: "this_month", score: 40 });
    check("a routine lead alerts nobody", (await alertsFor(routine.conversationId)).length === 0);
    await db.update(locations).set({ hours: ALL_DAY }).where(eq(locations.id, location.id));

    console.log("\nA tech texting back is not a customer");
    const runsBefore = ScriptedProvider.requests.length;
    const contactsBefore = (await db.query.contacts.findMany({ where: eq(contacts.tenantId, tenant.id) })).length;
    const onIt = await inbound(20, "On it", "+16175550102");  // Sam, who got the gas alert
    check("Sam's 'On it' never reaches the AI", ScriptedProvider.requests.length === runsBefore && onIt.outcome?.provider === "rule");
    check("and doesn't make Sam a contact", (await db.query.contacts.findMany({ where: eq(contacts.tenantId, tenant.id) })).length === contactsBefore);
    const claimed = await db.query.conversations.findFirst({ where: eq(conversations.id, onIt.conversationId) });
    // His latest alert was the no-heat emergency (after the gas one): that's the one he takes.
    check("it claims his latest alert's conversation, taking it off the AI", claimed?.aiPaused === true && claimed.id === noHeat.conversationId,
      `${onIt.conversationId} vs no-heat ${noHeat.conversationId}`);
    check("and tells him who it is", Boolean(onIt.outcome?.reply?.startsWith("Got it")), onIt.outcome?.reply ?? "");
    const staffTexts = async () => (await db.query.events.findMany({ where: and(eq(events.tenantId, tenant.id), eq(events.type, "staff_text")) })).length;
    const beforeDup = await staffTexts();
    const dup = await inbound(20, "On it", "+16175550102");  // the same Twilio message redelivered
    check("a redelivered staff text is handled once", (await staffTexts()) === beforeDup && dup.outcome?.reply === "");
    const chat = await inbound(21, "what's for lunch", "+16175550101");  // Dana
    check("anything else from staff gets a pointer, not a chat", chat.outcome?.provider === "rule" && ScriptedProvider.requests.length === runsBefore, chat.outcome?.reply ?? "");
    const { intakeLead } = await import("@/server/features/lead-intake");
    const test = await intakeLead(tenant.id, { source: "website", externalId: "owner-test", name: "Dana", phone: "617-555-0101", message: "testing the form" });
    check("the owner testing the web form with her own mobile is still a lead", Boolean(test.leadId) && Boolean(test.conversationId));

    console.log("\nA lead the AI couldn't text reaches a person");
    await db.update(locations).set({ hours: ALL_DAY }).where(eq(locations.id, location.id));
    const held = await intakeLead(tenant.id, { source: "angi", externalId: "angi-held-1", name: "Ivy", phone: "617-555-0198",
      consent: { sms: true, language: "I agree to be contacted." } });
    const heldAlerts = await alertsFor(held.conversationId!);
    check("an Angi lead held for lack of consent alerts the team", held.firstResponse === "held_for_review" && heldAlerts.length === 1 &&
      String((heldAlerts[0].payload as { reason?: string }).reason).includes("needs a call"), String((heldAlerts[0]?.payload as { reason?: string })?.reason));

    console.log("\nReschedule requests reach a person");
    const [c] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: "Leah", primaryPhone: "+16175550195" }).returning();
    const [convo] = await db.insert(conversations).values({ tenantId: tenant.id, contactId: c.id, channel: "sms" }).returning();
    const { appointments } = await import("@/server/db");
    const [appt] = await db.insert(appointments).values({
      tenantId: tenant.id, contactId: c.id, locationId: location.id, service: "Tune-up",
      startsAt: new Date(Date.now() + 3 * 86400_000), endsAt: new Date(Date.now() + 3 * 86400_000 + 3600_000),
    }).returning();
    await db.update(locations).set({ hours: ALL_DAY }).where(eq(locations.id, location.id));
    await db.insert(messages).values({
      tenantId: tenant.id, conversationId: convo.id, direction: "outbound", channel: "sms", authorType: "ai",
      body: "reminder", status: "sent", meta: { reminderFor: appt.id },
    });
    await inbound(6, "R", "+16175550195");
    check("'R' to a reminder alerts the team", (await alertsFor(convo.id)).length === 1);
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
