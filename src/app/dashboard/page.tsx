import Link from "next/link";
import { getDashboard } from "@/server/queries/dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboard("northside-hvac", 30);
  if (!data) return <Empty />;

  const h = data.headline;
  const money = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 24px 100px" }}>
      <Header title={data.tenant.name} subtitle={`Last ${data.days} days`} />

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
        </div>
      </Section>

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
            head={["Score", "Service", "Urgency", "Status", "Channel"]}
            rows={data.recentLeads.map((l) => [
              <ScorePill key="s" score={l.score} />,
              l.service ?? "—", l.urgency ?? "—", l.status, l.sourceChannel,
            ])}
          />
        </Section>
      )}
    </main>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

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
