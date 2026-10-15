import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "64px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Leadgen</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        AI lead generation and customer care for local service businesses.
      </p>
      <div style={{ display: "grid", gap: 12, marginTop: 32 }}>
        <Link href="/voice" style={cardStyle}>
          🎙 <strong>Talk to the agent</strong>
          <span style={subStyle}>Use your mic. No phone number needed.</span>
        </Link>
        <Link href="/inbox" style={cardStyle}>
          💬 <strong>Unified inbox</strong>
          <span style={subStyle}>Every channel, one thread per person.</span>
        </Link>
        <Link href="/dashboard" style={cardStyle}>
          📊 <strong>Dashboard</strong>
          <span style={subStyle}>What the AI actually captured.</span>
        </Link>
      </div>
    </main>
  );
}

const cardStyle: React.CSSProperties = {
  display: "flex", gap: 12, alignItems: "baseline",
  padding: "16px 18px", background: "var(--panel)",
  border: "1px solid var(--border)", borderRadius: "var(--radius)",
  color: "var(--text)", textDecoration: "none",
};
const subStyle: React.CSSProperties = { color: "var(--muted)", fontSize: 14 };
