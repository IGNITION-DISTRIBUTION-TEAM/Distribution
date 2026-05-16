import { NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_DIALLER_STATS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

export async function GET() {
  try {
    const rows = await executeSnowflakeQuery<{ V: string | null }>(
      `SELECT DISTINCT CALL_STATUS AS V
       FROM ${VIEW}
       WHERE CALL_STATUS IS NOT NULL
       ORDER BY V`,
      SF_OPTS
    )
    return NextResponse.json({
      values: {
        callStatuses: rows
          .map((r) => (r.V === null ? "" : String(r.V)))
          .filter((v) => v.length > 0),
      },
      errors: {} as Record<string, string>,
    })
  } catch (error) {
    return NextResponse.json(
      {
        values: { callStatuses: [] },
        errors: { callStatuses: error instanceof Error ? error.message : String(error) },
      },
      { status: 200 }
    )
  }
}
