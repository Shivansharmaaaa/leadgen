import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, appointments, contacts, tenants } from "@/server/db";

/**
 * FEATURE 17 — booked jobs in the owner's own calendar.
 *
 * Proper ServiceTitan / Jobber / Google Calendar sync needs OAuth apps and
 * credentials. Every calendar app can already subscribe to an iCalendar
 * feed, though, so a private feed URL puts every booking (with the
 * customer's name and number) on the owner's and the techs' phones today,
 * read-only, refreshed by the calendar app.
 *
 * The URL is the credential: 32 random bytes, shown on /settings, rotated
 * there. It carries customer names and numbers, so it is never guessable and
 * a rotation cuts off every old subscription at once.
 */

export async function tenantByCalendarToken(token: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return undefined;
  return db.query.tenants.findFirst({ where: sql`${tenants.settings}->>'calendarToken' = ${token}` });
}

export async function calendarFeed(tenantId: string, now = new Date()): Promise<string> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const business = tenant?.settings?.businessName ?? tenant?.name ?? "Bookings";
  const rows = await db.select({ a: appointments, name: contacts.displayName, phone: contacts.primaryPhone })
    .from(appointments)
    .innerJoin(contacts, eq(contacts.id, appointments.contactId))
    .where(and(
      eq(appointments.tenantId, tenantId),
      inArray(appointments.status, ["confirmed", "pending", "completed", "cancelled"]),
      gte(appointments.startsAt, new Date(now.getTime() - 30 * 86400_000)),
      lte(appointments.startsAt, new Date(now.getTime() + 180 * 86400_000)),
    ));
  const app = (process.env.APP_URL ?? "").replace(/\/$/, "");

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//leadgen//bookings//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${text(`${business} jobs`)}`, "X-PUBLISHED-TTL:PT15M", "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
  ];
  for (const { a, name, phone } of rows) {
    const who = name ?? phone ?? "Customer";
    const notes = [
      phone ? `Phone: ${phone}` : null,
      a.notes ? `Notes: ${a.notes}` : null,
      a.status === "pending" && a.rescheduleRequestedAt ? "Customer asked to reschedule." : null,
      a.customerConfirmedAt ? "Customer confirmed." : null,
      app ? `${app}/dashboard` : null,
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${a.id}@leadgen`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(a.startsAt)}`,
      `DTEND:${stamp(a.endsAt)}`,
      `SUMMARY:${text(`${a.service} — ${who}`)}`,
      ...(notes ? [`DESCRIPTION:${text(notes)}`] : []),
      `STATUS:${a.status === "cancelled" ? "CANCELLED" : a.status === "pending" ? "TENTATIVE" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** RFC 5545 TEXT escaping. */
function text(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0, first = true;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + (first ? 75 : 74));
    // Never split a UTF-8 character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return parts.join("\r\n");
}
