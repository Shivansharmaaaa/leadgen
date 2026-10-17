import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The businesses the /voice page can call as or for: every tenant with voice
 * settings (a booking noun and reasons to call). Names and reasons only.
 */
export async function GET() {
  const rows = await db.query.tenants.findMany();
  const businesses = rows
    .filter((t) => t.settings?.bookingNoun && t.settings?.outboundReasons)
    .map((t) => ({
      slug: t.slug,
      name: t.settings?.businessName ?? t.name,
      agentName: t.settings?.agentName ?? "Alex",
      reasons: t.settings?.outboundReasons ?? {},
    }))
    .sort((a, b) => (a.slug === "northside-hvac" ? -1 : b.slug === "northside-hvac" ? 1 : a.name.localeCompare(b.name)));
  return Response.json({ businesses });
}
