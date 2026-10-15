import { and, eq, sql as raw } from "drizzle-orm";
import { db, knowledgeChunks } from "@/server/db";
import { getEmbeddingProvider } from "./embeddings";

/**
 * Hybrid retrieval: dense vectors for meaning, full-text for exact terms,
 * fused with Reciprocal Rank Fusion.
 *
 * Pure vector search is bad at precisely the queries this product gets most —
 * model numbers, brand names, postcodes, "EPA 608". Pure keyword search misses
 * paraphrase. RRF needs no score calibration between the two, which is why it
 * is used instead of a weighted sum.
 */
const RRF_K = 60;

export type Retrieved = {
  content: string;
  docId: string;
  vectorRank: number | null;
  textRank: number | null;
  score: number;
};

export async function hybridSearch(
  tenantId: string, query: string, limit = 5,
): Promise<Retrieved[]> {
  const [dense, lexical] = await Promise.all([
    vectorSearch(tenantId, query, limit * 3).catch(() => []),
    textSearch(tenantId, query, limit * 3).catch(() => []),
  ]);

  const fused = new Map<string, Retrieved>();

  dense.forEach((row, i) => {
    fused.set(row.id, {
      content: row.content, docId: row.docId,
      vectorRank: i + 1, textRank: null,
      score: 1 / (RRF_K + i + 1),
    });
  });

  lexical.forEach((row, i) => {
    const existing = fused.get(row.id);
    if (existing) {
      existing.textRank = i + 1;
      existing.score += 1 / (RRF_K + i + 1);
    } else {
      fused.set(row.id, {
        content: row.content, docId: row.docId,
        vectorRank: null, textRank: i + 1,
        score: 1 / (RRF_K + i + 1),
      });
    }
  });

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

async function vectorSearch(tenantId: string, query: string, limit: number) {
  const provider = getEmbeddingProvider();
  const [vec] = await provider.embed([query]);
  const literal = `[${vec.join(",")}]`;

  return db
    .select({
      id: knowledgeChunks.id,
      content: knowledgeChunks.content,
      docId: knowledgeChunks.docId,
    })
    .from(knowledgeChunks)
    .where(and(
      eq(knowledgeChunks.tenantId, tenantId),
      raw`${knowledgeChunks.embedding} IS NOT NULL`,
    ))
    .orderBy(raw`${knowledgeChunks.embedding} <=> ${literal}::vector`)
    .limit(limit);
}

async function textSearch(tenantId: string, query: string, limit: number) {
  return db
    .select({
      id: knowledgeChunks.id,
      content: knowledgeChunks.content,
      docId: knowledgeChunks.docId,
    })
    .from(knowledgeChunks)
    .where(and(
      eq(knowledgeChunks.tenantId, tenantId),
      raw`to_tsvector('english', ${knowledgeChunks.content}) @@ plainto_tsquery('english', ${query})`,
    ))
    .orderBy(raw`ts_rank(to_tsvector('english', ${knowledgeChunks.content}), plainto_tsquery('english', ${query})) DESC`)
    .limit(limit);
}
