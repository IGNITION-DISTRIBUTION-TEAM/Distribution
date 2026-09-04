/**
 * What the app knows about the syncs it created.
 *
 * Two app-owned tables in DATAWAREHOUSE.LEADS_DISTRIBUTION, alongside the
 * other TSK_ tables the app already creates there — so no new Snowflake grant
 * is needed for either.
 *
 *   TSK_SFTP_SYNC_CONFIGS   one row per sync: the whole configuration, so a job
 *                           can be reopened, edited and redeployed. Before
 *                           this, closing the wizard lost the mapping.
 *   TSK_SFTP_SYNC_RUNS      append-only, one row per run, written by the
 *                           generated procedure itself (see RUN_LOG_TABLE in
 *                           lib/sftp-sync-codegen.ts).
 *
 * Both self-migrate the way `ensureConfigsTable` in lib/distribution-steps.ts
 * does: CREATE TABLE IF NOT EXISTS, then introspect and ALTER in anything an
 * older version of the table is missing. The app owns them, so it may.
 *
 * NEITHER TABLE HOLDS A CREDENTIAL. A sync references an endpoint by name; the
 * host, the SFTP user and the pinned host key stay in SPOT_DW.SFTP_ADMIN where
 * the app cannot read them.
 */
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { GENERATOR_VERSION, RUN_LOG_TABLE, type SyncConfig } from "@/lib/sftp-sync-codegen"

export const REGISTRY_SF = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const
export const CONFIGS_TABLE = `${REGISTRY_SF.database}.${REGISTRY_SF.schema}.TSK_SFTP_SYNC_CONFIGS`
export const RUNS_TABLE = RUN_LOG_TABLE

/** Non-key columns, used both to create the table and to add missing ones. */
const CONFIG_COLUMNS: [string, string][] = [
  ["SYNC_NAME", "VARCHAR"],
  ["ENDPOINT", "VARCHAR"],
  ["REMOTE_DIR", "VARCHAR"],
  ["FILE_PATTERN", "VARCHAR"],
  ["TARGET_DB", "VARCHAR"],
  ["TARGET_SCHEMA", "VARCHAR"],
  ["TARGET_TABLE", "VARCHAR"],
  ["CREATE_TABLE", "BOOLEAN"],
  // The source header names and their ordinals, so reopening a job can redraw
  // the mapping table without going back to the SFTP for the file.
  ["COLUMN_MAP_JSON", "VARCHAR"],
  ["LOAD_MODE", "VARCHAR"],
  ["MERGE_KEYS_JSON", "VARCHAR"],
  ["DELIMITER", "VARCHAR"],
  ["SKIP_HEADER", "BOOLEAN"],
  ["ON_ERROR", "VARCHAR"],
  ["ONLY_WHEN_CHANGED", "BOOLEAN"],
  ["SCHEDULE_CRON", "VARCHAR"],
  ["SCHEDULE_TZ", "VARCHAR"],
  ["WAREHOUSE", "VARCHAR"],
  ["GENERATOR_VERSION", "NUMBER"],
  ["DEPLOYED_SQL", "VARCHAR"],
  ["DEPLOYED_AT", "TIMESTAMP_NTZ"],
  ["DEPLOYED_BY", "VARCHAR"],
  ["IS_ACTIVE", "BOOLEAN"],
  ["CREATED_AT", "TIMESTAMP_NTZ"],
  ["CREATED_BY", "VARCHAR"],
  ["UPDATED_AT", "TIMESTAMP_NTZ"],
  ["UPDATED_BY", "VARCHAR"],
]

const RUN_COLUMNS: [string, string][] = [
  ["SYNC_NAME", "VARCHAR"],
  ["STARTED_AT", "TIMESTAMP_LTZ"],
  ["FINISHED_AT", "TIMESTAMP_LTZ"],
  ["STATUS", "VARCHAR"],
  ["FILES", "NUMBER"],
  ["ROWS_LOADED", "NUMBER"],
  ["ROWS_IN_TARGET", "NUMBER"],
  ["MESSAGE", "VARCHAR"],
]

const lit = (v: string) => `'${String(v).replace(/'/g, "''")}'`
const nlit = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "NULL" : String(v))
const blit = (v: boolean) => (v ? "TRUE" : "FALSE")

async function ensure(table: string, bare: string, columns: [string, string][], idCol: string) {
  await executeSnowflakeQuery(
    `CREATE TABLE IF NOT EXISTS ${table} (
       ${idCol} NUMBER AUTOINCREMENT START 1 INCREMENT 1,
       ${columns.map(([n, t]) => `${n} ${t}`).join(", ")}
     )`,
    REGISTRY_SF
  )
  // Add whatever an older copy of the table is missing. Best-effort: a failure
  // here must not stop a deploy, and the next call tries again.
  try {
    const existing = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM ${REGISTRY_SF.database}.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = '${REGISTRY_SF.schema}' AND TABLE_NAME = '${bare}'`,
      REGISTRY_SF
    )
    const have = new Set(existing.map((r) => String(r.COLUMN_NAME).toUpperCase()))
    for (const [name, type] of columns) {
      if (!have.has(name)) {
        try {
          await executeSnowflakeQuery(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`, REGISTRY_SF)
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* introspection best-effort */
  }
}

export async function ensureRegistryTables(): Promise<void> {
  await ensure(CONFIGS_TABLE, "TSK_SFTP_SYNC_CONFIGS", CONFIG_COLUMNS, "SYNC_ID")
  await ensure(RUNS_TABLE, "TSK_SFTP_SYNC_RUNS", RUN_COLUMNS, "RUN_ID")
}

/* ------------------------------------------------------------------- shapes */

export type SyncRegistryRow = {
  syncId: number | null
  config: SyncConfig
  generatorVersion: number
  deployedAt: string | null
  deployedBy: string | null
  isActive: boolean
  /** True when the deployed objects predate a generator change that matters. */
  stale: boolean
}

/**
 * Rebuild a SyncConfig from a stored row.
 *
 * The round trip config -> row -> config must produce an identical
 * `buildSyncScript` output, otherwise "Open in wizard" would quietly redeploy
 * something other than what is running. There is a test for exactly that.
 */
export function rowToConfig(r: Record<string, unknown>): SyncConfig {
  const str = (k: string, dflt = "") => (r[k] == null ? dflt : String(r[k]))
  const bool = (k: string) => r[k] === true || String(r[k]).toLowerCase() === "true"
  const json = <T,>(k: string, dflt: T): T => {
    try {
      const raw = r[k]
      return raw == null || raw === "" ? dflt : (JSON.parse(String(raw)) as T)
    } catch {
      return dflt
    }
  }
  return {
    syncName: str("SYNC_NAME"),
    endpoint: str("ENDPOINT"),
    remoteDir: str("REMOTE_DIR"),
    filePattern: str("FILE_PATTERN"),
    targetDb: str("TARGET_DB"),
    targetSchema: str("TARGET_SCHEMA"),
    targetTable: str("TARGET_TABLE"),
    createTable: bool("CREATE_TABLE"),
    columns: json("COLUMN_MAP_JSON", [] as SyncConfig["columns"]),
    loadMode: (str("LOAD_MODE", "truncate_insert") as SyncConfig["loadMode"]) ?? "truncate_insert",
    mergeKeys: json("MERGE_KEYS_JSON", [] as string[]),
    // A tab arrives back as the two characters \t through JSON/Snowflake; the
    // generator wants the real character.
    delimiter: str("DELIMITER", ",") === "\\t" ? "\t" : str("DELIMITER", ","),
    skipHeader: bool("SKIP_HEADER"),
    warehouse: str("WAREHOUSE"),
    scheduleCron: str("SCHEDULE_CRON"),
    scheduleTz: str("SCHEDULE_TZ"),
    onError: (str("ON_ERROR", "ABORT_STATEMENT") as SyncConfig["onError"]) ?? "ABORT_STATEMENT",
    onlyWhenChanged: bool("ONLY_WHEN_CHANGED"),
  }
}

export function rowToRegistry(r: Record<string, unknown>): SyncRegistryRow {
  const version = Number(r.GENERATOR_VERSION ?? 0)
  return {
    syncId: r.SYNC_ID == null ? null : Number(r.SYNC_ID),
    config: rowToConfig(r),
    generatorVersion: version,
    deployedAt: r.DEPLOYED_AT == null ? null : String(r.DEPLOYED_AT),
    deployedBy: r.DEPLOYED_BY == null ? null : String(r.DEPLOYED_BY),
    isActive: r.IS_ACTIVE !== false && String(r.IS_ACTIVE).toLowerCase() !== "false",
    stale: version < GENERATOR_VERSION,
  }
}

/* -------------------------------------------------------------------- reads */

export async function listSyncs(): Promise<SyncRegistryRow[]> {
  await ensureRegistryTables()
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    // EXCLUDE + TO_VARCHAR: SELECT * would hand DEPLOYED_AT back as Snowflake's
    // raw "<seconds>.<nanos>" wire form, which reads as a big number on screen.
    `SELECT * EXCLUDE (DEPLOYED_AT),
            TO_VARCHAR(DEPLOYED_AT, 'YYYY-MM-DD HH24:MI:SS') AS DEPLOYED_AT
       FROM ${CONFIGS_TABLE} ORDER BY SYNC_NAME`,
    REGISTRY_SF
  )
  return rows.map(rowToRegistry)
}

export async function getSync(syncName: string): Promise<SyncRegistryRow | null> {
  await ensureRegistryTables()
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    `SELECT * FROM ${CONFIGS_TABLE} WHERE SYNC_NAME = ${lit(syncName.toUpperCase())} LIMIT 1`,
    REGISTRY_SF
  )
  return rows[0] ? rowToRegistry(rows[0]) : null
}

/* ------------------------------------------------------------------- writes */

/**
 * Record a successful deploy. Upsert on SYNC_NAME.
 *
 * Delete-then-insert rather than MERGE: Snowflake does not enforce the unique
 * constraint that would make a MERGE safe here, so the only way to guarantee
 * one row per sync is to remove any that exist first.
 */
export async function recordDeploy(
  cfg: SyncConfig,
  opts: { deployedBy: string; deployedSql: string }
): Promise<void> {
  await ensureRegistryTables()
  const name = cfg.syncName.toUpperCase()

  const existing = await executeSnowflakeQuery<{ CREATED_AT: unknown; CREATED_BY: unknown }>(
    `SELECT CREATED_AT, CREATED_BY FROM ${CONFIGS_TABLE} WHERE SYNC_NAME = ${lit(name)} LIMIT 1`,
    REGISTRY_SF
  )
  const firstCreatedBy = existing[0]?.CREATED_BY ? String(existing[0].CREATED_BY) : opts.deployedBy

  await executeSnowflakeQuery(`DELETE FROM ${CONFIGS_TABLE} WHERE SYNC_NAME = ${lit(name)}`, REGISTRY_SF)

  const values = [
    lit(name),
    lit(cfg.endpoint),
    lit(cfg.remoteDir),
    lit(cfg.filePattern),
    lit(cfg.targetDb),
    lit(cfg.targetSchema),
    lit(cfg.targetTable),
    blit(cfg.createTable),
    lit(JSON.stringify(cfg.columns)),
    lit(cfg.loadMode),
    lit(JSON.stringify(cfg.mergeKeys)),
    lit(cfg.delimiter === "\t" ? "\\t" : cfg.delimiter),
    blit(cfg.skipHeader),
    lit(cfg.onError),
    blit(Boolean(cfg.onlyWhenChanged)),
    lit(cfg.scheduleCron),
    lit(cfg.scheduleTz),
    lit(cfg.warehouse),
    nlit(GENERATOR_VERSION),
    lit(opts.deployedSql.slice(0, 60000)),
    "CURRENT_TIMESTAMP()",
    lit(opts.deployedBy),
    "TRUE",
    existing[0] ? "CURRENT_TIMESTAMP()" : "CURRENT_TIMESTAMP()",
    lit(firstCreatedBy),
    "CURRENT_TIMESTAMP()",
    lit(opts.deployedBy),
  ]

  await executeSnowflakeQuery(
    `INSERT INTO ${CONFIGS_TABLE}
       (${CONFIG_COLUMNS.map(([n]) => n).join(", ")})
     SELECT ${values.join(", ")}`,
    REGISTRY_SF
  )
}

/**
 * Record a schedule changed from the Tasks screen.
 *
 * Without this the registry keeps the old cron, so reopening the job in the
 * wizard would show a schedule the task is not running on — and redeploying
 * would quietly put the old one back.
 */
export async function updateSchedule(syncName: string, cron: string, actor: string): Promise<void> {
  await ensureRegistryTables()
  await executeSnowflakeQuery(
    `UPDATE ${CONFIGS_TABLE}
        SET SCHEDULE_CRON = ${lit(cron)},
            UPDATED_AT = CURRENT_TIMESTAMP(),
            UPDATED_BY = ${lit(actor)}
      WHERE SYNC_NAME = ${lit(syncName.toUpperCase())}`,
    REGISTRY_SF
  )
}

/** Forget a sync. The Snowflake objects are deliberately left alone. */
export async function forgetSync(syncName: string): Promise<void> {
  await ensureRegistryTables()
  await executeSnowflakeQuery(
    `DELETE FROM ${CONFIGS_TABLE} WHERE SYNC_NAME = ${lit(syncName.toUpperCase())}`,
    REGISTRY_SF
  )
}

/* --------------------------------------------------------------------- runs */

export type SyncRun = {
  syncName: string
  startedAt: string | null
  finishedAt: string | null
  status: string
  files: number
  rowsLoaded: number
  rowsInTarget: number | null
  message: string | null
}

export async function listRuns(opts: { days: number; limit: number }): Promise<SyncRun[]> {
  await ensureRegistryTables()
  const days = Math.max(1, Math.min(365, Math.trunc(opts.days) || 7))
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit) || 100))
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(
    // TO_VARCHAR, not raw columns: executeSnowflakeQuery hands back Snowflake's
    // wire encoding, so a TIMESTAMP arrives as "1788491077.765000000". That is
    // ugly on screen and worse in densify(), which buckets by the first ten
    // characters expecting YYYY-MM-DD — on a raw epoch every row falls outside
    // every bucket and the chart renders flat zero however many runs there were.
    `SELECT SYNC_NAME,
            TO_VARCHAR(STARTED_AT,  'YYYY-MM-DD HH24:MI:SS') AS STARTED_AT,
            TO_VARCHAR(FINISHED_AT, 'YYYY-MM-DD HH24:MI:SS') AS FINISHED_AT,
            STATUS, FILES, ROWS_LOADED, ROWS_IN_TARGET, MESSAGE
       FROM ${RUNS_TABLE}
      WHERE STARTED_AT >= DATEADD(day, -${days}, CURRENT_TIMESTAMP())
      ORDER BY STARTED_AT DESC
      LIMIT ${limit}`,
    REGISTRY_SF
  )
  return rows.map((r) => ({
    syncName: String(r.SYNC_NAME ?? ""),
    startedAt: r.STARTED_AT == null ? null : String(r.STARTED_AT),
    finishedAt: r.FINISHED_AT == null ? null : String(r.FINISHED_AT),
    status: String(r.STATUS ?? ""),
    files: Number(r.FILES ?? 0),
    rowsLoaded: Number(r.ROWS_LOADED ?? 0),
    rowsInTarget: r.ROWS_IN_TARGET == null ? null : Number(r.ROWS_IN_TARGET),
    message: r.MESSAGE == null ? null : String(r.MESSAGE),
  }))
}

/**
 * Runs and rows per day, as a DENSE series — every day in the window gets a
 * bucket even when nothing ran. A sparse series makes a gap look like a dip in
 * volume rather than what it is: no runs at all.
 */
export function densify(
  runs: SyncRun[],
  days: number
): { date: string; runs: number; rows: number; failed: number }[] {
  const buckets = new Map<string, { date: string; runs: number; rows: number; failed: number }>()
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000)
    const key = d.toISOString().slice(0, 10)
    buckets.set(key, { date: key, runs: 0, rows: 0, failed: 0 })
  }
  for (const r of runs) {
    if (!r.startedAt) continue
    const key = String(r.startedAt).slice(0, 10)
    const b = buckets.get(key)
    if (!b) continue
    b.runs += 1
    b.rows += r.rowsLoaded
    if (/^FAILED/i.test(r.status)) b.failed += 1
  }
  return [...buckets.values()]
}

/* ----------------------------------------------------- target table health */

/**
 * Does the target table exist?
 *
 * THREE ANSWERS, NOT TWO. An earlier version returned only "missing" and
 * swallowed a failed lookup as "present" — fail-safe, and the wrong instinct:
 * a clean row that actually means "the check did not run" is the same quiet
 * wrongness as a chart that renders zero because its buckets never matched.
 *
 * One INFORMATION_SCHEMA query per distinct database, not one per sync, so a
 * job list of twenty costs one round trip.
 *
 * Note that INFORMATION_SCHEMA lists only what the role has privileges on, so
 * "missing" means ABSENT OR INVISIBLE. Snowflake words both the same way at run
 * time too, so it is not a distinction this app can make — the UI keeps saying
 * both rather than asserting the table is gone.
 */
export type TargetHealth = "present" | "missing" | "unknown"

export async function checkTargets(
  targets: { db: string; schema: string; table: string }[]
): Promise<Map<string, TargetHealth>> {
  const key = (t: { db: string; schema: string; table: string }) =>
    `${t.db}.${t.schema}.${t.table}`.toUpperCase()
  const out = new Map<string, TargetHealth>()
  for (const t of targets) out.set(key(t), "unknown")
  if (targets.length === 0) return out

  const byDb = new Map<string, typeof targets>()
  for (const t of targets) {
    const d = t.db.toUpperCase()
    byDb.set(d, [...(byDb.get(d) ?? []), t])
  }

  for (const [db, list] of byDb) {
    if (!/^[A-Za-z0-9_]+$/.test(db)) continue // stays unknown
    const schemas = [...new Set(list.map((t) => t.schema.toUpperCase()))].filter((x) =>
      /^[A-Za-z0-9_]+$/.test(x)
    )
    if (schemas.length === 0) continue
    try {
      const rows = await executeSnowflakeQuery<{ TABLE_SCHEMA: string; TABLE_NAME: string }>(
        `SELECT TABLE_SCHEMA, TABLE_NAME
           FROM ${db}.INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA IN (${schemas.map((x) => `'${x}'`).join(", ")})`,
        { database: db, schema: schemas[0] }
      )
      const present = new Set(
        rows.map((r) => `${db}.${String(r.TABLE_SCHEMA)}.${String(r.TABLE_NAME)}`.toUpperCase())
      )
      // The query answered, so every target in this database now has a real
      // answer either way.
      for (const t of list) out.set(key(t), present.has(key(t)) ? "present" : "missing")
    } catch {
      // Leave them "unknown". Reporting them present would be a claim the
      // lookup did not support; reporting them missing would badge working
      // jobs red on the strength of a failed query.
    }
  }
  return out
}

/**
 * Does this run status say the target table is not there?
 *
 * A second signal, independent of the privilege the INFORMATION_SCHEMA check
 * needs: Snowflake already told us, in the failure the job recorded. Pure, so
 * it is testable without a warehouse.
 *
 *   Table 'SPOT_DW.SPOT_SFTP.ARPU_DASHBOARD_FEES3' does not exist or not authorized.
 */
export function statusBlamesMissingTarget(status: string | null | undefined, target: string): boolean {
  if (!status || !target) return false
  const s = String(status)
  if (!/does not exist or not authorized/i.test(s)) return false
  // Match the qualified name or the bare table, since the message quotes
  // whichever form the failing statement used.
  const bare = target.split(".").pop() ?? target
  const hay = s.toUpperCase()
  return hay.includes(target.toUpperCase()) || hay.includes(bare.toUpperCase())
}

/**
 * Consecutive failures per sync, most recent run first.
 *
 * Counts the unbroken run of FAILED at the head of each sync's history, so one
 * bad night reads as 1 and a job that has been broken for a week reads as 7.
 * A sync with no logged runs is absent from the map rather than zero — those
 * are the ones deployed before run logging, and calling them "0 failures"
 * would be a claim the data does not support.
 */
export async function consecutiveFailures(): Promise<Map<string, number>> {
  const runs = await listRuns({ days: 90, limit: 500 })
  const out = new Map<string, number>()
  const stopped = new Set<string>()
  for (const r of runs) {
    // listRuns is already ordered STARTED_AT DESC.
    if (stopped.has(r.syncName)) continue
    if (/^FAILED/i.test(r.status)) out.set(r.syncName, (out.get(r.syncName) ?? 0) + 1)
    else {
      stopped.add(r.syncName)
      if (!out.has(r.syncName)) out.set(r.syncName, 0)
    }
  }
  return out
}
