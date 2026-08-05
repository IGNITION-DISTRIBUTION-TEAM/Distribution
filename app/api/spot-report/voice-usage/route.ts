import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live rebuild of the Spot Report "Voice Usage by Tenant" page. The PBI map
// (docs/telco-pbi-page-table-map.md, "Voice usage by tenant") sources this from
// VW_UC_USAGE (per-account usage: MINUTES_USED, MEGS_USED, SMS, …) joined to
// UCONNECT_MAY_MERGE for TENANT/MASTER_TENANT. The original static page was a
// placeholder because CDR usage wasn't reachable at build time; the app's
// service role can be granted SELECT on the view (scripts/spot-report.sql).
const USAGE = "UCONNECT_DW.ANALYTICS.VW_UC_USAGE"
const MERGE = "UCONNECT_DW.ANALYTICS.UCONNECT_MAY_MERGE"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  try {
    // Per tenant per month over the last 13 months (matches the page's rolling
    // 13-month range). Active voice user = an account with any voice minutes in
    // the month. Minutes are summed; users are distinct accounts.
    const rows = await executeSnowflakeQuery<{
      TENANT: string | null; M: string; MINUTES: string | number; ACTIVE_USERS: string | number
    }>(
      `SELECT m.TENANT AS TENANT,
              TO_VARCHAR(DATE_TRUNC('month', u.USAGE_DATE), 'YYYY-MM-DD') AS M,
              SUM(u.MINUTES_USED) AS MINUTES,
              COUNT(DISTINCT CASE WHEN u.MINUTES_USED > 0 THEN u.ACCOUNT_NUMBER END) AS ACTIVE_USERS
       FROM ${USAGE} AS u
       LEFT JOIN ${MERGE} AS m ON m.ACCOUNT_NUMBER = u.ACCOUNT_NUMBER
       WHERE CAST(u.USAGE_DATE AS DATE) >= DATE_TRUNC('month', DATEADD('month', -12, CURRENT_DATE()))
         AND m.MASTER_TENANT = 'uConnect'
       GROUP BY m.TENANT, DATE_TRUNC('month', u.USAGE_DATE)
       HAVING SUM(u.MINUTES_USED) > 0`,
      SF_OPTS
    )

    const data = rows.map((r) => ({
      tenant: String(r.TENANT ?? "Unknown"),
      month: String(r.M),
      minutes: num(r.MINUTES),
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
    console.error("[/api/spot-report/voice-usage] error:", message)
    return NextResponse.json({ error: message, hasData: false, rows: [], months: [] }, { status: 200 })
  }
}
