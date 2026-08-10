import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { TABLE, SF_OPTS, ensureTable } from "@/app/api/distribution/tasks/route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

// Vercel Cron hits this on a schedule (see vercel.json). It runs every Active
// task whose frequency interval has elapsed since its last run. Interval-based
// (timezone-safe). Secured by CRON_SECRET (Vercel sends it as a Bearer token;
// x-cron-secret also accepted).
function authed(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get("authorization")
  const q = request.nextUrl.searchParams.get("secret")
  return request.headers.get("x-cron-secret") === secret || auth === `Bearer ${secret}` || q === secret
}

async function handle(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let due: { ID: number | string }[] = []
  try {
    await ensureTable()
    // Evaluate in SAST (Africa/Johannesburg — no DST). LAST_RUN_AT is stored in
    // UTC (SYSDATE), so CONVERT_TIMEZONE('UTC', …) is correct.
    const NOW = "CONVERT_TIMEZONE('UTC','Africa/Johannesburg', SYSDATE())"
    const LAST = "CONVERT_TIMEZONE('UTC','Africa/Johannesburg', LAST_RUN_AT)"
    due = await executeSnowflakeQuery<{ ID: number | string }>(
      `SELECT ID FROM ${TABLE}
       WHERE STATUS = 'Active' AND SCHEDULE_FREQUENCY IN ('hourly','daily','weekly')
         AND (
           -- Hourly: at least ~an hour since the last run.
           (SCHEDULE_FREQUENCY = 'hourly'
              AND (LAST_RUN_AT IS NULL OR DATEDIFF(minute, LAST_RUN_AT, SYSDATE()) >= 55))
           -- Daily: at/after the chosen time and not yet run today (SAST).
           OR (SCHEDULE_FREQUENCY = 'daily'
              AND TO_CHAR(${NOW}, 'HH24:MI') >= COALESCE(SCHEDULE_TIME, '00:00')
              AND (LAST_RUN_AT IS NULL OR TO_DATE(${LAST}) < TO_DATE(${NOW})))
           -- Weekly: right weekday, at/after the time, not yet run today (SAST).
           OR (SCHEDULE_FREQUENCY = 'weekly'
              AND DAYNAME(${NOW}) = COALESCE(SCHEDULE_DOW, 'Mon')
              AND TO_CHAR(${NOW}, 'HH24:MI') >= COALESCE(SCHEDULE_TIME, '00:00')
              AND (LAST_RUN_AT IS NULL OR TO_DATE(${LAST}) < TO_DATE(${NOW})))
         )
       ORDER BY ID`,
      SF_OPTS
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const origin = request.nextUrl.origin
  const secret = process.env.CRON_SECRET ?? ""
  const results: { id: number | string; ok: boolean; error?: string }[] = []
  for (const t of due) {
    try {
      const res = await fetch(`${origin}/api/distribution/tasks/${t.ID}/run`, {
        method: "POST",
        headers: { "x-cron-secret": secret },
      })
      const data = await res.json().catch(() => ({}))
      results.push({ id: t.ID, ok: res.ok, error: (data as { error?: string }).error })
    } catch (e) {
      results.push({ id: t.ID, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return NextResponse.json({ checked: due.length, ran: results })
}

export async function GET(request: NextRequest) { return handle(request) }
export async function POST(request: NextRequest) { return handle(request) }
