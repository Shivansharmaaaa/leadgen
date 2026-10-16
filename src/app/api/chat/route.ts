import {
  allow, allowedOrigin, chatTurn, chatUpdates, limits, MAX_MESSAGE_CHARS, tenantBySlug, validSession,
} from "@/server/features/webchat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The website chat widget's backend (public/widget.js).
 *
 *   POST /api/chat   { tenant, sessionId, text, clientMessageId? }  → the agent's reply
 *   GET  /api/chat?tenant=&sessionId=&after=<iso>                 → replies since, incl. a person's
 */
export async function OPTIONS(req: Request) {
  const tenant = await tenantBySlug(new URL(req.url).searchParams.get("tenant"));
  return new Response(null, { status: 204, headers: cors(req, tenant?.settings?.webchatOrigins) });
}

export async function POST(req: Request) {
  let body: { tenant?: string; sessionId?: unknown; text?: unknown; clientMessageId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "body must be JSON" }, 400);
  }
  const tenant = await tenantBySlug(body.tenant ?? null);
  const headers = cors(req, tenant?.settings?.webchatOrigins);
  if (!tenant) return json(req, { error: "unknown tenant" }, 404, headers);
  if (!validSession(body.sessionId)) return json(req, { error: "sessionId must be 22-64 url-safe characters" }, 400, headers);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json(req, { error: "text is required" }, 400, headers);
  if (text.length > MAX_MESSAGE_CHARS) return json(req, { error: `keep it under ${MAX_MESSAGE_CHARS} characters` }, 413, headers);

  const ip = clientIp(req);
  const { perSession, perIp } = limits();
  if (!allow(`s:${tenant.id}:${body.sessionId}`, perSession) || !allow(`ip:${tenant.id}:${ip}`, perIp)) {
    return json(req, { error: "too many messages — please give us a call instead" }, 429, { ...headers, "retry-after": "600" });
  }

  const clientMessageId = typeof body.clientMessageId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.clientMessageId)
    ? body.clientMessageId : undefined;
  const turn = await chatTurn({ tenantId: tenant.id, sessionId: body.sessionId, text, clientMessageId });
  return json(req, turn, 200, headers);
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const tenant = await tenantBySlug(q.get("tenant"));
  const headers = cors(req, tenant?.settings?.webchatOrigins);
  if (!tenant) return json(req, { error: "unknown tenant" }, 404, headers);
  const sessionId = q.get("sessionId");
  if (!validSession(sessionId)) return json(req, { error: "bad sessionId" }, 400, headers);
  const after = new Date(q.get("after") ?? 0);
  if (Number.isNaN(after.getTime())) return json(req, { error: "after must be an ISO time" }, 400, headers);
  return json(req, { messages: await chatUpdates({ tenantId: tenant.id, sessionId, after }) }, 200, headers);
}

function cors(req: Request, origins: string[] | undefined): Record<string, string> {
  const origin = allowedOrigin(req.headers.get("origin"), origins);
  return origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
        vary: "origin",
      }
    : { vary: "origin" };
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

function json(_req: Request, data: unknown, status: number, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}
