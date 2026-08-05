import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live read of the materialised cohort table (SPOT_COHORT, populated by
// cohort-refresh). Fast — it's a compact real table, not the 90s view. Returns
// a payload the cohort page renders when present; 404 (→ snapshot fallback)
// when nothing has been refreshed yet.
const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.SPOT_COHORT"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const
const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<{
      CAMPAIGN: string; COHORT_MONTH: string; DATE_SERIES_MONTH: string; MONTH_PERIOD: number | string
      SALES: number | string; REGISTERED_BASE: number | string; ACTIVE_1_BASE: number | string; TOTAL_REVENUE: number | string
    }>(
      `SELECT CAMPAIGN, COHORT_MONTH, DATE_SERIES_MONTH, MONTH_PERIOD, SALES, REGISTERED_BASE, ACTIVE_1_BASE, TOTAL_REVENUE
       FROM ${TABLE}`,
      SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ hasData: false }, { status: 404 })

    const meta = await executeSnowflakeQuery<{ AT: string | null }>(
      `SELECT TO_VARCHAR(MAX(REFRESHED_AT), 'YYYY-MM-DD HH24:MI') AS AT FROM ${TABLE}`,
      SF_OPTS
    )

    // Sales by campaign × observed month (stacked bar).
    const channelMap = new Map<string, number>() // `${month}|${campaign}` -> sales
    const campaigns = new Set<string>()
    const monthsSet = new Set<string>()
    // Cohort retention: cohort_month × aging → active base and M0 sales.
    const agingActive = new Map<string, number>() // `${cohort}|${aging}` -> active_1_base
    const cohortM0Sales = new Map<string, number>() // cohort -> sales at aging 0
    let totalSales = 0
    let totalRevenue = 0

    for (const r of rows) {
      const campaign = String(r.CAMPAIGN ?? "Unknown")
      const dm = String(r.DATE_SERIES_MONTH)
      const cm = String(r.COHORT_MONTH)
      const aging = num(r.MONTH_PERIOD)
      const sales = num(r.SALES)
      const active = num(r.ACTIVE_1_BASE)
      totalSales += sales
      totalRevenue += num(r.TOTAL_REVENUE)
      campaigns.add(campaign)
      monthsSet.add(dm)
      channelMap.set(`${dm}|${campaign}`, (channelMap.get(`${dm}|${campaign}`) ?? 0) + sales)
      agingActive.set(`${cm}|${aging}`, (agingActive.get(`${cm}|${aging}`) ?? 0) + active)
      if (aging === 0) cohortM0Sales.set(cm, (cohortM0Sales.get(cm) ?? 0) + sales)
    }

    const months = Array.from(monthsSet).sort()
    const channels = Array.from(campaigns).sort()
    const monthly_by_channel = months.flatMap((m) =>
      channels.map((c) => ({ month: m, channel: c, sales: Math.round(channelMap.get(`${m}|${c}`) ?? 0) }))
    ).filter((r) => r.sales > 0)

    const cohortAgings = Array.from(agingActive.entries()).map(([k, active]) => {
      const [cohort, aging] = k.split("|")
      return { cohort, aging: Number(aging), active: Math.round(active), m0Sales: Math.round(cohortM0Sales.get(cohort) ?? 0) }
    })

    return NextResponse.json({
      hasData: true,
      refreshedAt: meta[0]?.AT ? String(meta[0].AT) : null,
      totalSales: Math.round(totalSales),
      totalRevenue: Math.round(totalRevenue),
      monthly_by_channel,
      cohort: cohortAgings,
      _live: true,
    })
  } catch (error) {
    // Table missing (never refreshed) or read error → fall back to snapshot.
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/cohort] read error:", message)
    return NextResponse.json({ hasData: false, error: message }, { status: 404 })
  }
}
