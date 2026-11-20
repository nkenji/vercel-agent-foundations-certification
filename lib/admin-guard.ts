/**
 * Server-side admin check for API routes.
 *
 * `proxy.ts` only guards /admin pages. API routes must check the cookie
 * themselves, so the admin agent is never reachable without the admin login.
 */
import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, ADMIN_PASSWORD } from "@/lib/admin-auth";

export async function isAdminRequest(): Promise<boolean> {
  const store = await cookies();
  return store.get(ADMIN_COOKIE_NAME)?.value === ADMIN_PASSWORD;
}

export function unauthorized(): Response {
  return Response.json({ error: "Admin sign-in required." }, { status: 401 });
}
