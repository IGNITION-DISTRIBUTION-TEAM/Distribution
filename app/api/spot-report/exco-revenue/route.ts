import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"

const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.SPOT_TELCO_FINANCIALS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

// Monthly total revenue for Exco, derived from the uploaded income statement:
// sum of every "Revenue" line in the "Format Is" sheet, per month, up to the
// current month (excludes future forecast rows in the workbook).
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  try {
    const rows = await executeSnowflakeQuery<{ MONTH: string; REV: number | string }>(
      `SELECT TO_VARCHAR(DATE_TRUNC('month', PERIOD), 'YYYY-MM-DD') AS MONTH,
              SUM(VALUE) AS REV
       FROM ${TABLE}
       WHERE SHEET = 'Format Is'
         AND UPPER(TRIM(HEADER)) = 'REVENUE'
         AND PERIOD < DATEADD('month', 1, DATE_TRUNC('month', CURRENT_DATE()))
       GROUP BY 1
       ORDER BY 1`,
      SF_OPTS
    )
    const monthly_revenue = rows.map((r) => ({
      month: String(r.MONTH),
      revenue: typeof r.REV === "number" ? r.REV : parseFloat(String(r.REV)) || 0,
    }))
    const rev_mtd = monthly_revenue.length ? monthly_revenue[monthly_revenue.length - 1].revenue : null
    return NextResponse.json({
      monthly_revenue,
      rev_mtd,
      hasData: monthly_revenue.length > 0,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/exco-revenue] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
