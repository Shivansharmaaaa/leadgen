import Link from "next/link";
import { getDashboard } from "@/server/queries/dashboard";
import { currentTenantSlug } from "@/server/settings";
import { CampaignButton } from "./CampaignButton";
import { closeJob, markLead } from "./actions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboard(currentTenantSlug(), 30);
  if (!data) return <Empty />;

  const h = data.headline;
  const money = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 24px 100px" }}>
      <Header title={data.tenant.name} subtitle={`Last ${data.days} days`} />
      {data.overdue.count > 0 && (
        <div role="alert" style={{ padding: "12px 16px", marginBottom: 24, borderRadius: "var(--radius)",
                                   border: "1px solid var(--danger)", color: "var(--danger)", fontSize: 14 }}>
          {data.overdue.count} scheduled job{data.overdue.count === 1 ? " is" : "s are"} overdue (oldest {data.overdue.oldestMinutes} min):
          reminders, team alerts, CRM updates and campaigns aren't going out. Is <code>npm run worker</code> running?
        </div>
      )}
      <nav style={{ display: "flex", gap: 16, margin: "-20px 0 28px", fontSize: 13 }}>
        <Link href="/inbox" style={{ color: "var(--accent)" }}>Inbox</Link>
        <Link href="/settings" style={{ color: "var(--accent)" }}>Settings</Link>
      </nav>

      <Section title="What the AI captured">
        <div style={grid}>
          <Stat label="Conversations handled" value={h.conversationsHandled} />
          <Stat label="Leads captured" value={h.leadsCaptured} accent />
          <Stat label="Appointments booked" value={h.appointmentsBooked} accent />
          <Stat label="After-hours conversations" value={h.afterHoursConversations}
                hint="Would have gone to voicemail" />
          <Stat label="Pipeline value" value={money(h.pipelineValue)} accent />
          <Stat label="Handed to a human" value={h.escalations} hint="Working as intended" />
          <Stat label="Replies held for review" value={h.repliesHeld} hint="Guardrail stopped these" />
          <Stat label="AI cost" value={h.aiCost < 0.01 ? "$0.00" : money(h.aiCost)}
                hint={`${data.agentRuns} runs · ${data.avgLatencyMs}ms avg`} />
          <Stat label="Opt-outs honoured" value={data.optOuts} hint="STOP, unsubscribe, don't call me" />
        </div>
      </Section>

      {data.jobsToClose.length > 0 && (
        <Section title="How did these jobs go?"
                 hint="Marking a job done wins the lead and asks the customer for a review three hours later. No-shows are counted.">
          <Table
            head={["When", "Job", ""]}
            rows={data.jobsToClose.map((a) => [
              // The business's clock, not the server's: a 9am job is 9am where the job is.
              a.startsAt.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: data.tenant.timezone }),
              a.service,
              <form key="f" action={closeJob} style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <input type="hidden" name="appointmentId" value={a.id} />
                <button name="outcome" value="completed" style={jobButton("var(--accent)")}>Done</button>
                <button name="outcome" value="no_show" style={jobButton("var(--warn)")}>No-show</button>
                <button name="outcome" value="cancelled" style={jobButton("var(--muted)")}>Cancelled</button>
              </form>,
            ])}
          />
        </Section>
      )}

      {data.coach.needsAttention.length > 0 && (
        <Section title="Needs your attention"
                 hint="Conversations where a lead may have slipped. Each line says what was missed, so you can pick it up.">
          <Table
            head={["Score", "Customer", "Channel", "What was missed", ""]}
            rows={data.coach.needsAttention.map((c) => [
              <ScorePill key="s" score={c.score} />,
              c.contactName ?? "(unknown)",
              c.channel,
              <span key="f" style={{ fontSize: 13 }}>
                {c.flags.filter((f) => f.severity === "high").map((f) => f.detail).join(" ")}
              </span>,
              <Link key="o" href={`/inbox?c=${c.conversationId}`} style={{ color: "var(--accent)", fontSize: 13 }}>open</Link>,
            ])}
          />
        </Section>
      )}

      {data.coach.scored > 0 && (
        <Section title="How the conversations went"
                 hint={`${data.coach.scored} scored · average ${data.coach.averageScore}/100. Every flag is a rule over the transcript, not a guess.`}>
          <div style={grid}>
            <Stat label="Booked" value={data.coach.outcomes.booked} accent />
            <Stat label="Lead captured" value={data.coach.outcomes.lead_captured} />
            <Stat label="Handed to a person" value={data.coach.outcomes.escalated} />
            <Stat label="Still talking" value={data.coach.outcomes.engaged} />
            <Stat label="Went quiet" value={data.coach.outcomes.abandoned} />
          </div>
          {data.coach.flags.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Table
                head={["Missed", "How often", "Example"]}
                rows={data.coach.flags.map((f) => [
                  <span key="c" style={{ color: f.severity === "high" ? "var(--danger)" : f.severity === "medium" ? "var(--warn)" : "var(--muted)" }}>
                    {FLAG_LABEL[f.code] ?? f.code}
                  </span>,
                  f.count,
                  <span key="e" style={{ fontSize: 13, color: "var(--muted)" }}>{f.example}</span>,
                ])}
              />
            </div>
          )}
        </Section>
      )}

      {data.leadSources.length > 0 && (
        <Section title="Which lead sources turn into jobs"
                 hint="Where to spend: the share of each source's leads that booked, and what each booked job cost. Enter what you pay each source in Settings.">
          <Table
            head={["Source", "Leads", "Booked", "Booked rate", "Spend", "Per lead", "Per booked job"]}
            rows={data.leadSources.map((s) => [
              SOURCE_LABEL[s.source] ?? s.source, s.leads, s.booked,
              `${s.leads ? Math.round((s.booked / s.leads) * 100) : 0}%`,
              s.spend != null ? money(s.spend) : "—",
              s.costPerLead != null ? money(s.costPerLead) : "—",
              s.costPerBooked != null ? <strong key="c">{money(s.costPerBooked)}</strong>
                : s.spend ? <span key="n" style={{ color: "var(--danger)" }}>no bookings yet</span> : "—",
            ])}
          />
        </Section>
      )}

      {data.forms.problems.length > 0 && (
        <Section title="Fix on your website"
                 hint={`${data.forms.leadsNotTexted} form lead(s) could not be texted automatically because the consent wording on the form is incomplete. They were held for your team instead. Changing the wording fixes it for every future lead.`}>
          <Table
            head={["What the consent text is missing", "Leads affected"]}
            rows={data.forms.problems.map(([problem, n]) => [problem, n])}
          />
        </Section>
      )}

      {(data.appointmentsOps.remindersSent > 0 || data.appointmentsOps.rescheduleRequests > 0) && (
        <Section title="Appointments" hint="Reminders go the day before and on the day; customers reply C to confirm or R to move it.">
          <div style={grid}>
            <Stat label="Reminders sent" value={data.appointmentsOps.remindersSent} />
            <Stat label="Confirmed by the customer" value={data.appointmentsOps.confirmedByCustomer} accent />
            <Stat label="Waiting to be rescheduled" value={data.appointmentsOps.rescheduleRequests}
                  hint={data.appointmentsOps.rescheduleRequests ? "Someone needs to find them a new time" : undefined} />
            <Stat label="No-shows" value={data.appointmentsOps.noShows} />
          </div>
        </Section>
      )}

      {(data.alerts.sent + data.alerts.failed + data.alerts.heldForOpening > 0 || data.alerts.problems.length > 0) && (
        <Section title="Team alerts" hint="Texts to your team when the AI hands a conversation over. Emergencies go to whoever is on call, at any hour.">
          <div style={grid}>
            <Stat label="Alerts delivered" value={data.alerts.sent} accent />
            <Stat label="Held until opening" value={data.alerts.heldForOpening} hint="Not urgent, so nobody was woken" />
            <Stat label="Failed" value={data.alerts.failed} />
          </div>
          {data.alerts.problems.length > 0 && (
            <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>
              Not reaching your team: {data.alerts.problems.join("; ")}. Add staff phone numbers, and connect Twilio.
            </p>
          )}
        </Section>
      )}

      <Section title="Speed to lead" hint="The strongest predictor of conversion in local services">
        <div style={grid}>
          <Stat label="Median first response"
                value={data.sla.medianSeconds != null ? `${data.sla.medianSeconds}s` : "—"} accent />
          <Stat label="90th percentile"
                value={data.sla.p90Seconds != null ? `${data.sla.p90Seconds}s` : "—"} />
          <Stat label="Within 60s target" value={`${data.sla.withinTargetPct.toFixed(0)}%`} />
          <Stat label="First responses measured" value={data.sla.totalFirstResponses} />
        </div>
      </Section>

      {data.byChannel.length > 0 && (
        <Section title="Where leads came from">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.byChannel.map(([channel, n]) => {
              const max = data.byChannel[0][1];
              return (
                <div key={channel} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 100, fontSize: 13, color: "var(--muted)" }}>{channel}</span>
                  <div style={{ flex: 1, height: 22, background: "var(--panel-2)", borderRadius: 5 }}>
                    <div style={{
                      width: `${(n / max) * 100}%`, height: "100%",
                      background: "var(--accent)", opacity: 0.75, borderRadius: 5,
                    }} />
                  </div>
                  <span style={{ width: 28, textAlign: "right", fontSize: 13 }}>{n}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {data.liftReports.length > 0 && (
        <Section title="Did it actually work?"
                 hint="Every outreach campaign withholds a random slice. This compares contacted against untouched — real causal lift, not attribution.">
          {data.liftReports.map((r) => (
            <div key={r.campaign} style={{
              padding: "16px 18px", marginBottom: 10, background: "var(--panel)",
              border: `1px solid ${r.significant ? "var(--accent)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
            }}>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong>{r.campaign}</strong>
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  contacted {r.treatmentN} · held back {r.holdoutN}
                </span>
              </div>
              <div style={{ display: "flex", gap: 28, marginTop: 10, flexWrap: "wrap" }}>
                <MiniStat label="Contacted booked" value={`${(r.treatmentRate * 100).toFixed(1)}%`} />
                <MiniStat label="Untouched booked" value={`${(r.holdoutRate * 100).toFixed(1)}%`} />
                <MiniStat label="Lift"
                          value={`${r.absoluteLift >= 0 ? "+" : ""}${(r.absoluteLift * 100).toFixed(1)}pp`}
                          accent={r.significant} />
                <MiniStat label="Extra jobs won" value={r.incrementalConversions} accent={r.significant} />
              </div>
              <div style={{ fontSize: 12, color: r.significant ? "var(--accent)" : "var(--warn)", marginTop: 10 }}>
                {r.significant
                  ? `Statistically significant — 95% CI [${(r.ciLow * 100).toFixed(1)}, ${(r.ciHigh * 100).toFixed(1)}]pp`
                  : `Not yet proven — 95% CI [${(r.ciLow * 100).toFixed(1)}, ${(r.ciHigh * 100).toFixed(1)}]pp crosses zero. Needs more data.`}
              </div>
            </div>
          ))}
        </Section>
      )}

      {data.reactivation.length > 0 && (
        <Section title="Call these back today"
                 hint="Ranked by expected INCREMENTAL value — how much calling changes the outcome, times what the job is worth. Not by who is likeliest to book anyway.">
          <CampaignButton timeZone={data.tenant.timezone} contactable={data.reactivation.filter((r) => r.contactableVia.some((v) => v === "sms" || v === "email") && r.segment !== "do_not_disturb").length} />
          <Table
            head={["Exp. value", "Segment", "Name", "Service", "Dormant", "Reachable on"]}
            rows={data.reactivation.map((r) => [
              <strong key="v" style={{ color: "var(--accent)" }}>
                {r.expectedValue > 0 ? `$${r.expectedValue.toFixed(0)}` : "—"}
              </strong>,
              <SegmentPill key="g" segment={r.segment} fallback={r.upliftFallback} />,
              r.name ?? "(unknown)",
              r.service ?? "—",
              `${r.daysDormant}d`,
              r.contactableVia.length
                ? r.contactableVia.join(", ")
                : <span key="b" style={{ color: "var(--danger)" }}>blocked — {r.blockedReason}</span>,
            ])}
          />
        </Section>
      )}

      {data.crossSell.length > 0 && (
        <Section title="Cross-sell opportunities"
                 hint="Same business, existing customers. Patterns learned across all clients; people never shared.">
          <Table
            head={["Customer", "Had", "Suggest", "Since", "Contactable"]}
            rows={data.crossSell.map((c) => [
              c.name ?? "(unknown)", c.had, c.pitch, `${c.daysSince}d`,
              c.contactable ? "yes" : "no consent",
            ])}
          />
        </Section>
      )}

      {data.recentLeads.length > 0 && (
        <Section title="Recent leads">
          <Table
            head={["Score", "Service", "Urgency", "Status", "From", ""]}
            rows={data.recentLeads.map((l) => [
              <ScorePill key="s" score={l.score} />,
              l.service ?? "—", l.urgency ?? "—", l.status,
              SOURCE_LABEL[l.source ?? l.sourceChannel] ?? l.source ?? l.sourceChannel,
              l.status === "won" || l.status === "lost" ? "" : (
                <form key="o" action={markLead} style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <input type="hidden" name="leadId" value={l.id} />
                  <button name="outcome" value="won" style={jobButton("var(--accent)")}>Won</button>
                  <button name="outcome" value="lost" style={jobButton("var(--muted)")}>Lost</button>
                </form>
              ),
            ])}
          />
        </Section>
      )}
    </main>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

const jobButton = (colour: string): React.CSSProperties => ({
  fontSize: 12, padding: "3px 10px", borderRadius: 20, background: "transparent",
  color: colour, border: `1px solid ${colour}`, cursor: "pointer",
});

const FLAG_LABEL: Record<string, string> = {
  time_asked_not_offered: "Asked for a time, never offered one",
  no_contact_details: "Ended with no number or email",
  reply_stuck_in_review: "Reply stuck waiting for review",
  escalation_unanswered: "Handed over, nobody replied",
  emergency_not_booked: "Emergency not booked",
  price_not_answered: "Price question not answered",
  slow_first_reply: "Slow first reply",
  went_quiet_no_follow_up: "Went quiet, no follow-up",
  agent_repeated_itself: "Agent repeated itself",
};

const SOURCE_LABEL: Record<string, string> = {
  website: "Website form", google_lsa: "Google Local Services", angi: "Angi", thumbtack: "Thumbtack",
  facebook_lead_ad: "Facebook lead ads", zapier: "Zapier", other: "Other form", missed_call: "Missed calls",
  voice: "Phone calls", sms: "Texts", webchat: "Web chat", instagram: "Instagram",
  messenger: "Messenger", whatsapp: "WhatsApp", email: "Email",
};

const grid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12,
};

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <Link href="/" style={{ color: "var(--muted)", fontSize: 13, textDecoration: "none" }}>← home</Link>
      <h1 style={{ fontSize: 26, margin: "8px 0 2px" }}>{title}</h1>
      <p style={{ color: "var(--muted)", margin: 0, fontSize: 14 }}>{subtitle}</p>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 36 }}>
      <h2 style={{ fontSize: 15, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted)", marginBottom: 4 }}>
        {title}
      </h2>
      {hint && <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>{hint}</p>}
      {children}
    </section>
  );
}

function Stat({ label, value, hint, accent }: {
  label: string; value: string | number; hint?: string; accent?: boolean;
}) {
  return (
    <div style={{
      padding: "16px 18px", background: "var(--panel)",
      border: "1px solid var(--border)", borderRadius: "var(--radius)",
    }}>
      <div style={{ fontSize: 26, fontWeight: 600, color: accent ? "var(--accent)" : "var(--text)" }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--muted)", opacity: 0.7, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600, color: accent ? "var(--accent)" : "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

const SEGMENT_STYLE: Record<string, { label: string; colour: string }> = {
  persuadable:    { label: "persuadable",  colour: "var(--accent)" },
  sure_thing:     { label: "books anyway", colour: "var(--muted)" },
  lost_cause:     { label: "unlikely",     colour: "var(--muted)" },
  do_not_disturb: { label: "leave alone",  colour: "var(--danger)" },
  unknown:        { label: "no model yet", colour: "var(--warn)" },
};

function SegmentPill({ segment, fallback }: { segment: string; fallback: boolean }) {
  const s = SEGMENT_STYLE[segment] ?? SEGMENT_STYLE.unknown;
  return (
    <span title={fallback ? "No holdout data yet — ranked by predicted conversion" : undefined}
          style={{
            fontSize: 11, padding: "2px 8px", borderRadius: 20,
            color: s.colour, border: `1px solid ${s.colour}`, whiteSpace: "nowrap",
          }}>{s.label}</span>
  );
}

function ScorePill({ score }: { score: number }) {
  const colour = score >= 70 ? "var(--accent)" : score >= 40 ? "var(--warn)" : "var(--muted)";
  return (
    <span style={{
      display: "inline-block", minWidth: 34, textAlign: "center",
      padding: "2px 8px", borderRadius: 20, fontSize: 12, fontWeight: 600,
      color: colour, border: `1px solid ${colour}`,
    }}>{score}</span>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: "var(--radius)",
      overflow: "hidden", background: "var(--panel)",
    }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{
                textAlign: "left", padding: "10px 14px", fontSize: 12,
                color: "var(--muted)", fontWeight: 500, borderBottom: "1px solid var(--border)",
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: i < rows.length - 1 ? "1px solid var(--border)" : "none" }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: "10px 14px" }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty() {
  return (
    <main style={{ maxWidth: 600, margin: "0 auto", padding: 64 }}>
      <h1>No tenant found</h1>
      <p style={{ color: "var(--muted)" }}>
        Run <code>npm run seed</code>, then <code>npm run smoke</code> to generate activity.
      </p>
    </main>
  );
}
