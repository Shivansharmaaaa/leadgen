import { and, eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db, tenants, locations, staff, events, jobs, messages, conversations, contacts } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { screenInbound } from "@/server/core/guardrails";
import { alertStaff, alertText, isOpen, nextOpening, pickRecipients } from "@/server/features/staff-alerts";
import { ScriptedProvider } from "@/server/agent/providers";

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
  check("tenant trigger 'insurance claim' still escalates", s("this is an insurance claim").escalate);
  check("'I smell gas' is a safety escalation", s("I smell gas in the basement").safety === true);
  check("a CO alarm is a safety escalation", s("the CO alarm keeps going off").safety === true);

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

  const slug = "alerts-test";
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
