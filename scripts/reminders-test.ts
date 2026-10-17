import { and, eq } from "drizzle-orm";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { addDays } from "date-fns";
import { db, tenants, locations, contacts, appointments, jobs, messages, conversations } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { executeTool } from "@/server/agent/tools";
import { scheduleAppointmentReminders, sendAppointmentReminder, reminderText } from "@/server/features/reminders";
import { ScriptedProvider } from "@/server/agent/providers";
import { testSlug } from "./test-tenant";

/**
 * Appointment reminders end to end against Postgres, with no model and no
 * SMS provider (sends that pass every gate fail at the provider, which is
 * how a test tells "allowed" from "blocked").
 *
 *   npm run reminders:test
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const TZ = "America/New_York";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const local = (daysAhead: number, hhmm: string) =>
  fromZonedTime(`${formatInTimeZone(addDays(new Date(), daysAhead), TZ, "yyyy-MM-dd")}T${hhmm}:00`, TZ);
const hourOf = (d: Date) => Number(formatInTimeZone(d, TZ, "H"));

async function main() {
  const slug = await testSlug("reminders-test");
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Reminder Test HVAC", slug, country: "US", timezone: TZ,
    settings: { businessName: "Reminder Test HVAC", agentName: "Alex" },
  }).returning();
  const allDay = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "07:00", close: "21:00" }));
  const [location] = await db.insert(locations).values({
    tenantId: tenant.id, name: "Main", country: "US", timezone: TZ, hours: allDay,
  }).returning();
  // No SMS consent at all: reminders must still go (transactional), STOP must still win.
  const [contact] = await db.insert(contacts).values({
    tenantId: tenant.id, displayName: "Grace Murphy", primaryPhone: "+16175550123",
  }).returning();
  const book = async (startsAt: Date, contactId = contact.id) => (await db.insert(appointments).values({
    tenantId: tenant.id, contactId, locationId: location.id, service: "AC repair",
    startsAt, endsAt: new Date(startsAt.getTime() + 3600_000),
  }).returning())[0];
  const jobsFor = (id: string) => db.query.jobs.findMany({
    where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "appointment_reminder")),
  }).then((rows) => rows.filter((j) => j.payload.appointmentId === id));

  try {
    console.log("\nScheduling");
    const afternoon = await book(local(3, "14:00"));
    const plan = await scheduleAppointmentReminders(afternoon.id);
    check("2pm in three days → day-before and same-day", plan.map((p) => p.kind).join(",") === "day_before,same_day",
      plan.map((p) => `${p.kind}@${formatInTimeZone(p.at, TZ, "EEE HH:mm")}`).join(" "));
    await scheduleAppointmentReminders(afternoon.id);
    check("scheduling twice makes no duplicate jobs", (await jobsFor(afternoon.id)).length === 2);

    const early = await book(local(4, "07:30"));
    const earlyPlan = await scheduleAppointmentReminders(early.id);
    const db1 = earlyPlan.find((p) => p.kind === "day_before");
    check("7:30am job: no same-day text at 5:30am", !earlyPlan.some((p) => p.kind === "same_day"));
    check("7:30am job: day-before text moved to 8am, not sent at 7:30", db1 ? hourOf(db1.at) === 8 : false,
      db1 ? formatInTimeZone(db1.at, TZ, "HH:mm") : "none");

    const late = await book(local(5, "20:30"));
    const latePlan = await scheduleAppointmentReminders(late.id);
    const db2 = latePlan.find((p) => p.kind === "day_before");
    check("8:30pm job: day-before text pulled back inside sending hours", db2 ? hourOf(db2.at) < 20 : false,
      db2 ? formatInTimeZone(db2.at, TZ, "HH:mm") : "none");

    const onCall = await book(local(6, "10:00"));
    const callPlan = await scheduleAppointmentReminders(onCall.id, { bookedOnCall: true });
    check("booked on a call → written confirmation first", callPlan[0]?.kind === "confirmation");

    console.log("\nText");
    const txt = reminderText("day_before", {
      business: "Reminder Test HVAC", firstName: "Grace", service: "AC repair", when: afternoon.startsAt, tz: TZ, customerConfirmed: false,
    });
    check("names the business", txt.includes("Reminder Test HVAC"));
    check("offers C and R, never CANCEL (a carrier opt-out word)", txt.includes("Reply C to confirm or R") && !/cancel/i.test(txt), txt);
    check("carries STOP", txt.includes("STOP"));

    console.log("\nSending");
    const [due] = await jobsFor(afternoon.id);
    const result = await sendAppointmentReminder(due.payload);
    const convo = await db.query.conversations.findFirst({
      where: and(eq(conversations.contactId, contact.id), eq(conversations.channel, "sms")),
    });
    const reminderMsg = convo ? await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, convo.id), eq(messages.direction, "outbound")),
    }) : null;
    // Inside sending hours this reaches the provider; outside, the job holds it.
    const inHours = hourOf(new Date()) >= 8 && hourOf(new Date()) < 20;
    if (inHours) {
      check("no marketing consent, still allowed (transactional)", reminderMsg?.status === "failed" && reminderMsg?.error === "Twilio not configured",
        `${reminderMsg?.status}: ${reminderMsg?.error ?? reminderMsg?.meta?.holdReason}`);
      check("message records which appointment it was for", reminderMsg?.meta?.reminderFor === afternoon.id);
    } else {
      check("outside 8am–8pm local, nothing is sent", !result.sent && result.reason === "outside sending hours", result.reason);
      // Send one anyway to exercise the reply path: a confirmation ignores the clock.
      await sendAppointmentReminder({ appointmentId: afternoon.id, kind: "confirmation", startsAt: afternoon.startsAt.toISOString() });
      const m = await db.query.messages.findFirst({
        where: and(eq(messages.tenantId, tenant.id), eq(messages.direction, "outbound")),
      });
      check("a confirmation is allowed without marketing consent", m?.status === "failed" && m?.error === "Twilio not configured",
        `${m?.status}: ${m?.error ?? m?.meta?.holdReason}`);
    }

    console.log("\nReplies");
    ScriptedProvider.reset();
    const yes = await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-r1", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550123" }, body: "C",
    });
    const confirmed = await db.query.appointments.findFirst({ where: eq(appointments.id, afternoon.id) });
    check("'C' confirms the appointment", Boolean(confirmed?.customerConfirmedAt));
    check("answered by rule, not the model", yes.outcome?.provider === "rule" && ScriptedProvider.requests.length === 0);
    check("and says so", Boolean(yes.outcome?.reply?.startsWith("Thanks — you're confirmed")), yes.outcome?.reply ?? "");

    const yesAgain = await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-r2", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550123" }, body: "yes",
    });
    check("a later 'yes' (last message was not a reminder) goes to the agent", yesAgain.outcome?.provider === "scripted");

    await sendAppointmentReminder({ appointmentId: afternoon.id, kind: "confirmation", startsAt: afternoon.startsAt.toISOString() });
    const r = await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-r3", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550123" }, body: "R",
    });
    const moved = await db.query.appointments.findFirst({ where: eq(appointments.id, afternoon.id) });
    check("'R' flags a reschedule and holds the slot as pending", moved?.status === "pending" && Boolean(moved?.rescheduleRequestedAt));
    check("and hands it to a person", r.outcome?.escalated === true && Boolean(r.outcome?.reply?.includes("Someone from the team")));
    const skip = await sendAppointmentReminder({ appointmentId: afternoon.id, kind: "same_day", startsAt: afternoon.startsAt.toISOString() });
    check("no more reminders once a reschedule is asked for", !skip.sent && skip.reason === "reschedule requested", skip.reason);

    console.log("\nStale and blocked");
    const stale = await sendAppointmentReminder({ appointmentId: early.id, kind: "day_before", startsAt: new Date(0).toISOString() });
    check("a reminder for a moved appointment stands down", stale.reason === "appointment was moved", stale.reason);
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, late.id));
    const cancelled = await sendAppointmentReminder({ appointmentId: late.id, kind: "day_before", startsAt: late.startsAt.toISOString() });
    check("no reminder for a cancelled job", cancelled.reason === "appointment is cancelled", cancelled.reason);
    await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-r4", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550123" }, body: "STOP",
    });
    const afterStop = await sendAppointmentReminder({ appointmentId: onCall.id, kind: "confirmation", startsAt: onCall.startsAt.toISOString() });
    check("STOP beats a transactional reminder", afterStop.reason === "contact is on do-not-contact", afterStop.reason);

    console.log("\nDouble-booking guard");
    await db.update(contacts).set({ doNotContact: false }).where(eq(contacts.id, contact.id));
    const [chat] = await db.insert(conversations).values({ tenantId: tenant.id, contactId: contact.id, channel: "webchat" }).returning();
    const ctx = { tenant, contactId: contact.id, conversationId: chat.id, location };
    const slot = local(9, "11:00");
    const cancelledThere = await book(slot);
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, cancelledThere.id));
    // Someone else's confirmed booking in the same slot. (The customer's own
    // booking there is theirs already, and booking it again confirms it.)
    const [someoneElse] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: "Someone Else" }).returning();
    await book(slot, someoneElse.id); // confirmed, same slot
    // Times as check_availability hands them out: local, with the offset.
    const offered = (d: Date) => formatInTimeZone(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    const clash = await executeTool(ctx, "book_appointment", { service: "Tune-up", starts_at: offered(slot) });
    check("a cancelled booking no longer hides a confirmed one", clash.ok === false, String(clash.error ?? "booked!"));
    const mine = await book(local(9, "14:00"));
    const again = await executeTool(ctx, "book_appointment", { service: "Tune-up", starts_at: offered(mine.startsAt) });
    check("booking your own slot again confirms it, not 'taken'",
      again.ok === true && (again as { already_booked?: boolean }).already_booked === true, JSON.stringify(again).slice(0, 80));
    const backToBack = await executeTool(ctx, "book_appointment", {
      service: "Tune-up", starts_at: offered(new Date(slot.getTime() + 3600_000)),
    });
    check("back-to-back slots are not a clash", backToBack.ok === true, String(backToBack.error ?? ""));
    const tunedJobs = await jobsFor(String(backToBack.appointment_id));
    check("booking through the tool schedules its reminders", tunedJobs.length >= 1, `${tunedJobs.length} job(s)`);
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
