import type { NextRequest } from "next/server"

/**
 * The shared secret every Vercel Cron route checks.
 *
 * Lifted verbatim from app/api/cron/distribution/route.ts when the calendar
 * reminder cron was added, so the two cannot drift apart. Vercel sends the
 * secret as a Bearer token; x-cron-secret and ?secret= are accepted so a
 * manual curl can exercise the route while diagnosing it.
 *
 * FAILS CLOSED. With CRON_SECRET unset every request is refused — including
 * Vercel's own. That is the safe direction, but it is also silent: a cron whose
 * secret was never set returns 401 forever and nothing inside the app says so.
 * First check after a deploy should always be a manual call with the secret.
 */
export function cronAuthed(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get("authorization")
  const q = request.nextUrl.searchParams.get("secret")
  return (
    request.headers.get("x-cron-secret") === secret ||
    auth === `Bearer ${secret}` ||
    q === secret
  )
}
