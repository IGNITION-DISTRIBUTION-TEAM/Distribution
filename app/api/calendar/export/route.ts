import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { addDaysIso, isValidIsoDate, sastTodayIso } from "@/lib/calendar-dates"
import { buildIcs } from "@/lib/calendar-ics"
import { ensureCalendarTables, loadTasks, loadTasksInRange } from "@/lib/calendar-store"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Download the calendar as an .ics file.
 *
 * A SNAPSHOT, NOT A SUBSCRIPTION — and the distinction is the whole reason
 * this route looks like it does. It is guarded by the same department grant as
 * every other calendar route, which means Outlook cannot poll it: Outlook has
 * no session. So what a person gets is a file they import once, and the
 * DESCRIPTION on every event says so.
 *
 * Making it subscribable would mean an unauthenticated URL carrying a bearer
 * token, readable by anyone who ever sees the link, exposing every task title,
 * date and assignee with no audit trail. That was considered and deliberately
 * not built.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "calendar")
  if (guard instanceof NextResponse) return guard

  const params = request.nextUrl.searchParams
  const fromRaw = params.get("from")
  const toRaw = params.get("to")
  const ranged = fromRaw !== null || toRaw !== null
  if (ranged && (!isValidIsoDate(fromRaw) || !isValidIsoDate(toRaw))) {
    return NextResponse.json(
      { error: "from and to must both be real dates in YYYY-MM-DD form" },
      { status: 400 }
    )
  }

  try {
    await ensureCalendarTables()
    const today = sastTodayIso()

    let tasks
    let label
    if (ranged && isValidIsoDate(fromRaw) && isValidIsoDate(toRaw)) {
      const [from, to] = fromRaw <= toRaw ? [fromRaw, toRaw] : [toRaw, fromRaw]
      tasks = await loadTasksInRange(from, to)
      label = `${from}_to_${to}`
    } else {
      tasks = await loadTasks(addDaysIso(today, -30))
      label = today
    }

    const body = buildIcs(tasks, { name: "Ignition team calendar" })
    return new NextResponse(body, {
      headers: {
        // charset matters: task titles carry names and punctuation.
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="ignition-calendar-${label}.ics"`,
        // A snapshot of live data — never let a proxy hand back yesterday's.
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/calendar/export GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
