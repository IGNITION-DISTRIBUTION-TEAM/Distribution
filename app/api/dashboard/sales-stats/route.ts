import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_ONAIR_SALES_STATS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

function escSql(s: string): string {
  return s.replace(/'/g, "''")
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const namesRaw = searchParams.get("campaignNames")
  const startDate = searchParams.get("startDate")
  const endDate = searchParams.get("endDate") ?? startDate

  // No campaignNames at all means EVERY campaign — the report defaults to the
  // whole book rather than refusing to load until something is picked.
  const names = Array.from(
    new Set(
      (namesRaw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  )
  if (names.length > 200) {
    return NextResponse.json({ error: "Max 200 campaigns per request" }, { status: 400 })
  }
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return NextResponse.json(
      { error: "startDate query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json(
      { error: "endDate query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }
  if (startDate > endDate) {
    return NextResponse.json(
      { error: "startDate must be on or before endDate" },
      { status: 400 }
    )
  }

  // Empty list = no campaign predicate, rather than an IN over every name.
  const campaignFilter =
    names.length > 0
      ? `CAMPAIGNNAME IN (${names.map((n) => `'${escSql(n)}'`).join(",")}) AND`
      : ""


  const collectMulti = (key: string): string[] => {
    const raw = searchParams.get(key)
    if (!raw) return []
    return Array.from(
      new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    )
  }
  const providerTypes = collectMulti("providerTypes")
  const isInsurable = collectMulti("isInsurable")

  const inClause = (col: string, vals: string[]) =>
    vals.length > 0 ? `AND ${col} IN (${vals.map((v) => `'${escSql(v)}'`).join(",")})` : ""

  // For the single-day view, the hour-of-day shape has to come from OTHER days —
  // today is the thing being projected. Reuse every filter except the date and
  // look back four weeks, ending the day before the selected one.
  const dayShift = (iso: string, days: number): string => {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }
  const profileStart = dayShift(startDate, -28)
  const profileEnd = dayShift(startDate, -1)
  // Fitting window for the daily forecast. The model must not depend on how wide
  // a range the user happened to pick — "this month" is only ~3 weeks and cannot
  // support day-of-week factors on its own — so it always fits on 12 trailing
  // weeks ending at the selected end date.
  const historyStart = dayShift(endDate, -84)

  const where = `
    WHERE ${campaignFilter}
      ORDERDATE BETWEEN '${startDate}' AND '${endDate}'
      ${inClause("PROVIDERTYPE", providerTypes)}
      ${inClause("ISINSURABLE", isInsurable)}
  `

  const profileWhere = `
    WHERE ${campaignFilter}
      ORDERDATE BETWEEN '${profileStart}' AND '${profileEnd}'
      ${inClause("PROVIDERTYPE", providerTypes)}
      ${inClause("ISINSURABLE", isInsurable)}
  `

  const historyWhere = `
    WHERE ${campaignFilter}
      ORDERDATE BETWEEN '${historyStart}' AND '${endDate}'
      ${inClause("PROVIDERTYPE", providerTypes)}
      ${inClause("ISINSURABLE", isInsurable)}
  `

  try {
    const [totals, bySalesDate, hourProfile, dailyHistory, byCampaign, byScoreDate] =
      await Promise.all([
      executeSnowflakeQuery<{
        TOTAL_SALES: number | string | null
        TOTAL_ROWS: number | string
        DISTINCT_DAYS: number | string
        DISTINCT_CAMPAIGNS: number | string
      }>(
        `SELECT
           SUM(SALES) AS TOTAL_SALES,
           COUNT(*) AS TOTAL_ROWS,
           COUNT(DISTINCT ORDERDATE) AS DISTINCT_DAYS,
           COUNT(DISTINCT CAMPAIGNNAME) AS DISTINCT_CAMPAIGNS
         FROM ${VIEW}
         ${where}`,
        SF_OPTS
      ),
      // Single-day selection → bucket by hour. Multi-day → bucket by date.
      executeSnowflakeQuery<{ BUCKET: string; SALES: number | string | null }>(
        startDate === endDate
          ? `SELECT
               LPAD(EXTRACT(HOUR FROM ORDERORDERDATE)::VARCHAR, 2, '0') || ':00' AS BUCKET,
               SUM(SALES) AS SALES
             FROM ${VIEW}
             ${where}
             GROUP BY 1
             ORDER BY 1`
          : `SELECT
               TO_CHAR(ORDERDATE, 'YYYY-MM-DD') AS BUCKET,
               SUM(SALES) AS SALES
             FROM ${VIEW}
             ${where}
             GROUP BY 1
             ORDER BY 1`,
        SF_OPTS
      ),
      // Hour-of-day shape over the trailing four weeks. Same hour expression as
      // the single-day bucket above, so the profile and today's actuals line up.
      // Skipped entirely on a multi-day range, where it is not needed.
      startDate === endDate
        ? executeSnowflakeQuery<{
            BUCKET: string
            SALES: number | string | null
            DAYS: number | string
          }>(
            `SELECT
               LPAD(EXTRACT(HOUR FROM ORDERORDERDATE)::VARCHAR, 2, '0') || ':00' AS BUCKET,
               SUM(SALES) AS SALES,
               COUNT(DISTINCT ORDERDATE) AS DAYS
             FROM ${VIEW}
             ${profileWhere}
             GROUP BY 1
             ORDER BY 1`,
            SF_OPTS
          )
        : Promise.resolve([]),
      // Daily history for fitting the forecast — wider than the selected range
      // on purpose. Skipped on a single-day view, which uses the hour profile.
      startDate === endDate
        ? Promise.resolve([])
        : executeSnowflakeQuery<{ BUCKET: string; SALES: number | string | null }>(
            `SELECT
               TO_CHAR(ORDERDATE, 'YYYY-MM-DD') AS BUCKET,
               SUM(SALES) AS SALES
             FROM ${VIEW}
             ${historyWhere}
             GROUP BY 1
             ORDER BY 1`,
            SF_OPTS
          ),
      executeSnowflakeQuery<{ CAMPAIGNNAME: string | null; SALES: number | string | null }>(
        `SELECT CAMPAIGNNAME, SUM(SALES) AS SALES
         FROM ${VIEW}
         ${where}
         GROUP BY 1
         ORDER BY SALES DESC NULLS LAST`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{
        SCOREGROUP: string | null
        DAY: string
        SALES: number | string | null
      }>(
        `SELECT
           COALESCE(NULLIF(TRIM(SCOREGROUP3), ''), '(none)') AS SCOREGROUP,
           TO_CHAR(ORDERDATE, 'YYYY-MM-DD') AS DAY,
           SUM(SALES) AS SALES
         FROM ${VIEW}
         ${where}
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        SF_OPTS
      ),
    ])

    const t = totals[0] ?? {}
    const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)
    const numFloat = (v: unknown): number =>
      typeof v === "number" ? v : Number.isFinite(parseFloat(String(v))) ? parseFloat(String(v)) : 0

    const granularity: "day" | "hour" = startDate === endDate ? "hour" : "day"

    return NextResponse.json({
      campaignNames: names,
      startDate,
      endDate,
      granularity,
      totals: {
        totalSales: numFloat(t.TOTAL_SALES),
        rows: num(t.TOTAL_ROWS),
        days: num(t.DISTINCT_DAYS),
        campaigns: num(t.DISTINCT_CAMPAIGNS),
      },
      bySalesDate: bySalesDate.map((r) => ({ date: r.BUCKET, sales: numFloat(r.SALES) })),
      // Trailing daily series used to fit the forecast, independent of the
      // selected range. Empty on a single-day view.
      dailyHistory: (dailyHistory as { BUCKET: string; SALES: number | string | null }[]).map(
        (r) => ({ date: r.BUCKET, sales: numFloat(r.SALES) })
      ),
      historyFrom: historyStart,
      // Share of a day's sales landing in each hour, from the trailing window.
      // Empty on a multi-day range.
      hourProfile: (() => {
        const rows = hourProfile as { BUCKET: string; SALES: number | string | null; DAYS: number | string }[]
        const total = rows.reduce((a, r) => a + (numFloat(r.SALES) ?? 0), 0)
        if (!(total > 0)) return { hours: [], days: 0, from: profileStart, to: profileEnd }
        const days = Math.max(...rows.map((r) => Number(r.DAYS) || 0), 0)
        return {
          hours: rows.map((r) => ({
            hour: r.BUCKET,
            share: (numFloat(r.SALES) ?? 0) / total,
          })),
          days,
          from: profileStart,
          to: profileEnd,
        }
      })(),
      byCampaign: byCampaign.map((r) => ({
        campaignName: r.CAMPAIGNNAME ?? "(unnamed)",
        sales: numFloat(r.SALES),
      })),
      byScoreDate: byScoreDate.map((r) => ({
        scoreGroup: r.SCOREGROUP ?? "(none)",
        date: r.DAY,
        count: numFloat(r.SALES),
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dashboard/sales-stats] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
