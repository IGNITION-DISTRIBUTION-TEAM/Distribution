import { executeSnowflakeQuery } from "@/lib/snowflake"
import {
  TABLE as CONFIG_TABLE,
  SF_OPTS as CONFIG_SF_OPTS,
  RUN_QUALIFIED,
  RUN_PROC_IDENT,
} from "@/app/api/campaign-config/route"
import { IDENT_COL } from "@/app/api/distribution/tasks/route"
import {
  HLL_TABLE,
  hllColumnSet,
  buildHllInsertLists,
  buildAutoExprs,
  activeAutoExprs,
  normLeadExpiryDays,
} from "@/lib/hll-insert"

// A campaign config row (only the fields the run needs; SELECT * fills the rest).
export type RunConfigRow = Record<string, unknown>

export type StepDef = { key: string; label: string }

export const CONFIG_TABLE_REF = CONFIG_TABLE
export const CONFIG_SF = CONFIG_SF_OPTS

function str(config: RunConfigRow, col: string): string {
  const v = config[col]
  return v == null ? "" : String(v).trim()
}

// A proc reference may carry a call-argument list (e.g. DB.SCHEMA.SP_X(1)).
function buildCall(procRef: string): string {
  return procRef.includes("(") ? `CALL ${procRef}` : `CALL ${procRef}()`
}
function dbSchemaOf(ref: string): { database: string; schema: string } {
  const [database, schema] = ref.split("(")[0].split(".")
  return { database, schema }
}

export async function readRunConfig(campaignId: number): Promise<RunConfigRow | null> {
  const rows = await executeSnowflakeQuery<RunConfigRow>(
    `SELECT * FROM ${CONFIG_TABLE} WHERE CAMPAIGNID = ${campaignId}`,
    CONFIG_SF_OPTS
  )
  return rows[0] ?? null
}

export function isConfigActive(config: RunConfigRow): boolean {
  const v = config.IS_ACTIVE
  return v == null ? true : v === true || String(v).toUpperCase() === "TRUE"
}

// The ordered steps that will actually run for this config. The initial source
// is split into "run procedure" (CALL) and "load into HLL" (INSERT) so each is
// a single statement that can be submitted async and polled independently.
export function planSteps(config: RunConfigRow): StepDef[] {
  const steps: StepDef[] = []
  const sk = str(config, "SOURCE_KIND").toLowerCase()
  if (sk === "proc") steps.push({ key: "source_proc", label: "Initial source — run procedure" })
  if (sk === "proc" || sk === "view") steps.push({ key: "source_load", label: "Initial source — load into HLL" })
  if (str(config, "LOAD_HISTORY_PROCEDURE")) steps.push({ key: "load_history", label: "Load into history" })
  if (str(config, "UPDATE_HLL_PROCEDURE")) steps.push({ key: "update_hll", label: "Update HLL" })
  if (str(config, "SYNC_PROCEDURE")) steps.push({ key: "sync", label: "Sync" })
  return steps
}

const PROC_COL: Record<string, string> = {
  load_history: "LOAD_HISTORY_PROCEDURE",
  update_hll: "UPDATE_HLL_PROCEDURE",
  sync: "SYNC_PROCEDURE",
}

// Build the SQL + exec opts for one step. Throws a clear message on bad config.
export async function buildStepSql(
  config: RunConfigRow,
  campaignId: number,
  key: string
): Promise<{ sql: string; database: string; schema: string }> {
  if (key === "source_proc") {
    const object = str(config, "SOURCE_OBJECT")
    if (!RUN_PROC_IDENT.test(object)) throw new Error(`Source procedure is not valid: ${object || "(empty)"}`)
    return { sql: buildCall(object), ...dbSchemaOf(object) }
  }

  if (key === "source_load") {
    const kind = str(config, "SOURCE_KIND").toLowerCase()
    const object = str(config, "SOURCE_OBJECT")
    const stage = str(config, "UPLOAD_TARGET_TABLE")
    const readFrom = kind === "proc" ? stage : object
    if (!RUN_QUALIFIED.test(readFrom)) {
      throw new Error(`${kind === "proc" ? "Upload target" : "View"} must be DATABASE.SCHEMA.NAME: ${readFrom || "(empty)"}`)
    }
    let mapping: Record<string, string> = {}
    try { mapping = JSON.parse(str(config, "SOURCE_MAPPING_JSON") || "{}") } catch { mapping = {} }
    const pairs = Object.entries(mapping).filter(([h, s]) => IDENT_COL.test(h) && typeof s === "string" && IDENT_COL.test(s)) as [string, string][]
    let hllColumns: Set<string> | null = null
    try { hllColumns = await hllColumnSet() } catch { /* assume reserved cols exist */ }
    const autos = activeAutoExprs(
      buildAutoExprs(campaignId, normLeadExpiryDays(config.LEAD_EXPIRY_DAYS), str(config, "BATCH_NAME_TEMPLATE") || null),
      hllColumns
    )
    const autoUpper = new Set(Object.keys(autos).map((c) => c.toUpperCase()))
    if (pairs.filter(([h]) => !autoUpper.has(h.toUpperCase())).length === 0) {
      throw new Error("Map at least one source column (besides the auto-filled ones) into HLL.")
    }
    const { hllCols, selectExprs } = buildHllInsertLists(pairs, autos)
    return {
      sql: `INSERT INTO ${HLL_TABLE} (${hllCols.join(", ")}) SELECT ${selectExprs.join(", ")} FROM ${readFrom}`,
      database: HLL_TABLE.split(".")[0],
      schema: HLL_TABLE.split(".")[1],
    }
  }

  const col = PROC_COL[key]
  if (!col) throw new Error(`Unknown step: ${key}`)
  const proc = str(config, col)
  if (!RUN_PROC_IDENT.test(proc)) throw new Error(`Configured ${key} procedure is invalid: ${proc || "(empty)"}`)
  return { sql: buildCall(proc), ...dbSchemaOf(proc) }
}
