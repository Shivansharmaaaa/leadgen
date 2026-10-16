import twilio from "twilio";
import { eq, and } from "drizzle-orm";
import { db, channelAccounts, contacts, tenants } from "@/server/db";
import type { ChannelAdapter, OutboundMessage, SendResult } from "@/server/core/types";
import { canInitiateOutbound } from "@/server/core/guardrails";

let cached: ReturnType<typeof twilio> | null = null;

export function twilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  cached ??= twilio(sid, token);
  return cached;
}

export const twilioConfigured = () =>
  Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

/**
 * SMS egress.
 *
 * `canSend` enforces consent and do-not-contact BEFORE the message leaves.
 * Under TCPA a single non-consented text carries $500-$1,500 in statutory
 * damages, so this check is not advisory — it is the reason the product is
 * sellable in the US at all.
 */
export const smsAdapter: ChannelAdapter = {
  channel: "sms",
  maxLength: 1500,

  async canSend(msg: OutboundMessage) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, msg.tenantId), eq(contacts.primaryPhone, msg.to.externalId)),
    });
    const initiated = msg.meta?.initiated === true;
    // Starting contact with someone we hold no record of means no consent on file.
    if (!contact) return initiated ? { ok: false, reason: "no contact record, so no SMS consent on file" } : { ok: true };

    // A reply inside an open conversation is a service message and is exempt;
    // this gate exists for business-initiated sends.
    if (!initiated) return { ok: true };

    // A reminder about a booking they made needs only the number they gave,
    // but never overrides a STOP.
    if (msg.meta?.transactional === true) {
      return contact.doNotContact ? { ok: false, reason: "contact is on do-not-contact" } : { ok: true };
    }

    return canInitiateOutbound("sms", contact);
  },

  async send(msg: OutboundMessage): Promise<SendResult> {
    const client = twilioClient();
    if (!client) return { status: "failed", error: "Twilio not configured" };

    const from = await resolveFromNumber(msg.tenantId);
    if (!from) return { status: "failed", error: "no Twilio number for this tenant" };

    try {
      const sent = await client.messages.create({
        to: msg.to.externalId, from, body: msg.body,
      });
      return { status: "sent", externalId: sent.sid };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : "twilio send failed" };
    }
  },
};

/** Voice replies are spoken by TwiML in the webhook, so egress is a no-op. */
export const voiceAdapter: ChannelAdapter = {
  channel: "voice",
  async send(): Promise<SendResult> {
    return { status: "sent", externalId: null };
  },
};

export async function resolveFromNumber(tenantId: string): Promise<string | null> {
  const account = await db.query.channelAccounts.findFirst({
    where: and(
      eq(channelAccounts.tenantId, tenantId),
      eq(channelAccounts.channel, "sms"),
    ),
  });
  return account?.externalAccountId ?? process.env.TWILIO_PHONE_NUMBER ?? null;
}

export async function tenantForNumber(e164: string) {
  const account = await db.query.channelAccounts.findFirst({
    where: eq(channelAccounts.externalAccountId, e164),
  });
  if (account) {
    return db.query.tenants.findFirst({ where: eq(tenants.id, account.tenantId) });
  }
  // Single-tenant dev fallback.
  if (process.env.TWILIO_PHONE_NUMBER === e164 || !process.env.TWILIO_PHONE_NUMBER) {
    return db.query.tenants.findFirst({ where: eq(tenants.slug, process.env.DEFAULT_TENANT ?? "northside-hvac") });
  }
  return undefined;
}

/** Twilio signs every webhook. An unverified webhook is an open relay. */
export function verifyTwilioSignature(
  signature: string | null, url: string, params: Record<string, string>,
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  if (!signature) return false;
  if (process.env.TWILIO_SKIP_VERIFY === "1") return true; // local tunnels rewrite the URL
  return twilio.validateRequest(token, signature, url, params);
}
