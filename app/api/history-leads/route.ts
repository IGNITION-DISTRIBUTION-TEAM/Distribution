import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" } as const

type Row = {
  CNT: number | string
  BATCHNAME: string | null
  CAMPAIGNID: number | string | null
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get("date")
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "date query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }

  const sql = `
    SELECT COUNT(1) AS CNT, h.BATCHNAME, h.CAMPAIGNID
    FROM ${TABLE} h
    WHERE CAST(h.CREATEDONDATE AS DATE) = '${date}'
      AND h.ESTATUS IS NULL
    GROUP BY h.BATCHNAME, h.CAMPAIGNID
    ORDER BY CNT DESC
  `

  try {
    const rows = await executeSnowflakeQuery<Row>(sql, SF_OPTS)
    const items = rows.map((r) => ({
      batchName: r.BATCHNAME ?? "(unnamed)",
      campaignId: r.CAMPAIGNID === null ? null : String(r.CAMPAIGNID),
      count: typeof r.CNT === "string" ? parseInt(r.CNT, 10) : r.CNT,
    }))
    return NextResponse.json({ date, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/history-leads] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
