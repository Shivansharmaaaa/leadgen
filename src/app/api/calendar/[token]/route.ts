import { calendarFeed, tenantByCalendarToken } from "@/server/features/calendar-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/calendar/<token>.ics: the private bookings feed a calendar app subscribes to. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const tenant = await tenantByCalendarToken(token.replace(/\.ics$/, ""));
  if (!tenant) return new Response("not found", { status: 404 });
  return new Response(await calendarFeed(tenant.id), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${tenant.slug}-jobs.ics"`,
      "cache-control": "private, max-age=300",
    },
  });
}
