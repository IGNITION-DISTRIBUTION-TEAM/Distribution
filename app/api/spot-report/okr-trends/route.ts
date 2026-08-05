import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"

const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.SPOT_TELCO_FINANCIALS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

// OKR Trends: the "Average subscription sales per day" OKR over time —
// actual (Telco fin sheet) vs target (Goal sheet), both from the uploaded
// income statement.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<{ M: string; KIND: string; V: number | string }>(
      `SELECT TO_VARCHAR(DATE_TRUNC('month', PERIOD), 'YYYY-MM-DD') AS M,
              CASE WHEN SHEET = 'Goal sheet' THEN 'target' ELSE 'actual' END AS KIND,
              VALUE AS V
       FROM ${TABLE}
       WHERE (SHEET = 'Goal sheet' AND LOWER(DETAIL) LIKE '%subscription sales per day%')
          OR (SHEET = 'Telco fin' AND LOWER(DETAIL) LIKE '%average subscription sales%')`,
      SF_OPTS
    )
    const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)
    const byMonth = new Map<string, { month: string; actual: number | null; target: number | null }>()
    for (const r of rows) {
      const m = String(r.M)
      const rec = byMonth.get(m) ?? { month: m, actual: null, target: null }
      if (String(r.KIND) === "target") rec.target = num(r.V)
      else rec.actual = num(r.V)
      byMonth.set(m, rec)
    }
    const series = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))
    return NextResponse.json({ series, hasData: series.length > 0 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/okr-trends] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
