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

  if (!namesRaw) {
    return NextResponse.json(
      { error: "campaignNames query param required (comma-separated)" },
      { status: 400 }
    )
  }
  const names = Array.from(
    new Set(
      namesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  )
  if (names.length === 0) {
    return NextResponse.json({ error: "campaignNames cannot be empty" }, { status: 400 })
  }
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

  const inList = names.map((n) => `'${escSql(n)}'`).join(",")

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

  const where = `
    WHERE CAMPAIGNNAME IN (${inList})
      AND ORDERDATE BETWEEN '${startDate}' AND '${endDate}'
      ${inClause("PROVIDERTYPE", providerTypes)}
      ${inClause("ISINSURABLE", isInsurable)}
  `

  try {
    const [totals, bySalesDate, byCampaign, byScoreDate] = await Promise.all([
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
