/**
 * Embedding providers, mirroring the LLM provider split: free and local for
 * development, hosted for production. Dimensions differ between models, so a
 * provider change requires re-indexing — the model name is stored per chunk
 * precisely so that mismatch is detectable rather than silently wrong.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class OllamaEmbeddings implements EmbeddingProvider {
  readonly id = "ollama";
  readonly dimensions = 768;

  constructor(
    readonly model = process.env.EMBED_MODEL ?? "nomic-embed-text",
    private baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434",
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings;
  }
}

/** Voyage is Anthropic's recommended embedding partner for production. */
export class VoyageEmbeddings implements EmbeddingProvider {
  readonly id = "voyage";
  readonly dimensions = 1024;

  constructor(readonly model = process.env.VOYAGE_MODEL ?? "voyage-3") {}

  async embed(texts: string[]): Promise<number[][]> {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error("VOYAGE_API_KEY is not set");

    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: this.model, input: texts, input_type: "document" }),
    });
    if (!res.ok) throw new Error(`Voyage embed failed: ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  const choice = process.env.EMBED_PROVIDER?.toLowerCase()
    ?? (process.env.VOYAGE_API_KEY ? "voyage" : "ollama");
  return choice === "voyage" ? new VoyageEmbeddings() : new OllamaEmbeddings();
}
