import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DAILY_TASKS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

type AggRow = {
  DAY: string
  STATE: string | null
  CNT: number | string
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const daysRaw = searchParams.get("days") ?? "30"
  const days = parseInt(daysRaw, 10)
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: "days must be 1-365" }, { status: 400 })
  }

  const sql = `
    SELECT
      TO_CHAR(CAST(SCHEDULED_TIME AS DATE), 'YYYY-MM-DD') AS DAY,
      UPPER(STATE) AS STATE,
      COUNT(*) AS CNT
    FROM ${VIEW}
    WHERE SCHEDULED_TIME >= DATEADD(day, -${days - 1}, CURRENT_DATE())
    GROUP BY 1, 2
    ORDER BY 1
  `

  try {
    const rows = await executeSnowflakeQuery<AggRow>(sql, SF_OPTS)

    // Build dense series — one bucket per day in range, even if no rows.
    const buckets = new Map<string, { date: string; succeeded: number; failed: number; other: number }>()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      buckets.set(key, { date: key, succeeded: 0, failed: 0, other: 0 })
    }

    for (const r of rows) {
      const b = buckets.get(r.DAY)
      if (!b) continue
      const cnt = typeof r.CNT === "string" ? parseInt(r.CNT, 10) : r.CNT
      const state = (r.STATE ?? "").toUpperCase()
      if (state === "SUCCEEDED") b.succeeded += cnt
      else if (state === "FAILED" || state === "FAILED_WITH_ERROR") b.failed += cnt
      else b.other += cnt
    }

    return NextResponse.json({ days, series: Array.from(buckets.values()) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/daily-tasks/runs/timeseries] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
