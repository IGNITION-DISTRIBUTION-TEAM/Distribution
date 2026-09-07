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

  // No campaign here: each pick carries its own, so a single push can cover
  // batches from several campaigns at once.
  const scope = {
    campaignId: null,
    from: String(body.from ?? ""),
    to: String(body.to ?? ""),
  }

  let where: string
  let qualify: string
  let dryRunSql: string
  let picks: { campaignId: number; batchName: string }[]
  try {
    const m = missingWhere(scope, body.picks)
    where = m.where
    qualify = m.qualify
    picks = m.picks
    dryRunSql = buildDryRun(scope, body.picks)
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
      // Shaped from the table the extend path already uses, so the 39-column
      // positional order cannot differ between the two pushes.
      createLike: "DATAWAREHOUSE.LEADS_DISTRIBUTION.TM_EXTEND_LEADS",
    })

    // A failed step carries the real Snowflake message; without lifting it into
    // `error` the client sees a bare "HTTP 500" and the reason is thrown away.
    // The commonest cause is the staging table not existing yet, which is a
    // one-script fix the operator can only make if they are told.
    const failed = result.steps.find((st) => !st.ok)
    return NextResponse.json(
      {
        ok: result.ok,
        dryRun: false,
        missing,
        pushed: result.inserted,
        steps: result.steps,
        picks,
        ...(failed
          ? {
              error:
                `The ${failed.name} step failed: ${failed.error ?? "no detail returned"}` +
                (/does not exist or not authorized/i.test(failed.error ?? "")
                  ? `\n\nIf it names ${STAGING}, that table has not been created yet — ` +
                    `run scripts/batch-recheck-table.sql.`
                  : ""),
            }
          : {}),
      },
      { status: result.ok ? 200 : 500 }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/distribution/batch-check/push POST] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
