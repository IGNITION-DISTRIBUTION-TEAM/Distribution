import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { listRuns, densify, listSyncs } from "@/lib/sftp-sync-registry"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * The runs dashboard: recent runs, a dense per-day series, and the totals.
 *
 *   GET ?days=7
 *
 * Reads the app's own run log. Snowflake's TASK_HISTORY is not used: there is
 * no grant for SNOWFLAKE.ACCOUNT_USAGE, INFORMATION_SCHEMA.TASK_HISTORY covers
 * only tasks this role owns and only about a week, and neither records rows
 * loaded — which is half of what this screen is for.
 *
 * The run log only has rows for syncs deployed by generator version 2 or later.
 * Older ones are flagged in the job list rather than silently showing as idle.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "task-automation")
  if (guard instanceof NextResponse) return guard

  const daysRaw = Number(request.nextUrl.searchParams.get("days"))
  const days = Number.isInteger(daysRaw) && daysRaw > 0 && daysRaw <= 90 ? daysRaw : 7

  try {
    const runs = await listRuns({ days, limit: 500 })
    const series = densify(runs, days)
    const syncs = await listSyncs()

    const totals = {
      runs: runs.length,
      failed: runs.filter((r) => /^FAILED/i.test(r.status)).length,
      noChange: runs.filter((r) => r.status === "NO_CHANGE").length,
      rowsLoaded: runs.reduce((n, r) => n + r.rowsLoaded, 0),
      filesFetched: runs.reduce((n, r) => n + r.files, 0),
      // How much of the picture is missing, stated rather than implied.
      notReporting: syncs.filter((s) => s.stale).length,
    }

    return NextResponse.json({ days, runs: runs.slice(0, 100), series, totals })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/tasks] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
