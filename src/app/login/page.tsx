export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "wrong-password": "That password isn't right.",
  "not-configured": "Sign-in isn't set up: add ADMIN_PASSWORD to the server's environment.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main style={{ maxWidth: 380, margin: "0 auto", padding: "96px 24px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>Sign in</h1>
      <p style={{ color: "var(--muted)", fontSize: 14, margin: "0 0 24px" }}>
        The dashboard and inbox hold your customers' details.
      </p>
      <form method="post" action="/api/auth/login" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="hidden" name="next" value={next ?? "/dashboard"} />
        <label style={{ fontSize: 13, color: "var(--muted)" }} htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus
               style={{ padding: "10px 12px", fontSize: 15, borderRadius: 8, border: "1px solid var(--border)",
                        background: "var(--panel)", color: "var(--text)" }} />
        {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: 0 }}>{ERRORS[error] ?? "Couldn't sign in."}</p>}
        <button type="submit" style={{ padding: "10px 12px", fontSize: 15, fontWeight: 600, borderRadius: 8, border: 0,
                                       background: "var(--accent)", color: "#fff", cursor: "pointer" }}>Sign in</button>
      </form>
    </main>
  );
}
