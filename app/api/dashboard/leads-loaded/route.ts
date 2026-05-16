import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const HISTORY_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" } as const

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const campaignIdsRaw = searchParams.get("campaignIds") ?? searchParams.get("campaignId")
  const startDate = searchParams.get("startDate") ?? searchParams.get("date")
  const endDate = searchParams.get("endDate") ?? startDate

  if (!campaignIdsRaw) {
    return NextResponse.json(
      { error: "campaignIds query param required (comma-separated positive integers)" },
      { status: 400 }
    )
  }
  const ids = Array.from(
    new Set(
      campaignIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  )
  if (ids.length === 0) {
    return NextResponse.json({ error: "campaignIds must contain at least one id" }, { status: 400 })
  }
  if (ids.some((s) => !/^[0-9]+$/.test(s))) {
    return NextResponse.json(
      { error: "All campaignIds must be positive integers" },
      { status: 400 }
    )
  }
  if (ids.length > 200) {
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

  const inList = ids.map((id) => Number(id)).join(",")
  const where = `
    WHERE campaignid IN (${inList})
      AND CAST(CREATEDONDATE AS DATE) BETWEEN '${startDate}' AND '${endDate}'
  `

  try {
    const [totals, byBatch, byStatus, byCampaign, byScoreDate, avgScoreByDay] = await Promise.all([
      executeSnowflakeQuery<{
        TOTAL: number | string
        DISTINCT_BATCHES: number | string
        DISTINCT_IDNUMBERS: number | string
        ACTIVE_LEADS: number | string
        EXPIRED_LEADS: number | string
        WITH_STATUS: number | string
        AVG_SCORE: number | string | null
        AVG_SALARY: number | string | null
        AVG_AVAILABLE_SPEND: number | string | null
        AVG_UDM8_LDA: number | string | null
      }>(
        `SELECT
           COUNT(*) AS TOTAL,
           COUNT(DISTINCT BATCHNAME) AS DISTINCT_BATCHES,
           COUNT(DISTINCT IDNUMBER) AS DISTINCT_IDNUMBERS,
           SUM(CASE WHEN LEADEXPIRY > CURRENT_DATE() THEN 1 ELSE 0 END) AS ACTIVE_LEADS,
           SUM(CASE WHEN LEADEXPIRY <= CURRENT_DATE() THEN 1 ELSE 0 END) AS EXPIRED_LEADS,
           SUM(CASE WHEN ESTATUS IS NOT NULL THEN 1 ELSE 0 END) AS WITH_STATUS,
           AVG(TRY_TO_NUMBER(SCORE)) AS AVG_SCORE,
           AVG(TRY_TO_NUMBER(SALARY)) AS AVG_SALARY,
           AVG(TRY_TO_NUMBER(AVAILABLESPEND)) AS AVG_AVAILABLE_SPEND,
           AVG(TRY_TO_DOUBLE(REGEXP_SUBSTR(UDM8, '[-+]?[0-9]+(\\.[0-9]+)?'))) AS AVG_UDM8_LDA
         FROM ${HISTORY_TABLE}
         ${where}`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ BATCHNAME: string | null; CNT: number | string }>(
        `SELECT BATCHNAME, COUNT(*) AS CNT
         FROM ${HISTORY_TABLE}
         ${where}
         GROUP BY BATCHNAME
         ORDER BY CNT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ ESTATUS: string | null; CNT: number | string }>(
        `SELECT COALESCE(ESTATUS, '(none)') AS ESTATUS, COUNT(*) AS CNT
         FROM ${HISTORY_TABLE}
         ${where}
         GROUP BY ESTATUS
         ORDER BY CNT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ CAMPAIGNID: number | string; CNT: number | string }>(
        `SELECT CAMPAIGNID, COUNT(*) AS CNT
         FROM ${HISTORY_TABLE}
         ${where}
         GROUP BY CAMPAIGNID
         ORDER BY CNT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{
        SCOREGROUP: string | null
        DAY: string
        CNT: number | string
      }>(
        `SELECT
           COALESCE(NULLIF(TRIM(SCOREGROUP), ''), '(none)') AS SCOREGROUP,
           TO_CHAR(CAST(CREATEDONDATE AS DATE), 'YYYY-MM-DD') AS DAY,
           COUNT(*) AS CNT
         FROM ${HISTORY_TABLE}
         ${where}
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ DAY: string; AVG_SCORE: number | string | null; CNT: number | string }>(
        `SELECT
           TO_CHAR(CAST(CREATEDONDATE AS DATE), 'YYYY-MM-DD') AS DAY,
           AVG(TRY_TO_NUMBER(SCORE)) AS AVG_SCORE,
           COUNT(*) AS CNT
         FROM ${HISTORY_TABLE}
         ${where}
         GROUP BY 1
         ORDER BY 1`,
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

    return NextResponse.json({
      campaignIds: ids.map((id) => Number(id)),
      startDate,
      endDate,
      totals: {
        total: num(t.TOTAL),
        distinctBatches: num(t.DISTINCT_BATCHES),
        distinctIdnumbers: num(t.DISTINCT_IDNUMBERS),
        active: num(t.ACTIVE_LEADS),
        expired: num(t.EXPIRED_LEADS),
        withStatus: num(t.WITH_STATUS),
        avgScore: numFloat(t.AVG_SCORE),
        avgSalary: numFloat(t.AVG_SALARY),
        avgAvailableSpend: numFloat(t.AVG_AVAILABLE_SPEND),
        avgUdm8Lda: numFloat(t.AVG_UDM8_LDA),
      },
      byBatch: byBatch.map((r) => ({
        batchName: r.BATCHNAME ?? "(unnamed)",
        count: num(r.CNT),
      })),
      byStatus: byStatus.map((r) => ({
        status: r.ESTATUS ?? "(none)",
        count: num(r.CNT),
      })),
      byCampaign: byCampaign.map((r) => ({
        campaignId: String(r.CAMPAIGNID),
        count: num(r.CNT),
      })),
      byScoreDate: byScoreDate.map((r) => ({
        scoreGroup: r.SCOREGROUP ?? "(none)",
        date: r.DAY,
        count: num(r.CNT),
      })),
      avgScoreByDay: avgScoreByDay.map((r) => ({
        date: r.DAY,
        avgScore: numFloat(r.AVG_SCORE),
        count: num(r.CNT),
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/dashboard/leads-loaded] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
