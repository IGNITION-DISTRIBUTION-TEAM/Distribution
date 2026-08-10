import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { RUN_HISTORY_TABLE, CONFIG_SF, ensureRunHistoryTable } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

type HistoryRow = {
  ID: number | string
  CREATED_AT: string | null
  STATUS: string | null
  RAN: number | string | null
  SUMMARY: string | null
  CREATED_BY: string | null
}

// GET — the most recent runs for this config, newest first.
export async function GET(request: NextRequest, { params }: { params: Promise<{ configId: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { configId } = await params
  const id = parseId(configId)
  if (id === null) return NextResponse.json({ error: "Invalid config id" }, { status: 400 })
  try {
    await ensureRunHistoryTable()
    const rows = await executeSnowflakeQuery<HistoryRow>(
      `SELECT ID, TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI') AS CREATED_AT,
              STATUS, RAN, SUMMARY, CREATED_BY
       FROM ${RUN_HISTORY_TABLE} WHERE CONFIG_ID = ${id}
       ORDER BY ID DESC LIMIT 20`,
      CONFIG_SF
    )
    return NextResponse.json({ rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 200 })
  }
}
