"use client";

import { useActionState } from "react";
import { launchCampaign } from "./actions";

/** Starts a reactivation campaign: a random ~15% are held back to prove it works. */
export function CampaignButton({ contactable }: { contactable: number }) {
  const [state, action, pending] = useActionState(launchCampaign, undefined);
  const r = state?.report;
  return (
    <form action={action} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
      <label style={{ fontSize: 13, color: "var(--muted)" }}>
        Text the top{" "}
        <input name="limit" type="number" min={1} max={200} defaultValue={Math.min(25, Math.max(1, contactable))}
               style={{ width: 64, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text)" }} />
        {" "}who agreed to hear from you
      </label>
      <button disabled={pending || contactable === 0} style={{
        padding: "6px 12px", borderRadius: 8, border: 0, background: "var(--accent)", color: "#fff", fontWeight: 600,
        cursor: "pointer", opacity: pending || contactable === 0 ? 0.5 : 1,
      }}>{pending ? "Starting…" : "Start campaign"}</button>
      {state?.error && <span style={{ color: "var(--danger)", fontSize: 13 }}>{state.error}</span>}
      {r && (
        <span role="status" style={{ fontSize: 13, color: "var(--accent)" }}>
          {r.treatment} will be messaged{r.firstSendAt ? ` from ${new Date(r.firstSendAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""},
          {" "}{r.holdout} held back to measure the difference{r.alreadyInCampaign ? `, ${r.alreadyInCampaign} already in today's campaign` : ""}.
          {r.skipped.length ? ` Skipped: ${r.skipped.map((s) => `${s.count} (${s.reason})`).join(", ")}.` : ""}
        </span>
      )}
    </form>
  );
}
