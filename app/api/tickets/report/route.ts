import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { TICKETS_TABLE, OPEN_STATUSES } from "@/lib/tickets-shared"
import { SF_OPTS, ensureTicketTables, sqlString } from "@/lib/tickets-server"

export const dynamic = "force-dynamic"

// GET /api/tickets/report — aggregate counts for the reporting page.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "tickets")
  if (guard instanceof NextResponse) return guard

  const openList = OPEN_STATUSES.map((s) => sqlString(s)).join(",")

  try {
    await ensureTicketTables()
    const [totalsRows, byStatus, byUrgency, byType, byDepartment, byWeek] = await Promise.all([
      executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT COUNT(*) AS TOTAL,
                SUM(CASE WHEN STATUS IN (${openList}) THEN 1 ELSE 0 END) AS OPEN_COUNT,
                SUM(CASE WHEN STATUS IN (${openList}) AND SLA_DUE_AT < CURRENT_TIMESTAMP()
                    THEN 1 ELSE 0 END) AS OVERDUE_OPEN,
                SUM(CASE WHEN STATUS = 'Completed' THEN 1 ELSE 0 END) AS COMPLETED
         FROM ${TICKETS_TABLE}`,
        SF_OPTS
      ),
      executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT STATUS AS LABEL, COUNT(*) AS CNT FROM ${TICKETS_TABLE}
         GROUP BY STATUS ORDER BY CNT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT COALESCE(URGENCY, '(none)') AS LABEL, COUNT(*) AS CNT FROM ${TICKETS_TABLE}
         GROUP BY URGENCY ORDER BY CNT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT COALESCE(REQUEST_TYPE, '(none)') AS LABEL, COUNT(*) AS CNT FROM ${TICKETS_TABLE}
         GROUP BY REQUEST_TYPE ORDER BY CNT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<Record<string, unknown>>(
        // Department lives in the answers JSON (FIELDS), not a column.
        `SELECT COALESCE(TRY_PARSE_JSON(FIELDS):department::string, '(none)') AS LABEL,
                COUNT(*) AS CNT
         FROM ${TICKETS_TABLE} GROUP BY 1 ORDER BY CNT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT TO_VARCHAR(DATE_TRUNC('week', CREATED_AT), 'YYYY-MM-DD') AS LABEL,
                COUNT(*) AS CNT
         FROM ${TICKETS_TABLE}
         WHERE CREATED_AT >= DATEADD('week', -8, CURRENT_TIMESTAMP())
         GROUP BY 1 ORDER BY 1 DESC`,
        SF_OPTS
      ),
    ])

    const toPairs = (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({ label: String(r.LABEL ?? ""), count: Number(r.CNT ?? 0) }))

    const t = totalsRows[0] ?? {}
    return NextResponse.json({
      totals: {
        total: Number(t.TOTAL ?? 0),
        open: Number(t.OPEN_COUNT ?? 0),
        overdueOpen: Number(t.OVERDUE_OPEN ?? 0),
        completed: Number(t.COMPLETED ?? 0),
      },
      byStatus: toPairs(byStatus),
      byUrgency: toPairs(byUrgency),
      byType: toPairs(byType),
      byDepartment: toPairs(byDepartment),
      byWeek: toPairs(byWeek),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/tickets/report] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
