import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { listRuns, densify, listSyncs } from "@/lib/sftp-sync-registry"
import { executeSnowflakeQuery } from "@/lib/snowflake"

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

    // The target's live count per scheduled sync, so "ran and did nothing" and
    // "ran and the table is empty" are distinguishable here rather than only
    // on Current jobs.
    const targetRows = new Map<string, number>()
    await Promise.all(
      syncs.map(async (r) => {
        const t = `${r.config.targetDb}.${r.config.targetSchema}.${r.config.targetTable}`
        if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(t)) return
        try {
          const rows = await executeSnowflakeQuery<Record<string, unknown>>(
            `SELECT COUNT(*) AS N FROM ${t}`,
            { database: r.config.targetDb, schema: r.config.targetSchema }
          )
          targetRows.set(r.config.syncName, Number(Object.values(rows[0] ?? {})[0] ?? 0))
        } catch {
          // Unreadable or missing — Current jobs reports on that separately.
        }
      })
    )

    const failed = runs.filter((r) => /^FAILED/i.test(r.status)).length
    const noChange = runs.filter((r) => r.status === "NO_CHANGE").length
    const totals = {
      // `runs` is EVERY run, whatever the outcome. Succeeded is reported
      // explicitly rather than left to be worked out as runs - failed -
      // noChange, which is how "Runs 3" got read as "3 runs passed".
      runs: runs.length,
      succeeded: runs.filter((r) => r.status === "SUCCESS").length,
      failed,
      noChange,
      rowsLoaded: runs.reduce((n, r) => n + r.rowsLoaded, 0),
      filesFetched: runs.reduce((n, r) => n + r.files, 0),
      // How much of the picture is missing, stated rather than implied.
      notReporting: syncs.filter((s) => s.stale).length,
    }

    return NextResponse.json({
      days,
      runs: runs.slice(0, 100),
      series,
      totals,
      targetRows: Object.fromEntries(targetRows),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[task-automation/tasks] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
