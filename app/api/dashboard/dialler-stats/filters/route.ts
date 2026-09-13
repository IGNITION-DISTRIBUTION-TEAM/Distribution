import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

/**
 * The Call status options, and — when there are none — WHY there are none.
 *
 * Three different faults used to arrive here as the same empty list: the app's
 * role has no SELECT on the view, the view is empty, and the view has rows but
 * no CALL_STATUS on any of them. The first makes every figure on the report
 * empty too, so it is worth knowing before anything else on that page is
 * believed; the others are ordinary.
 *
 * `hasRows` is a LIMIT 1 probe, not a COUNT — the question is "any at all",
 * and counting a reporting view to answer it would be the expensive way to
 * draw a caption.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  try {
    const rows = await executeSnowflakeQuery<{ V: string | null }>(
      `SELECT DISTINCT CALL_STATUS AS V
       FROM ${VIEW}
       WHERE CALL_STATUS IS NOT NULL
       ORDER BY V`,
      SF_OPTS
    )
    const callStatuses = rows
      .map((r) => (r.V === null ? "" : String(r.V)))
      .filter((v) => v.length > 0)

    // Only asked when it would change what the screen says.
    let hasRows: boolean | null = null
    if (callStatuses.length === 0) {
      try {
        const probe = await executeSnowflakeQuery<{ N: number | string }>(
          `SELECT COUNT(*) AS N FROM (SELECT 1 FROM ${VIEW} LIMIT 1)`,
          SF_OPTS
        )
        hasRows = Number(probe[0]?.N ?? 0) > 0
      } catch {
        /* Best effort. The caption degrades, the list does not. */
      }
    }

    return NextResponse.json({
      values: { callStatuses },
      hasRows,
      errors: {} as Record<string, string>,
    })
  } catch (error) {
    return NextResponse.json(
      {
        values: { callStatuses: [] },
        hasRows: null,
        errors: { callStatuses: error instanceof Error ? error.message : String(error) },
      },
      { status: 200 }
    )
  }
}
