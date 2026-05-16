import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS"
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
  const callStatuses = collectMulti("callStatuses")

  const inList = names.map((n) => `'${escSql(n)}'`).join(",")
  const inClause = (col: string, vals: string[]) =>
    vals.length > 0 ? `AND ${col} IN (${vals.map((v) => `'${escSql(v)}'`).join(",")})` : ""

  const where = `
    WHERE CAMPAIGN_NAME IN (${inList})
      AND CALL_START_TIME BETWEEN '${startDate}' AND '${endDate}'
      ${inClause("CALL_STATUS", callStatuses)}
  `

  try {
    const [totals, byBucket, byStatus, byCampaign, byScoreDate] = await Promise.all([
      executeSnowflakeQuery<{
        TOTAL_LEADS: number | string | null
        TOTAL_ROWS: number | string
        DISTINCT_DAYS: number | string
        DISTINCT_CAMPAIGNS: number | string
        AVG_SCORE: number | string | null
      }>(
        `SELECT
           SUM(LEADS) AS TOTAL_LEADS,
           COUNT(*) AS TOTAL_ROWS,
           COUNT(DISTINCT CALL_START_TIME) AS DISTINCT_DAYS,
           COUNT(DISTINCT CAMPAIGN_NAME) AS DISTINCT_CAMPAIGNS,
           AVG(SCORE) AS AVG_SCORE
         FROM ${VIEW}
         ${where}`,
        SF_OPTS
      ),
      // Single day → bucket by 30-min slot (shifted +2h for SAST). Multi-day → bucket by date.
      executeSnowflakeQuery<{ BUCKET: string; LEADS: number | string | null }>(
        startDate === endDate
          ? `SELECT
               TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI') AS BUCKET,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1
             ORDER BY 1`
          : `SELECT
               TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD') AS BUCKET,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1
             ORDER BY 1`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ CALL_STATUS: string | null; LEADS: number | string | null }>(
        `SELECT COALESCE(NULLIF(TRIM(CALL_STATUS), ''), '(none)') AS CALL_STATUS, SUM(LEADS) AS LEADS
         FROM ${VIEW}
         ${where}
         GROUP BY 1
         ORDER BY LEADS DESC NULLS LAST`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ CAMPAIGN_NAME: string | null; LEADS: number | string | null }>(
        `SELECT CAMPAIGN_NAME, SUM(LEADS) AS LEADS
         FROM ${VIEW}
         ${where}
         GROUP BY 1
         ORDER BY LEADS DESC NULLS LAST`,
        SF_OPTS
      ),
      // When a single day is selected, bucket the heatgrid by 30-min slot instead of date
      // so the user can see hour-of-day patterns within that day.
      executeSnowflakeQuery<{
        SCOREGROUP: string | null
        DAY: string
        LEADS: number | string | null
      }>(
        startDate === endDate
          ? `SELECT
               COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
               TO_CHAR(TIMEADD(HOUR, 2, TIME_BUCKET_30MIN), 'HH24:MI') AS DAY,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1, 2
             ORDER BY 1, 2`
          : `SELECT
               COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
               TO_CHAR(CALL_START_TIME, 'YYYY-MM-DD') AS DAY,
               SUM(LEADS) AS LEADS
             FROM ${VIEW}
             ${where}
             GROUP BY 1, 2
             ORDER BY 1, 2`,
        SF_OPTS
      ),
    ])

    const t = totals[0] ?? {}
    const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)
    const numFloat = (v: unknown): number | null => {
      if (v === null || v === undefined) return null
      const n = typeof v === "number" ? v : parseFloat(String(v))
      return Number.isFinite(n) ? n : null
    }

    const granularity: "day" | "halfHour" = startDate === endDate ? "halfHour" : "day"

    return NextResponse.json({
      campaignNames: names,
      startDate,
      endDate,
      granularity,
      totals: {
        totalLeads: num(t.TOTAL_LEADS),
        rows: num(t.TOTAL_ROWS),
        days: num(t.DISTINCT_DAYS),
        campaigns: num(t.DISTINCT_CAMPAIGNS),
        avgScore: numFloat(t.AVG_SCORE),
      },
      byBucket: byBucket.map((r) => ({ bucket: r.BUCKET, leads: num(r.LEADS) })),
      byStatus: byStatus.map((r) => ({
        status: r.CALL_STATUS ?? "(none)",
        leads: num(r.LEADS),
      })),
      byCampaign: byCampaign.map((r) => ({
        campaignName: r.CAMPAIGN_NAME ?? "(unnamed)",
        leads: num(r.LEADS),
      })),
      byScoreDate: byScoreDate.map((r) => ({
        scoreGroup: r.SCOREGROUP ?? "(none)",
        date: r.DAY,
        count: num(r.LEADS),
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dashboard/dialler-stats] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
