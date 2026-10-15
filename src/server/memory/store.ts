import { and, desc, eq, isNull } from "drizzle-orm";
import { db, contactMemories, events } from "@/server/db";

export type MemoryKind =
  | "equipment" | "property" | "preference"
  | "constraint" | "relationship" | "history" | "caution";

export type MemoryRow = typeof contactMemories.$inferSelect;

/**
 * Write a durable fact, superseding any live memory with the same key.
 *
 * Supersession rather than update: the old row is kept with a pointer to its
 * replacement, so "the customer said X in March and Y in June" stays auditable.
 * Retrieval only ever returns the live row.
 */
export async function remember(args: {
  tenantId: string;
  contactId: string;
  kind: MemoryKind;
  key: string;
  value: string;
  confidence?: number;
  conversationId?: string | null;
  messageId?: string | null;
  origin?: "agent_tool" | "deterministic" | "staff";
}): Promise<{ created: boolean; superseded: boolean; unchanged: boolean }> {
  const key = normalizeKey(args.key);

  const existing = await db.query.contactMemories.findFirst({
    where: and(
      eq(contactMemories.contactId, args.contactId),
      eq(contactMemories.key, key),
      isNull(contactMemories.supersededAt),
    ),
  });

  // Same claim again — just refresh the confirmation timestamp.
  if (existing && existing.value.trim().toLowerCase() === args.value.trim().toLowerCase()) {
    await db.update(contactMemories)
      .set({ lastConfirmedAt: new Date() })
      .where(eq(contactMemories.id, existing.id));
    return { created: false, superseded: false, unchanged: true };
  }

  const [created] = await db.insert(contactMemories).values({
    tenantId: args.tenantId,
    contactId: args.contactId,
    kind: args.kind,
    key,
    value: args.value.trim(),
    confidence: (args.confidence ?? 0.8).toFixed(2),
    sourceConversationId: args.conversationId ?? null,
    sourceMessageId: args.messageId ?? null,
    origin: args.origin ?? "agent_tool",
  }).returning();

  if (existing) {
    await db.update(contactMemories)
      .set({ supersededById: created.id, supersededAt: new Date() })
      .where(eq(contactMemories.id, existing.id));
  }

  await db.insert(events).values({
    tenantId: args.tenantId,
    type: existing ? "memory_updated" : "memory_created",
    contactId: args.contactId,
    conversationId: args.conversationId ?? null,
    payload: { kind: args.kind, key, superseded: Boolean(existing) },
  });

  return { created: true, superseded: Boolean(existing), unchanged: false };
}

/** Live memories for a contact, most confident and most recent first. */
export async function recall(contactId: string, limit = 24): Promise<MemoryRow[]> {
  const rows = await db.query.contactMemories.findMany({
    where: and(
      eq(contactMemories.contactId, contactId),
      isNull(contactMemories.supersededAt),
    ),
    orderBy: desc(contactMemories.lastConfirmedAt),
    limit: limit * 2,
  });

  return rows
    .sort((a, b) => {
      const c = Number(b.confidence) - Number(a.confidence);
      if (Math.abs(c) > 0.15) return c;
      return b.lastConfirmedAt.getTime() - a.lastConfirmedAt.getTime();
    })
    .slice(0, limit);
}

/** Drop a memory the customer corrected or staff flagged as wrong. */
export async function forget(memoryId: string, reason: string): Promise<void> {
  const row = await db.query.contactMemories.findFirst({
    where: eq(contactMemories.id, memoryId),
  });
  if (!row) return;

  await db.update(contactMemories)
    .set({ supersededAt: new Date() })
    .where(eq(contactMemories.id, memoryId));

  await db.insert(events).values({
    tenantId: row.tenantId,
    type: "memory_forgotten",
    contactId: row.contactId,
    payload: { key: row.key, reason },
  });
}

const KIND_LABEL: Record<MemoryKind, string> = {
  equipment: "Equipment",
  property: "Property / access",
  preference: "Preferences",
  constraint: "Constraints",
  relationship: "Who decides",
  history: "Past work",
  caution: "Heads-up",
};

/**
 * Render memories for the system prompt.
 *
 * Confidence is shown, not hidden. A model told a fact is uncertain will
 * confirm it rather than assert it — which is the behaviour you want when the
 * fact is "side gate code 4471" and the alternative is a wasted truck roll.
 */
export function renderMemoryBlock(memories: MemoryRow[]): string {
  if (memories.length === 0) return "";

  const grouped = new Map<string, string[]>();
  for (const m of memories) {
    const label = KIND_LABEL[m.kind as MemoryKind] ?? m.kind;
    const uncertain = Number(m.confidence) < 0.6 ? " (unconfirmed — check before relying on it)" : "";
    const list = grouped.get(label) ?? [];
    list.push(`${m.value}${uncertain}`);
    grouped.set(label, list);
  }

  return [...grouped.entries()]
    .map(([label, items]) => `${label}:\n${items.map((i) => `  - ${i}`).join("\n")}`)
    .join("\n");
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}
