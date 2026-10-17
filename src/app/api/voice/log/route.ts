import { appendFile, mkdir } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The voice page's own signals — what Chrome heard, what Parakeet heard, what
 * was ignored as echo or backchannel, when the mic restarted — written to
 * data/voice-logs/<session>.jsonl. These decide whether a turn ever reaches
 * the server, and "it ignores me sometimes" cannot be diagnosed from the
 * server side alone. data/ is gitignored; nothing here leaves the machine.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { sessionId?: string; events?: { at: number; kind: string; detail: string }[] }
    | null;
  const session = String(body?.sessionId ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const events = Array.isArray(body?.events) ? body!.events.slice(0, 200) : [];
  if (!session || events.length === 0) return new Response(null, { status: 204 });

  const lines = events
    .map((e) => JSON.stringify({
      at: new Date(Number(e.at) || Date.now()).toISOString(),
      kind: String(e.kind).slice(0, 40),
      detail: String(e.detail).slice(0, 400),
    }))
    .join("\n") + "\n";
  await mkdir("data/voice-logs", { recursive: true });
  await appendFile(`data/voice-logs/${session}.jsonl`, lines);
  return new Response(null, { status: 204 });
}
