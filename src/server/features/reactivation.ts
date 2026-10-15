import { and, eq, inArray, lt, desc } from "drizzle-orm";
import { db, leads, contacts, leadFeatures, events, tenants } from "@/server/db";
import { scoreLeadFeatures } from "@/server/learning/scorer";
import { fitUpliftModel, scoreUplift, type UpliftScore } from "@/server/learning/incrementality";
import { canInitiateOutbound } from "@/server/core/guardrails";

/**
 * FEATURE 1 — dormant lead reactivation.
 *
 * Every business is sitting on months of leads that never converted. The
 * scoring model ranks them by predicted conversion, so the owner gets a short
 * ranked list each morning rather than a spreadsheet of 400 names.
 *
 * Every row carries its contactability verdict. A lead that cannot lawfully be
 * contacted is still shown — but marked, so nobody texts it by accident.
 */
export type ReactivationCandidate = {
  leadId: string;
  contactId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  service: string | null;
  daysDormant: number;
  score: number;
  basis: string;
  topFactors: string[];
  /** Channels this contact may lawfully be approached on right now. */
  contactableVia: string[];
  blockedReason?: string;

  /* Incrementality — the reason to call THIS person rather than a likelier one. */
  uplift: number;
  segment: UpliftScore["segment"];
  upliftFallback: boolean;
  /** Expected incremental value: uplift x job value. The actual ranking key. */
  expectedValue: number;
};

/** Fallback job value when a lead carries no estimate. */
const DEFAULT_JOB_VALUE = 450;

export async function buildReactivationList(
  tenantId: string,
  opts: { minDaysDormant?: number; limit?: number } = {},
): Promise<ReactivationCandidate[]> {
  const minDays = opts.minDaysDormant ?? 14;
  const limit = opts.limit ?? 20;
  const cutoff = new Date(Date.now() - minDays * 86400_000);

  // One uplift model per tenant, reused across every candidate.
  const uplift = await fitUpliftModel(tenantId);

  const dormant = await db.query.leads.findMany({
    where: and(
      eq(leads.tenantId, tenantId),
      inArray(leads.status, ["new", "qualified", "unqualified"]),
      lt(leads.updatedAt, cutoff),
    ),
    orderBy: desc(leads.updatedAt),
    limit: 300,
  });

  const out: ReactivationCandidate[] = [];

  for (const lead of dormant) {
    const [features, contact] = await Promise.all([
      db.query.leadFeatures.findFirst({ where: eq(leadFeatures.leadId, lead.id) }),
      db.query.contacts.findFirst({ where: eq(contacts.id, lead.contactId) }),
    ]);
    if (!contact) continue;

    const scored = features ? await scoreLeadFeatures(features) : null;
    const up = features
      ? scoreUplift(uplift, features, scored?.probability ?? 0.3)
      : { uplift: 0, pTreated: null, pUntreated: null, segment: "unknown" as const, fallback: true };

    // Ranking key, mirroring an ad auction's total value: how much the
    // outcome moves BECAUSE we called, times what the job is worth.
    const jobValue = Number(lead.estimatedValue ?? 0) || DEFAULT_JOB_VALUE;
    const expectedValue = up.uplift * jobValue;

    const contactableVia: string[] = [];
    let blockedReason: string | undefined;

    for (const channel of ["sms", "email"] as const) {
      const verdict = canInitiateOutbound(channel, contact);
      if (verdict.ok) contactableVia.push(channel);
      else blockedReason ??= verdict.reason;
    }
    // A phone call by a human is always permitted to an existing enquirer;
    // an AI-voice outbound call is not (TCPA treats it as an artificial voice).
    if (contact.primaryPhone && !contact.doNotContact) contactableVia.push("human_call");

    out.push({
      leadId: lead.id,
      contactId: contact.id,
      name: contact.displayName,
      phone: contact.primaryPhone,
      email: contact.primaryEmail,
      service: lead.service,
      daysDormant: Math.floor((Date.now() - lead.updatedAt.getTime()) / 86400_000),
      score: scored?.score ?? lead.score,
      basis: scored?.basis ?? "lead_score",
      topFactors: scored?.topFactors.map((f) => f.feature) ?? [],
      contactableVia,
      blockedReason: contactableVia.length === 0 ? blockedReason : undefined,
      uplift: up.uplift,
      segment: up.segment,
      upliftFallback: up.fallback,
      expectedValue,
    });
  }

  // Never spend outreach on people it would push away.
  const worthContacting = out.filter((c) => c.segment !== "do_not_disturb");

  return worthContacting
    .sort((a, b) => b.expectedValue - a.expectedValue)
    .slice(0, limit);
}

/** Record that the owner was shown the list, for the ROI dashboard. */
export async function logReactivationRun(tenantId: string, candidates: ReactivationCandidate[]) {
  await db.insert(events).values({
    tenantId,
    type: "reactivation_list_generated",
    payload: {
      count: candidates.length,
      contactable: candidates.filter((c) => c.contactableVia.length > 0).length,
      topScore: candidates[0]?.score ?? 0,
    },
  });
}
