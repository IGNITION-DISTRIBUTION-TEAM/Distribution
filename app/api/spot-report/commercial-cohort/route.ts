import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live read of the Commercial Cohort page from the same materialised SPOT_COHORT
// table the subscriptions cohort uses (populated by cohort-refresh from
// VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES). Shaped into the exact JSON
// the snapshot component already renders, so the component just reads live-first
// with a snapshot fallback. 404 → fall back to snapshot (table not built yet).
const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.SPOT_COHORT"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const
const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<{
      CAMPAIGN: string; COHORT_MONTH: string; MONTH_PERIOD: number | string
      SALES: number | string; ACTIVE_1_BASE: number | string; TOTAL_REVENUE: number | string
    }>(
      `SELECT CAMPAIGN, COHORT_MONTH, MONTH_PERIOD, SALES, ACTIVE_1_BASE, TOTAL_REVENUE FROM ${TABLE}`,
      SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ hasData: false }, { status: 404 })
    const meta = await executeSnowflakeQuery<{ AT: string | null }>(
      `SELECT TO_VARCHAR(MAX(REFRESHED_AT), 'YYYY-MM-DD HH24:MI') AS AT FROM ${TABLE}`,
      SF_OPTS
    )

    // Per cohort: M0 sales (cohort size), active at latest age, total revenue.
    const m0 = new Map<string, number>()             // cohort -> M0 sales
    const maxAge = new Map<string, number>()          // cohort -> max aging seen
    const activeByAge = new Map<string, number>()     // cohort|age -> active
    const revByAge = new Map<string, number>()        // cohort|age -> revenue
    const revTotal = new Map<string, number>()        // cohort -> revenue
    const chM0 = new Map<string, number>()            // cohort|campaign -> M0 sales
    for (const r of rows) {
      const cohort = String(r.COHORT_MONTH)
      const age = num(r.MONTH_PERIOD)
      const sales = num(r.SALES)
      const active = num(r.ACTIVE_1_BASE)
      const rev = num(r.TOTAL_REVENUE)
      maxAge.set(cohort, Math.max(maxAge.get(cohort) ?? 0, age))
      activeByAge.set(`${cohort}|${age}`, (activeByAge.get(`${cohort}|${age}`) ?? 0) + active)
      revByAge.set(`${cohort}|${age}`, (revByAge.get(`${cohort}|${age}`) ?? 0) + rev)
      revTotal.set(cohort, (revTotal.get(cohort) ?? 0) + rev)
      if (age === 0) {
        m0.set(cohort, (m0.get(cohort) ?? 0) + sales)
        chM0.set(`${cohort}|${r.CAMPAIGN}`, (chM0.get(`${cohort}|${r.CAMPAIGN}`) ?? 0) + sales)
      }
    }
    const cohorts = Array.from(m0.keys()).sort()

    const acquisitions = cohorts.map((c) => ({
      month: c,
      acquired: Math.round(m0.get(c) ?? 0),
      still_active: Math.round(activeByAge.get(`${c}|${maxAge.get(c) ?? 0}`) ?? 0),
    }))
    const revenue_per_cohort = cohorts.map((c) => ({ month: c, revenue: Math.round(revTotal.get(c) ?? 0), accounts: Math.round(m0.get(c) ?? 0) }))
    const channel_by_month = Array.from(chM0.entries()).map(([k, count]) => {
      const [month, channel] = k.split("|")
      return { month, channel, count: Math.round(count) }
    }).filter((r) => r.count > 0)
    const cohort_aging: { cohort_month: string; age_months: number; acquired: number; active: number; revenue: number }[] = []
    for (const c of cohorts) {
      for (let a = 0; a <= (maxAge.get(c) ?? 0); a++) {
        const key = `${c}|${a}`
        if (!activeByAge.has(key) && !revByAge.has(key)) continue
        cohort_aging.push({ cohort_month: c, age_months: a, acquired: Math.round(m0.get(c) ?? 0), active: Math.round(activeByAge.get(key) ?? 0), revenue: Math.round(revByAge.get(key) ?? 0) })
      }
    }

    return NextResponse.json({
      hasData: true,
      refreshedAt: meta[0]?.AT ? String(meta[0].AT) : null,
      acquisitions, revenue_per_cohort, channel_by_month, cohort_aging,
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/commercial-cohort] read error:", message)
    return NextResponse.json({ hasData: false, error: message }, { status: 404 })
  }
}
