import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  TABLE as CONFIG_TABLE,
  SF_OPTS as CONFIG_SF_OPTS,
  sqlStr,
  RUN_QUALIFIED,
  RUN_PROC_IDENT,
  ensurePublicConfigColumns,
} from "@/app/api/campaign-config/route"
import { IDENT_COL } from "@/app/api/distribution/tasks/route"

const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

type StepResult = { step: string; status: "success" | "error" | "skipped"; message: string }

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// A proc reference may carry a call-argument list (e.g. DB.SCHEMA.SP_X(1)).
// Build the CALL statement and pull the DB/SCHEMA from the part before "(".
function buildCall(procRef: string): { sql: string; database: string; schema: string } {
  const head = procRef.split("(")[0]
  const [database, schema] = head.split(".")
  const sql = procRef.includes("(") ? `CALL ${procRef}` : `CALL ${procRef}()`
  return { sql, database, schema }
}

// POST — run the campaign's full distribution in order, stopping at the first
// failure: Step 1 initial source → HLL, then load-history, update-HLL, sync.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const campaignId = parseId(id)
  if (campaignId === null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })

  // Read the campaign's stored config.
  type Config = {
    SOURCE_KIND: string | null
    SOURCE_OBJECT: string | null
    SOURCE_MAPPING_JSON: string | null
    UPLOAD_TARGET_TABLE: string | null
    LOAD_HISTORY_PROCEDURE: string | null
    UPDATE_HLL_PROCEDURE: string | null
    SYNC_PROCEDURE: string | null
    IS_ACTIVE: boolean | string | null
  }
  let config: Config
  try {
    await ensurePublicConfigColumns()
    const rows = await executeSnowflakeQuery<Config>(
      `SELECT SOURCE_KIND, SOURCE_OBJECT, SOURCE_MAPPING_JSON, UPLOAD_TARGET_TABLE,
              LOAD_HISTORY_PROCEDURE, UPDATE_HLL_PROCEDURE, SYNC_PROCEDURE, IS_ACTIVE
       FROM ${CONFIG_TABLE} WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ error: "No campaign config found for this campaign." }, { status: 400 })
    config = rows[0]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }

  const isActive = config.IS_ACTIVE === true || String(config.IS_ACTIVE).toUpperCase() === "TRUE"
  if (!isActive) {
    return NextResponse.json({ error: "This campaign's config is inactive. Activate it before running." }, { status: 400 })
  }

  const results: StepResult[] = []

  // ── Step 1: initial source → HLL ────────────────────────────────────────
  const sourceKind = (config.SOURCE_KIND ?? "none").trim().toLowerCase()
  if (sourceKind === "proc" || sourceKind === "view") {
    const r = await runInitialSource(sourceKind, config)
    results.push(r)
    if (r.status === "error") return finish(campaignId, results)
  } else {
    results.push({ step: "Initial source", status: "skipped", message: "No initial source configured." })
  }

  // ── Steps 2-4: the configured procedures, in order ──────────────────────
  const procSteps: { step: string; ref: string | null }[] = [
    { step: "Load into history", ref: config.LOAD_HISTORY_PROCEDURE },
    { step: "Update HLL", ref: config.UPDATE_HLL_PROCEDURE },
    { step: "Sync", ref: config.SYNC_PROCEDURE },
  ]
  for (const { step, ref } of procSteps) {
    const proc = (ref ?? "").trim()
    if (!proc) {
      results.push({ step, status: "skipped", message: "Not configured." })
      continue
    }
    if (!RUN_PROC_IDENT.test(proc)) {
      results.push({ step, status: "error", message: `Configured procedure is invalid: ${proc}` })
      return finish(campaignId, results)
    }
    try {
      const { sql, database, schema } = buildCall(proc)
      await executeSnowflakeQuery(sql, { database, schema })
      results.push({ step, status: "success", message: `Ran ${proc}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ step, status: "error", message: `Failed at ${proc}: ${message}` })
      return finish(campaignId, results)
    }
  }

  return finish(campaignId, results)
}

// Run Step 1: for a proc source, CALL it to (re)populate the upload/stage table,
// then append mapped columns into HLL; for a view, append straight from the view.
async function runInitialSource(
  kind: string,
  config: {
    SOURCE_OBJECT: string | null
    SOURCE_MAPPING_JSON: string | null
    UPLOAD_TARGET_TABLE: string | null
  }
): Promise<StepResult> {
  const step = "Initial source"
  const object = (config.SOURCE_OBJECT ?? "").trim()
  const stageTable = (config.UPLOAD_TARGET_TABLE ?? "").trim()

  if (!object || !RUN_PROC_IDENT.test(object)) {
    return { step, status: "error", message: `Source object is not valid: ${object || "(empty)"}` }
  }
  // What we SELECT from: the proc's upload/stage table, or the view itself.
  const readFrom = kind === "proc" ? stageTable : object
  if (kind === "proc" && (!stageTable || !RUN_QUALIFIED.test(stageTable))) {
    return { step, status: "error", message: `Upload target table (for the proc's output) must be DATABASE.SCHEMA.TABLE: ${stageTable || "(empty)"}` }
  }
  if (kind === "view" && !RUN_QUALIFIED.test(object)) {
    return { step, status: "error", message: `View must be DATABASE.SCHEMA.NAME: ${object}` }
  }

  // Parse + validate the { hllColumn: sourceColumn } mapping.
  let mapping: Record<string, string>
  try {
    mapping = JSON.parse(config.SOURCE_MAPPING_JSON ?? "{}")
  } catch {
    mapping = {}
  }
  const pairs = Object.entries(mapping).filter(([h, s]) => IDENT_COL.test(h) && typeof s === "string" && IDENT_COL.test(s))
  if (pairs.length === 0) {
    return { step, status: "error", message: "No column mapping is set for the initial source." }
  }

  try {
    // 1. If proc, run it to (re)populate its upload/stage table.
    if (kind === "proc") {
      const { sql, database, schema } = buildCall(object)
      await executeSnowflakeQuery(sql, { database, schema })
    }
    // 2. Append mapped rows into HLL.
    const hllCols = pairs.map(([h]) => h).join(", ")
    const srcCols = pairs.map(([, s]) => s).join(", ")
    await executeSnowflakeQuery(
      `INSERT INTO ${HLL_TABLE} (${hllCols}) SELECT ${srcCols} FROM ${readFrom}`,
      { database: HLL_TABLE.split(".")[0], schema: HLL_TABLE.split(".")[1] }
    )
    // 3. Best-effort row count of the source.
    let loaded = ""
    try {
      const [dbR, schR] = readFrom.split(".")
      const cnt = await executeSnowflakeQuery<{ N: number | string }>(`SELECT COUNT(*) AS N FROM ${readFrom}`, { database: dbR, schema: schR })
      loaded = ` (${Number(cnt[0]?.N ?? 0).toLocaleString()} source rows)`
    } catch { /* count is best-effort */ }
    const label = kind === "proc" ? `${object} → ${readFrom}` : object
    return { step, status: "success", message: `Loaded ${label} into HLL${loaded}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { step, status: "error", message: `Initial source → HLL failed: ${message}` }
  }
}

// Persist the run outcome on the config row and return the response.
async function finish(campaignId: number, results: StepResult[]): Promise<NextResponse> {
  const failed = results.some((r) => r.status === "error")
  const ranCount = results.filter((r) => r.status === "success").length
  const summary = results.map((r) => `${r.step}: ${r.status}`).join(" | ")
  const status = failed ? "Error" : "Success"
  try {
    await executeSnowflakeQuery(
      `UPDATE ${CONFIG_TABLE} SET LAST_RUN_AT = CURRENT_TIMESTAMP(), LAST_RUN_STATUS = ${sqlStr(status)},
              LAST_RUN_MESSAGE = ${sqlStr(summary.slice(0, 4000))}
       WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF_OPTS
    )
  } catch (e) {
    console.error("[/api/distribution/campaigns/[id]/run] record error:", e)
  }
  return NextResponse.json({ ok: !failed, ran: ranCount, results }, { status: failed ? 500 : 200 })
}
