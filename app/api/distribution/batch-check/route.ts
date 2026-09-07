import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { buildFreshness, buildSummary } from "@/lib/batch-check-sql"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

const APP_SF = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" } as const

/**
 * GET ?campaignId=&from=&to= — how many leads each batch has in HLL versus how
 * many reached SilverSurfer.
 *
 * Read-only. Nothing here writes, which is why it can run freely; the push is a
 * separate route with a confirm.
 *
 * The freshness pair rides along because the SilverSurfer side is a replica.
 * Without it, a check made minutes after a sync reports every lead as missing
 * and looks authoritative. See lib/batch-check-sql.ts.
 */
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  const params = request.nextUrl.searchParams
  // campaignId is OPTIONAL and omitted means every campaign. That is the point
  // of the screen: you do not know which campaign is short until you look, so
  // requiring one meant checking them one at a time.
  const campaignRaw = params.get("campaignId") ?? ""
  if (campaignRaw !== "" && !/^[0-9]+$/.test(campaignRaw)) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const scope = {
    campaignId: campaignRaw === "" ? null : Number(campaignRaw),
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  }

  let summarySql: string
  try {
    summarySql = buildSummary(scope)
  } catch (error) {
    // The builders throw on a bad scope rather than escaping it, so this is a
    // 400 and not a 500.
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }

  try {
    const [rows, fresh] = await Promise.all([
      executeSnowflakeQuery<Record<string, unknown>>(summarySql, APP_SF),
      executeSnowflakeQuery<Record<string, unknown>>(buildFreshness(), APP_SF).catch(() => []),
    ])

    const batches = rows.map((r) => ({
      campaignId: r.CAMPAIGNID == null ? "" : String(r.CAMPAIGNID),
      batchName: r.BATCHNAME == null ? "(unnamed)" : String(r.BATCHNAME),
      hllCount: Number(r.HLL_COUNT ?? 0),
      ssCount: Number(r.SS_COUNT ?? 0),
      shortfall: Number(r.SHORTFALL ?? 0),
      missingByBatch: Number(r.MISSING_BY_BATCH ?? 0),
    }))

    const f = fresh[0] ?? {}
    return NextResponse.json({
      batches,
      freshness: {
        hllLatest: f.HLL_LATEST == null ? null : String(f.HLL_LATEST),
        ssLatest: f.SS_LATEST == null ? null : String(f.SS_LATEST),
      },
      totals: {
        hll: batches.reduce((n, b) => n + b.hllCount, 0),
        missing: batches.reduce((n, b) => n + b.missingByBatch, 0),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/batch-check GET] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
