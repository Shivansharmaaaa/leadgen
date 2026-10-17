import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { POST as login } from "@/app/api/auth/login/route";
import { createSession, passwordMatches, safeNext, SESSION_COOKIE, verifySession } from "@/server/auth/session";

/**
 * Owner sign-in: sessions, the middleware's decisions, and the login route.
 *
 *   npm run auth:test
 */
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
const env = process.env as Record<string, string | undefined>;
const req = (path: string, init: { method?: string; cookie?: string; origin?: string } = {}) =>
  new NextRequest(`http://app.local${path}`, {
    method: init.method ?? "GET",
    headers: {
      host: "app.local",
      ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
  });
const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function main() {
  console.log("\nSessions");
  const token = await createSession("hunter22");
  check("a fresh session verifies", await verifySession(token, "hunter22"));
  check("a changed password signs everyone out", !(await verifySession(token, "new-password")));
  check("a forged signature fails", !(await verifySession(token.replace(/.$/, (c) => (c === "0" ? "1" : "0")), "hunter22")));
  check("an extended expiry fails (it is signed)", !(await verifySession(`9999999999.${token.split(".")[1]}`, "hunter22")));
  check("an expired session fails", !(await verifySession(await createSession("hunter22", Date.now() - 13 * 3600_000), "hunter22")));
  check("garbage fails", !(await verifySession("not-a-token", "hunter22")) && !(await verifySession(undefined, "hunter22")));
  check("password comparison", (await passwordMatches("hunter22", "hunter22")) && !(await passwordMatches("hunter2", "hunter22")));

  console.log("\nRedirect after sign-in stays on this site");
  check("/inbox?c=1 is kept", safeNext("/inbox?c=1") === "/inbox?c=1");
  check("//evil.com is refused", safeNext("//evil.com") === "/dashboard");
  check("https://evil.com is refused", safeNext("https://evil.com") === "/dashboard");
  check("/\\evil.com is refused", safeNext("/\\evil.com") === "/dashboard");

  console.log("\nMiddleware, password set");
  env.ADMIN_PASSWORD = "hunter22";
  const page = await middleware(req("/dashboard"));
  check("dashboard without a session → sign-in page", page.status === 307 && Boolean(page.headers.get("location")?.includes("/login?next=%2Fdashboard")), page.headers.get("location") ?? "");
  const deep = await middleware(req("/inbox?c=abc"));
  check("the thread link survives the sign-in", Boolean(deep.headers.get("location")?.includes(encodeURIComponent("/inbox?c=abc"))));
  check("inbox API without a session → 401", (await middleware(req("/api/inbox", { method: "POST" }))).status === 401);
  check("settings without a session → sign-in page", (await middleware(req("/settings"))).status === 307);
  check("dashboard with a session → through", passes(await middleware(req("/dashboard", { cookie: token }))));
  check("inbox API with a session, same site → through", passes(await middleware(req("/api/inbox", { method: "POST", cookie: token, origin: "http://app.local" }))));
  check("inbox API with a session from another site → 403", (await middleware(req("/api/inbox", { method: "POST", cookie: token, origin: "https://evil.example" }))).status === 403);
  check("the public chat API is not gated", passes(await middleware(req("/api/chat", { method: "POST" }))));
  check("the browser voice demo needs sign-in once a password is set", (await middleware(req("/voice"))).status === 307 &&
    (await middleware(req("/api/voice/turn", { method: "POST" }))).status === 401);
  check("Twilio's voice webhook stays public (it has its own signature check)", passes(await middleware(req("/api/webhooks/twilio/voice", { method: "POST" }))));
  check("lead intake is not gated (it has its own key)", passes(await middleware(req("/api/leads", { method: "POST" }))));

  console.log("\nMiddleware, no password");
  delete env.ADMIN_PASSWORD;
  env.NODE_ENV = "development";
  check("development stays open", passes(await middleware(req("/dashboard"))));
  env.NODE_ENV = "production";
  check("production fails closed (503)", (await middleware(req("/dashboard"))).status === 503);
  env.NODE_ENV = "development";

  console.log("\nLogin route");
  env.ADMIN_PASSWORD = "hunter22";
  const form = (password: string, next = "/inbox") => {
    const f = new FormData();
    f.set("password", password);
    f.set("next", next);
    return new Request("http://app.local/api/auth/login", { method: "POST", body: f });
  };
  const ok = await login(form("hunter22"));
  const cookie = ok.headers.get("set-cookie") ?? "";
  check("right password → back to where they were going", ok.status === 303 && ok.headers.get("location") === "http://app.local/inbox");
  check("cookie is httpOnly and SameSite=Lax", /HttpOnly/i.test(cookie) && /SameSite=lax/i.test(cookie), cookie.split(";").slice(1).join(";"));
  const issued = decodeURIComponent(cookie.split(";")[0].split("=")[1] ?? "");
  check("and the middleware accepts it", passes(await middleware(req("/dashboard", { cookie: issued }))));
  const t0 = Date.now();
  const bad = await login(form("guess"));
  check("wrong password → back to sign-in with an error, no cookie",
    bad.status === 303 && Boolean(bad.headers.get("location")?.includes("error=wrong-password")) && !bad.headers.get("set-cookie"));
  check("and costs about a second", Date.now() - t0 >= 900, `${Date.now() - t0}ms`);
  const evil = await login(form("hunter22", "//evil.com/phish"));
  check("a crafted next= cannot send them off-site", evil.headers.get("location") === "http://app.local/dashboard", evil.headers.get("location") ?? "");

  console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
