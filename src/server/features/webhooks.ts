import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { eq } from "drizzle-orm";
import { db, contacts, jobs, tenants } from "@/server/db";

/**
 * FEATURE 12 — push what happened into the client's own systems.
 *
 * An owner's day runs in their CRM or job software (ServiceTitan, Jobber,
 * Housecall Pro, a spreadsheet via Zapier). A lead or a booking that only
 * exists in this product's dashboard gets re-typed by hand or lost. So each
 * tenant can register URLs; every lead, booking, confirmation, reschedule,
 * handover and opt-out is POSTed there as signed JSON.
 *
 * Publishing only inserts a job: no network on the request path, and the
 * worker's retry with exponential backoff covers a CRM that is down. A
 * delivery that keeps failing ends as a dead job with its last error.
 *
 * Signed like Stripe's: `x-leadgen-signature: t=<unix>,v1=<hex>` where v1 is
 * HMAC-SHA256(secret, "<t>.<body>"). The receiver recomputes it and rejects
 * old timestamps, so a captured request cannot be replayed.
 *
 * These URLs are typed in by a tenant, and the server calls them: without a
 * guard that is a way to make this server request its own network (cloud
 * metadata, the database). Only https to public addresses is allowed.
 */

export const WEBHOOK_EVENTS = [
  "lead.created", "lead.qualified", "lead.won", "lead.lost", "appointment.booked", "appointment.confirmed",
  "appointment.reschedule_requested", "appointment.completed", "appointment.no_show", "appointment.cancelled",
  "conversation.escalated", "contact.opted_out", "contact.erased",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];


export function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** What a receiver runs. Exported so tests (and docs) use the real thing. */
export function verify(secret: string, body: string, header: string | null, toleranceSec = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, body, t).split("v1=")[1]);
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Who the event is about, in the shape every event uses. */
export async function contactData(contactId: string | null | undefined) {
  if (!contactId) return null;
  const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
  return c ? { id: c.id, name: c.displayName, phone: c.primaryPhone, email: c.primaryEmail } : null;
}

/**
 * Queue one delivery per subscribed endpoint. Never throws: a webhook
 * problem must not break the booking or the reply that triggered it.
 */
export async function publish(tenantId: string, type: WebhookEvent, data: Record<string, unknown>): Promise<number> {
  try {
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    const endpoints = tenant?.settings?.webhooks ?? [];
    const subscribed = endpoints.filter((e) => !e.events?.length || e.events.includes(type));
    if (!tenant || !subscribed.length) return 0;
    const event = { id: randomUUID(), type, created_at: new Date().toISOString(), tenant: tenant.slug, data };
    await db.insert(jobs).values(subscribed.map((e, i) => ({
      tenantId, type: "webhook_delivery", maxAttempts: 8,
      payload: { endpoint: i, url: e.url, event },
      idempotencyKey: `webhook:${event.id}:${i}`,
    })));
    return subscribed.length;
  } catch (err) {
    console.error("webhook publish failed", err);
    return 0;
  }
}

/** The job handler. Throws on failure so the worker retries with backoff. */
export async function deliverWebhook(payload: Record<string, unknown>, tenantId: string | null) {
  if (!tenantId) return { skipped: "no tenant" };
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  // Look the endpoint up again: a URL removed or a secret rotated since the
  // event was queued must win.
  const endpoint = (tenant?.settings?.webhooks ?? []).find((e) => e.url === payload.url);
  if (!endpoint) return { skipped: "endpoint no longer configured" };

  await assertPublicHttps(endpoint.url);
  const body = JSON.stringify(payload.event);
  const status = await postJson(endpoint.url, body, {
    "user-agent": "leadgen-webhooks/1",
    "x-leadgen-event": String((payload.event as { type?: string })?.type ?? ""),
    "x-leadgen-signature": sign(endpoint.secret, body),
  });
  if (status < 200 || status >= 300) {
    throw new Error(`webhook ${endpoint.url} answered ${status}`);
  }
  return { delivered: true, status };
}

/**
 * POST without following redirects, checking every address at connect time.
 *
 * assertPublicHttps checks the name when it is saved and before sending,
 * but fetch then resolves it again on its own: a name that answers "public"
 * to the check and 10.0.0.5 a moment later (DNS rebinding) would get
 * through. Here the connection's own lookup refuses a private address, so
 * what is checked is what is connected to.
 */
export function postJson(url: string, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<number> {
  const allowPrivate = process.env.WEBHOOKS_ALLOW_PRIVATE === "1";
  const u = new URL(url);
  const lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad && !allowPrivate) return callback(new Error(`webhook host ${hostname} resolved to private ${bad.address}`), "", 0);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
  const transport = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = transport(u, {
      method: "POST", lookup, timeout: timeoutMs,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      res.resume(); // drain; only the status matters, and redirects are never followed
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error(`webhook ${url} timed out`)));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Refuse anything but https to a public address. Checks the resolved IPs,
 * not just the hostname, so a public name pointing at 10.0.0.5 is refused.
 * WEBHOOKS_ALLOW_PRIVATE=1 lifts it for local tests only.
 */
export async function assertPublicHttps(raw: string): Promise<void> {
  const allowPrivate = process.env.WEBHOOKS_ALLOW_PRIVATE === "1";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`webhook url is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new Error("webhook url must use https");
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`webhook host ${host} is not a public address`);
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}
