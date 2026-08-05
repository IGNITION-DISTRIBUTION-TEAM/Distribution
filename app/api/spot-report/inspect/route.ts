import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

// Fast column inspection (INFORMATION_SCHEMA, metadata only — never runs the
// views) for the sources needed to make the remaining Commercial/Recharges
// pages live. Hit this once the grants are applied and paste the result so the
// queries can be written against the real schema without guessing.
const VIEWS = [
  "VW_TELCO_MONTHLY_REVENUE_L13MONTHS",
  "VW_PARGO_COLLECTIONS",
  "VW_ACTIVE_SUBSCRIPTIONS_USAGE_DETAILS",
  "VW_SNU_FOR_ACCOUNTS_35_60_DAYS_OLD_PER_MONTH",
  "VW_SNU_FOR_ACCOUNTS_35_60_DAYS_OLD_PER_DAY",
]
const SF_OPTS = { database: "UCONNECT_DW", schema: "ANALYTICS" } as const

export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard
  const inList = VIEWS.map((v) => `'${v}'`).join(", ")
  try {
    const rows = await executeSnowflakeQuery<{ TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string; ORDINAL_POSITION: number | string }>(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
       FROM UCONNECT_DW.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'ANALYTICS' AND TABLE_NAME IN (${inList})
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      SF_OPTS
    )
    const byView: Record<string, string[]> = {}
    for (const r of rows) {
      const t = String(r.TABLE_NAME)
      ;(byView[t] ??= []).push(`${r.COLUMN_NAME} (${r.DATA_TYPE})`)
    }
    const missing = VIEWS.filter((v) => !byView[v])
    return NextResponse.json({ ok: true, views: byView, missingOrUngranted: missing })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 200 })
  }
}
