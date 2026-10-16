import { and, desc, eq, gte } from "drizzle-orm";
import { subHours } from "date-fns";
import {
  db, messages as messagesTable, conversations, events, contacts, tenants,
} from "@/server/db";
import type { InboundMessage, Channel } from "./types";
import { resolveContact, linkIdentifierToContact } from "./identity";
import { extractIdentifiers } from "./extract";
import { detectConsentKeyword, optInConfirmation, optOutConfirmation } from "./opt-out";
import { handleReminderReply } from "@/server/features/reminders";
import { extractMemories } from "@/server/memory/extract";
import { runAgentTurn, type AgentOutcome } from "@/server/agent/runtime";
import { deliver } from "./deliver";

// deliver() lives in its own module so features that send (reminders,
// alerts) never import the agent runtime: tools.ts -> reminders -> ingest ->
// runtime -> tools was a cycle that crashed the voice stream on load.
export { deliver };

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
  const consentKeyword = detectConsentKeyword(msg.body, msg.channel);
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
    const confirmation = optingOut
      ? optOutConfirmation(businessName, msg.channel)
      : optInConfirmation(businessName);
    // One confirmation is allowed, and expected, after a revocation.
    const sent = await deliver({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      channel: msg.channel,
      to: msg.from,
      body: confirmation,
    });
    // Voice speaks outcome.reply, so the confirmation goes there too.
    const outcome: AgentOutcome = {
      reply: confirmation, escalated: false, toolCalls: [], costUsd: 0, latencyMs: 0,
      provider: "rule", model: "opt-out", productionGrade: true,
    };
    return { conversationId: conversation.id, contactId: contact.id, messageId: stored.id, duplicate: false, outcome, sent };
  }

  // 4d. An answer to a reminder ("C", "R"), only when the last thing we sent
  //     in this thread was that reminder. Bookkeeping, so it applies even
  //     when a person has taken the thread over.
  const reminderReply = await handleReminderReply({
    tenantId: msg.tenantId, conversationId: conversation.id, body: msg.body,
  });
  if (reminderReply) {
    const sent = await deliver({
      tenantId: msg.tenantId,
      conversationId: conversation.id,
      channel: msg.channel,
      to: msg.from,
      body: reminderReply.reply,
      meta: { reminderAnswer: reminderReply.action, appointmentId: reminderReply.appointmentId },
    });
    const outcome: AgentOutcome = {
      reply: reminderReply.reply, escalated: reminderReply.action === "reschedule", toolCalls: [],
      costUsd: 0, latencyMs: 0, provider: "rule", model: "reminder-reply", productionGrade: true,
    };
    return { conversationId: conversation.id, contactId: contact.id, messageId: stored.id, duplicate: false, outcome, sent };
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
