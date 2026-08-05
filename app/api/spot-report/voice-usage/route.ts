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
    // Per tenant per month over the last 6 months. VW_UC_USAGE is CDR-level
    // (one row per usage event) and voice minutes only appear on MOC records —
    // most rows (PDP data) have MINUTES_USED = NULL. So pre-aggregate to
    // account x month with a MINUTES_USED > 0 filter FIRST (that filter alone
    // discards every data-only row), then join the tiny result to the tenant
    // table. This keeps the expensive per-account distinct off the raw CDR feed
    // and shrinks the join by orders of magnitude vs joining the full table.
    // Active voice user = an account with any voice minutes in the month.
    const rows = await executeSnowflakeQuery<{
      TENANT: string | null; M: string; MINUTES: string | number; ACTIVE_USERS: string | number
    }>(
      `WITH acct AS (
         SELECT ACCOUNT_NUMBER,
                DATE_TRUNC('month', USAGE_DATE) AS M,
                SUM(MINUTES_USED) AS MINUTES
         FROM ${USAGE}
         WHERE MINUTES_USED > 0
           AND CAST(USAGE_DATE AS DATE) >= DATE_TRUNC('month', DATEADD('month', -5, CURRENT_DATE()))
         GROUP BY ACCOUNT_NUMBER, DATE_TRUNC('month', USAGE_DATE)
       )
       SELECT m.TENANT AS TENANT,
              TO_VARCHAR(a.M, 'YYYY-MM-DD') AS M,
              SUM(a.MINUTES) AS MINUTES,
              COUNT(DISTINCT a.ACCOUNT_NUMBER) AS ACTIVE_USERS
       FROM acct AS a
       JOIN ${MERGE} AS m ON m.ACCOUNT_NUMBER = a.ACCOUNT_NUMBER
       WHERE m.MASTER_TENANT = 'uConnect'
       GROUP BY m.TENANT, a.M
       HAVING SUM(a.MINUTES) > 0`,
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
