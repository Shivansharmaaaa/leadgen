import { eq } from "drizzle-orm";
import { db, tenants, contacts, appointments } from "@/server/db";
import { rotateCalendarToken } from "@/server/settings";
import { GET } from "@/app/api/calendar/[token]/route";
import { testSlug } from "./test-tenant";

/**
 * The private bookings feed: valid iCalendar, the right jobs, and a URL that
 * stops working the moment it is replaced.
 *
 *   npm run calendar:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const get = (token: string) => GET(new Request(`http://localhost/api/calendar/${token}.ics`), { params: Promise.resolve({ token: `${token}.ics` }) });

async function main() {
  const slug = await testSlug("calendar-test");
  await db.delete(tenants).where(eq(tenants.slug, slug));
  const [tenant] = await db.insert(tenants).values({ name: "Calendar Test", slug, country: "US", timezone: "America/New_York",
    settings: { businessName: "Calendar Test HVAC" } }).returning();
  const [c] = await db.insert(contacts).values({ tenantId: tenant.id, displayName: "Zoë O'Brien-Lindqvist", primaryPhone: "+16175550601" }).returning();
  const at = (days: number) => new Date(Date.now() + days * 86400_000);
  const mk = (days: number, status: "confirmed" | "cancelled" | "pending", service = "AC repair") => db.insert(appointments).values({
    tenantId: tenant.id, contactId: c.id, service, status, startsAt: at(days), endsAt: new Date(at(days).getTime() + 3600_000),
    notes: status === "confirmed" ? "Gate code 1234; dog in yard, friendly" : null,
  });
  await mk(2, "confirmed", "Heat pump install, 3-ton; upstairs + downstairs zones — long description to force folding");
  await mk(5, "cancelled");
  await mk(-3, "pending");
  await mk(-90, "confirmed"); // too old for the feed

  try {
    check("no link yet → 404", (await get("x".repeat(43))).status === 404);
    const t1 = (await rotateCalendarToken(tenant.id)).value!;
    const res = await get(t1);
    const body = await res.text();
    check("200 text/calendar", res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("text/calendar"));
    check("CRLF line endings throughout", body.includes("\r\n") && !body.replace(/\r\n/g, "").includes("\n"));
    const physical = body.split("\r\n");
    check("no line longer than 75 octets", physical.every((l) => Buffer.byteLength(l, "utf8") <= 75),
      String(Math.max(...physical.map((l) => Buffer.byteLength(l, "utf8")))));
    const unfolded = body.replace(/\r\n /g, "").split("\r\n");
    check("folding never splits a character (ë and the em dash survive)", unfolded.some((l) => l.includes("Zoë O'Brien-Lindqvist")) && unfolded.some((l) => l.includes("—")));
    const events = unfolded.filter((l) => l === "BEGIN:VEVENT").length;
    check("the three jobs in the window, not the one from 90 days ago", events === 3, String(events));
    check("commas and semicolons escaped", unfolded.some((l) => l.startsWith("SUMMARY:Heat pump install\\, 3-ton\\; upstairs")));
    check("notes carry the phone and gate code", unfolded.some((l) => l.startsWith("DESCRIPTION:") && l.includes("+16175550601") && l.includes("Gate code 1234\\;")));
    check("a cancelled job shows as cancelled, a pending one as tentative",
      unfolded.includes("STATUS:CANCELLED") && unfolded.includes("STATUS:TENTATIVE") && unfolded.includes("STATUS:CONFIRMED"));
    const t2 = (await rotateCalendarToken(tenant.id)).value!;
    check("replacing the link cuts off the old one", (await get(t1)).status === 404 && (await get(t2)).status === 200);
    check("a short or odd token is refused before any lookup", (await get("abc")).status === 404 && (await get("../../etc")).status === 404);
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
