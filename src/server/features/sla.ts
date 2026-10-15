import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db, messages, conversations, events } from "@/server/db";

/**
 * FEATURE 2 — speed-to-lead SLA.
 *
 * The highest-leverage number in local services: the odds of qualifying a lead
 * fall off a cliff after the first few minutes. The agent's whole economic
 * argument is that it replies in seconds at 3am, so this must be measured and
 * put on the dashboard, not assumed.
 */
export const SLA_TARGET_SECONDS = 60;

export type SlaReport = {
  totalFirstResponses: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  withinTargetPct: number;
  afterHoursCount: number;
  slowest: { conversationId: string; seconds: number }[];
};

export async function slaReport(tenantId: string, sinceDays = 30): Promise<SlaReport> {
  const since = new Date(Date.now() - sinceDays * 86400_000);

  const convos = await db.query.conversations.findMany({
    where: and(eq(conversations.tenantId, tenantId), gte(conversations.createdAt, since)),
  });

  const latencies: { conversationId: string; seconds: number; hour: number }[] = [];

  for (const c of convos) {
    const msgs = await db.query.messages.findMany({
      where: eq(messages.conversationId, c.id),
      orderBy: asc(messages.createdAt),
      limit: 10,
    });
    const firstIn = msgs.find((m) => m.direction === "inbound");
    const firstOut = msgs.find(
      (m) => m.direction === "outbound" && firstIn && m.createdAt >= firstIn.createdAt,
    );
    if (!firstIn || !firstOut) continue;

    latencies.push({
      conversationId: c.id,
      seconds: Math.max(0, Math.round((firstOut.createdAt.getTime() - firstIn.createdAt.getTime()) / 1000)),
      hour: firstIn.createdAt.getUTCHours(),
    });
  }

  if (latencies.length === 0) {
    return {
      totalFirstResponses: 0, medianSeconds: null, p90Seconds: null,
      withinTargetPct: 0, afterHoursCount: 0, slowest: [],
    };
  }

  const sorted = [...latencies].sort((a, b) => a.seconds - b.seconds);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].seconds;

  return {
    totalFirstResponses: latencies.length,
    medianSeconds: at(0.5),
    p90Seconds: at(0.9),
    withinTargetPct:
      (latencies.filter((l) => l.seconds <= SLA_TARGET_SECONDS).length / latencies.length) * 100,
    afterHoursCount: latencies.filter((l) => l.hour < 8 || l.hour >= 18).length,
    slowest: sorted.slice(-3).reverse().map(({ conversationId, seconds }) => ({ conversationId, seconds })),
  };
}

/** Fires when a first response misses the target, so the breach is visible. */
export async function recordSlaBreach(tenantId: string, conversationId: string, seconds: number) {
  if (seconds <= SLA_TARGET_SECONDS) return;
  await db.insert(events).values({
    tenantId, type: "sla_breach", conversationId,
    payload: { seconds, target: SLA_TARGET_SECONDS },
  });
}
