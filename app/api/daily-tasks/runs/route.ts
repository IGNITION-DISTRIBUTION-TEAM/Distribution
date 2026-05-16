import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DAILY_TASKS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

type RunRow = {
  NAME: string | null
  STATE: string | null
  SCHEDULED_TIME: string | null
  COMPLETED_TIME: string | null
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get("date")
  const state = searchParams.get("state") // optional, e.g. "SUCCEEDED"

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "date query param required, format YYYY-MM-DD" },
      { status: 400 }
    )
  }

  const safeState = state && /^[A-Z_]+$/.test(state) ? state : null

  const sql = `
    SELECT NAME, STATE, SCHEDULED_TIME, COMPLETED_TIME
    FROM ${VIEW}
    WHERE CAST(SCHEDULED_TIME AS DATE) = '${date}'
      ${safeState ? `AND STATE = '${safeState}'` : ""}
    ORDER BY SCHEDULED_TIME DESC
  `

  try {
    const rows = await executeSnowflakeQuery<RunRow>(sql, SF_OPTS)
    return NextResponse.json({ rows, date, state: safeState })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/daily-tasks/runs] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
