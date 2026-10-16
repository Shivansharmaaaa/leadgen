import { and, eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db, tenants, locations, contacts, leads, jobs, messages, outreachAssignments, conversations } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { campaignText, launchReactivation, nextSendTime, sendCampaignMessage } from "@/server/features/campaigns";

/**
 * Reactivation campaigns: who is chosen, the holdout, sending hours, and
 * consent re-checked at send time. No model, nothing really sent.
 *
 *   npm run campaigns:test
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.SMTP_HOST;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const TZ = "America/New_York";

async function main() {
  console.log("\nSending window (10am–7pm local)");
  const at = (iso: string) => formatInTimeZone(nextSendTime(new Date(iso), TZ), TZ, "EEE HH:mm");
  check("2pm stays 2pm", at("2026-10-19T18:00:00Z") === "Mon 14:00");
  check("7am waits for 10am the same day", at("2026-10-19T11:00:00Z") === "Mon 10:00");
  check("9pm waits for 10am tomorrow", at("2026-10-20T01:00:00Z") === "Tue 10:00", at("2026-10-20T01:00:00Z"));
  const text = campaignText("sms", { firstName: "Leah", agent: "Alex", business: "Biz", service: "Furnace tune-up" });
  check("names the business, the service, and how to stop", text.startsWith("Hi Leah, it's Alex at Biz.") && text.includes("furnace tune-up") && text.endsWith("Reply STOP to opt out."), text);

  const slug = "campaigns-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Campaign Test HVAC", slug, country: "US", timezone: TZ,
    settings: { businessName: "Campaign Test HVAC", agentName: "Alex" },
  }).returning();
  await db.insert(locations).values({ tenantId: tenant.id, name: "Main", country: "US", timezone: TZ, hours: [] });
  const old = new Date(Date.now() - 40 * 86400_000);
  const person = async (n: number, o: { smsConsent?: boolean; doNotContact?: boolean; status?: "new" | "booked" } = {}) => {
    const [c] = await db.insert(contacts).values({
      tenantId: tenant.id, displayName: `Person ${n}`, primaryPhone: `+1617555${String(1000 + n)}`,
      smsConsent: o.smsConsent ?? true, doNotContact: o.doNotContact ?? false,
    }).returning();
    const [l] = await db.insert(leads).values({
      tenantId: tenant.id, contactId: c.id, sourceChannel: "sms", service: "Furnace tune-up",
      status: o.status ?? "new", createdAt: old, updatedAt: old,
    }).returning();
    return { contact: c, lead: l };
  };

  try {
    const consented = await Promise.all(Array.from({ length: 30 }, (_, i) => person(i)));
    const noConsent = await person(100, { smsConsent: false });
    const stopped = await person(101, { doNotContact: true });
    await person(102, { status: "booked" });
    const recent = await person(103);
    await db.update(leads).set({ updatedAt: new Date() }).where(eq(leads.id, recent.lead.id));

    console.log("\nLaunch");
    const r = await launchReactivation(tenant.id, { campaign: "test-campaign", limit: 40 });
    const assigned = await db.query.outreachAssignments.findMany({ where: eq(outreachAssignments.campaign, "test-campaign") });
    const chosenIds = new Set(assigned.map((a) => a.contactId));
    check("everyone with consent and a dormant lead is in the experiment", r.selected === 30 && assigned.length === 30, JSON.stringify({ selected: r.selected, assigned: assigned.length }));
    check("no consent → not chosen", !chosenIds.has(noConsent.contact.id));
    check("do-not-contact → not chosen", !chosenIds.has(stopped.contact.id));
    check("a booked lead or a recent one is not dormant → not chosen", assigned.length === 30);
    check("a random slice is held back, before anything is sent", r.holdout >= 1 && r.holdout <= 12 && r.treatment + r.holdout === 30, `${r.treatment} treatment / ${r.holdout} holdout`);
    const queued = await db.query.jobs.findMany({ where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "campaign_message")) });
    check("one message queued per treatment person, none for the holdout", queued.length === r.treatment);
    const hours = queued.map((j) => Number(formatInTimeZone(j.runAt, TZ, "H")));
    check("every send is inside 10am–7pm local", hours.every((h) => h >= 10 && h < 19), [...new Set(hours)].join(","));
    const spread = Math.max(...queued.map((j) => j.runAt.getTime())) - Math.min(...queued.map((j) => j.runAt.getTime()));
    check("staggered, not a burst", spread >= (r.treatment - 1) * 40_000, `${Math.round(spread / 60_000)} min across ${r.treatment}`);
    const again = await launchReactivation(tenant.id, { campaign: "test-campaign", limit: 40 });
    check("launching the same campaign twice adds nobody twice", again.treatment === 0 && again.alreadyInCampaign === 30);

    console.log("\nSending");
    const job = queued[0];
    const target = await db.query.contacts.findFirst({ where: eq(contacts.id, String(job.payload.contactId)) });
    // A clock inside the window, so these paths run whatever the real time is.
    const twoPm = new Date(`${formatInTimeZone(new Date(), TZ, "yyyy-MM-dd")}T18:00:00Z`);
    const forceHours = (p: Record<string, unknown>) => sendCampaignMessage(p, tenant.id, twoPm);
    const inWindow = true;
    const res = await forceHours(job.payload);
    const night = await sendCampaignMessage(queued[3].payload, tenant.id, new Date(`${formatInTimeZone(new Date(), TZ, "yyyy-MM-dd")}T02:00:00Z`));
    check("at 10pm it waits for the next window instead of sending", typeof (night as { deferredTo?: string }).deferredTo === "string", JSON.stringify(night));
    if (inWindow) {
      const m = await db.query.messages.findFirst({ where: and(eq(messages.tenantId, tenant.id), eq(messages.direction, "outbound")) });
      check("sends with consent (fails only at the SMS provider here)", m?.status === "failed" && m.error === "Twilio not configured", `${m?.status} ${m?.error}`);
      check("tagged with its campaign", m?.meta?.campaign === "test-campaign");
    } else {
      check("outside 10am–7pm it waits for the next window", typeof (res as { deferredTo?: string }).deferredTo === "string", JSON.stringify(res));
    }
    // STOP between launch and send wins.
    const job2 = queued[1];
    const t2 = await db.query.contacts.findFirst({ where: eq(contacts.id, String(job2.payload.contactId)) });
    await handleInbound({ tenantId: tenant.id, channel: "sms", externalId: "SM-c-stop", externalThreadId: null,
      from: { channel: "sms", externalId: t2!.primaryPhone! }, body: "STOP" });
    await forceHours(job2.payload);
    if (inWindow) {
      const convo = await db.query.conversations.findFirst({ where: and(eq(conversations.contactId, t2!.id), eq(conversations.channel, "sms")) });
      const held = convo ? await db.query.messages.findFirst({ where: and(eq(messages.conversationId, convo.id), eq(messages.status, "held_for_review")) }) : null;
      check("a STOP that arrives after launch blocks the send", held?.meta?.holdReason === "contact is on do-not-contact", String(held?.meta?.holdReason));
    }
    const job3 = queued[2];
    await db.update(leads).set({ status: "booked" }).where(eq(leads.id, String(job3.payload.leadId)));
    const r3 = await forceHours(job3.payload);
    check("someone who booked since launch is not messaged", inWindow ? (r3 as { skipped?: string }).skipped === "booked since launch" : true, JSON.stringify(r3));
    void target;
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
