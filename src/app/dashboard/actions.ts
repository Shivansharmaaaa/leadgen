"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/server/auth/owner";
import { launchReactivation, type LaunchReport } from "@/server/features/campaigns";
import { recordAppointmentOutcome, setLeadOutcome, type Outcome } from "@/server/features/appointment-outcomes";
import { getTenant } from "@/server/settings";

export type LaunchState = { error?: string; report?: LaunchReport } | undefined;

export async function launchCampaign(_: LaunchState, form: FormData): Promise<LaunchState> {
  await requireOwner();
  const tenant = await getTenant();
  if (!tenant) return { error: "No tenant." };
  const limit = Number(form.get("limit") ?? 25);
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) return { error: "Choose between 1 and 200 people." };
  const report = await launchReactivation(tenant.id, { limit });
  revalidatePath("/dashboard");
  return { report };
}

export async function closeJob(form: FormData): Promise<void> {
  await requireOwner();
  const tenant = await getTenant();
  if (!tenant) return;
  const outcome = String(form.get("outcome")) as Outcome;
  if (!["completed", "no_show", "cancelled"].includes(outcome)) return;
  await recordAppointmentOutcome(tenant.id, String(form.get("appointmentId")), outcome, "owner via dashboard");
  revalidatePath("/dashboard");
}

export async function markLead(form: FormData): Promise<void> {
  await requireOwner();
  const tenant = await getTenant();
  if (!tenant) return;
  const outcome = String(form.get("outcome"));
  if (outcome !== "won" && outcome !== "lost") return;
  await setLeadOutcome(tenant.id, String(form.get("leadId")), outcome, "owner via dashboard");
  revalidatePath("/dashboard");
}
