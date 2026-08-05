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
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

// Column list from INFORMATION_SCHEMA (metadata only — instant, never
// materializes the heavy view). Pass ?sample=1 to also pull a few rows, but
// note that DOES run the view (~90s) so leave it off unless needed.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const cols = await executeSnowflakeQuery<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM UCONNECT_DW.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'ANALYTICS'
         AND TABLE_NAME = 'VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES'
       ORDER BY ORDINAL_POSITION`,
      SF_OPTS
    )
    const columns = cols.map((c) => `${c.COLUMN_NAME} (${c.DATA_TYPE})`)
    let sample: Record<string, unknown>[] | undefined
    if (request.nextUrl.searchParams.get("sample") === "1") {
      sample = await executeSnowflakeQuery<Record<string, unknown>>(
        `SELECT * FROM UCONNECT_DW.ANALYTICS.VW_COHORT_OVERALL_SALES_WITH_AGING_ON_MEASURES LIMIT 5`,
        SF_OPTS
      )
    }
    return NextResponse.json({ ok: true, columns, sample })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 200 })
  }
}
