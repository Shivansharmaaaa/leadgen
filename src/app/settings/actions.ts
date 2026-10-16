"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/server/auth/owner";
import {
  addWebhook, disableIntake, getTenant, removeStaff, removeWebhook, rotateIntakeKey, setSourceSpend, setWebchatOrigins,
  updateBusiness, upsertStaff,
} from "@/server/settings";

/** What a form shows after submitting: an error, or something to copy once. */
export type ActionState = { error?: string; saved?: string; reveal?: string } | undefined;

async function tenantOrThrow() {
  await requireOwner();
  const tenant = await getTenant();
  if (!tenant) throw new Error("tenant not found — run npm run seed");
  return tenant;
}

const done = (saved: string, reveal?: string): ActionState => {
  revalidatePath("/settings");
  return { saved, reveal };
};

export async function saveBusiness(_: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenantOrThrow();
  const r = await updateBusiness(t.id, {
    businessName: String(form.get("businessName") ?? ""),
    agentName: String(form.get("agentName") ?? ""),
    asrContext: String(form.get("asrContext") ?? ""),
  });
  return r.ok ? done("Saved.") : { error: r.error };
}

export async function saveStaff(_: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenantOrThrow();
  const r = await upsertStaff(t.id, {
    id: String(form.get("id") ?? "") || undefined,
    name: String(form.get("name") ?? ""),
    email: String(form.get("email") ?? ""),
    phone: String(form.get("phone") ?? ""),
    role: String(form.get("role") ?? ""),
    alerts: form.get("alerts") === "on",
    onCall: form.get("onCall") === "on",
  }, t.country);
  return r.ok ? done("Saved.") : { error: r.error };
}

export async function deleteStaff(form: FormData): Promise<void> {
  const t = await tenantOrThrow();
  await removeStaff(t.id, String(form.get("id")));
  revalidatePath("/settings");
}

export async function newIntakeKey(_: ActionState): Promise<ActionState> {
  const t = await tenantOrThrow();
  const r = await rotateIntakeKey(t.id);
  return r.ok ? done("New key created. The old one stops working now.", r.value) : { error: "Couldn't create a key." };
}

export async function turnOffIntake(_: ActionState): Promise<ActionState> {
  const t = await tenantOrThrow();
  await disableIntake(t.id);
  return done("Lead intake is off.");
}

export async function saveOrigins(_: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenantOrThrow();
  const r = await setWebchatOrigins(t.id, String(form.get("origins") ?? ""));
  return r.ok ? done(r.value?.length ? `Allowed: ${r.value.join(", ")}` : "No sites allowed yet.") : { error: r.error };
}

export async function saveWebhook(_: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenantOrThrow();
  const r = await addWebhook(t.id, String(form.get("url") ?? ""), form.getAll("events").map(String));
  return r.ok ? done("Added. Copy the signing secret now; it won't be shown again.", r.value) : { error: r.error };
}

export async function deleteWebhook(form: FormData): Promise<void> {
  const t = await tenantOrThrow();
  await removeWebhook(t.id, String(form.get("url")));
  revalidatePath("/settings");
}

export async function saveSpend(_: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenantOrThrow();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("spend:")) raw[k.slice(6)] = String(v);
  const r = await setSourceSpend(t.id, raw);
  return r.ok ? done("Saved. Cost per booked job is on the dashboard.") : { error: r.error };
}
