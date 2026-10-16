import { and, eq } from "drizzle-orm";
import { db, tenants, contacts, leads, appointments, jobs } from "@/server/db";
import { jobsToClose, recordAppointmentOutcome } from "@/server/features/appointment-outcomes";

/**
 * Closing a job: done wins the lead and queues the review request; no-shows
 * are counted; nothing can be closed twice, early, or across tenants.
 *
 *   npm run outcomes:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const H = 3600_000;

async function main() {
  const slug = "outcomes-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  await db.delete(tenants).where(eq(tenants.slug, `${slug}-other`));
  const [tenant] = await db.insert(tenants).values({
    name: "Outcomes Test", slug, country: "US", timezone: "America/New_York",
    settings: { businessName: "Outcomes Test", webhooks: [{ url: "https://crm.example.com/hook", secret: "s" }] },
  }).returning();
  const [other] = await db.insert(tenants).values({ name: "Other", slug: `${slug}-other`, country: "US", timezone: "America/New_York" }).returning();
  const [c] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: "Ben", primaryPhone: "+16175550401", smsConsent: true }).returning();
  const appt = async (offsetH: number, status: "confirmed" | "completed" | "cancelled" = "confirmed", withLead = true) => {
    const lead = withLead ? (await db.insert(leads).values({ tenantId: tenant.id, contactId: c.id, sourceChannel: "sms", status: "booked" }).returning())[0] : null;
    return (await db.insert(appointments).values({
      tenantId: tenant.id, contactId: c.id, leadId: lead?.id, service: "AC repair", status,
      startsAt: new Date(Date.now() + offsetH * H), endsAt: new Date(Date.now() + (offsetH + 1) * H),
    }).returning())[0];
  };

  try {
    const yesterday = await appt(-20);
    const lastWeek = await appt(-24 * 6);
    const tomorrow = await appt(24);
    const tooOld = await appt(-24 * 20);
    await appt(-5, "completed");
    await appt(-6, "cancelled");

    console.log("\nWhat needs closing");
    const list = (await jobsToClose(tenant.id)).map((a) => a.id);
    check("past, still-open jobs from the last two weeks are listed", list.includes(yesterday.id) && list.includes(lastWeek.id) && list.length === 2, `${list.length} listed`);
    check("future, already-closed and old ones are not", !list.includes(tomorrow.id) && !list.includes(tooOld.id));

    console.log("\nDone");
    check("marks it done", (await recordAppointmentOutcome(tenant.id, yesterday.id, "completed", "test")).ok);
    const done = await db.query.appointments.findFirst({ where: eq(appointments.id, yesterday.id) });
    const wonLead = await db.query.leads.findFirst({ where: eq(leads.id, done!.leadId!) });
    check("status completed, lead won", done?.status === "completed" && wonLead?.status === "won");
    const review = await db.query.jobs.findFirst({ where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "review_request")) });
    const delayH = review ? (review.runAt.getTime() - Date.now()) / H : 0;
    check("a review request is queued for ~3 hours later", Boolean(review) && delayH > 2.9 && delayH < 3.1, `${delayH.toFixed(2)} h`);
    const hooks = await db.query.jobs.findMany({ where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "webhook_delivery")) });
    check("the CRM hears appointment.completed", hooks.some((j) => (j.payload.event as { type: string }).type === "appointment.completed"));
    const twice = await recordAppointmentOutcome(tenant.id, yesterday.id, "no_show", "test");
    check("it can't be closed twice", !twice.ok && twice.error.includes("already marked completed"), twice.ok ? "" : twice.error);

    console.log("\nNo-show, early, and someone else's");
    check("no-show is recorded", (await recordAppointmentOutcome(tenant.id, lastWeek.id, "no_show", "test")).ok &&
      (await db.query.appointments.findFirst({ where: eq(appointments.id, lastWeek.id) }))?.status === "no_show");
    const nsLead = await db.query.leads.findFirst({ where: eq(leads.id, lastWeek.leadId!) });
    check("…and does not win the lead", nsLead?.status === "booked");
    const early = await recordAppointmentOutcome(tenant.id, tomorrow.id, "completed", "test");
    check("tomorrow's job can't be marked done today", !early.ok && early.error.includes("hasn't started"));
    check("…but it can be cancelled", (await recordAppointmentOutcome(tenant.id, tomorrow.id, "cancelled", "test")).ok);
    const foreign = await recordAppointmentOutcome(other.id, tooOld.id, "completed", "test");
    check("another tenant can't close it", !foreign.ok && foreign.error === "No such appointment.");
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
    await db.delete(tenants).where(eq(tenants.id, other.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
