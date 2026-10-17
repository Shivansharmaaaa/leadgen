import { getProvider } from "@/server/agent/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTS_URL = process.env.TTS_URL ?? "http://127.0.0.1:8787";
const STT_URL = process.env.STT_URL ?? "http://127.0.0.1:8789";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

/**
 * Wake every model before the caller speaks.
 *
 * Left idle, the voice, the recogniser and the LLM get paged out of memory on
 * an 18 GB Mac, and the first live turn paid for it: 2.5 s for Parakeet and
 * 7 s for Kokoro on a session at 10:57, against 60 ms and under 1 s warm. The
 * voice page calls this when it opens, so that cost lands before the first
 * word instead of inside it. Nothing it produces is played or stored.
 */
export async function POST() {
  const timed = async (name: string, run: () => Promise<unknown>) => {
    const t0 = Date.now();
    try {
      await run();
      return { name, ok: true, ms: Date.now() - t0 };
    } catch (err) {
      return { name, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const results = await Promise.all([
    // A sentence the cache cannot already hold, so the model itself runs.
    timed("tts", () => fetch(`${TTS_URL}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Warming up, line ${Date.now() % 997}.` }),
      signal: AbortSignal.timeout(20_000),
    }).then((r) => { if (!r.ok) throw new Error(`tts ${r.status}`); return r.arrayBuffer(); })),

    // Half a second of near-silence at 16 kHz, 16-bit.
    timed("stt", () => fetch(`${STT_URL}/transcribe`, {
      method: "POST",
      body: new Uint8Array(16000),
      signal: AbortSignal.timeout(20_000),
    }).then((r) => { if (!r.ok) throw new Error(`stt ${r.status}`); return r.json(); })),

    // An empty generate loads the model and keeps it resident for the call.
    timed("llm", async () => {
      const provider = getProvider("voice");
      if (provider.id !== "ollama") return;
      const r = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Same num_ctx as the provider (providers/ollama.ts): a different one
        // makes Ollama reload the model on the first real turn.
        body: JSON.stringify({ model: provider.model, keep_alive: "30m", options: { num_ctx: 8192 } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`ollama ${r.status}`);
      await r.text();
    }),
  ]);

  return Response.json({ results });
}
