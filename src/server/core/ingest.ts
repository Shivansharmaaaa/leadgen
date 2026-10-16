import { and, desc, eq, gte } from "drizzle-orm";
import { subHours } from "date-fns";
import {
  db, messages as messagesTable, conversations, events, contacts, tenants,
} from "@/server/db";
import type { InboundMessage, Channel } from "./types";
import { resolveContact, linkIdentifierToContact } from "./identity";
import { extractIdentifiers } from "./extract";
import { detectConsentKeyword, optInConfirmation, optOutConfirmation } from "./opt-out";
import { extractMemories } from "@/server/memory/extract";
import { runAgentTurn, type AgentOutcome } from "@/server/agent/runtime";
import { getAdapter } from "@/server/channels/registry";

/** How long an idle thread stays "the same conversation" before a new one starts. */
const THREAD_WINDOW_HOURS = 24;

export type IngestResult = {
  conversationId: string;
  contactId: string;
  messageId: string;
  duplicate: boolean;
  outcome?: AgentOutcome;
  sent?: boolean;
};

/**
 * The single entry point for every inbound message, from every channel.
 *
 *   normalise → resolve identity → thread → persist → agent → guardrail → send
 *
 * Adapters do nothing but produce an InboundMessage. Everything below is shared,
 * which is what makes this one product rather than six bots behind one login.
 */
export async function handleInbound(msg: InboundMessage): Promise<IngestResult> {
  const receivedAt = msg.receivedAt ?? new Date();

  // 1. Idempotency. Meta and Twilio both redeliver; double-replying is a visible bug.
  if (msg.externalId) {
    const existing = await db.query.messages.findFirst({
      where: and(
        eq(messagesTable.tenantId, msg.tenantId),
        eq(messagesTable.channel, msg.channel),
        eq(messagesTable.externalId, msg.externalId),
      ),
    });
    if (existing) {
      return {
        conversationId: existing.conversationId,
        contactId: msg.from.externalId,
        messageId: existing.id,
        duplicate: true,
      };
    }
  }

  // 2. Who is this, across every channel they have ever used?
  const contact = await resolveContact(msg.tenantId, msg.from);

  // 2b. Harvest any phone/email stated in the message body itself. This is what
  //     actually links an Instagram DM to the phone call that follows, and it
  //     must not depend on the model choosing to call a tool.
  const tenantRow = await db.query.tenants.findFirst({ where: eq(tenants.id, msg.tenantId) });
  const found = extractIdentifiers(msg.body, tenantRow?.country ?? "US");
  for (const phone of found.phones) {
    await linkIdentifierToContact(msg.tenantId, contact.id, "phone", phone);
  }
  for (const email of found.emails) {
    await linkIdentifierToContact(msg.tenantId, contact.id, "email", email);
  }

  // 3. Which thread does it belong to?
  const conversation = await findOrCreateConversation({
    tenantId: msg.tenantId,
    contactId: contact.id,
    channel: msg.channel,
    externalThreadId: msg.externalThreadId,
    receivedAt,
  });

  // 4. Persist canonically.
  const [stored] = await db
    .insert(messagesTable)
    .values({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      direction: "inbound",
      channel: msg.channel,
      authorType: "contact",
      body: msg.body,
      media: msg.media ?? [],
      externalId: msg.externalId,
      status: "received",
      meta: msg.meta ?? {},
      createdAt: receivedAt,
    })
    .returning();

  await db
    .update(conversations)
    .set({
      lastMessageAt: receivedAt,
      // Meta's 24h service window restarts on every inbound customer message.
      windowExpiresAt: subHours(receivedAt, -THREAD_WINDOW_HOURS),
    })
    .where(eq(conversations.id, conversation.id));

  await db.insert(events).values({
    tenantId: msg.tenantId,
    type: "message_received",
    conversationId: conversation.id,
    contactId: contact.id,
    payload: { channel: msg.channel, length: msg.body.length },
  });

  // 4b. Harvest durable facts deterministically, before the agent runs, so the
  //     model sees them this turn rather than next.
  await extractMemories({
    tenantId: msg.tenantId,
    contactId: contact.id,
    text: msg.body,
    conversationId: conversation.id,
    messageId: stored.id,
  });

  // 4c. STOP / START. Honoured before anything else can answer, and the
  //     agent never sees the message: a chatty reply to "STOP" is exactly
  //     what a TCPA plaintiff screenshots.
  const consentKeyword = detectConsentKeyword(msg.body);
  if (consentKeyword) {
    const optingOut = consentKeyword.kind === "opt_out";
    await db.update(contacts).set({ doNotContact: optingOut }).where(eq(contacts.id, contact.id));
    await db.insert(events).values({
      tenantId: msg.tenantId,
      type: optingOut ? "opt_out" : "opt_in",
      conversationId: conversation.id,
      contactId: contact.id,
      payload: { keyword: consentKeyword.keyword, channel: msg.channel, messageId: stored.id },
    });
    const businessName = tenantRow?.settings?.businessName ?? tenantRow?.name ?? "us";
    // One confirmation is allowed, and expected, after a revocation.
    const sent = await deliver({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      channel: msg.channel,
      to: msg.from,
      body: optingOut ? optOutConfirmation(businessName) : optInConfirmation(businessName),
    });
    return { conversationId: conversation.id, contactId: contact.id, messageId: stored.id, duplicate: false, sent };
  }

  // 5. A human has taken this thread — stay out of it.
  if (conversation.aiPaused) {
    return {
      conversationId: conversation.id,
      contactId: contact.id,
      messageId: stored.id,
      duplicate: false,
    };
  }

  // 6. Agent turn.
  const outcome = await runAgentTurn({
    conversationId: conversation.id,
    inboundMessageId: stored.id,
  });

  // 7. Egress — unless a guardrail held it for review. A lead that arrived
  //    by form never messaged us on this channel, so the reply is the
  //    business starting the thread and must pass the consent gate.
  let sent = false;
  const firstTouch = msg.meta?.businessInitiated === true;
  if (outcome.reply && !outcome.holdReason) {
    sent = await deliver({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      channel: msg.channel,
      to: msg.from,
      // Someone we are texting first does not know this number: say who it
      // is and how to stop, in words the model cannot drop.
      body: firstTouch ? frameFirstTouch(outcome.reply, msg.meta!) : outcome.reply,
      initiated: firstTouch,
    });
  } else if (outcome.reply && outcome.holdReason) {
    // Draft is kept so a human can approve or edit it in the inbox.
    await db.insert(messagesTable).values({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      direction: "outbound",
      channel: msg.channel,
      authorType: "ai",
      body: outcome.reply,
      status: "held_for_review",
      meta: { holdReason: outcome.holdReason },
    });
    await db.insert(events).values({
      tenantId: msg.tenantId,
      type: "reply_held",
      conversationId: conversation.id,
      contactId: contact.id,
      payload: { reason: outcome.holdReason },
    });
  }

  return {
    conversationId: conversation.id,
    contactId: contact.id,
    messageId: stored.id,
    duplicate: false,
    outcome,
    sent,
  };
}

/** Send an outbound message through its channel adapter and record the result. */
export async function deliver(args: {
  tenantId: string;
  conversationId: string;
  channel: Channel;
  to: { channel: Channel; externalId: string; handle?: string | null };
  body: string;
  authorType?: "ai" | "human";
  authorStaffId?: string;
  /**
   * The business is starting this contact rather than replying to one. The
   * adapter's consent gate only applies to these; without the flag it never
   * ran, so every send was treated as a service reply.
   */
  initiated?: boolean;
}): Promise<boolean> {
  const adapter = getAdapter(args.channel);

  if (!adapter) {
    await db.insert(messagesTable).values({
      tenantId: args.tenantId,
      conversationId: args.conversationId,
      direction: "outbound",
      channel: args.channel,
      authorType: args.authorType ?? "ai",
      body: args.body,
      status: "failed",
      error: `no adapter registered for ${args.channel}`,
    });
    return false;
  }

  const outbound = {
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    channel: args.channel,
    to: args.to,
    body: truncate(args.body, adapter.maxLength),
    meta: { initiated: args.initiated === true },
  };

  if (adapter.canSend) {
    const gate = await adapter.canSend(outbound);
    if (!gate.ok) {
      await db.insert(messagesTable).values({
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        direction: "outbound",
        channel: args.channel,
        authorType: args.authorType ?? "ai",
        body: outbound.body,
        status: "held_for_review",
        meta: { holdReason: gate.reason },
      });
      return false;
    }
  }

  const result = await adapter.send(outbound);

  await db.insert(messagesTable).values({
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    direction: "outbound",
    channel: args.channel,
    authorType: args.authorType ?? "ai",
    authorStaffId: args.authorStaffId ?? null,
    body: outbound.body,
    externalId: result.externalId ?? null,
    status: result.status === "sent" ? "sent" : "failed",
    error: result.error ?? null,
  });

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(conversations.id, args.conversationId));

  return result.status === "sent";
}

async function findOrCreateConversation(args: {
  tenantId: string;
  contactId: string;
  channel: Channel;
  externalThreadId: string | null;
  receivedAt: Date;
}) {
  if (args.externalThreadId) {
    const byThread = await db.query.conversations.findFirst({
      where: and(
        eq(conversations.tenantId, args.tenantId),
        eq(conversations.channel, args.channel),
        eq(conversations.externalThreadId, args.externalThreadId),
      ),
    });
    if (byThread) return byThread;
  }

  const recent = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.tenantId, args.tenantId),
      eq(conversations.contactId, args.contactId),
      eq(conversations.channel, args.channel),
      eq(conversations.status, "open"),
      gte(conversations.lastMessageAt, subHours(args.receivedAt, THREAD_WINDOW_HOURS)),
    ),
    orderBy: desc(conversations.lastMessageAt),
  });
  if (recent) return recent;

  const [created] = await db
    .insert(conversations)
    .values({
      tenantId: args.tenantId,
      contactId: args.contactId,
      channel: args.channel,
      externalThreadId: args.externalThreadId,
      lastMessageAt: args.receivedAt,
    })
    .returning();
  return created;
}

function frameFirstTouch(reply: string, meta: Record<string, unknown>): string {
  const intro = typeof meta.intro === "string" ? meta.intro : "";
  const footer = typeof meta.footer === "string" ? meta.footer : "";
  return [intro, reply, footer].filter(Boolean).join(" ");
}

function truncate(body: string, max?: number): string {
  if (!max || body.length <= max) return body;
  return body.slice(0, max - 1).trimEnd() + "…";
}
