import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"

// Live read of the uploaded BDM pipeline (see pipeline-upload). Returns the same
// shape as the baked snapshot ({snapshot_date, rows:[{stage,sort,category,count}]})
// plus the upload stamp, so the page can read it live with a snapshot fallback.
// Responds 404 when nothing has been uploaded yet, so the client falls back.
const TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.SPOT_PIPELINE"
const SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot-report")
  if (guard instanceof NextResponse) return guard
  try {
    const rows = await executeSnowflakeQuery<{ STAGE: string; SORT: number | string; CATEGORY: string; CNT: number | string }>(
      `SELECT STAGE, SORT, CATEGORY, CNT FROM ${TABLE}`,
      SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ hasData: false }, { status: 404 })

    const meta = await executeSnowflakeQuery<{ AT: string | null; BY: string | null }>(
      `SELECT TO_VARCHAR(MAX(UPLOADED_AT), 'YYYY-MM-DD HH24:MI') AS AT, MAX(UPLOADED_BY) AS BY FROM ${TABLE}`,
      SF_OPTS
    )
    const num = (v: unknown) => (typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0)
    const data = rows.map((r) => ({ stage: String(r.STAGE), sort: num(r.SORT), category: String(r.CATEGORY), count: num(r.CNT) }))
    const uploadedAt = meta[0]?.AT ? String(meta[0].AT) : null

    return NextResponse.json({
      hasData: true,
      snapshot_date: uploadedAt ? uploadedAt.slice(0, 10) : null,
      uploadedAt,
      uploadedBy: meta[0]?.BY ? String(meta[0].BY) : null,
      rows: data,
      _live: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/pipeline] error:", message)
    // Fall back to snapshot on error.
    return NextResponse.json({ hasData: false, error: message }, { status: 404 })
  }
}
