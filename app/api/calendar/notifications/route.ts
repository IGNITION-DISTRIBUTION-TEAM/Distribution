import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { ensureCalendarTables, loadNotificationLog } from "@/lib/calendar-store"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The record of every mail this department has attempted.
 *
 * Calendar mail is best effort and never throws, which is right for the user's
 * action but means a failure is otherwise invisible. This is the screen that
 * answers "did my teammates actually get it?" — and, when email has not been
 * switched on at all, shows a run of "mail not configured" rows rather than
 * silence that looks like nothing happened.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50)
  try {
    await ensureCalendarTables()
    return NextResponse.json({ log: await loadNotificationLog(limit) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/notifications GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
