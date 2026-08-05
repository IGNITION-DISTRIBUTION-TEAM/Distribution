import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live monthly recharge revenue by stream, from the pre-aggregated
// VW_TELCO_MONTHLY_REVENUE_L13MONTHS (columns per the PBI map). Small view
// (~13 months) so it's fine to read on load. Shaped to the same
// {monthly:[{month,cellc,voucher,app,billrun,postpaid,website}]} the Recharge
// Revenue Monthly and Revenue Comparisons pages already render. 404 → snapshot.
const SRC = "UCONNECT_DW.ANALYTICS.VW_TELCO_MONTHLY_REVENUE_L13MONTHS"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const
const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<{
      M: string; CELLC: number | string; VOUCHER: number | string; APP: number | string
      BILLRUN: number | string; POSTPAID: number | string; WEBSITE: number | string
    }>(
      `SELECT TO_VARCHAR(CAST(TRANSACTION_MONTH AS DATE), 'YYYY-MM-DD') AS M,
              REVENUE_CELLC_RECHARGE_VALUE AS CELLC,
              REVENUE_RETAIL_VOUCHER_REDEMPTIONS_VALUE AS VOUCHER,
              REVENUE_APP_PURCHASES_VALUE AS APP,
              REVENUE_MAY_BILLRUN_VALUE AS BILLRUN,
              REVENUE_TOTAL_POST_PAID_VALUE AS POSTPAID,
              REVENUE_MAY_WEBSITE_RECHARGES_VALUE AS WEBSITE
       FROM ${SRC}
       ORDER BY 1`,
      SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ hasData: false }, { status: 404 })
    const monthly = rows.map((r) => ({
      month: String(r.M), cellc: num(r.CELLC), voucher: num(r.VOUCHER), app: num(r.APP),
      billrun: num(r.BILLRUN), postpaid: num(r.POSTPAID), website: num(r.WEBSITE),
    }))
    return NextResponse.json({ hasData: true, monthly, _live: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/recharge-revenue] error:", message)
    return NextResponse.json({ hasData: false, error: message }, { status: 404 })
  }
}
