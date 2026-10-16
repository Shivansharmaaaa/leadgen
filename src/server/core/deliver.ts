import { eq } from "drizzle-orm";
import { db, messages as messagesTable, conversations } from "@/server/db";
import type { Channel } from "./types";
import { getAdapter } from "@/server/channels/registry";

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
  /**
   * Information about something the person already arranged (a booking
   * reminder), as opposed to marketing. Needs no marketing consent, but still
   * never goes to someone on do-not-contact.
   */
  transactional?: boolean;
  /** Stored on the message row, e.g. which appointment a reminder was for. */
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  const adapter = getAdapter(args.channel);
  const rowMeta = args.meta ?? {};

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
      meta: rowMeta,
    });
    return false;
  }

  const outbound = {
    tenantId: args.tenantId,
    conversationId: args.conversationId,
    channel: args.channel,
    to: args.to,
    body: truncate(args.body, adapter.maxLength),
    meta: { initiated: args.initiated === true, transactional: args.transactional === true },
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
        meta: { ...rowMeta, holdReason: gate.reason },
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
    meta: rowMeta,
  });

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(conversations.id, args.conversationId));

  return result.status === "sent";
}

function truncate(body: string, max?: number): string {
  if (!max || body.length <= max) return body;
  return body.slice(0, max - 1).trimEnd() + "…";
}
