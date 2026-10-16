import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { db, tenants, locations, jobs } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { intakeLead } from "@/server/features/lead-intake";
import {
  assertPublicHttps, deliverWebhook, isPrivateAddress, postJson, publish, sign, verify,
} from "@/server/features/webhooks";

/**
 * Outbound webhooks: signing, the private-network guard, subscriptions,
 * delivery to a real HTTP server, retries, and the events that publish.
 *
 *   npm run webhooks:test
 */
process.env.LLM_PROVIDER = "scripted";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function rejects(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

async function main() {
  console.log("\nSigning");
  const body = JSON.stringify({ type: "lead.created", data: { a: 1 } });
  const header = sign("s3cret", body);
  check("a receiver verifies a genuine request", verify("s3cret", body, header));
  check("a changed body fails", !verify("s3cret", body.replace("1", "2"), header));
  check("the wrong secret fails", !verify("other", body, header));
  check("a replayed request ten minutes later fails", !verify("s3cret", body, header, 300, Date.now() + 600_000));
  check("no header fails", !verify("s3cret", body, null));

  console.log("\nOnly public https");
  check("10.x is private", isPrivateAddress("10.1.2.3"));
  check("cloud metadata 169.254.169.254 is private", isPrivateAddress("169.254.169.254"));
  check("172.20.x is private, 172.32.x is not", isPrivateAddress("172.20.0.1") && !isPrivateAddress("172.32.0.1"));
  check("IPv6 loopback and mapped IPv4 are private", isPrivateAddress("::1") && isPrivateAddress("::ffff:127.0.0.1"));
  check("8.8.8.8 is public", !isPrivateAddress("8.8.8.8"));
  delete process.env.WEBHOOKS_ALLOW_PRIVATE;
  check("http is refused", (await rejects(assertPublicHttps("http://example.com/hook")))?.includes("https") === true);
  check("https to localhost is refused", Boolean(await rejects(assertPublicHttps("https://localhost/hook"))));
  check("https to an IP in 10/8 is refused", Boolean(await rejects(assertPublicHttps("https://10.0.0.5/hook"))));
  check("https to [::1] is refused", Boolean(await rejects(assertPublicHttps("https://[::1]/hook"))));
  const pub = await rejects(assertPublicHttps("https://hooks.zapier.com/hooks/catch/1/abc"));
  check("https to a public host is allowed", pub === null, pub ?? "");

  // A real receiver on this machine; only reachable with the test override.
  const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: data });
      if (status === 302) res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      else res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  const slug = "webhooks-test";
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({
    name: "Webhook Test HVAC", slug, country: "US", timezone: "America/New_York",
    settings: {
      businessName: "Webhook Test HVAC",
      webhooks: [
        { url, secret: "whsec_test" },
        { url: "https://crm.example.com/leads", secret: "other", events: ["lead.created"] },
      ],
    },
  }).returning();
  await db.insert(locations).values({ tenantId: tenant.id, name: "Main", country: "US", timezone: "America/New_York", hours: [] });
  const queued = (type?: string) => db.query.jobs.findMany({
    where: and(eq(jobs.tenantId, tenant.id), eq(jobs.type, "webhook_delivery")),
  }).then((rows) => rows.filter((j) => !type || (j.payload.event as { type: string }).type === type));

  try {
    console.log("\nSubscriptions");
    check("an opt-out goes only to the endpoint that wants everything", (await publish(tenant.id, "contact.opted_out", {})) === 1);
    check("a new lead goes to both", (await publish(tenant.id, "lead.created", {})) === 2);
    await db.delete(jobs).where(eq(jobs.tenantId, tenant.id));

    console.log("\nEvents publish where they happen");
    await intakeLead(tenant.id, { source: "website", externalId: "w-1", name: "Priya Patel", phone: "6175550142", message: "AC is warm" });
    const leadJobs = await queued("lead.created");
    const ev = leadJobs[0]?.payload.event as { data: { contact: { name: string; phone: string }; source: string } } | undefined;
    check("a form lead publishes lead.created to both endpoints", leadJobs.length === 2, String(leadJobs.length));
    check("with who it is and where it came from", ev?.data.contact.name === "Priya Patel" && ev.data.contact.phone === "+16175550142" && ev.data.source === "website");
    await intakeLead(tenant.id, { source: "website", externalId: "w-1", phone: "6175550142" });
    check("a redelivered form does not publish twice", (await queued("lead.created")).length === 2);
    await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-w1", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550142" }, body: "STOP",
    });
    check("STOP tells the CRM too", (await queued("contact.opted_out")).length === 1);
    await handleInbound({
      tenantId: tenant.id, channel: "sms", externalId: "SM-w2", externalThreadId: null,
      from: { channel: "sms", externalId: "+16175550199" }, body: "I want a refund",
    });
    check("a handover publishes conversation.escalated", (await queued("conversation.escalated")).length === 1);

    console.log("\nDelivery");
    process.env.WEBHOOKS_ALLOW_PRIVATE = "1";
    const [job] = (await queued("lead.created")).filter((j) => j.payload.url === url);
    const out = await deliverWebhook(job.payload, tenant.id);
    const got = received[received.length - 1];
    check("delivered to the receiver", (out as { delivered?: boolean }).delivered === true && Boolean(got));
    check("the receiver can verify the signature", verify("whsec_test", got.body, String(got.headers["x-leadgen-signature"])));
    check("event type in a header", got.headers["x-leadgen-event"] === "lead.created");
    status = 500;
    check("a 500 throws, so the worker retries with backoff", (await rejects(deliverWebhook(job.payload, tenant.id)))?.includes("500") === true);
    status = 302;
    check("a redirect is not followed (could point inside)", (await rejects(deliverWebhook(job.payload, tenant.id)))?.includes("302") === true);
    status = 200;
    delete process.env.WEBHOOKS_ALLOW_PRIVATE;
    check("without the test override, the local receiver is refused", Boolean(await rejects(deliverWebhook(job.payload, tenant.id))));
    // Skip the up-front check entirely: the connection's own lookup must refuse
    // a name that resolves to loopback (what DNS rebinding would exploit).
    const rebind = await rejects(postJson(`http://localhost:${new URL(url).port}/hook`, "{}", {}));
    check("the connect-time guard alone refuses a name resolving to loopback", rebind?.includes("private") === true, rebind ?? "connected!");
    await db.update(tenants).set({ settings: { businessName: "Webhook Test HVAC", webhooks: [] } }).where(eq(tenants.id, tenant.id));
    const gone = await deliverWebhook(job.payload, tenant.id);
    check("an endpoint removed since queueing is skipped", (gone as { skipped?: string }).skipped === "endpoint no longer configured");
  } finally {
    server.close();
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
