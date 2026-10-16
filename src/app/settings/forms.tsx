"use client";

import { useActionState } from "react";
import {
  saveBusiness, saveStaff, newIntakeKey, turnOffIntake, saveOrigins, saveWebhook, type ActionState,
} from "./actions";

const input: React.CSSProperties = {
  padding: "8px 10px", fontSize: 14, borderRadius: 8, border: "1px solid var(--border)",
  background: "var(--panel-2)", color: "var(--text)", width: "100%",
};
const label: React.CSSProperties = { fontSize: 12, color: "var(--muted)", display: "block", marginBottom: 4 };
const button: React.CSSProperties = {
  padding: "8px 14px", fontSize: 14, fontWeight: 600, borderRadius: 8, border: 0,
  background: "var(--accent)", color: "#fff", cursor: "pointer",
};
const quiet: React.CSSProperties = { ...button, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" };

function Status({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <div role="status" style={{ marginTop: 8, fontSize: 13 }}>
      {state.error && <span style={{ color: "var(--danger)" }}>{state.error}</span>}
      {state.saved && <span style={{ color: "var(--accent)" }}>{state.saved}</span>}
      {state.reveal && (
        <code style={{ display: "block", marginTop: 6, padding: "8px 10px", background: "var(--panel-2)",
                       borderRadius: 6, wordBreak: "break-all", userSelect: "all" }}>{state.reveal}</code>
      )}
    </div>
  );
}

export function BusinessForm(p: { businessName: string; agentName: string; asrContext: string }) {
  const [state, action, pending] = useActionState(saveBusiness, undefined);
  return (
    <form action={action} style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <div><label style={label} htmlFor="bn">Business name</label>
          <input id="bn" name="businessName" defaultValue={p.businessName} style={input} required /></div>
        <div><label style={label} htmlFor="an">The assistant's name</label>
          <input id="an" name="agentName" defaultValue={p.agentName} style={input} required /></div>
      </div>
      <div><label style={label} htmlFor="asr">What speech recognition gets wrong in your trade (read on calls)</label>
        <textarea id="asr" name="asrContext" defaultValue={p.asrContext} rows={2} style={{ ...input, resize: "vertical" }}
          placeholder="this is a heating and cooling business: 'an answer' is almost certainly 'an AC'" /></div>
      <div><button style={button} disabled={pending}>{pending ? "Saving…" : "Save"}</button></div>
      <Status state={state} />
    </form>
  );
}

export function StaffForm(p: {
  id?: string; name?: string; email?: string; phone?: string | null; role?: string; alerts?: boolean; onCall?: boolean;
}) {
  const [state, action, pending] = useActionState(saveStaff, undefined);
  return (
    <form action={action} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, alignItems: "end" }}>
      {p.id && <input type="hidden" name="id" value={p.id} />}
      <div><label style={label}>Name</label><input name="name" defaultValue={p.name} style={input} required aria-label="Name" /></div>
      <div><label style={label}>Email</label><input name="email" type="email" defaultValue={p.email} style={input} required aria-label="Email" /></div>
      <div><label style={label}>Mobile for alerts</label><input name="phone" defaultValue={p.phone ?? ""} style={input} placeholder="(617) 555-0100" aria-label="Mobile" /></div>
      <div><label style={label}>Role</label><input name="role" defaultValue={p.role ?? "tech"} style={input} aria-label="Role" /></div>
      <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" name="alerts" defaultChecked={p.alerts ?? true} /> Handover texts</label>
      <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" name="onCall" defaultChecked={p.onCall ?? false} /> On call (emergencies)</label>
      <div><button style={p.id ? quiet : button} disabled={pending}>{pending ? "…" : p.id ? "Update" : "Add"}</button></div>
      <div style={{ gridColumn: "1 / -1" }}><Status state={state} /></div>
    </form>
  );
}

export function IntakePanel({ enabled, endpoint }: { enabled: boolean; endpoint: string }) {
  const [rotated, rotate, rotating] = useActionState(newIntakeKey, undefined);
  const [off, turnOff, turningOff] = useActionState(turnOffIntake, undefined);
  return (
    <div>
      <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 8px" }}>
        {enabled ? "On." : "Off: no key yet."} Send leads from your website form, Zapier, Angi or Thumbtack to
      </p>
      <code style={{ display: "block", padding: "8px 10px", background: "var(--panel-2)", borderRadius: 6, fontSize: 13, wordBreak: "break-all" }}>
        POST {endpoint} with header x-intake-key: &lt;key&gt;
      </code>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <form action={rotate}><button style={button} disabled={rotating}>{enabled ? "Replace the key" : "Create a key"}</button></form>
        {enabled && <form action={turnOff}><button style={quiet} disabled={turningOff}>Turn off</button></form>}
      </div>
      <Status state={rotated ?? off} />
    </div>
  );
}

export function OriginsForm({ origins }: { origins: string[] }) {
  const [state, action, pending] = useActionState(saveOrigins, undefined);
  return (
    <form action={action} style={{ display: "grid", gap: 8 }}>
      <label style={label} htmlFor="origins">Your websites (one per line), so only they can embed the chat</label>
      <textarea id="origins" name="origins" rows={2} defaultValue={origins.join("\n")} style={{ ...input, resize: "vertical" }}
        placeholder="https://www.yourbusiness.com" />
      <div><button style={button} disabled={pending}>Save</button></div>
      <Status state={state} />
    </form>
  );
}

export function WebhookForm({ events }: { events: readonly string[] }) {
  const [state, action, pending] = useActionState(saveWebhook, undefined);
  return (
    <form action={action} style={{ display: "grid", gap: 8 }}>
      <label style={label} htmlFor="hook">Add an endpoint (your CRM, a Zapier "Catch Hook", Make)</label>
      <input id="hook" name="url" style={input} placeholder="https://hooks.zapier.com/hooks/catch/…" required />
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
        <legend style={label}>Events (none ticked = all)</legend>
        {events.map((e) => (
          <label key={e} style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" name="events" value={e} /> {e}
          </label>
        ))}
      </fieldset>
      <div><button style={button} disabled={pending}>{pending ? "Checking…" : "Add endpoint"}</button></div>
      <Status state={state} />
    </form>
  );
}
