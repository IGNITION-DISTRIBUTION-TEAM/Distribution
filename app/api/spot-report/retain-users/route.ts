import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live monthly free-airtime reward qty & value for the Spot Report "Retain
// Users via Free Airtime" page. Source per the PBI map ("Retain users using via
// free airtime", "Free Rewards data"): VW_SC_TRANSACTION_REPORT filtered to the
// retentions sub-wallet and the four free-airtime bundle benefit IDs. The
// page's monthly charts aren't split by tenant, so we skip the ICCID→tenant
// join entirely and just aggregate by month (cheap grouped scan).
//
// Retention (recipient vs no-reward still-active) and revenue-per-recipient
// stay on the baked snapshot — those depend on the STILL_USING_AFTER_* views
// and a non-reward-revenue cohort join the map doesn't fully specify.
const SRC = "UCONNECT_DW.ANALYTICS.VW_SC_TRANSACTION_REPORT"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  try {
    // NOTE: the WALLET value has a trailing space in source — keep it exactly.
    const rows = await executeSnowflakeQuery<{ M: string; QTY: string | number; VAL: string | number }>(
      `SELECT TO_VARCHAR(DATE_TRUNC('month', RECHARGEDATE::DATE), 'YYYY-MM-DD') AS M,
              COUNT(CUSTOMER_VALUE) AS QTY,
              SUM(CUSTOMER_VALUE) AS VAL
       FROM ${SRC}
       WHERE WALLET = 'Sub Wallet - Retentions '
         AND BENEFITID IN ('401', '313', '335', '351')
         AND SIMSTATUS = 'Completed'
         AND BENEFIT_TYPE = 'Bundle'
         AND RECHARGEDATE::DATE >= DATE_TRUNC('month', DATEADD('month', -13, CURRENT_DATE()))
         AND RECHARGEDATE::DATE < DATE_TRUNC('month', DATEADD('month', 1, CURRENT_DATE()))
       GROUP BY DATE_TRUNC('month', RECHARGEDATE::DATE)
       ORDER BY M`,
      SF_OPTS
    )

    const monthly = rows.map((r) => ({
      month: String(r.M),
      reward_qty: num(r.QTY),
      reward_value: num(r.VAL),
    }))

    return NextResponse.json({
      hasData: monthly.length > 0,
      monthly,
      dataThrough: monthly.length ? monthly[monthly.length - 1].month : null,
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/retain-users] error:", message)
    return NextResponse.json({ error: message, hasData: false, monthly: [] }, { status: 200 })
  }
}
