import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy to the local Kokoro service.
 *
 * Kept behind the app so the browser needs no knowledge of the TTS host, and
 * so a failure degrades to the browser's own speech synthesis rather than
 * silence.
 */
const TTS_URL = process.env.TTS_URL ?? "http://127.0.0.1:8787";

export async function POST(req: Request) {
  const { text, voice, speed, exaggeration } = (await req.json().catch(() => ({}))) as {
    text?: string; voice?: string; speed?: number; exaggeration?: number;
  };
  // Chatterbox's emotion dial, from the plan. Kokoro ignores it.
  const feeling = typeof exaggeration === "number" && Number.isFinite(exaggeration)
    ? Math.min(2, Math.max(0.25, exaggeration)) : undefined;
  // From the delivery plan: slower on times and prices, quicker on fillers.
  // Clamped, and omitted when absent so Kokoro uses its default (and the
  // pre-rendered openers stay cache hits).
  const pace = typeof speed === "number" && Number.isFinite(speed) ? Math.min(1.3, Math.max(0.6, speed)) : undefined;
  if (!text?.trim()) return new Response("text required", { status: 400 });

  try {
    const res = await fetch(`${TTS_URL}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text, voice: voice ?? process.env.TTS_VOICE,
        ...(pace ? { speed: pace } : {}), ...(feeling ? { exaggeration: feeling } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return new Response("tts failed", { status: 502 });

    return new Response(await res.arrayBuffer(), {
      headers: {
        "content-type": "audio/wav",
        "cache-control": "no-store",
        "x-generation-ms": res.headers.get("x-generation-ms") ?? "",
      },
    });
  } catch {
    // Service down — the client falls back to speechSynthesis.
    return new Response("tts unavailable", { status: 503 });
  }
}

export async function GET() {
  try {
    const res = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ ok: false, reason: "tts service not running" }, { status: 503 });
  }
}
