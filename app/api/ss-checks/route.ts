import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

const VIEW = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_SS_CHECKS"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT * FROM ${VIEW}`,
      SF_OPTS
    )
    return NextResponse.json({ rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/ss-checks] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
