import { NextRequest } from "next/server";

// Protects the cron endpoints (/api/remind, /api/tick).
// If CRON_SECRET is not configured (local dev), the routes stay open.
export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const key = new URL(req.url).searchParams.get("key");
  if (key && key === secret) return true;

  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;

  return false;
}
