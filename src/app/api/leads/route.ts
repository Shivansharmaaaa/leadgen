import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, tenants } from "@/server/db";
import { intakeLead, LeadIntakeSchema } from "@/server/features/lead-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lead intake: web forms, Zapier, Google LSA / Angi / Thumbtack forwarders.
 *
 *   POST /api/leads?tenant=<slug>
 *   x-intake-key: <tenant settings.intakeKey>
 *   { "source": "website", "name": "...", "phone": "...", "message": "...",
 *     "consent": { "sms": true, "language": "<the exact disclosure>" } }
 *
 * The key is a server-to-server secret: a website should post through its
 * own backend or a Zapier step, never from browser JavaScript, where anyone
 * can read it. Responds 202 once the lead is stored and the first reply has
 * been attempted, with what happened and why.
 */
export async function POST(req: Request) {
  const slug = new URL(req.url).searchParams.get("tenant");
  if (!slug) return json({ error: "missing ?tenant=<slug>" }, 400);

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  const expected = tenant?.settings?.intakeKey;
  // Same response for an unknown tenant and a wrong key: don't confirm which slugs exist.
  if (!tenant || !expected || !keyMatches(req.headers.get("x-intake-key"), expected)) {
    return json({ error: "unauthorised" }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const parsed = LeadIntakeSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "invalid lead", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 422);
  }
  if (!parsed.data.phone && !parsed.data.email) {
    return json({ error: "invalid lead", issues: ["a phone or an email is required"] }, 422);
  }

  const result = await intakeLead(tenant.id, parsed.data);
  if (!result.leadId && !result.duplicate) return json({ error: result.reason ?? "lead not stored" }, 422);
  return json(result, result.duplicate ? 200 : 202);
}

function keyMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(data: unknown, status: number) {
  return Response.json(data, { status });
}
