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

// Multi-config table: a campaign can have many named automation configs. This
// is a NEW table the app creates and owns, so it can add columns itself (no
// ALTER rights on the legacy single-config table required).
export const CONFIGS_TABLE = `${CONFIG_SF_OPTS.database}.${CONFIG_SF_OPTS.schema}.TSK_CAMPAIGN_AUTOMATION_CONFIGS`

// Non-key columns (with types) the app writes; used to create the table and to
// add any that are missing on an older version of it.
export const CONFIGS_COLUMNS: [string, string][] = [
  ["CAMPAIGNID", "NUMBER"], ["CONFIG_NAME", "VARCHAR"], ["CAMPAIGN_TITLE", "VARCHAR"],
  ["LEAD_SOURCE", "VARCHAR"],
  ["SFTP_HOST", "VARCHAR"], ["SFTP_PORT", "NUMBER"], ["SFTP_USERNAME", "VARCHAR"],
  ["SFTP_PASSWORD", "VARCHAR"], ["SFTP_PRIVATE_KEY", "VARCHAR"], ["SFTP_REMOTE_PATH", "VARCHAR"],
  ["SFTP_AUTH_TYPE", "VARCHAR"], ["UPLOAD_TARGET_TABLE", "VARCHAR"],
  ["LOAD_HISTORY_PROCEDURE", "VARCHAR"], ["UPDATE_HLL_PROCEDURE", "VARCHAR"], ["SYNC_PROCEDURE", "VARCHAR"],
  ["SOURCE_KIND", "VARCHAR"], ["SOURCE_OBJECT", "VARCHAR"], ["SOURCE_MAPPING_JSON", "VARCHAR"],
  ["UPDATE_HLL_PROCEDURES", "VARCHAR"],
  ["LEAD_EXPIRY_DAYS", "NUMBER"], ["BATCH_NAME_TEMPLATE", "VARCHAR"],
  ["IS_ACTIVE", "BOOLEAN"],
  ["LAST_RUN_AT", "TIMESTAMP_NTZ"], ["LAST_RUN_STATUS", "VARCHAR"], ["LAST_RUN_MESSAGE", "VARCHAR"],
  ["CREATED_BY", "VARCHAR"], ["CREATED_AT", "TIMESTAMP_NTZ"], ["UPDATED_BY", "VARCHAR"], ["UPDATED_AT", "TIMESTAMP_NTZ"],
]

export async function ensureConfigsTable(): Promise<void> {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${CONFIGS_TABLE} (
       CONFIG_ID NUMBER AUTOINCREMENT START 1 INCREMENT 1,
       ${CONFIGS_COLUMNS.map(([n, t]) => `${n} ${t}`).join(", ")}
     )`,
    CONFIG_SF_OPTS
  )
  // Add any columns missing on an older version of the table (app owns it).
  try {
    const existing = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM ${CONFIG_SF_OPTS.database}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${CONFIG_SF_OPTS.schema}' AND TABLE_NAME = 'TSK_CAMPAIGN_AUTOMATION_CONFIGS'`,
      CONFIG_SF_OPTS
    )
    const have = new Set(existing.map((r) => String(r.COLUMN_NAME).toUpperCase()))
    for (const [name, type] of CONFIGS_COLUMNS) {
      if (!have.has(name)) {
        try { await executeSnowflakeQuery(`ALTER TABLE ${CONFIGS_TABLE} ADD COLUMN ${name} ${type}`, CONFIG_SF_OPTS) } catch { /* best-effort */ }
      }
    }
  } catch { /* introspection best-effort */ }
}

// Read one config by its CONFIG_ID.
export async function readConfigById(configId: number): Promise<RunConfigRow | null> {
  const rows = await executeSnowflakeQuery<RunConfigRow>(
    `SELECT * FROM ${CONFIGS_TABLE} WHERE CONFIG_ID = ${configId}`,
    CONFIG_SF_OPTS
  )
  return rows[0] ?? null
}

// Append-only log of distribution runs (one row per completed run). Created by
// the app role, so it needs no ALTER/MODIFY rights on the config table.
export const RUN_HISTORY_TABLE = `${CONFIG_SF_OPTS.database}.${CONFIG_SF_OPTS.schema}.TSK_DISTRIBUTION_RUN_HISTORY`

export async function ensureRunHistoryTable(): Promise<void> {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${RUN_HISTORY_TABLE} (
       ID NUMBER AUTOINCREMENT START 1 INCREMENT 1,
       CAMPAIGNID NUMBER, CONFIG_ID NUMBER, CONFIG_NAME VARCHAR, CAMPAIGN_TITLE VARCHAR,
       STATUS VARCHAR, RAN NUMBER, SUMMARY VARCHAR, STEPS_JSON VARCHAR,
       CREATED_BY VARCHAR,
       CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
     )`,
    CONFIG_SF_OPTS
  )
  // Older history tables predate CONFIG_ID / CONFIG_NAME — add if missing.
  for (const col of ["CONFIG_ID NUMBER", "CONFIG_NAME VARCHAR"]) {
    try { await executeSnowflakeQuery(`ALTER TABLE ${RUN_HISTORY_TABLE} ADD COLUMN IF NOT EXISTS ${col}`, CONFIG_SF_OPTS) } catch { /* best-effort */ }
  }
}

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

// The update-HLL procedures for a config: the new multi list (UPDATE_HLL_PROCEDURES
// JSON array), falling back to the legacy single UPDATE_HLL_PROCEDURE.
export function getUpdateHllProcs(config: RunConfigRow): string[] {
  const raw = str(config, "UPDATE_HLL_PROCEDURES")
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
    } catch { /* fall through */ }
  }
  const single = str(config, "UPDATE_HLL_PROCEDURE")
  return single ? [single] : []
}

// Short display name for a proc reference (last segment before any args).
function procShortName(ref: string): string {
  return ref.split("(")[0].split(".").pop() || ref
}

// The ordered steps that will actually run for this config. The initial source
// is split into "run procedure" (CALL) and "load into HLL" (INSERT); the
// update-HLL step expands into one step per selected procedure.
export function planSteps(config: RunConfigRow): StepDef[] {
  const steps: StepDef[] = []
  const sk = str(config, "SOURCE_KIND").toLowerCase()
  if (sk === "proc") steps.push({ key: "source_proc", label: "Initial source — run procedure" })
  if (sk === "proc" || sk === "view") steps.push({ key: "source_load", label: "Initial source — load into HLL" })
  if (str(config, "LOAD_HISTORY_PROCEDURE")) steps.push({ key: "load_history", label: "Load into history" })
  const uh = getUpdateHllProcs(config)
  uh.forEach((p, i) => steps.push({ key: `update_hll:${i}`, label: uh.length > 1 ? `Update HLL — ${procShortName(p)}` : "Update HLL" }))
  if (str(config, "SYNC_PROCEDURE")) steps.push({ key: "sync", label: "Sync" })
  return steps
}

const PROC_COL: Record<string, string> = {
  load_history: "LOAD_HISTORY_PROCEDURE",
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

  // Update HLL — one of possibly several procedures (key "update_hll" or
  // "update_hll:<index>").
  if (key === "update_hll" || key.startsWith("update_hll:")) {
    const list = getUpdateHllProcs(config)
    const idx = key.includes(":") ? Number(key.split(":")[1]) : 0
    const proc = list[idx] ?? ""
    if (!RUN_PROC_IDENT.test(proc)) throw new Error(`Configured update-HLL procedure is invalid: ${proc || "(empty)"}`)
    return { sql: buildCall(proc), ...dbSchemaOf(proc) }
  }

  const col = PROC_COL[key]
  if (!col) throw new Error(`Unknown step: ${key}`)
  const proc = str(config, col)
  if (!RUN_PROC_IDENT.test(proc)) throw new Error(`Configured ${key} procedure is invalid: ${proc || "(empty)"}`)
  return { sql: buildCall(proc), ...dbSchemaOf(proc) }
}
