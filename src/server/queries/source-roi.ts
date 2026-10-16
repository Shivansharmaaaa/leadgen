/**
 * Cost per lead and per booked job, by source: the number that answers "is
 * Angi worth it?". Monthly spend is prorated to the window being shown, and a
 * source with spend but no bookings says so rather than dividing by zero.
 */
export type SourceRow = { source: string; leads: number; booked: number };
export type SourceRoi = SourceRow & { spend: number | null; costPerLead: number | null; costPerBooked: number | null };

export function sourceRoi(rows: SourceRow[], monthlySpend: Record<string, number> | undefined, days: number): SourceRoi[] {
  const out: SourceRoi[] = rows.map((r) => {
    const monthly = monthlySpend?.[r.source];
    const spend = monthly != null ? Math.round(monthly * (days / 30) * 100) / 100 : null;
    return {
      ...r, spend,
      costPerLead: spend != null && r.leads ? Math.round((spend / r.leads) * 100) / 100 : null,
      costPerBooked: spend != null && r.booked ? Math.round((spend / r.booked) * 100) / 100 : null,
    };
  });
  // A source being paid for that produced nothing in the window still shows.
  for (const [source, monthly] of Object.entries(monthlySpend ?? {})) {
    if (!out.some((r) => r.source === source) && monthly > 0) {
      out.push({ source, leads: 0, booked: 0, spend: Math.round(monthly * (days / 30) * 100) / 100, costPerLead: null, costPerBooked: null });
    }
  }
  return out;
}
