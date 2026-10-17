import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, staff } from "@/server/db";
import { getTenant } from "@/server/settings";
import { WEBHOOK_EVENTS } from "@/server/features/webhooks";
import { recommendedConsentWording } from "@/server/features/lead-intake";
import { deleteStaff, deleteWebhook } from "./actions";
import { BusinessForm, CalendarPanel, IntakePanel, OriginsForm, SpendForm, StaffForm, WebhookForm } from "./forms";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const tenant = await getTenant();
  if (!tenant) {
    return <main style={{ maxWidth: 600, margin: "0 auto", padding: 64 }}><h1>No tenant found</h1>
      <p style={{ color: "var(--muted)" }}>Run <code>npm run seed</code>.</p></main>;
  }
  const s = tenant.settings ?? {};
  const team = await db.query.staff.findMany({ where: eq(staff.tenantId, tenant.id) });
  const app = (process.env.APP_URL ?? "http://localhost:3100").replace(/\/$/, "");
  const nobodyReachable = !team.some((m) => m.phone && m.alerts);
  const nobodyOnCall = !team.some((m) => m.phone && m.alerts && m.onCall);

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px 100px" }}>
      <Link href="/dashboard" style={{ color: "var(--muted)", fontSize: 13, textDecoration: "none" }}>← dashboard</Link>
      <h1 style={{ fontSize: 26, margin: "8px 0 28px" }}>Settings</h1>

      <Section title="Business">
        <BusinessForm businessName={s.businessName ?? tenant.name} agentName={s.agentName ?? "Alex"} asrContext={s.asrContext ?? ""} />
      </Section>

      <Section title="Team" hint="Who gets a text when the assistant hands a conversation over. Emergencies go to whoever is on call, at any hour; everything else waits for opening time.">
        {nobodyReachable && <Warn>Nobody will be alerted: add a mobile number for at least one person.</Warn>}
        {!nobodyReachable && nobodyOnCall && <Warn>Nobody is on call, so emergencies after hours go to everyone with alerts on.</Warn>}
        <div style={{ display: "grid", gap: 14 }}>
          {team.map((m) => (
            <div key={m.id} style={{ padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              <StaffForm id={m.id} name={m.name} email={m.email} phone={m.phone} role={m.role} alerts={m.alerts} onCall={m.onCall} />
              <form action={deleteStaff} style={{ marginTop: 6 }}>
                <input type="hidden" name="id" value={m.id} />
                <button style={{ background: "none", border: 0, color: "var(--muted)", fontSize: 12, cursor: "pointer", padding: 0 }}>Remove {m.name}</button>
              </form>
            </div>
          ))}
          <div style={{ padding: 12, border: "1px dashed var(--border)", borderRadius: "var(--radius)" }}>
            <StaffForm />
          </div>
        </div>
      </Section>

      <Section title="Lead intake" hint="Leads from forms and marketplaces get a reply in seconds. Texting needs the form's consent wording to name your business; the dashboard tells you if it doesn't.">
        <IntakePanel enabled={Boolean(s.intakeKey)} endpoint={`${app}/api/leads?tenant=${tenant.slug}`} />
        <p style={{ fontSize: 13, color: "var(--muted)", margin: "18px 0 6px" }}>
          Put this next to an unticked checkbox on your form, so leads can be texted straight away:
        </p>
        <code style={{ display: "block", padding: "10px 12px", background: "var(--panel-2)", borderRadius: 6, fontSize: 13, whiteSpace: "pre-wrap", userSelect: "all" }}>
          {recommendedConsentWording(s.businessName ?? tenant.name)}
        </code>
        <details style={{ marginTop: 12, fontSize: 13 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Example request for your web developer</summary>
          <code style={{ display: "block", padding: "10px 12px", background: "var(--panel-2)", borderRadius: 6, fontSize: 12, whiteSpace: "pre-wrap", marginTop: 8 }}>
            {`POST ${app}/api/leads?tenant=${tenant.slug}
x-intake-key: <your key>
content-type: application/json

{
  "source": "website",
  "externalId": "<your form's submission id>",
  "name": "Priya Patel",
  "phone": "(617) 555-0142",
  "service": "AC repair",
  "message": "AC is blowing warm air",
  "consent": {
    "sms": true,
    "language": "<the exact wording shown next to the box>",
    "pageUrl": "https://www.yoursite.com/contact"
  }
}`}
          </code>
        </details>
      </Section>

      <Section title="Website chat" hint="Paste this before </body> on your site.">
        <code style={{ display: "block", padding: "10px 12px", background: "var(--panel-2)", borderRadius: 6, fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 14 }}>
          {`<script src="${app}/widget.js" data-tenant="${tenant.slug}" data-name="${attr(s.businessName ?? tenant.name)}" async></script>`}
        </code>
        <OriginsForm origins={s.webchatOrigins ?? []} />
      </Section>

      <Section title="Jobs in your calendar" hint="Subscribe to this link in Google Calendar (Other calendars → From URL), Apple Calendar or Outlook, and every booking appears with the customer's name and number. It carries customer details: share it only with your team.">
        <CalendarPanel url={s.calendarToken ? `${app}/api/calendar/${s.calendarToken}.ics` : null} />
      </Section>

      <Section title="What you pay for leads" hint="Monthly spend per source. The dashboard turns it into cost per lead and cost per booked job, so you can see which sources are worth it.">
        <SpendForm spend={s.sourceSpend ?? {}} sources={[
          { key: "google_lsa", label: "Google Local Services" }, { key: "angi", label: "Angi" },
          { key: "thumbtack", label: "Thumbtack" }, { key: "facebook_lead_ad", label: "Facebook lead ads" },
          { key: "website", label: "Website / SEO" }, { key: "voice", label: "Phone (ads, listings)" },
        ]} />
      </Section>

      <Section title="Send to your CRM" hint="Every new lead, booking, confirmation, reschedule, handover and opt-out is posted as signed JSON. Check the x-leadgen-signature header with your signing secret.">
        {(s.webhooks ?? []).length > 0 && (
          <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
            {(s.webhooks ?? []).map((w) => (
              <div key={w.url} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 }}>
                <span style={{ wordBreak: "break-all" }}>{w.url}</span>
                <span style={{ color: "var(--muted)" }}>{w.events?.length ? w.events.join(", ") : "all events"} · secret {w.secret.slice(0, 10)}…</span>
                <form action={deleteWebhook} style={{ marginLeft: "auto" }}>
                  <input type="hidden" name="url" value={w.url} />
                  <button style={{ background: "none", border: 0, color: "var(--danger)", fontSize: 12, cursor: "pointer" }}>Remove</button>
                </form>
              </div>
            ))}
          </div>
        )}
        <WebhookForm events={WEBHOOK_EVENTS} />
      </Section>

      {process.env.ADMIN_PASSWORD && (
        <form action="/api/auth/logout" method="post">
          <button style={{ background: "none", border: "1px solid var(--border)", color: "var(--muted)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>Sign out</button>
        </form>
      )}
    </main>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 36, padding: 20, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
      <h2 style={{ fontSize: 15, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted)", margin: "0 0 4px" }}>{title}</h2>
      {hint && <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 14px" }}>{hint}</p>}
      {children}
    </section>
  );
}

/** The snippet is pasted into someone's HTML: escape what would break an attribute. */
function attr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function Warn({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--warn)", fontSize: 13, margin: "0 0 12px" }}>{children}</p>;
}
