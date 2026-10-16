import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, channelAccounts, events, tenants } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";
import { header, isAutomated, parseAddress, parseAddressList, stripQuoted } from "@/server/channels/email-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inbound email from a provider's inbound-parse webhook (SendGrid Inbound
 * Parse posts multipart form fields; anything else can post JSON with the
 * same names: from, to, subject, text, headers).
 *
 *   POST /api/webhooks/email?token=<EMAIL_INBOUND_TOKEN>
 *
 * Inbound-parse webhooks are not signed, so the URL carries a secret. The
 * tenant is whoever owns the address it was sent to. Always 200 once
 * authenticated: providers retry anything else, and a retry storm of the
 * same email is worse than one dropped one (which is logged).
 */
export async function POST(req: Request) {
  const expected = process.env.EMAIL_INBOUND_TOKEN;
  const given = new URL(req.url).searchParams.get("token") ?? "";
  if (!expected) return new Response("inbound email is not configured", { status: 503 });
  if (!(given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected)))) {
    return new Response("unauthorised", { status: 401 });
  }

  const fields = await readFields(req);
  if (!fields) return new Response("unreadable body", { status: 400 });

  const from = parseAddress(fields.from);
  if (!from) return ok("no sender");
  const recipients = [...parseAddressList(fields.to), ...parseAddressList(fields.cc)];
  const account = recipients.length
    ? (await Promise.all(recipients.map((a) => db.query.channelAccounts.findFirst({
        where: and(eq(channelAccounts.channel, "email"), eq(channelAccounts.externalAccountId, a)),
      })))).find(Boolean)
    : undefined;
  const tenant = account
    ? await db.query.tenants.findFirst({ where: eq(tenants.id, account.tenantId) })
    : undefined;
  if (!tenant) return ok(`no tenant for ${recipients.join(", ") || "(no recipients)"}`);

  const messageId = header(fields.headers, "Message-ID") ?? fields.messageId ?? null;
  const automated = isAutomated(from.address, fields.headers);
  if (automated) {
    await db.insert(events).values({
      tenantId: tenant.id, type: "email_ignored",
      payload: { from: from.address, subject: fields.subject ?? null, reason: automated },
    });
    return ok(`automated (${automated}), not answered`);
  }

  const body = stripQuoted(fields.text ?? "") || (fields.subject ?? "").trim();
  if (!body) return ok("empty");

  await handleInbound({
    tenantId: tenant.id,
    channel: "email",
    externalId: messageId,
    externalThreadId: null,
    from: { channel: "email", externalId: from.address, name: from.name, email: from.address },
    body,
    meta: { subject: fields.subject ?? null, emailMessageId: messageId },
  });
  return ok("handled");
}

type Fields = { from?: string; to?: string; cc?: string; subject?: string; text?: string; headers?: string; messageId?: string };

async function readFields(req: Request): Promise<Fields | null> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) return (await req.json()) as Fields;
    const form = await req.formData();
    const get = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };
    return { from: get("from"), to: get("to"), cc: get("cc"), subject: get("subject"), text: get("text"), headers: get("headers") };
  } catch {
    return null;
  }
}

function ok(note: string) {
  return Response.json({ ok: true, note });
}
