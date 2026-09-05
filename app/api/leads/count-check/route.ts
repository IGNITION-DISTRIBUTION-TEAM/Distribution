import { NextRequest, NextResponse } from "next/server"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { readCampaignSetting } from "@/lib/config-lookup"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
const HLL_SF_OPTS = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_DATA_APPLICATION" } as const

async function countRows(sql: string, opts: { database: string; schema: string }): Promise<number> {
  const rows = await executeSnowflakeQuery<{ CNT: number | string }>(sql, opts)
  const v = rows[0]?.CNT
  return typeof v === "number" ? v : parseInt(String(v ?? "0"), 10) || 0
}

export type LabelCount = {
  /** null for an absent value — not a string, so the UI decides how to say it. */
  label: string | null
  leads: number
}

/**
 * The columns this endpoint will group by, and how each is ordered.
 *
 * A fixed map, not a request parameter: the column name is interpolated into
 * SQL, so it can only ever be one of these literals.
 *
 * ESTATUS is ordered by size — the dominant exclusion reason is what you look
 * for. UDM30 is a rank, which has its own order and reads as a ladder, so it is
 * ordered numerically. TRY_TO_NUMBER takes VARCHAR only, hence the cast; a rank
 * that is not numeric sorts last by its text rather than breaking the query.
 */
const GROUPABLE: Record<string, { column: string; orderBy: string; where?: string }> = {
  estatus: { column: "ESTATUS", orderBy: "LEADS DESC" },
  // Eligible leads only. A rank decides dialling order, and a labelled lead is
  // one something upstream objected to — its position in the queue is not the
  // question. It also matches how the rank is produced: SP_VCD_VCCVM_POST_LOAD
  // only scores rows where ESTATUS IS NULL, so labelled leads would show up as
  // unranked for a reason that has nothing to do with the ranking step.
  rank: {
    column: "UDM30",
    where: "ESTATUS IS NULL",
    orderBy: "TRY_TO_NUMBER(UDM30::VARCHAR) NULLS LAST, UDM30",
  },
}

/**
 * Today's rows for this campaign, grouped by one column.
 *
 * Never throws. The counts are this endpoint's job and the breakdowns are an
 * addition, so a breakdown that fails must not take the reconciliation with it —
 * it reports its own failure instead, and the UI says so rather than quietly
 * showing one fewer panel.
 */
async function readGrouped(
  campaignId: number,
  which: keyof typeof GROUPABLE
): Promise<{ rows: LabelCount[] | null; error: string | null }> {
  const { column, orderBy, where } = GROUPABLE[which]
  try {
    const rows = await executeSnowflakeQuery<{ LABEL: string | null; LEADS: number | string }>(
      `SELECT ${column} AS LABEL, COUNT(1) AS LEADS
         FROM ${HLL_TABLE}
        WHERE CAMPAIGNID = ${campaignId}
          AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()
          ${where ? `AND ${where}` : ""}
        GROUP BY ${column}
        ORDER BY ${orderBy}`,
      HLL_SF_OPTS
    )
    return {
      rows: rows.map((r) => {
        const raw = r.LABEL
        // An empty string is not the same as NULL in Snowflake but means the
        // same thing here, so both collapse to one row rather than showing a
        // blank one.
        const label = raw == null || String(raw).trim() === "" ? null : String(raw)
        const n = typeof r.LEADS === "number" ? r.LEADS : parseInt(String(r.LEADS ?? "0"), 10) || 0
        return { label, leads: n }
      }),
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[/api/leads/count-check] ${column} breakdown failed:`, message)
    return { rows: null, error: message }
  }
}

// Compare the stage table row count against the HLL (main) table for this
// campaign loaded today. Stage table is read from the campaign config.
export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  let body: { campaignId?: unknown; configId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.campaignId || !/^[0-9]+$/.test(String(body.campaignId))) {
    return NextResponse.json({ error: "campaignId must be a positive integer" }, { status: 400 })
  }
  const id = Number(body.campaignId)
  const configId =
    body.configId != null && /^[0-9]+$/.test(String(body.configId)) ? Number(body.configId) : null

  let stageTable: string | null
  let configSource: string
  try {
    const found = await readCampaignSetting(id, configId, ["UPLOAD_TARGET_TABLE"])
    stageTable = found.value
    configSource = found.source
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/count-check] config read error:", message)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }

  if (!stageTable) {
    return NextResponse.json(
      {
        error:
          `No upload target (stage) table is configured for campaign ${id}` +
          `${configId != null ? ` in config ${configId}` : ""}. Set it in ` +
          `Settings → Campaign automation, on the same config this panel is using — ` +
          `checked ${configSource}.`,
      },
      { status: 400 }
    )
  }
  stageTable = stageTable.trim()
  if (!QUALIFIED.test(stageTable)) {
    return NextResponse.json(
      { error: `Configured stage table is not a valid DATABASE.SCHEMA.NAME: ${stageTable}` },
      { status: 400 }
    )
  }
  const [stageDb, stageSchema] = stageTable.split(".")

  try {
    const [stageCount, hllCount, byEstatus, byRank] = await Promise.all([
      countRows(`SELECT COUNT(1) AS CNT FROM ${stageTable}`, {
        database: stageDb,
        schema: stageSchema,
      }),
      // Campaign + today, deliberately WITHOUT an ESTATUS filter.
      countRows(
        `SELECT COUNT(1) AS CNT FROM ${HLL_TABLE}
         WHERE CAMPAIGNID = ${id}
           AND CAST(CREATEDONDATE AS DATE) = CURRENT_DATE()`,
        HLL_SF_OPTS
      ),
      // The same rows, split by label. Matching totals say the load lost
      // nothing; this says what is actually IN it — a batch can reconcile
      // perfectly and still be mostly leads something upstream excluded.
      // NULL is its own row rather than being folded away: an unlabelled lead
      // is the eligible case, and it is the number people are looking for.
      readGrouped(id, "estatus"),
      // UDM30 is the rank, written by the LAST update-HLL procedure. Straight
      // after a load it is legitimately all NULL, and the count of unranked
      // leads is how you see whether the ranking has run at all. Scoped to
      // ESTATUS IS NULL — see GROUPABLE.
      readGrouped(id, "rank"),
    ])

    return NextResponse.json({
      stageTable,
      stageCount,
      hllCount,
      match: stageCount === hllCount,
      byEstatus: byEstatus.rows,
      byEstatusError: byEstatus.error,
      byRank: byRank.rows,
      byRankError: byRank.error,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/leads/count-check] error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
