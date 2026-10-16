import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "./session";

/**
 * For server actions. The middleware already guards the page they post to;
 * this is the second lock, so an action stays protected even if a route is
 * ever moved out from under the matcher.
 */
export async function requireOwner(): Promise<void> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV !== "production") return;
    throw new Error("ADMIN_PASSWORD is not set");
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySession(token, password))) throw new Error("sign in required");
}
