import { NextResponse, type NextRequest } from "next/server";
import { isProtected, SESSION_COOKIE, verifySession } from "@/server/auth/session";

/**
 * Guards the owner-facing surfaces (dashboard, inbox, settings, inbox API).
 *
 * Public by design, each with its own protection: /api/chat (rate limits),
 * /api/leads (intake key), /api/webhooks/* (provider signatures), the chat
 * widget, and /login. The /voice demo and /api/voice/* are left open for
 * local development and must be closed before a public deployment.
 *
 * Without ADMIN_PASSWORD: open in development, refused in production — a
 * deployment that forgot the password must fail closed, not open.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!isProtected(pathname)) return NextResponse.next();

  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("ADMIN_PASSWORD is not set, so the dashboard and inbox are closed.", { status: 503 });
  }

  // A cross-site page must not be able to drive the inbox API with the
  // owner's cookie. SameSite=Lax already withholds it; this is the belt.
  if (pathname.startsWith("/api/") && req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) {
      return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
    }
  }

  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value, password)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/dashboard/:path*", "/inbox/:path*", "/settings/:path*", "/api/inbox/:path*"],
};
