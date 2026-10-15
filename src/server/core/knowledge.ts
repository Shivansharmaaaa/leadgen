import { and, eq, sql as raw } from "drizzle-orm";
import { db, knowledgeFacts, knowledgeDocs, locations } from "@/server/db";

/**
 * Knowledge is deliberately split in two.
 *
 *   Facts  — hours, prices, service area, policies. Rendered as a typed block
 *            the model is told to quote verbatim and never invent.
 *   Docs   — prose (about us, FAQ). A small business's entire set is a few
 *            thousand tokens, so it goes into the cached system prompt whole.
 *            No vector store, no retrieval error, no wrong chunk.
 *
 * Past the budget we fall back to Postgres full-text search rather than
 * silently truncating.
 */
const PROSE_TOKEN_BUDGET = 6000;

export type KnowledgePack = {
  factsBlock: string;
  proseBlock: string;
  truncated: boolean;
};

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export async function loadKnowledge(tenantId: string): Promise<KnowledgePack> {
  const [facts, docs, locs] = await Promise.all([
    db.query.knowledgeFacts.findMany({ where: eq(knowledgeFacts.tenantId, tenantId) }),
    db.query.knowledgeDocs.findMany({ where: eq(knowledgeDocs.tenantId, tenantId) }),
    db.query.locations.findMany({ where: eq(locations.tenantId, tenantId) }),
  ]);

  const byCategory = new Map<string, string[]>();
  for (const f of facts) {
    const list = byCategory.get(f.category) ?? [];
    list.push(`${f.key}: ${f.value}`);
    byCategory.set(f.category, list);
  }

  for (const loc of locs) {
    const hours = loc.hours.length
      ? loc.hours
          .map((h) => `${DAYS[h.day]} ${h.open}-${h.close}`)
          .join(", ")
      : "not set";
    const list = byCategory.get("location") ?? [];
    list.push(
      `${loc.name}: ${[loc.addressLine1, loc.city, loc.region, loc.postalCode].filter(Boolean).join(", ")}`,
      `${loc.name} phone: ${loc.phone ?? "not set"}`,
      `${loc.name} hours: ${hours}`,
      `${loc.name} service area: ${loc.serviceArea.join(", ") || "not set"}`,
    );
    byCategory.set("location", list);
  }

  const factsBlock = [...byCategory.entries()]
    .map(([cat, lines]) => `[${cat}]\n${lines.map((l) => `  ${l}`).join("\n")}`)
    .join("\n");

  let used = 0;
  let truncated = false;
  const kept: string[] = [];
  for (const doc of docs) {
    const cost = doc.tokenEstimate || estimateTokens(doc.content);
    if (used + cost > PROSE_TOKEN_BUDGET) {
      truncated = true;
      continue;
    }
    used += cost;
    kept.push(`### ${doc.title}\n${doc.content}`);
  }

  return { factsBlock, proseBlock: kept.join("\n\n"), truncated };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Full-text fallback for tenants whose prose exceeds the inline budget. */
export async function searchKnowledge(tenantId: string, query: string, limit = 3) {
  const rows = await db
    .select({
      title: knowledgeDocs.title,
      content: knowledgeDocs.content,
      rank: raw<number>`ts_rank(to_tsvector('english', ${knowledgeDocs.content}), plainto_tsquery('english', ${query}))`,
    })
    .from(knowledgeDocs)
    .where(
      and(
        eq(knowledgeDocs.tenantId, tenantId),
        raw`to_tsvector('english', ${knowledgeDocs.content}) @@ plainto_tsquery('english', ${query})`,
      ),
    )
    .orderBy(raw`ts_rank(to_tsvector('english', ${knowledgeDocs.content}), plainto_tsquery('english', ${query})) DESC`)
    .limit(limit);
  return rows;
}
