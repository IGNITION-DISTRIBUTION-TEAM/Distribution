import { NextResponse } from "next/server"
import {
  executeSnowflakeQuery,
  executeSnowflakeQueryWithMeta,
  formatSnowflakeRows,
} from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const TABLE = "DATAWAREHOUSE.DISTRIBUTION_AUTOMATION.SYNC_LEAD_TRACKING"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_AUTOMATION" } as const

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get("date")
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "date query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }

  try {
    const [summaryMeta, byBatch] = await Promise.all([
      executeSnowflakeQueryWithMeta(
        `SELECT *
         FROM ${TABLE}
         WHERE CAST(CREATED_AT AS DATE) = '${date}'
           AND STATUS = 'SUMMARY'
         ORDER BY CREATED_AT DESC`,
        SF_OPTS
      ),
      executeSnowflakeQuery<{ BATCH_NAME: string | null; CNT: number | string }>(
        `SELECT BATCH_NAME, COUNT(1) AS CNT
         FROM ${TABLE}
         WHERE CAST(CREATED_AT AS DATE) = '${date}'
           AND STATUS <> 'SUMMARY'
         GROUP BY BATCH_NAME
         ORDER BY CNT DESC`,
        SF_OPTS
      ),
    ])

    const summary = formatSnowflakeRows(summaryMeta.columns, summaryMeta.rows)

    const byBatchClean = byBatch.map((r) => ({
      batchName: r.BATCH_NAME ?? "(unnamed)",
      count: typeof r.CNT === "string" ? parseInt(r.CNT, 10) : r.CNT,
    }))

    return NextResponse.json({ date, summary, byBatch: byBatchClean })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/sync-leads] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
