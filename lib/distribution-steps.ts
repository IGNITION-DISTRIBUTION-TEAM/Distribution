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
  // Optional: what the mapped INSERT reads. Defaults to the upload target.
  ["SOURCE_LOAD_FROM", "VARCHAR"],
  ["UPDATE_HLL_PROCEDURES", "VARCHAR"],
  // Structured sync (SP_SYNC_TO_SQLSERVER_LARGE): view is interchangeable.
  ["SYNC_SOURCE_VIEW", "VARCHAR"], ["SYNC_TARGET_TABLE", "VARCHAR"], ["SYNC_COLUMNS", "VARCHAR"], ["SYNC_BATCH_SIZE", "NUMBER"],
  // The sync is fire-and-forget (can run ~hours); track the last submission.
  ["SYNC_LAST_HANDLE", "VARCHAR"], ["SYNC_LAST_AT", "TIMESTAMP_NTZ"], ["SYNC_LAST_STATUS", "VARCHAR"],
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

// Completion-marker table for the fire-and-forget sync. The submitted Snowflake
// Scripting block writes 'running' at the start and 'done'/'error' at the end,
// so the app knows the sync finished independent of the browser / handle TTL.
export const SYNC_RUNS_TABLE = `${CONFIG_SF_OPTS.database}.${CONFIG_SF_OPTS.schema}.TSK_DISTRIBUTION_SYNC_RUNS`

export async function ensureSyncRunsTable(): Promise<void> {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${SYNC_RUNS_TABLE} (
       ID NUMBER AUTOINCREMENT START 1 INCREMENT 1,
       CONFIG_ID NUMBER, CAMPAIGNID NUMBER, RUN_TOKEN VARCHAR,
       STATUS VARCHAR, MESSAGE VARCHAR,
       STARTED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(), FINISHED_AT TIMESTAMP_NTZ
     )`,
    CONFIG_SF_OPTS
  )
}

// Build the Snowflake Scripting block that runs the sync and records its
// outcome in SYNC_RUNS, keyed by a caller-supplied token. `token` must be a
// safe string (a UUID). Returns the block + execution context.
export async function buildSyncBlock(
  config: RunConfigRow,
  configId: number,
  campaignId: number,
  token: string
): Promise<{ sql: string; database: string; schema: string }> {
  const { sql: callSql } = await buildStepSql(config, campaignId, "sync")
  const t = token.replace(/'/g, "''")
  const sql = `BEGIN
  INSERT INTO ${SYNC_RUNS_TABLE} (CONFIG_ID, CAMPAIGNID, RUN_TOKEN, STATUS) VALUES (${configId}, ${campaignId}, '${t}', 'running');
  ${callSql};
  UPDATE ${SYNC_RUNS_TABLE} SET STATUS = 'done', FINISHED_AT = CURRENT_TIMESTAMP() WHERE RUN_TOKEN = '${t}';
  RETURN 'done';
EXCEPTION
  WHEN OTHER THEN
    LET errmsg VARCHAR := SQLERRM;
    UPDATE ${SYNC_RUNS_TABLE} SET STATUS = 'error', MESSAGE = :errmsg, FINISHED_AT = CURRENT_TIMESTAMP() WHERE RUN_TOKEN = '${t}';
    RETURN 'error';
END;`
  return { sql, database: CONFIG_SF_OPTS.database, schema: CONFIG_SF_OPTS.schema }
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
  // Older history tables predate CONFIG_ID / CONFIG_NAME. Introspect and add
  // any missing columns with a plain ALTER (don't rely on ADD COLUMN IF NOT
  // EXISTS support). Without these columns the per-config write/read fail
  // silently and no history shows.
  try {
    const existing = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM ${CONFIG_SF_OPTS.database}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${CONFIG_SF_OPTS.schema}' AND TABLE_NAME = 'TSK_DISTRIBUTION_RUN_HISTORY'`,
      CONFIG_SF_OPTS
    )
    const have = new Set(existing.map((r) => String(r.COLUMN_NAME).toUpperCase()))
    for (const [name, type] of [["CONFIG_ID", "NUMBER"], ["CONFIG_NAME", "VARCHAR"]] as [string, string][]) {
      if (!have.has(name)) {
        try { await executeSnowflakeQuery(`ALTER TABLE ${RUN_HISTORY_TABLE} ADD COLUMN ${name} ${type}`, CONFIG_SF_OPTS) } catch { /* best-effort */ }
      }
    }
  } catch { /* introspection best-effort */ }
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
  const fileSource = str(config, "LEAD_SOURCE").toLowerCase() === "file"
  // A procedure always runs BEFORE the load, never instead of it: it prepares
  // what the mapped INSERT then reads. Same order for every lead source; only
  // the labels differ, since on a file source this is step 2 rather than step 1.
  if (sk === "proc") {
    steps.push({
      key: "source_proc",
      label: fileSource ? "Load into HLL — run procedure" : "Initial source — run procedure",
    })
  }
  if (sk === "proc" || sk === "view") {
    steps.push({
      key: "source_load",
      label: fileSource ? "Load into HLL — map into HLL" : "Initial source — load into HLL",
    })
  }
  if (str(config, "LOAD_HISTORY_PROCEDURE")) steps.push({ key: "load_history", label: "Load into history" })
  const uh = getUpdateHllProcs(config)
  uh.forEach((p, i) => steps.push({ key: `update_hll:${i}`, label: uh.length > 1 ? `Update HLL — ${procShortName(p)}` : "Update HLL" }))
  if (str(config, "SYNC_PROCEDURE")) steps.push({ key: "sync", label: "Sync" })
  return steps
}

const PROC_COL: Record<string, string> = {
  load_history: "LOAD_HISTORY_PROCEDURE",
}

// SQL string literal (single-quoted, quotes escaped).
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
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
    // "Load from" wins when set. On a file source the upload target is where the
    // FILE lands, so a procedure that writes its output somewhere else — a view
    // over the staging table, or a second table — has nowhere else to say so.
    const override = str(config, "SOURCE_LOAD_FROM")
    const readFrom = override || (kind === "proc" ? stage : object)
    if (!RUN_QUALIFIED.test(readFrom)) {
      const what = override ? "Load from" : kind === "proc" ? "Upload target" : "View"
      throw new Error(`${what} must be DATABASE.SCHEMA.NAME: ${readFrom || "(empty)"}`)
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

  // Sync — structured SP_SYNC_TO_SQLSERVER_LARGE call when a source view is set
  // (CALL proc('<view>','<target>','<columns>',<batch>)); otherwise a plain proc.
  if (key === "sync") {
    const proc = str(config, "SYNC_PROCEDURE")
    const view = str(config, "SYNC_SOURCE_VIEW")
    if (view) {
      if (!RUN_QUALIFIED.test(proc)) throw new Error(`Sync procedure must be DATABASE.SCHEMA.PROC: ${proc || "(empty)"}`)
      if (!RUN_QUALIFIED.test(view)) throw new Error(`Sync source view must be DATABASE.SCHEMA.NAME: ${view}`)
      const target = str(config, "SYNC_TARGET_TABLE") || "Upload.TempUpload"
      if (!/^[A-Za-z0-9_.]+$/.test(target)) throw new Error(`Sync target table invalid: ${target}`)
      const cols = str(config, "SYNC_COLUMNS").replace(/\s+/g, "")
      if (!/^[A-Za-z0-9_,]+$/.test(cols)) throw new Error("Sync columns must be a comma-separated list of column names.")
      const batchRaw = str(config, "SYNC_BATCH_SIZE")
      const batch = /^[0-9]+$/.test(batchRaw) ? batchRaw : "10000"
      const sql = `CALL ${proc}(${sqlLit(view)}, ${sqlLit(target)}, ${sqlLit(cols)}, ${batch})`
      const [database, schema] = proc.split(".")
      return { sql, database, schema }
    }
    if (!RUN_PROC_IDENT.test(proc)) throw new Error(`Configured sync procedure is invalid: ${proc || "(empty)"}`)
    return { sql: buildCall(proc), ...dbSchemaOf(proc) }
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

// The procedure a step CALLs, or null for steps that run plain SQL.
export function procRefForStep(config: RunConfigRow, key: string): string | null {
  if (key === "source_proc") return str(config, "SOURCE_OBJECT") || null
  if (key === "sync") return str(config, "SYNC_PROCEDURE") || null
  if (key === "load_history") return str(config, "LOAD_HISTORY_PROCEDURE") || null
  if (key === "update_hll" || key.startsWith("update_hll:")) {
    const list = getUpdateHllProcs(config)
    const idx = key.includes(":") ? Number(key.split(":")[1]) : 0
    return list[idx] ?? null
  }
  return null
}

/**
 * Turn Snowflake's unresolved-CALL errors into something actionable.
 *
 * Snowflake reports "Unknown user-defined function" for THREE different
 * situations and does not distinguish between them — deliberately, so a missing
 * grant does not leak the existence of an object. Naming all three is the only
 * honest hint we can give, and the argument-count case is the one people miss:
 * the app sends CALL NAME() unless the config carries its own argument list.
 *
 * Returns "" for any other error, so callers can append it unconditionally.
 */
export function callHint(message: string, procRef: string): string {
  const name = procRef.split("(")[0]
  const short = name.split(".").pop()

  // Count what was actually passed, so the hint can be specific about arity.
  const inner = procRef.includes("(") ? procRef.slice(procRef.indexOf("(") + 1, procRef.lastIndexOf(")")) : ""
  const argCount = inner.trim() === "" ? 0 : inner.split(",").length

  // "Invalid argument types" is the GOOD failure: the procedure exists and the
  // role can see it, only the argument count is wrong. Worth its own message —
  // it means the fix is the config field, not a grant.
  if (/invalid argument types/i.test(message)) {
    return (
      ` — the app passed ${argCount} argument${argCount === 1 ? "" : "s"}. The procedure exists and ` +
      `this role can reach it, so only the count is wrong: the signature changed, or the config was ` +
      `never updated to match. SHOW PROCEDURES LIKE '${short}' IN SCHEMA ` +
      `${name.split(".").slice(0, 2).join(".")} lists the signatures that do exist — put the right ` +
      `one in the source object field and save.`
    )
  }

  if (!/unknown (user-defined )?function|does not exist or not authorized|invalid identifier/i.test(message)) {
    return ""
  }
  const args = argCount > 0
    ? `called as ${procRef}`
    : `called with no arguments as ${name}()`
  return (
    ` — the app ${args}. Snowflake reports the same error whether (a) nothing of that name exists at ` +
    `${name}, (b) it exists but takes a different number of arguments — set the source object to ` +
    `NAME(1) to pass one, or (c) the app's Snowflake role has no USAGE on it. ` +
    `SHOW PROCEDURES LIKE '${short}' IN ACCOUNT tells you which.`
  )
}
