import { and, asc, eq, gt } from "drizzle-orm";
import { db, conversations, messages, tenants } from "@/server/db";
import { handleInbound } from "@/server/core/ingest";

/**
 * FEATURE 11 — the chat bubble on the client's own website.
 *
 * Web chat was a channel everywhere except where a visitor could reach it:
 * only the eval harness ever created a webchat conversation. This is the
 * public side: one endpoint the widget posts to, and one it polls, so a reply
 * a person sends from the inbox reaches the visitor too.
 *
 * It is the only endpoint that runs the model for an anonymous caller, so it
 * is the one most worth protecting. The visitor's session id is a random
 * 128-bit value that works as a bearer token: it threads the conversation and
 * is the only way to read it back. Every session and every IP gets a budget,
 * browsers are only allowed from the tenant's own sites, and a message has a
 * hard length cap.
 */

export const MAX_MESSAGE_CHARS = 1000;
const SESSION_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** Messages per window. Generous for a person, useless for a script. */
const LIMITS = { perSession: 30, perIp: 60, windowMs: 3600_000 };
const buckets = new Map<string, number[]>();

export function allow(key: string, max: number, now = Date.now()): boolean {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < LIMITS.windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 50_000) {
    // Bound memory under a flood: drop the oldest keys.
    for (const k of [...buckets.keys()].slice(0, 10_000)) buckets.delete(k);
  }
  return true;
}

export function resetRateLimits() {
  buckets.clear();
}

export function validSession(id: unknown): id is string {
  return typeof id === "string" && SESSION_RE.test(id);
}

/**
 * Which origin, if any, may call from a browser. A tenant lists its sites in
 * settings.webchatOrigins; with none listed, only same-origin pages (the
 * demo, the app itself) work. CORS does not stop a script — the rate limit
 * does — but it stops anyone else embedding this tenant's widget on their
 * site and spending its budget.
 */
export function allowedOrigin(origin: string | null, configured: string[] | undefined): string | null {
  if (!origin || !configured?.length) return null;
  const norm = (o: string) => o.replace(/\/$/, "").toLowerCase();
  return configured.map(norm).includes(norm(origin)) ? origin : null;
}

export type ChatMessage = { id: string; body: string; from: "assistant" | "team"; at: string };

export type ChatTurn = {
  reply: ChatMessage | null;
  /** Nothing went out yet: a person will answer, and the widget says so. */
  waitingForTeam: boolean;
};

export async function chatTurn(args: {
  tenantId: string; sessionId: string; text: string; clientMessageId?: string;
}): Promise<ChatTurn> {
  const result = await handleInbound({
    tenantId: args.tenantId,
    channel: "webchat",
    externalId: args.clientMessageId ? `web:${args.sessionId}:${args.clientMessageId}` : null,
    externalThreadId: args.sessionId,
    from: { channel: "webchat", externalId: args.sessionId },
    body: args.text,
  });
  if (result.duplicate) return { reply: null, waitingForTeam: false };
  // The reply as stored, so the widget can match it against what it polls.
  const [reply] = result.sent
    ? await db.query.messages.findMany({
        where: and(eq(messages.conversationId, result.conversationId), eq(messages.direction, "outbound"),
          eq(messages.status, "sent")),
        orderBy: (m, { desc }) => desc(m.createdAt),
        limit: 1,
      })
    : [];
  return {
    reply: reply ? { id: reply.id, body: reply.body, from: "assistant", at: reply.createdAt.toISOString() } : null,
    waitingForTeam: !reply,
  };
}

/** Replies sent into this session's thread after `after`: how a person's inbox reply reaches the visitor. */
export async function chatUpdates(args: { tenantId: string; sessionId: string; after: Date }) {
  const convo = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.tenantId, args.tenantId),
      eq(conversations.channel, "webchat"),
      eq(conversations.externalThreadId, args.sessionId),
    ),
  });
  if (!convo) return [];
  const rows = await db.query.messages.findMany({
    where: and(
      eq(messages.conversationId, convo.id),
      eq(messages.direction, "outbound"),
      eq(messages.status, "sent"),
      gt(messages.createdAt, args.after),
    ),
    orderBy: asc(messages.createdAt),
    limit: 20,
  });
  return rows.map((m): ChatMessage => ({
    id: m.id, body: m.body, from: m.authorType === "human" ? "team" : "assistant", at: m.createdAt.toISOString(),
  }));
}

export async function tenantBySlug(slug: string | null) {
  if (!slug || !/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  return db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
}

export function limits() {
  return LIMITS;
}
