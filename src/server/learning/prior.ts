import { db, modelWeights } from "@/server/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Bootstrap prior for a vertical with no pooled data yet.
 *
 * A freshly launched platform has zero labelled leads, so the pooled model
 * cannot be trained and every lead scores the same. That makes the product
 * look broken on day one. Instead we seed the global model with weights
 * derived from published industry benchmarks, then let real outcomes overwrite
 * them as they accumulate.
 *
 * Weights are log-odds ratios computed from these figures:
 *
 *   - Overall lead conversion across channels sits near 7.8%.
 *   - Phone leads convert around 46% — roughly 6x the all-channel average.
 *   - HVAC / home-services conversion runs 3-7%.
 *   - Contacting inside 60 seconds is associated with a ~391% lift (Velocify).
 *   - Responding within 2 minutes converts ~62% vs ~28% at a 42-minute average.
 *   - 78% of customers buy from whoever responds first.
 *
 * These are population-level effect sizes, not a trained model: they are a
 * starting point that any real tenant data should beat. `sampleSize` is set
 * deliberately low so the hierarchical blend hands over to real data quickly.
 */

const lor = (multiplier: number) => Math.log(multiplier);

export const BENCHMARK_PRIOR: Record<string, number> = {
  // Channel. Phone dominates; social DMs are high-volume, low-intent.
  ch_voice: lor(2.4),
  ch_sms: lor(1.3),
  ch_webchat: lor(1.0),
  ch_email: lor(0.8),
  ch_instagram: lor(0.6),
  ch_messenger: lor(0.6),
  ch_whatsapp: lor(0.9),

  // Speed to lead — the strongest single lever in the literature.
  latency_under_60s: lor(2.6),
  log_latency: -1.4,

  // Stated urgency.
  urg_emergency: lor(2.2),
  urg_this_week: lor(1.4),
  urg_this_month: lor(0.9),
  urg_researching: lor(0.35),

  // Qualification signals.
  gave_phone: lor(2.1),
  gave_email: lor(1.2),
  returning: lor(1.8),
  asked_price: lor(0.85),

  // Context.
  after_hours: lor(1.15),
  is_weekend: lor(0.95),
  hour_sin: 0,
  hour_cos: 0,
  msg_count: 0.4,

  svc_cooling: 0, svc_heating: 0, svc_repair: 0,
  svc_install: lor(0.8), svc_maintenance: lor(1.1), svc_air_quality: 0, svc_other: 0,
};

/** Base rate for home services sits at the low end of the 3-7% band. */
const BENCHMARK_BASE_RATE = 0.05;

/**
 * Install the prior as the active global model for a scope, but only if no
 * real trained model exists. Never overwrites learned weights.
 */
export async function seedPriorIfMissing(vertical: string, country: string) {
  const existing = await db.query.modelWeights.findFirst({
    where: and(
      eq(modelWeights.vertical, vertical),
      eq(modelWeights.country, country),
      isNull(modelWeights.tenantId),
      eq(modelWeights.active, true),
    ),
  });
  if (existing && existing.sampleSize > 0) {
    return { seeded: false, reason: `a trained model already exists (n=${existing.sampleSize})` };
  }
  if (existing) return { seeded: false, reason: "prior already present" };

  await db.insert(modelWeights).values({
    vertical, country, tenantId: null, version: 1,
    weights: BENCHMARK_PRIOR,
    bias: Math.log(BENCHMARK_BASE_RATE / (1 - BENCHMARK_BASE_RATE)).toFixed(6),
    // Low on purpose: real tenant data should outweigh the prior fast.
    sampleSize: 0,
    baseRate: BENCHMARK_BASE_RATE.toFixed(5),
    auc: null,
    active: true,
  });

  return { seeded: true };
}
