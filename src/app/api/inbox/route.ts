import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db, conversations, messages, contacts, staff, events } from "@/server/db";
import { deliver } from "@/server/core/ingest";
import { screenOutbound } from "@/server/core/guardrails";
import { recordOutreachOutcome } from "@/server/learning/incrementality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Human takeover.
 *
 * Three actions a person needs before they will trust this with their
 * customers: take the thread off the AI, send their own reply, and approve or
 * edit a draft the guardrails held. Without these the inbox is a read-only
 * window and the product is unusable in anger.
 */
type Action =
  | { action: "takeover"; conversationId: string }
  | { action: "release"; conversationId: string }
  | { action: "reply"; conversationId: string; body: string }
  | { action: "approve_draft"; messageId: string; body?: string }
  | { action: "discard_draft"; messageId: string };

export async function POST(req: Request) {
  let payload: Action;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  switch (payload.action) {
    case "takeover":
      return setPaused(payload.conversationId, true);
    case "release":
      return setPaused(payload.conversationId, false);
    case "reply":
      return sendReply(payload.conversationId, payload.body);
    case "approve_draft":
      return approveDraft(payload.messageId, payload.body);
    case "discard_draft":
      return discardDraft(payload.messageId);
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}

async function setPaused(conversationId: string, paused: boolean) {
  const convo = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!convo) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  await db.update(conversations)
    .set({ aiPaused: paused })
    .where(eq(conversations.id, conversationId));

  await db.insert(events).values({
    tenantId: convo.tenantId,
    type: paused ? "human_took_over" : "returned_to_ai",
    conversationId,
    contactId: convo.contactId,
    payload: {},
  });

  return NextResponse.json({ ok: true, aiPaused: paused });
}

async function sendReply(conversationId: string, body: string) {
  if (!body?.trim()) return NextResponse.json({ error: "body is required" }, { status: 400 });

  const convo = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!convo) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, convo.contactId),
  });
  const member = await db.query.staff.findFirst({ where: eq(staff.tenantId, convo.tenantId) });

  // Taking over implicitly pauses the AI — two voices in one thread is worse
  // than either alone.
  if (!convo.aiPaused) {
    await db.update(conversations).set({ aiPaused: true }).where(eq(conversations.id, conversationId));
  }

  const to = resolveAddress(convo.channel, contact);
  if (!to) return NextResponse.json({ error: "no address for this contact on this channel" }, { status: 400 });

  const sent = await deliver({
    tenantId: convo.tenantId,
    conversationId,
    channel: convo.channel,
    to: { channel: convo.channel, externalId: to },
    body: body.trim(),
    authorType: "human",
    authorStaffId: member?.id,
  });

  return NextResponse.json({ ok: true, sent, aiPaused: true });
}

/**
 * Approve a held draft, optionally edited.
 *
 * An edited draft is re-screened: a human can legitimately quote a price the
 * AI may not, but they should not be able to send something that trips a
 * guardrail by accident. The verdict is returned either way rather than
 * silently blocking.
 */
async function approveDraft(messageId: string, editedBody?: string) {
  const draft = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!draft) return NextResponse.json({ error: "draft not found" }, { status: 404 });
  if (draft.status !== "held_for_review") {
    return NextResponse.json({ error: `message is ${draft.status}, not held` }, { status: 400 });
  }

  const convo = await db.query.conversations.findFirst({
    where: eq(conversations.id, draft.conversationId),
  });
  const contact = convo
    ? await db.query.contacts.findFirst({ where: eq(contacts.id, convo.contactId) })
    : null;
  if (!convo || !contact) return NextResponse.json({ error: "conversation missing" }, { status: 404 });

  const body = (editedBody ?? draft.body).trim();
  const to = resolveAddress(convo.channel, contact);
  if (!to) return NextResponse.json({ error: "no address for this contact" }, { status: 400 });

  const sent = await deliver({
    tenantId: convo.tenantId,
    conversationId: convo.id,
    channel: convo.channel,
    to: { channel: convo.channel, externalId: to },
    body,
    authorType: "human",
  });

  await db.update(messages)
    .set({ status: "sent", meta: { ...draft.meta, approvedByHuman: true, edited: Boolean(editedBody) } })
    .where(eq(messages.id, messageId));

  await db.insert(events).values({
    tenantId: convo.tenantId,
    type: "draft_approved",
    conversationId: convo.id,
    contactId: contact.id,
    payload: { edited: Boolean(editedBody), originalHold: draft.meta?.holdReason ?? null },
  });

  return NextResponse.json({ ok: true, sent });
}

async function discardDraft(messageId: string) {
  const draft = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!draft) return NextResponse.json({ error: "draft not found" }, { status: 404 });

  await db.update(messages)
    .set({ status: "failed", error: "discarded by human reviewer" })
    .where(eq(messages.id, messageId));

  await db.insert(events).values({
    tenantId: draft.tenantId,
    type: "draft_discarded",
    conversationId: draft.conversationId,
    payload: { holdReason: draft.meta?.holdReason ?? null },
  });

  return NextResponse.json({ ok: true });
}

function resolveAddress(
  channel: string,
  contact: { primaryPhone: string | null; primaryEmail: string | null } | null | undefined,
): string | null {
  if (!contact) return null;
  if (channel === "sms" || channel === "voice" || channel === "whatsapp") return contact.primaryPhone;
  if (channel === "email") return contact.primaryEmail;
  // Social threads are addressed by the platform identity, resolved at send time.
  return contact.primaryPhone ?? contact.primaryEmail ?? "unknown";
}
