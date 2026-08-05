import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Live subscription SALES for a subscriptions page, by channel. Reuses the same
// source + channel classification as the OKR page (VW_SILVER_SURFER_SALES_SIM_INFO,
// already granted). This covers the sales trends and sales KPIs only — the
// book/FTC%/Month-2% measures and card-collected billing come from billing/cohort
// views (DATAWAREHOUSE.BILLING, SMARTCONNECT_DBO) that aren't granted and are
// PBI-defined, so those stay on the page's snapshot.
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

const SILVER = "UCONNECT_DW.ANALYTICS.VW_SILVER_SURFER_SALES_SIM_INFO"
const SUBS = "UCONNECT_DW.ANALYTICS.VW_UCONNECT_SUBSCRIPTIONS"

// channel key → { source, date column, count expr, WHERE predicate }, mirroring
// the classification CASE in the PBI map (and the OKR route). Only channels the
// map actually classifies are supported; "Below the Line" has no channel in the
// CASE, so it isn't offered here and stays on the page snapshot.
type ChannelCfg = { src: string; date: string; count: string; where: string }
const CHANNELS: Record<string, ChannelCfg> = {
  Telesales: { src: SILVER, date: "SALESDATE", count: "COUNT(*)", where: "(CAMPAIGNNAME IN ('Uconnect Upsell', 'UConnect Triplesave') OR CAMPAIGNNAME ILIKE '%Breakfree%')" },
  Whatsapp: { src: SILVER, date: "SALESDATE", count: "COUNT(*)", where: "CAMPAIGNNAME = 'Digital UConnect Upsell'" },
  "Mobile Store": { src: SILVER, date: "SALESDATE", count: "COUNT(*)", where: "CAMPAIGNNAME ILIKE '%Mobile Store%'" },
  "DigiM VAS": { src: SILVER, date: "SALESDATE", count: "COUNT(*)", where: "CAMPAIGNNAME IN ('DigiM Resells')" },
  App: { src: SUBS, date: "ACTIVATIONDATE", count: "COUNT(DISTINCT MANDATEREFERENCE)", where: "MANDATETYPE = 'App' AND COALESCE(POSITION('RETAIL_PROMOTIONS' IN EXTERNALREFERENCE), 0) = 0" },
}

const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard

  const channel = request.nextUrl.searchParams.get("channel") ?? ""
  const cfg = CHANNELS[channel]
  if (!cfg) return NextResponse.json({ hasData: false, error: `No live classification for '${channel}'` }, { status: 404 })

  try {
    const rows = await executeSnowflakeQuery<{ D: string; N: string | number }>(
      `SELECT TO_VARCHAR(CAST(${cfg.date} AS DATE), 'YYYY-MM-DD') AS D, ${cfg.count} AS N
       FROM ${cfg.src}
       WHERE ${cfg.where}
         AND CAST(${cfg.date} AS DATE) >= DATEADD('month', -13, DATE_TRUNC('month', CURRENT_DATE()))
         AND CAST(${cfg.date} AS DATE) < DATE_TRUNC('month', DATEADD('month', 1, CURRENT_DATE()))
       GROUP BY 1
       ORDER BY 1`,
      SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ hasData: false }, { status: 404 })

    const byDate = new Map<string, number>()
    for (const r of rows) byDate.set(String(r.D), num(r.N))

    // Monthly totals.
    const byMonth = new Map<string, number>()
    for (const [d, n] of byDate) {
      const mk = `${d.slice(0, 7)}-01`
      byMonth.set(mk, (byMonth.get(mk) ?? 0) + n)
    }
    const monthly = Array.from(byMonth.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([month, sales]) => ({ month, sales }))

    // Daily (last 45 days present).
    const dailyAll = Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, sales]) => ({ date, sales }))
    const daily = dailyAll.slice(-45)

    // Window KPIs, computed against today (server date) so they match the trend.
    const today = new Date()
    const iso = (dt: Date) => dt.toISOString().slice(0, 10)
    const addDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d) }
    const yday = addDays(-1)
    const monthStart = `${iso(today).slice(0, 7)}-01`
    const l30Start = addDays(-30)
    const l7Start = addDays(-7)
    let sales_yday = 0, sales_mtd = 0, sales_l30 = 0, sales_l7 = 0
    for (const [d, n] of byDate) {
      if (d === yday) sales_yday += n
      if (d >= monthStart) sales_mtd += n
      if (d >= l30Start) sales_l30 += n
      if (d >= l7Start) sales_l7 += n
    }

    return NextResponse.json({
      hasData: true,
      channel,
      monthly,
      daily,
      sales_yday,
      sales_mtd,
      sales_l30,
      sales_l7,
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/subscriptions] error:", message)
    return NextResponse.json({ hasData: false, error: message }, { status: 404 })
  }
}
