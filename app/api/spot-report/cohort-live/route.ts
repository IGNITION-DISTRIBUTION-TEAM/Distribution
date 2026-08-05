import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Inspection endpoint for the cohort view. Once VW_COHORT_OVERALL_SALES_WITH_
// AGING_ON_MEASURES is granted, hitting this returns its column names + a few
// sample rows so the real cohort query can be written against the actual schema
// (no column-name guessing). This becomes the live cohort read once the mapping
// is known.
const VIEW = "UCONNECT_DW.ANALYTICS.VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES"
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(`SELECT * FROM ${VIEW} LIMIT 5`, SF_OPTS)
    const columns = rows.length ? Object.keys(rows[0]) : []
    return NextResponse.json({ ok: true, columns, rowCount: rows.length, sample: rows })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 200 })
  }
}
