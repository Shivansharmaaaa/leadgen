import nodemailer, { type Transporter } from "nodemailer";
import { and, desc, eq } from "drizzle-orm";
import { db, channelAccounts, contacts, messages, tenants } from "@/server/db";
import type { ChannelAdapter, OutboundMessage, SendResult } from "@/server/core/types";
import { canInitiateOutbound } from "@/server/core/guardrails";

/**
 * Email egress over SMTP (any provider: SendGrid, Postmark, SES, Google).
 *
 * Replies thread under the person's own subject ("Re: ...") with In-Reply-To
 * and References set, so the conversation stays one thread in their inbox.
 * The consent rules match SMS: a reply to someone who wrote in is a service
 * message; a business-initiated email needs email consent, unless it is
 * transactional (an answer to their own enquiry, a booking reminder); and
 * do-not-contact always wins.
 */

let transport: Transporter | null = null;

export const emailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.EMAIL_FROM);

function smtp(): Transporter | null {
  if (!emailConfigured()) return null;
  if (!transport) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      // On 587, refuse to send credentials or mail over an unencrypted link.
      requireTLS: port === 587,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
    });
  }
  return transport;
}

/** For tests: point at a local SMTP server. */
export function resetEmailTransport() {
  transport = null;
}

export const emailAdapter: ChannelAdapter = {
  channel: "email",
  maxLength: 20_000,

  async canSend(msg: OutboundMessage) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, msg.tenantId), eq(contacts.primaryEmail, msg.to.externalId.toLowerCase())),
    });
    const initiated = msg.meta?.initiated === true;
    if (!contact) return initiated ? { ok: false, reason: "no contact record, so no email consent on file" } : { ok: true };
    if (contact.doNotContact) return { ok: false, reason: "contact is on do-not-contact" };
    if (!initiated || msg.meta?.transactional === true) return { ok: true };
    return canInitiateOutbound("email", contact);
  },

  async send(msg: OutboundMessage): Promise<SendResult> {
    const mailer = smtp();
    if (!mailer) return { status: "failed", error: "Email not configured (SMTP_HOST, EMAIL_FROM)" };

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, msg.tenantId) });
    const business = tenant?.settings?.businessName ?? tenant?.name ?? "";
    const from = await fromAddress(msg.tenantId);

    // Thread under what they wrote, if they wrote.
    const lastIn = await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, msg.conversationId), eq(messages.direction, "inbound")),
      orderBy: desc(messages.createdAt),
    });
    const theirSubject = typeof lastIn?.meta?.subject === "string" ? lastIn.meta.subject : null;
    const theirId = typeof lastIn?.meta?.emailMessageId === "string" ? lastIn.meta.emailMessageId : null;
    const subject = typeof msg.meta?.subject === "string"
      ? msg.meta.subject
      : theirSubject
        ? (/^re:/i.test(theirSubject) ? theirSubject : `Re: ${theirSubject}`)
        : `A message from ${business}`;

    try {
      const info = await mailer.sendMail({
        from: { name: business, address: from },
        to: msg.to.externalId,
        subject,
        text: msg.body,
        ...(theirId ? { inReplyTo: theirId, references: [theirId] } : {}),
        headers: { "Auto-Submitted": "auto-replied" },
      });
      return { status: "sent", externalId: info.messageId };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : "SMTP send failed" };
    }
  },
};

/** The tenant's own inbound address if connected, else the deployment's sender. */
async function fromAddress(tenantId: string): Promise<string> {
  const account = await db.query.channelAccounts.findFirst({
    where: and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.channel, "email")),
  });
  return account?.externalAccountId ?? process.env.EMAIL_FROM!;
}
