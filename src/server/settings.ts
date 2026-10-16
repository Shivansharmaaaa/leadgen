import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, staff, tenants, type TenantSettings } from "@/server/db";
import { normalizePhone } from "@/server/core/phone";
import { assertPublicHttps, WEBHOOK_EVENTS } from "@/server/features/webhooks";

/**
 * What an owner can change from /settings, validated here so the page, a
 * script and a test all go through the same rules. Every function returns
 * an error message rather than throwing, because each one ends up as a line
 * of text next to a form field.
 */

export type Result<T = undefined> = { ok: true; value?: T } | { ok: false; error: string; value?: undefined };

/** The tenant the single-owner UI manages; one deployment, one business for now. */
export function currentTenantSlug(): string {
  return process.env.TENANT_SLUG ?? "northside-hvac";
}

export async function getTenant(slug = currentTenantSlug()) {
  return db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
}

async function patchSettings(tenantId: string, patch: Partial<TenantSettings>) {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!t) throw new Error("tenant not found");
  await db.update(tenants).set({ settings: { ...(t.settings ?? {}), ...patch } }).where(eq(tenants.id, tenantId));
}

export async function updateBusiness(tenantId: string, input: {
  businessName?: string; agentName?: string; asrContext?: string;
}): Promise<Result> {
  const businessName = input.businessName?.trim();
  const agentName = input.agentName?.trim();
  if (businessName !== undefined && (businessName.length < 2 || businessName.length > 80)) {
    return { ok: false, error: "Business name should be 2–80 characters." };
  }
  if (agentName !== undefined && (agentName.length < 1 || agentName.length > 30)) {
    return { ok: false, error: "Agent name should be 1–30 characters." };
  }
  const asr = input.asrContext?.trim();
  if (asr && asr.length > 400) return { ok: false, error: "Keep speech hints under 400 characters." };
  await patchSettings(tenantId, {
    ...(businessName !== undefined ? { businessName } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
    ...(input.asrContext !== undefined ? { asrContext: asr || undefined } : {}),
  });
  return { ok: true };
}

export async function upsertStaff(tenantId: string, input: {
  id?: string; name: string; email: string; phone?: string; role?: string; alerts?: boolean; onCall?: boolean;
}, country = "US"): Promise<Result> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) return { ok: false, error: "Name is required." };
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return { ok: false, error: "That email doesn't look right." };
  let phone: string | null = null;
  if (input.phone?.trim()) {
    phone = normalizePhone(input.phone, country);
    if (!phone) return { ok: false, error: `Couldn't read "${input.phone}" as a phone number.` };
  }
  const values = {
    name, email, phone, role: input.role?.trim() || "tech",
    alerts: input.alerts ?? true, onCall: input.onCall ?? false,
  };
  try {
    if (input.id) {
      await db.update(staff).set(values).where(and(eq(staff.id, input.id), eq(staff.tenantId, tenantId)));
    } else {
      await db.insert(staff).values({ tenantId, ...values });
    }
  } catch (err) {
    if (String(err).includes("staff_tenant_email_idx")) return { ok: false, error: `${email} is already on the team.` };
    throw err;
  }
  return { ok: true };
}

export async function removeStaff(tenantId: string, id: string): Promise<Result> {
  await db.delete(staff).where(and(eq(staff.id, id), eq(staff.tenantId, tenantId)));
  return { ok: true };
}

/** A new intake key replaces the old one at once: anything still using it gets 401. */
export async function rotateIntakeKey(tenantId: string): Promise<Result<string>> {
  const key = `lk_${randomBytes(24).toString("base64url")}`;
  await patchSettings(tenantId, { intakeKey: key });
  return { ok: true, value: key };
}

export async function disableIntake(tenantId: string): Promise<Result> {
  await patchSettings(tenantId, { intakeKey: undefined });
  return { ok: true };
}

/** One origin per line or comma. https only, except a local dev server. */
export async function setWebchatOrigins(tenantId: string, raw: string): Promise<Result<string[]>> {
  const origins: string[] = [];
  for (const piece of raw.split(/[\s,]+/).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(piece);
    } catch {
      return { ok: false, error: `"${piece}" isn't a web address. Use the full form, like https://example.com` };
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
      return { ok: false, error: `${piece} must start with https://` };
    }
    origins.push(u.origin);
  }
  const unique = [...new Set(origins)];
  await patchSettings(tenantId, { webchatOrigins: unique.length ? unique : undefined });
  return { ok: true, value: unique };
}

/** The secret is shown once, when the endpoint is added; after that only its prefix. */
export async function addWebhook(tenantId: string, url: string, events: string[]): Promise<Result<string>> {
  const trimmed = url.trim();
  try {
    await assertPublicHttps(trimmed);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "That URL can't be used." };
  }
  const unknown = events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (unknown.length) return { ok: false, error: `Unknown event(s): ${unknown.join(", ")}` };
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const existing = t?.settings?.webhooks ?? [];
  if (existing.some((w) => w.url === trimmed)) return { ok: false, error: "That URL is already registered." };
  if (existing.length >= 5) return { ok: false, error: "Five endpoints at most; remove one first." };
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  await patchSettings(tenantId, { webhooks: [...existing, { url: trimmed, secret, events: events.length ? events : undefined }] });
  return { ok: true, value: secret };
}

export async function removeWebhook(tenantId: string, url: string): Promise<Result> {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  await patchSettings(tenantId, { webhooks: (t?.settings?.webhooks ?? []).filter((w) => w.url !== url) });
  return { ok: true };
}

/** Monthly spend per lead source. Blank removes it; nothing negative or absurd. */
export async function setSourceSpend(tenantId: string, raw: Record<string, string>): Promise<Result<Record<string, number>>> {
  const spend: Record<string, number> = {};
  for (const [source, value] of Object.entries(raw)) {
    const v = value.trim().replace(/[$,£\s]/g, "");
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return { ok: false, error: `"${value}" for ${source} isn't an amount.` };
    if (!/^[a-z_]{2,40}$/.test(source)) return { ok: false, error: `Unknown source ${source}.` };
    spend[source] = Math.round(n * 100) / 100;
  }
  await patchSettings(tenantId, { sourceSpend: Object.keys(spend).length ? spend : undefined });
  return { ok: true, value: spend };
}
