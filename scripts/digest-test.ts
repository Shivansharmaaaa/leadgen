import net from "node:net";
import type { AddressInfo } from "node:net";
import { and, eq, like } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db, tenants, locations, staff, contacts, conversations, messages, leads, appointments, events, jobs } from "@/server/db";
import { buildDigest, sendDigest } from "@/server/features/digest";
import { ensureRecurringJobs, nextLocal } from "@/server/jobs/schedule";

/**
 * The morning summary and the recurring-job scheduler.
 *
 *   npm run digest:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function smtpServer() {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    sock.write("220 test\r\n");
    let buf = "", inData = false, data = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === ".") { inData = false; received.push(data); data = ""; sock.write("250 OK\r\n"); } else data += line + "\r\n"; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-test\r\n250 8BITMIME\r\n");
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, received, close: () => server.close() };
}

async function main() {
  console.log("\nWhen recurring jobs run");
  const TZ = "America/New_York";
  const fmt = (d: Date) => formatInTimeZone(d, TZ, "EEE HH:mm");
  check("at 7am, today's 8am", fmt(nextLocal(new Date("2026-10-19T11:00:00Z"), TZ, 8)) === "Mon 08:00");
  check("at 9am, tomorrow's 8am", fmt(nextLocal(new Date("2026-10-19T13:00:00Z"), TZ, 8)) === "Tue 08:00");
  check("across the clocks going back (Nov 1), still 8am local", fmt(nextLocal(new Date("2026-10-31T13:00:00Z"), TZ, 8)) === "Sun 08:00" &&
    formatInTimeZone(nextLocal(new Date("2026-10-31T13:00:00Z"), TZ, 8), "UTC", "HH:mm") === "13:00");

  const slug = "digest-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Digest Test HVAC", slug, country: "US", timezone: TZ, vertical: "home_services",
    settings: { businessName: "Digest Test HVAC" },
  }).returning();
  await db.insert(locations).values({ tenantId: tenant.id, name: "Main", country: "US", timezone: TZ, hours: [] });
  const smtp = await smtpServer();

  try {
    console.log("\nScheduling");
    const first = await ensureRecurringJobs();
    const mine = await db.query.jobs.findMany({ where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "daily_digest")) });
    check("a digest is scheduled for this business", mine.length === 1 && Number(formatInTimeZone(mine[0].runAt, TZ, "H")) === 8,
      mine[0] ? fmt(mine[0].runAt) : "none");
    const retrain = await db.query.jobs.findFirst({ where: and(eq(jobs.type, "train_models"), like(jobs.idempotencyKey, "train_models:home_services:US:%")) });
    check("and a nightly retrain for its vertical", Boolean(retrain) && formatInTimeZone(retrain!.runAt, "UTC", "HH:mm") === "03:00");
    const again = await ensureRecurringJobs();
    check("calling it again (another worker, five minutes later) adds nothing", again === 0, `first ${first}, again ${again}`);

    console.log("\nNoticing that the worker isn't running");
    const { overdueJobs } = await import("@/server/queries/health");
    const { GET: health } = await import("@/app/api/health/route");
    const before = (await overdueJobs(tenant.id)).count;
    await db.insert(jobs).values({ tenantId: tenant.id, type: "appointment_reminder", payload: {}, runAt: new Date(Date.now() - 30 * 60_000) });
    await db.insert(jobs).values({ tenantId: tenant.id, type: "appointment_reminder", payload: {}, runAt: new Date(Date.now() + 30 * 60_000) });
    const od = await overdueJobs(tenant.id);
    check("a job due 30 minutes ago and still pending is overdue; a future one isn't", od.count === before + 1 && (od.oldestMinutes ?? 0) >= 29, JSON.stringify(od));
    const h = await health();
    check("/api/health says the worker is behind (503)", h.status === 503 && (await h.json()).worker === "behind");
    await db.delete(jobs).where(and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "appointment_reminder")));

    console.log("\nThe digest");
    const [c] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: "Mia", primaryPhone: "+16175550501" }).returning();
    const [cv] = await db.insert(conversations).values({ tenantId: tenant.id, contactId: c.id, channel: "sms" }).returning();
    await db.insert(messages).values([
      { tenantId: tenant.id, conversationId: cv.id, direction: "inbound", channel: "sms", authorType: "contact", body: "When can someone come out?", status: "received", createdAt: new Date(Date.now() - 3 * 3600_000) },
      { tenantId: tenant.id, conversationId: cv.id, direction: "outbound", channel: "sms", authorType: "ai", body: "What's the problem?", status: "sent", createdAt: new Date(Date.now() - 3 * 3600_000 + 4000) },
    ]);
    await db.insert(leads).values({ tenantId: tenant.id, contactId: c.id, conversationId: cv.id, sourceChannel: "sms" });
    // Someone else's job from yesterday, still open.
    const [booker] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: "Raj", primaryPhone: "+16175550502" }).returning();
    await db.insert(appointments).values({ tenantId: tenant.id, contactId: booker.id, service: "AC", startsAt: new Date(Date.now() - 20 * 3600_000), endsAt: new Date(Date.now() - 19 * 3600_000) });
    await db.insert(events).values({ tenantId: tenant.id, type: "opt_out", contactId: c.id, payload: {} });
    const d = await buildDigest(tenant.id);
    check("counts the day", d?.numbers.conversations === 1 && d.numbers.leads === 1 && d.numbers.optOuts === 1, JSON.stringify(d?.numbers));
    check("names who needs the owner, and why", Boolean(d?.text.includes("Mia (sms): Asked \"When can someone come out?\" and was never offered a time.")), d?.text);
    check("asks for yesterday's job to be closed", Boolean(d?.text.includes("1 past job to mark done or no-show")));
    check("the subject says how much needs them", Boolean(d?.subject.includes("2 need you")), d?.subject);

    console.log("\nSending it");
    delete process.env.SMTP_HOST;
    check("no team email → nothing sent, and says why", (await sendDigest(tenant.id)).skipped === "nobody on the team has an email");
    await db.insert(staff).values([
      { tenantId: tenant.id, email: "owner@digest.example", name: "Owner", role: "owner" },
      { tenantId: tenant.id, email: "muted@digest.example", name: "Muted", role: "tech", alerts: false },
    ]);
    check("no SMTP → nothing sent, and says why", (await sendDigest(tenant.id)).skipped === "email not configured");
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.EMAIL_FROM = "digest@app.example";
    delete process.env.SMTP_USER;
    const r = await sendDigest(tenant.id);
    check("sent to the team member with alerts on, not the muted one", r.sent === 1 && smtp.received.length === 1 &&
      smtp.received[0].includes("owner@digest.example") && !smtp.received[0].includes("muted@digest.example"));
  } finally {
    smtp.close();
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
    await db.delete(jobs).where(like(jobs.idempotencyKey, "train_models:%"));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
