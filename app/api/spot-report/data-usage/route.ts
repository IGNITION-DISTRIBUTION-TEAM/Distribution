import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live rebuild of the Spot Report "Data Usage by Tenant" page. Same source and
// method as Voice Usage (docs/telco-pbi-page-table-map.md, "Data usage by
// tenant"): VW_UC_USAGE per-account usage joined to UCONNECT_MAY_MERGE, but on
// MEGS_USED (data, from PDP records) instead of MINUTES_USED (voice, MOC).
// Pre-aggregate to account x month with a MEGS_USED > 0 filter first, then join
// the tenant table — keeps the distinct off the raw CDR feed and shrinks the
// join. MEGS_USED is megabytes; the client converts to GB for display.
const USAGE = "UCONNECT_DW.ANALYTICS.VW_UC_USAGE"
const MERGE = "UCONNECT_DW.ANALYTICS.UCONNECT_MAY_MERGE"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  try {
    // Per tenant per month over the last 6 months. Active data user = an
    // account with any data (megs) in the month.
    const rows = await executeSnowflakeQuery<{
      TENANT: string | null; M: string; MEGS: string | number; ACTIVE_USERS: string | number
    }>(
      `WITH acct AS (
         SELECT ACCOUNT_NUMBER,
                DATE_TRUNC('month', USAGE_DATE) AS M,
                SUM(MEGS_USED) AS MEGS
         FROM ${USAGE}
         WHERE MEGS_USED > 0
           AND CAST(USAGE_DATE AS DATE) >= DATE_TRUNC('month', DATEADD('month', -5, CURRENT_DATE()))
         GROUP BY ACCOUNT_NUMBER, DATE_TRUNC('month', USAGE_DATE)
       )
       SELECT m.TENANT AS TENANT,
              TO_VARCHAR(a.M, 'YYYY-MM-DD') AS M,
              SUM(a.MEGS) AS MEGS,
              COUNT(DISTINCT a.ACCOUNT_NUMBER) AS ACTIVE_USERS
       FROM acct AS a
       JOIN ${MERGE} AS m ON m.ACCOUNT_NUMBER = a.ACCOUNT_NUMBER
       WHERE m.MASTER_TENANT = 'uConnect'
       GROUP BY m.TENANT, a.M
       HAVING SUM(a.MEGS) > 0`,
      SF_OPTS
    )

    const data = rows.map((r) => ({
      tenant: String(r.TENANT ?? "Unknown"),
      month: String(r.M),
      megs: num(r.MEGS),
      activeUsers: num(r.ACTIVE_USERS),
    }))
    const months = Array.from(new Set(data.map((r) => r.month))).sort((a, b) => a.localeCompare(b))
    const dataThrough = months.length ? months[months.length - 1] : null

    return NextResponse.json({
      hasData: data.length > 0,
      rows: data,
      months,
      dataThrough,
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/data-usage] error:", message)
    return NextResponse.json({ error: message, hasData: false, rows: [], months: [] }, { status: 200 })
  }
}
