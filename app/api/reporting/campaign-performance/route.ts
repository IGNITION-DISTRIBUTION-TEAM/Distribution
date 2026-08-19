import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Per-campaign performance funnel: leads loaded → leads dialled → sales.
 *
 * The three measures live in three different objects, keyed differently, so
 * each is aggregated separately and merged in JS on the campaign master:
 *
 *   leads loaded  TM_HLL_HISTORYLEADSLOADED   key CAMPAIGNID (numeric)
 *   dialled       VW_DIALLER_STATS            key CAMPAIGN_NAME  (pre-aggregated, SUM(LEADS))
 *   sales         VW_ONAIR_SALES_STATS        key CAMPAIGNNAME   (SUM(SALES))
 *
 * Joining the dialler/sales views by campaign NAME is the convention already
 * used by the Distribution dashboards, which pass CAMPAIGN.TITLE as
 * `campaignNames`. Names are matched case-insensitively and trimmed here to be
 * a little more forgiving; campaigns whose name finds no dialler/sales rows are
 * still returned (with nulls) and counted in `unmatched` so a naming mismatch
 * is visible rather than silently reported as zero.
 */

const CAMPAIGN_TABLE = "DATAWAREHOUSE.SILVERSURFER_CAMP_HEVO.CAMPAIGN"
const HISTORY_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
const DIALLER_VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS"
const SALES_VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_ONAIR_SALES_STATS"

const DATE = /^\d{4}-\d{2}-\d{2}$/

function escSql(s: string): string {
  return s.replace(/'/g, "''")
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const n = typeof v === "number" ? v : Number(String(v))
  return Number.isFinite(n) ? n : 0
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null

export type CampaignPerformanceRow = {
  campaignId: string
  title: string
  leadsLoaded: number
  leadsDialled: number
  sales: number
  /** dialled / loaded — how much of what was loaded actually got worked. */
  dialledRate: number | null
  /** sales / loaded — end-to-end conversion. */
  conversionRate: number | null
  /** sales / dialled — how well the dialled leads converted. */
  salesPerDialled: number | null
  /** No dialler rows matched this campaign's title in the period. */
  noDiallerMatch: boolean
  /** No sales rows matched this campaign's title in the period. */
  noSalesMatch: boolean
}

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "reporting")
  if (guard instanceof NextResponse) return guard

  const { searchParams } = new URL(request.url)
  const startDate = searchParams.get("startDate") ?? ""
  const endDate = searchParams.get("endDate") ?? startDate
  const campaignIdsRaw = searchParams.get("campaignIds") ?? ""

  if (!DATE.test(startDate)) {
    return NextResponse.json(
      { error: "startDate query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }
  if (!DATE.test(endDate)) {
    return NextResponse.json(
      { error: "endDate query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }
  if (startDate > endDate) {
    return NextResponse.json({ error: "startDate must be on or before endDate" }, { status: 400 })
  }

  // Optional campaign filter. Empty = every active campaign.
  const ids = Array.from(
    new Set(campaignIdsRaw.split(",").map((s) => s.trim()).filter(Boolean))
  )
  if (ids.some((s) => !/^[0-9]+$/.test(s))) {
    return NextResponse.json({ error: "All campaignIds must be positive integers" }, { status: 400 })
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: "Max 500 campaigns per request" }, { status: 400 })
  }

  try {
    // 1. Campaign master — defines the rows and the id ↔ title mapping.
    const campaignRows = await executeSnowflakeQuery<{
      CAMPAIGNID: string | number
      TITLE: string | null
    }>(
      `SELECT CAMPAIGNID, TITLE
       FROM ${CAMPAIGN_TABLE}
       WHERE ACTIVE = 1
         AND TITLE IS NOT NULL
         AND TITLE <> ''
         ${ids.length > 0 ? `AND CAMPAIGNID IN (${ids.map(Number).join(",")})` : ""}
       ORDER BY TITLE`,
      { database: "DATAWAREHOUSE", schema: "SILVERSURFER_CAMP_HEVO" }
    )

    const campaigns = campaignRows
      .map((r) => ({ id: String(r.CAMPAIGNID), title: (r.TITLE ?? "").trim() }))
      .filter((c) => c.title !== "")

    if (campaigns.length === 0) {
      return NextResponse.json({
        startDate,
        endDate,
        rows: [],
        totals: {
          leadsLoaded: 0,
          leadsDialled: 0,
          sales: 0,
          dialledRate: null,
          conversionRate: null,
          salesPerDialled: null,
        },
        unmatched: { dialler: 0, sales: 0 },
      })
    }

    const idList = campaigns.map((c) => Number(c.id)).join(",")
    const nameList = campaigns.map((c) => `'${escSql(c.title)}'`).join(",")

    // 2..4 The three measures, in parallel. Each is grouped by its own key.
    const [loadedRows, dialledRows, salesRows] = await Promise.all([
      executeSnowflakeQuery<{ CAMPAIGNID: string | number; LEADS: number | string | null }>(
        `SELECT CAMPAIGNID, COUNT(*) AS LEADS
         FROM ${HISTORY_TABLE}
         WHERE CAMPAIGNID IN (${idList})
           AND CAST(CREATEDONDATE AS DATE) BETWEEN '${startDate}' AND '${endDate}'
         GROUP BY 1`,
        { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" }
      ),
      executeSnowflakeQuery<{ CAMPAIGN_NAME: string | null; LEADS: number | string | null }>(
        `SELECT CAMPAIGN_NAME, SUM(LEADS) AS LEADS
         FROM ${DIALLER_VIEW}
         WHERE CAMPAIGN_NAME IN (${nameList})
           AND CALL_START_TIME BETWEEN '${startDate}' AND '${endDate}'
         GROUP BY 1`,
        { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" }
      ),
      executeSnowflakeQuery<{ CAMPAIGNNAME: string | null; SALES: number | string | null }>(
        `SELECT CAMPAIGNNAME, SUM(SALES) AS SALES
         FROM ${SALES_VIEW}
         WHERE CAMPAIGNNAME IN (${nameList})
           AND ORDERDATE BETWEEN '${startDate}' AND '${endDate}'
         GROUP BY 1`,
        { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" }
      ),
    ])

    const loadedById = new Map<string, number>()
    for (const r of loadedRows) loadedById.set(String(r.CAMPAIGNID), num(r.LEADS))

    // Case-insensitive name keys; accumulate in case two spellings collapse.
    const key = (s: string | null) => (s ?? "").trim().toLowerCase()
    const dialledByName = new Map<string, number>()
    for (const r of dialledRows) {
      const k = key(r.CAMPAIGN_NAME)
      dialledByName.set(k, (dialledByName.get(k) ?? 0) + num(r.LEADS))
    }
    const salesByName = new Map<string, number>()
    for (const r of salesRows) {
      const k = key(r.CAMPAIGNNAME)
      salesByName.set(k, (salesByName.get(k) ?? 0) + num(r.SALES))
    }

    const rows: CampaignPerformanceRow[] = campaigns.map((c) => {
      const k = key(c.title)
      const leadsLoaded = loadedById.get(c.id) ?? 0
      const hasDialler = dialledByName.has(k)
      const hasSales = salesByName.has(k)
      const leadsDialled = dialledByName.get(k) ?? 0
      const sales = salesByName.get(k) ?? 0
      return {
        campaignId: c.id,
        title: c.title,
        leadsLoaded,
        leadsDialled,
        sales,
        dialledRate: rate(leadsDialled, leadsLoaded),
        conversionRate: rate(sales, leadsLoaded),
        salesPerDialled: rate(sales, leadsDialled),
        noDiallerMatch: !hasDialler,
        noSalesMatch: !hasSales,
      }
    })

    const sum = (pick: (r: CampaignPerformanceRow) => number) =>
      rows.reduce((acc, r) => acc + pick(r), 0)
    const totalLoaded = sum((r) => r.leadsLoaded)
    const totalDialled = sum((r) => r.leadsDialled)
    const totalSales = sum((r) => r.sales)

    return NextResponse.json({
      startDate,
      endDate,
      rows,
      totals: {
        leadsLoaded: totalLoaded,
        leadsDialled: totalDialled,
        sales: totalSales,
        dialledRate: rate(totalDialled, totalLoaded),
        conversionRate: rate(totalSales, totalLoaded),
        salesPerDialled: rate(totalSales, totalDialled),
      },
      // How many campaigns had activity in neither source — a naming mismatch
      // between the campaign master and the dialler/sales views shows up here.
      unmatched: {
        dialler: rows.filter((r) => r.noDiallerMatch).length,
        sales: rows.filter((r) => r.noSalesMatch).length,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/reporting/campaign-performance] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
