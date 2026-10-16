import { NextResponse } from "next/server";
import { createSession, passwordMatches, safeNext, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Form post from /login. A wrong password costs a second, to blunt guessing. */
export async function POST(req: Request) {
  const form = await req.formData();
  const given = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const password = process.env.ADMIN_PASSWORD;
  const back = (error: string) => NextResponse.redirect(
    new URL(`/login?error=${error}&next=${encodeURIComponent(next)}`, req.url), 303);

  if (!password) return back("not-configured");
  if (!(await passwordMatches(given, password))) {
    await new Promise((r) => setTimeout(r, 1000));
    return back("wrong-password");
  }
  const res = NextResponse.redirect(new URL(next, req.url), 303);
  res.cookies.set(SESSION_COOKIE, await createSession(password), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
