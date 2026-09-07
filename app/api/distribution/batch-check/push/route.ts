import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { MAX_PUSH_ROWS, buildDryRun, missingWhere } from "@/lib/batch-check-sql"
import { REPUSH_DATES, pushToSilverSurfer } from "@/lib/silversurfer-push"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Its OWN staging table, not TM_EXTEND_LEADS.
 *
 * The push truncates before it inserts, so sharing one table with Extend
 * Expired Leads means a re-push and an in-flight extend can each silently
 * destroy the other's rows. Created by scripts/batch-recheck-table.sql as
 * LIKE TM_EXTEND_LEADS, so the 39-column positional order cannot drift from
 * its sibling.
 */
const STAGING = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_BATCH_RECHECK_LEADS"

const APP_SF = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" } as const

/**
 * POST — re-push the leads that never reached SilverSurfer.
 *
 * DRY RUN BY DEFAULT. Without `confirm: "PUSH"` in the body this counts what it
 * would send and writes nothing. That is not ceremony: the check reads a
 * replica of the CRM, and a replica that is lagging reports everything as
 * missing. The dry run is the moment to notice.
 */
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const campaignRaw = String(body.campaignId ?? "")
  if (!/^[0-9]+$/.test(campaignRaw)) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const scope = {
    campaignId: Number(campaignRaw),
    from: String(body.from ?? ""),
    to: String(body.to ?? ""),
  }

  let where: string
  let qualify: string
  let dryRunSql: string
  try {
    const m = missingWhere(scope, body.batchNames)
    where = m.where
    qualify = m.qualify
    dryRunSql = buildDryRun(scope, body.batchNames)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }

  try {
    // Always count first, whether or not this is the real thing — the count is
    // what the confirmation was given for, and it is also the cap check.
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(dryRunSql, APP_SF)
    const missing = Number(rows[0]?.MISSING ?? 0)
    const sample = {
      firstId: rows[0]?.FIRST_ID == null ? null : String(rows[0].FIRST_ID),
      lastId: rows[0]?.LAST_ID == null ? null : String(rows[0].LAST_ID),
    }

    if (body.confirm !== "PUSH") {
      return NextResponse.json({ ok: true, dryRun: true, missing, sample })
    }
    if (missing === 0) {
      return NextResponse.json({ ok: true, dryRun: false, missing: 0, pushed: 0, steps: [] })
    }
    if (missing > MAX_PUSH_ROWS) {
      return NextResponse.json(
        {
          error:
            `${missing.toLocaleString()} leads is more than the ${MAX_PUSH_ROWS.toLocaleString()} cap for one push. ` +
            `That many missing usually means the SilverSurfer copy is lagging rather than that the load failed — ` +
            `check the freshness line before narrowing the date range and trying again.`,
        },
        { status: 400 }
      )
    }

    // REPUSH_DATES, not EXTEND_DATES: this sends the lead as it was loaded and
    // must not quietly move its expiry.
    const result = await pushToSilverSurfer({
      stagingTable: STAGING,
      where,
      qualify,
      dates: REPUSH_DATES,
    })

    return NextResponse.json(
      {
        ok: result.ok,
        dryRun: false,
        missing,
        pushed: result.inserted,
        steps: result.steps,
        batchNames: body.batchNames,
      },
      { status: result.ok ? 200 : 500 }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/batch-check/push POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
