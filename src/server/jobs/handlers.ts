import { and, eq, lt, isNotNull } from "drizzle-orm";
import { db, jobs, tenants, leads, appointments, conversations, messages } from "@/server/db";
import { sendReviewRequest } from "@/server/features/reviews";
import { sendAppointmentReminder } from "@/server/features/reminders";
import { alertStaff, type AlertUrgency } from "@/server/features/staff-alerts";
import { deliverWebhook } from "@/server/features/webhooks";
import { buildReactivationList, logReactivationRun } from "@/server/features/reactivation";
import { buildConversionEvent, sendToMetaCapi } from "@/server/features/conversions";
import { extractFeaturesForLead, labelLead } from "@/server/learning/features";
import { labelWithDelayCorrection } from "@/server/learning/delayed-feedback";
import { assignCohort, measureLift } from "@/server/learning/incrementality";
import { trainScope } from "@/server/learning/train";
import { seedPriorIfMissing } from "@/server/learning/prior";
import { deliver } from "@/server/core/ingest";

export type JobHandler = (payload: Record<string, unknown>, tenantId: string | null) => Promise<unknown>;

/**
 * Everything that happens on a timer rather than in response to a message.
 * Without this loop the review requests, follow-ups and model training that
 * other modules schedule would sit in the jobs table forever.
 */
export const HANDLERS: Record<string, JobHandler> = {
  async review_request(payload) {
    return sendReviewRequest(String(payload.appointmentId));
  },

  async appointment_reminder(payload) {
    return sendAppointmentReminder(payload);
  },

  /** One signed POST to a tenant's CRM / Zapier URL; throws to retry with backoff. */
  async webhook_delivery(payload, tenantId) {
    return deliverWebhook(payload, tenantId);
  },

  /** A non-urgent handover that came in after hours, delivered at opening time. */
  async staff_alert(payload, tenantId) {
    if (!tenantId) return { skipped: "no tenant" };
    return alertStaff({
      tenantId, conversationId: String(payload.conversationId), reason: String(payload.reason),
      urgency: payload.urgency as AlertUrgency, deferred: true,
    });
  },

  /** Re-offer a slot once when a booking conversation goes quiet. Never nag. */
  async followup_message(payload, tenantId) {
    if (!tenantId) return { skipped: "no tenant" };
    const conversationId = String(payload.conversationId);

    const convo = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
    if (!convo || convo.aiPaused || convo.status !== "open") {
      return { skipped: "conversation closed or taken over" };
    }

    // If they replied since this was scheduled, drop it.
    const recent = await db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
    });
    const lastInbound = recent.filter((m) => m.direction === "inbound").pop();
    if (lastInbound && lastInbound.createdAt > new Date(String(payload.scheduledAt))) {
      return { skipped: "customer already replied" };
    }

    const alreadyFollowedUp = recent.some((m) => m.meta?.followUp === true);
    if (alreadyFollowedUp) return { skipped: "already followed up once" };

    const sent = await deliver({
      tenantId,
      conversationId,
      channel: convo.channel,
      to: { channel: convo.channel, externalId: String(payload.to) },
      body: String(payload.body),
      // What alreadyFollowedUp looks for. Nothing ever set it, so the
      // "follow up once, never nag" guard above could not fire.
      meta: { followUp: true },
    });
    return { sent };
  },

  async reactivation_digest(_payload, tenantId) {
    if (!tenantId) return { skipped: "no tenant" };
    const list = await buildReactivationList(tenantId, { minDaysDormant: 14, limit: 20 });
    await logReactivationRun(tenantId, list);
    return { candidates: list.length, contactable: list.filter((c) => c.contactableVia.length).length };
  },

  async push_conversion(payload, tenantId) {
    if (!tenantId) return { skipped: "no tenant" };
    const built = await buildConversionEvent(String(payload.appointmentId), "Schedule");
    if (!built) return { skipped: "appointment not found" };
    return sendToMetaCapi(built.tenantId, built.event);
  },

  async extract_features(payload) {
    await extractFeaturesForLead(String(payload.leadId));
    return { ok: true };
  },

  /**
   * Close the learning loop, delay-aware.
   *
   * Replaces the naive "unconverted after 30 days = negative" rule, which
   * over-counted losses and biased the model against slow-deciding high-value
   * jobs. Leads still inside the conversion window are left unlabelled rather
   * than guessed at.
   */
  async label_outcomes(_payload, tenantId) {
    if (!tenantId) return { skipped: "no tenant" };
    return labelWithDelayCorrection(tenantId);
  },

  /**
   * Build the call-back list AND assign cohorts, so a holdout exists to
   * measure against. Without the holdout there is no uplift model and no
   * honest answer to "did this work".
   */
  async reactivation_campaign(payload, tenantId) {
    if (!tenantId) return { skipped: "no tenant" };
    const campaign = String(payload.campaign ?? `reactivation_${new Date().toISOString().slice(0, 10)}`);
    const list = await buildReactivationList(tenantId, { minDaysDormant: 14, limit: 100 });

    let treatment = 0, holdout = 0;
    for (const c of list) {
      if (c.contactableVia.length === 0) continue;
      const cohort = await assignCohort({
        tenantId, contactId: c.contactId, leadId: c.leadId,
        campaign, score: c.score,
      });
      if (cohort === "treatment") treatment++;
      else if (cohort === "holdout") holdout++;
    }
    await logReactivationRun(tenantId, list);
    return { campaign, treatment, holdout, segments: summarise(list) };
  },

  async measure_campaign(payload, tenantId) {
    if (!tenantId) return { skipped: "no tenant" };
    const report = await measureLift(tenantId, String(payload.campaign));
    return report ?? { skipped: "no assignments for that campaign" };
  },

  /** Nightly retrain of the pooled and per-tenant models. */
  async train_models(payload) {
    const vertical = String(payload.vertical ?? "home_services");
    const country = String(payload.country ?? "US");
    await seedPriorIfMissing(vertical, country);
    const results = await trainScope(vertical, country);
    return {
      models: results.length,
      scopes: results.map((r) => ({
        scope: r.scope === "global" ? "pooled" : "tenant",
        n: r.model?.sampleSize ?? 0,
        auc: r.model?.auc ?? null,
      })),
    };
  },
};

/** Schedule a job, deduplicated by key. */
export async function enqueue(args: {
  type: keyof typeof HANDLERS | string;
  tenantId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  idempotencyKey?: string;
  maxAttempts?: number;
}) {
  await db.insert(jobs).values({
    tenantId: args.tenantId ?? null,
    type: args.type,
    payload: args.payload ?? {},
    runAt: args.runAt ?? new Date(),
    idempotencyKey: args.idempotencyKey ?? null,
    maxAttempts: args.maxAttempts ?? 5,
  }).onConflictDoNothing();
}

function summarise(list: { segment: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of list) out[c.segment] = (out[c.segment] ?? 0) + 1;
  return out;
}
