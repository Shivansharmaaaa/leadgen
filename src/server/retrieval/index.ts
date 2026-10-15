import { eq } from "drizzle-orm";
import { db, knowledgeDocs, knowledgeChunks } from "@/server/db";
import { getEmbeddingProvider } from "./embeddings";

/**
 * Chunking tuned for business knowledge, not prose: these documents are lists
 * of facts, policies and FAQ pairs, so chunks are small and overlap a little
 * to avoid splitting a question from its answer.
 */
const TARGET_CHARS = 700;
const OVERLAP_CHARS = 120;

export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 <= TARGET_CHARS) {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
      continue;
    }
    if (buffer) chunks.push(buffer);

    if (para.length <= TARGET_CHARS) {
      buffer = para;
      continue;
    }
    // A single oversized paragraph: split on sentences with overlap.
    const sentences = para.match(/[^.!?]+[.!?]+\s*/g) ?? [para];
    let sub = "";
    for (const s of sentences) {
      if (sub.length + s.length > TARGET_CHARS) {
        chunks.push(sub.trim());
        sub = sub.slice(-OVERLAP_CHARS) + s;
      } else sub += s;
    }
    buffer = sub.trim();
  }
  if (buffer) chunks.push(buffer);
  return chunks.filter((c) => c.length > 20);
}

/** (Re)index one document. Replaces existing chunks for that doc. */
export async function indexDocument(docId: string): Promise<number> {
  const doc = await db.query.knowledgeDocs.findFirst({ where: eq(knowledgeDocs.id, docId) });
  if (!doc) return 0;

  const provider = getEmbeddingProvider();
  const pieces = chunkText(doc.content);
  if (pieces.length === 0) return 0;

  const vectors = await provider.embed(pieces);

  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.docId, docId));
  await db.insert(knowledgeChunks).values(
    pieces.map((content, i) => ({
      tenantId: doc.tenantId,
      docId: doc.id,
      ordinal: i,
      content,
      tokenEstimate: Math.ceil(content.length / 4),
      embedding: vectors[i],
      embeddingModel: `${provider.id}:${provider.model}`,
    })),
  );

  return pieces.length;
}

export async function indexTenant(tenantId: string): Promise<{ docs: number; chunks: number }> {
  const docs = await db.query.knowledgeDocs.findMany({
    where: eq(knowledgeDocs.tenantId, tenantId),
  });
  let chunks = 0;
  for (const doc of docs) chunks += await indexDocument(doc.id);
  return { docs: docs.length, chunks };
}
