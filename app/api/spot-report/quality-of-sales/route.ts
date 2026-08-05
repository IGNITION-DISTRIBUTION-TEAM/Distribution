import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live per-tenant Quality of Sales for the Spot Report "Quality of Sales by
// Tenant & Store" page. Derived from the PBI map's "Quality of sales Last 7
// days" query, simplified to a single latest 7-day window: of the accounts
// activated in the trailing 7 days, what fraction have any real usage
// (minutes/megs/sms/ussd/mms > 0) in that window. That ratio is the quality
// metric; the map flags tenants below 50%.
//
// The snapshot has no tenant dimension, so this is the page's genuinely new
// content. Both tables are already granted (see scripts/spot-report.sql). We
// drive the usage scan from the small recent-sales set so VW_UC_USAGE is only
// probed for those accounts.
const MERGE = "UCONNECT_DW.ANALYTICS.UCONNECT_MAY_MERGE"
const USAGE = "UCONNECT_DW.ANALYTICS.VW_UC_USAGE"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  try {
    const rows = await executeSnowflakeQuery<{ TENANT: string | null; SALES: string | number; USING_CNT: string | number }>(
      `WITH recent_sales AS (
         SELECT DISTINCT ACCOUNT_NUMBER, TENANT
         FROM ${MERGE}
         WHERE MASTER_TENANT = 'uConnect'
           AND CAST(ACTIVATION_DATE AS DATE) BETWEEN DATEADD(DAY, -6, CURRENT_DATE()) AND CURRENT_DATE()
       ),
       used AS (
         SELECT DISTINCT u.ACCOUNT_NUMBER
         FROM ${USAGE} AS u
         JOIN recent_sales AS rs ON rs.ACCOUNT_NUMBER = u.ACCOUNT_NUMBER
         WHERE CAST(u.USAGE_DATE AS DATE) BETWEEN DATEADD(DAY, -6, CURRENT_DATE()) AND CURRENT_DATE()
           AND (COALESCE(u.MINUTES_USED, 0) + COALESCE(u.MEGS_USED, 0) + COALESCE(u.SMS, 0)
                + COALESCE(u.USSD, 0) + COALESCE(u.MMS, 0)) > 0
       )
       SELECT rs.TENANT AS TENANT,
              COUNT(DISTINCT rs.ACCOUNT_NUMBER) AS SALES,
              COUNT(DISTINCT us.ACCOUNT_NUMBER) AS USING_CNT
       FROM recent_sales AS rs
       LEFT JOIN used AS us ON us.ACCOUNT_NUMBER = rs.ACCOUNT_NUMBER
       GROUP BY rs.TENANT
       HAVING COUNT(DISTINCT rs.ACCOUNT_NUMBER) > 0
       ORDER BY SALES DESC`,
      SF_OPTS
    )

    const tenants = rows.map((r) => {
      const sales = num(r.SALES)
      const using = num(r.USING_CNT)
      return { tenant: String(r.TENANT ?? "Unknown"), sales, using, qos: sales > 0 ? using / sales : 0 }
    })
    const totalSales = tenants.reduce((a, t) => a + t.sales, 0)
    const totalUsing = tenants.reduce((a, t) => a + t.using, 0)

    return NextResponse.json({
      hasData: tenants.length > 0,
      tenants,
      totalSales,
      totalUsing,
      overallQos: totalSales > 0 ? totalUsing / totalSales : 0,
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/quality-of-sales] error:", message)
    return NextResponse.json({ error: message, hasData: false, tenants: [] }, { status: 200 })
  }
}
