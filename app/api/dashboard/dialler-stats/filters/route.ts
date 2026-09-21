import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { FACT_SF_OPTS, FACT_TABLE, TENANT_ID } from "@/lib/dialler-fact"

export const dynamic = "force-dynamic"

/**
 * The Call status options, and — when there are none — WHY there are none.
 *
 * Reads FACT_YAXXA_DIALLER, the same source as the report. It used to read
 * VW_DIALLER_STATS, which is how "No call status values" came to sit over a
 * page that had no data for an entirely different reason.
 *
 * SCOPED TO A TRAILING WINDOW, not the whole table. A per-call fact grows
 * without limit, and DISTINCT over all of it to fill a dropdown would be the
 * slowest query on the page by a wide margin. Ninety days is long enough that a
 * status in current use cannot be missing from the list.
 */
const WINDOW_DAYS = 90

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const scope =
    `WHERE TENANT_ID = ${TENANT_ID}\n` +
    `  AND CAST(CALL_DATE AS DATE) >= DATEADD(DAY, -${WINDOW_DAYS}, CURRENT_DATE())`

  try {
    const rows = await executeSnowflakeQuery<{ V: string | null }>(
      `SELECT DISTINCT CALL_STATUS AS V
       FROM ${FACT_TABLE}
       ${scope}
         AND CALL_STATUS IS NOT NULL
         AND TRIM(CALL_STATUS) <> ''
       ORDER BY V`,
      FACT_SF_OPTS
    )
    const callStatuses = rows
      .map((r) => (r.V === null ? "" : String(r.V)))
      .filter((v) => v.length > 0)

    // Only asked when it would change what the screen says: an empty list means
    // either no calls at all or calls with no status, and those need different
    // answers.
    let hasRows: boolean | null = null
    if (callStatuses.length === 0) {
      try {
        const probe = await executeSnowflakeQuery<{ N: number | string }>(
          `SELECT COUNT(*) AS N FROM (SELECT 1 FROM ${FACT_TABLE} ${scope} LIMIT 1)`,
          FACT_SF_OPTS
        )
        hasRows = Number(probe[0]?.N ?? 0) > 0
      } catch {
        /* Best effort. The caption degrades, the list does not. */
      }
    }

    return NextResponse.json({
      values: { callStatuses },
      hasRows,
      windowDays: WINDOW_DAYS,
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
