import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy to the local Parakeet service. Body is 16 kHz mono int16 PCM.
 * Any failure returns a status the client treats as "use the browser's own
 * transcript", so a stopped STT service degrades accuracy, never the call.
 */
const STT_URL = process.env.STT_URL ?? "http://127.0.0.1:8789";

export async function POST(req: Request) {
  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0) return NextResponse.json({ error: "no audio" }, { status: 400 });
  try {
    const res = await fetch(`${STT_URL}/transcribe`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: audio,
      signal: AbortSignal.timeout(8_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "stt unavailable" }, { status: 503 });
  }
}

export async function GET() {
  try {
    const res = await fetch(`${STT_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ ok: false, reason: "stt service not running" }, { status: 503 });
  }
}
