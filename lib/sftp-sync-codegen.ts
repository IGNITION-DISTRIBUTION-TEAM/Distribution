/**
 * Turn a sync configuration into the Snowflake objects that run it.
 *
 * PURE FUNCTIONS, NO I/O — so the whole thing is testable without Snowflake,
 * which matters more here than anywhere else in the app: a bug in a generator
 * reaches every sync anyone ever creates, and the column list appears in four
 * places (CREATE TABLE, COPY INTO, and both halves of the MERGE) that must
 * agree exactly.
 *
 * Follows the 7-object pattern from the Data Engineering standards document:
 * stage, target table, transient staging table, control row, procedure, task.
 * Deviations from that template are listed against DEVIATIONS below and each
 * one is commented in the emitted SQL, so a reviewer sees them in the object
 * rather than having to diff against the template.
 */

import { checkSchedule } from "./cron-schedule"

/** Legal unqualified Snowflake identifier. Anything else is REFUSED, not quoted. */
const IDENT = /^[A-Za-z0-9_]+$/

/** The only schema the app may create objects in. Mirrors 00-grants.sql §2. */
export const ALLOWED_TARGET_SCHEMAS = ["SPOT_DW.SPOT_SFTP"]

/**
 * Bumped whenever the emitted objects change in a way that matters.
 *
 * The registry stores the version each sync was deployed with, so Current jobs
 * can say "this one predates the run log" and offer a redeploy, instead of
 * showing it as a sync that mysteriously never runs anything.
 *
 * 2 — the generated procedure writes to TSK_SFTP_SYNC_RUNS.
 * 3 — it verifies its own load: reporting SUCCESS while the target is empty is
 *     the worst failure this thing has, and it happened.
 * 4 — it repairs an empty target instead of reporting NO_CHANGE at it forever.
 * 5 — THE LOAD MODE MEANS WHAT IT SAYS. Every run fetches and loads: pick
 *     truncate-and-insert and the target is rebuilt every run; pick merge and
 *     the merge runs every run. Change detection is opt-in, not the default.
 */
export const GENERATOR_VERSION = 5

/**
 * The app-owned run log. One row per run of any generated sync.
 *
 * It lives with the app's other TSK_ tables rather than in SPOT_SFTP, and the
 * generated procedure runs EXECUTE AS OWNER as the app role, so writing to it
 * needs no grant that does not already exist.
 *
 * This is the ONLY place rows-loaded-per-run is recorded.
 * DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL keeps one row per sync holding the whole
 * target's row count, which answers a different question and overwrites itself
 * every run.
 */
export const RUN_LOG_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_SFTP_SYNC_RUNS"

/**
 * The four metadata columns the standards document requires.
 *
 * They are placed AFTER the business columns, not before them. The template
 * leads with them; that makes `SELECT *` open on four columns of plumbing
 * before the first column anyone came to read. The set, the names and the
 * (_FILE, _LINE) key are unchanged, so this is a layout difference and worth
 * mentioning to Justin rather than hiding — but nothing depends on position:
 * every INSERT, MERGE and COPY in the generated objects names its columns.
 */
export const META_COLUMNS = ["_FILE", "_LINE", "_MODIFIED", "_UPDATED"] as const

/** The metadata column list as it appears in an explicit column list. */
const META_LIST = META_COLUMNS.join(", ")

export type ColumnMap = {
  /** Header text as it appears in the file. Informational. */
  source: string
  /** 1-based position in the delimited row. COPY INTO addresses this as $n. */
  ordinal: number
  /** Target column name. */
  target: string
  /** Only used when the target table is being created. */
  type: string
}

export type SyncConfig = {
  syncName: string
  endpoint: string
  remoteDir: string
  filePattern: string
  targetDb: string
  targetSchema: string
  targetTable: string
  createTable: boolean
  columns: ColumnMap[]
  loadMode: "truncate_insert" | "merge"
  mergeKeys: string[]
  delimiter: string
  skipHeader: boolean
  warehouse: string
  scheduleCron: string
  scheduleTz: string
  onError: "ABORT_STATEMENT" | "CONTINUE"
  /**
   * Skip the load when no file is newer than the last successful run.
   *
   * OFF by default, because the load mode should mean what it says: choose
   * truncate-and-insert and the target is rebuilt every run, choose merge and
   * the merge runs every run. With this on, a run whose source file has not
   * moved returns before reaching either — which is cheaper on a directory
   * that accumulates hundreds of files, and confusing everywhere else.
   */
  onlyWhenChanged?: boolean
  /**
   * Set by the test load when it measured the merge key against the whole file
   * and found duplicates. Evidence, not a guess — so `validate()` refuses on it.
   */
  mergeKeyProvenNonUnique?: { distinct: number; rows: number; suggestion?: string[] | null }
}

export type BuildResult = {
  /** Executed in order. An array, not one blob, so a failure names its statement. */
  statements: { label: string; sql: string }[]
  warnings: string[]
}

/* ------------------------------------------------------------------ helpers */

function ident(value: string, what: string): string {
  const v = (value ?? "").trim()
  if (!IDENT.test(v)) {
    throw new Error(
      `${what} must be letters, digits and underscores only — received ${JSON.stringify(value)}. ` +
        `Rejected rather than quoted: an identifier that needs escaping to be legal is a ` +
        `configuration mistake, and escaping it would hide that.`
    )
  }
  return v.toUpperCase()
}

/** A SQL string literal. Only ever used for VALUES, never for identifiers. */
function lit(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * The SCHEDULE clause, validated and NORMALISED at the point of use.
 *
 * Deliberately shaped like `ident()`: it throws rather than escaping, and it
 * emits what `checkSchedule` canonicalised rather than what the caller sent.
 * Checking alone would not be enough — `"0   7 * * *"` passes a check and then
 * interpolates its double spaces into the DDL.
 *
 * Doing it here rather than only in `validate()` means no future code path can
 * emit a task without the check, even one that skips validation.
 */
function scheduleClause(cfg: SyncConfig): string {
  const { canonical } = checkSchedule(cfg.scheduleCron, cfg.scheduleTz)
  return `'USING CRON ${canonical} ${cfg.scheduleTz}'`
}

/**
 * The delimiter, as a Snowflake FIELD_DELIMITER literal.
 * A tab has to travel as an escape sequence, not a raw tab character.
 */
function delimiterLiteral(d: string): string {
  if (d === "\t") return "'\\t'"
  if (d.length !== 1) {
    throw new Error(`Delimiter must be a single character — received ${JSON.stringify(d)}.`)
  }
  return lit(d)
}

/* ------------------------------------------------------------------- naming */

export function objectNames(syncName: string) {
  const n = ident(syncName, "Sync name")
  return {
    name: n,
    /** §11: internal stage */
    stage: `STG_SFTP_${n}`,
    /** §11: transient staging table */
    staging: `STG_${n}`,
    /** §11: procedure */
    proc: `SP_SFTP_SYNC_${n}`,
    /** §11: task */
    task: `TSK_SFTP_SYNC_${n}`,
    /** §6: control-table key */
    sourceName: n,
  }
}

/* ------------------------------------------------------------------- checks */

function validate(cfg: SyncConfig): string[] {
  const warnings: string[] = []

  const db = ident(cfg.targetDb, "Target database")
  const schema = ident(cfg.targetSchema, "Target schema")
  ident(cfg.targetTable, "Target table")
  ident(cfg.syncName, "Sync name")
  ident(cfg.endpoint, "Endpoint name")
  ident(cfg.warehouse, "Warehouse")

  // Throws on a bad cron or a timezone off the allow-list. Both reach a
  // CREATE TASK run by a privileged role, and the cron was the only free-text
  // value in this file that used to get there unchecked.
  warnings.push(...checkSchedule(cfg.scheduleCron, cfg.scheduleTz).warnings)

  if (cfg.createTable && !ALLOWED_TARGET_SCHEMAS.includes(`${db}.${schema}`)) {
    throw new Error(
      `Refusing to create objects in ${db}.${schema}. The app may only create in ` +
        `${ALLOWED_TARGET_SCHEMAS.join(", ")} — that narrowness is the control on what a ` +
        `generator bug can produce, so it is enforced here rather than left to grants.`
    )
  }

  if (cfg.columns.length === 0) throw new Error("Map at least one column.")

  const targets = new Set<string>()
  for (const c of cfg.columns) {
    const t = ident(c.target, `Column target ${JSON.stringify(c.target)}`)
    if (META_COLUMNS.includes(t as (typeof META_COLUMNS)[number])) {
      throw new Error(
        `${t} is a metadata column the generator fills itself; it cannot be mapped from the file.`
      )
    }
    if (targets.has(t)) {
      throw new Error(`Column ${t} is mapped twice. Each target column may take one source field.`)
    }
    targets.add(t)
    if (!Number.isInteger(c.ordinal) || c.ordinal < 1) {
      throw new Error(`Column ${t} has ordinal ${c.ordinal}; COPY INTO positions start at 1.`)
    }
  }

  if (cfg.loadMode === "merge") {
    if (cfg.mergeKeys.length === 0) {
      warnings.push(
        "Merge with no business key: falling back to (_FILE, _LINE). That makes re-running the " +
          "same file safe, but the same record arriving in a differently-named file tomorrow " +
          "will insert a duplicate rather than update."
      )
    }
    for (const k of cfg.mergeKeys) {
      if (!targets.has(ident(k, "Merge key"))) {
        throw new Error(`Merge key ${k} is not one of the mapped target columns.`)
      }
    }
    // A merge key the test load PROVED non-unique is refused, not warned about.
    // Snowflake raises "Duplicate row detected during DML action" when several
    // source rows match one target row, so this deploys a job that fails at its
    // scheduled hour with nobody awake — and the fix is one more ticked column.
    const nu = cfg.mergeKeyProvenNonUnique
    if (nu) {
      throw new Error(
        `${cfg.mergeKeys.join(", ")} is not unique in the file that was tested: ${nu.rows} rows ` +
          `but only ${nu.distinct} distinct values. A merge on it would either fail with ` +
          `"Duplicate row detected during DML action" or keep one arbitrary row per key and ` +
          `discard the rest.` +
          (nu.suggestion?.length
            ? ` Merging on ${nu.suggestion.join(", ")} would be unique.`
            : ` Add columns to the key until it identifies one row, or use truncate and insert.`)
      )
    }
  }

  if (cfg.onError === "CONTINUE") {
    warnings.push(
      "ON_ERROR = CONTINUE: rows that fail to parse are skipped and the load still reports " +
        "success. The row count is then the only evidence anything was dropped."
    )
  }

  // §15 — masking policies must be applied before any non-admin grant.
  const PII = /(^|_)(ID_?NUM|IDNUMBER|CELL|MSISDN|PHONE|EMAIL|FIRST_?NAME|LAST_?NAME|SURNAME|ADDRESS)(_|$)/
  const flagged = [...targets].filter((t) => PII.test(t))
  if (flagged.length > 0) {
    warnings.push(
      `Looks like personal information: ${flagged.join(", ")}. The standards document requires a ` +
        `masking policy on such columns BEFORE the table is granted to any non-admin role.`
    )
  }

  return warnings
}

/* ---------------------------------------------------------------- statements */

/**
 * The single source of truth for the business column list.
 *
 * Everything downstream derives from this array in the same order, which is
 * what stops the CREATE TABLE, the COPY INTO and the two MERGE clauses drifting
 * apart. They are not written out four times; they are rendered four ways from
 * one list.
 */
function businessColumns(cfg: SyncConfig): { target: string; ordinal: number; type: string }[] {
  return cfg.columns
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => ({ target: ident(c.target, "column"), ordinal: c.ordinal, type: c.type }))
}

/**
 * The fully-qualified object names for a config, and its column list.
 *
 * Exported because the test-load route needs exactly the same names the deploy
 * will use — if it computed its own, a passing test would say nothing about
 * the sync that gets created.
 */
export function resolveSync(cfg: SyncConfig) {
  const o = objectNames(cfg.syncName)
  const db = ident(cfg.targetDb, "Target database")
  const schema = ident(cfg.targetSchema, "Target schema")
  const table = ident(cfg.targetTable, "Target table")
  const q = (n: string) => `${db}.${schema}.${n}`
  return {
    db,
    schema,
    names: o,
    target: q(table),
    table,
    stage: q(o.stage),
    /**
     * The same stage, as a stage REFERENCE. The `@` is not decoration: without
     * it a COPY's FROM clause reads the name as a table and Snowflake answers
     * "Invalid from object type used in Copy transformation". DDL takes the
     * bare name, everything that reads the stage takes this one.
     */
    stageRef: `@${q(o.stage)}`,
    staging: q(o.staging),
    proc: q(o.proc),
    task: q(o.task),
    cols: businessColumns(cfg),
  }
}

/**
 * The staging table's columns, in the order the CREATE puts them.
 *
 * Exported so the test-load route can tell whether an existing staging table
 * still matches — including the metadata columns, which moved to the end. A
 * check that only compared business columns would leave a table built by an
 * older version in place with its metadata still at the front.
 */
export function stagingColumnNames(cfg: SyncConfig): string[] {
  return [...resolveSync(cfg).cols.map((c) => c.target), ...META_COLUMNS]
}

/** Statement 1 of the script. Same text whether it is a test or a deploy. */
export function buildStageStatement(cfg: SyncConfig): { label: string; sql: string } {
  const r = resolveSync(cfg)
  return {
    label: `Stage ${r.names.stage}`,
    sql: `CREATE STAGE IF NOT EXISTS ${r.stage}
  COMMENT = 'Landing stage for the ${r.names.name} SFTP sync.';`,
  }
}

/**
 * Statement 3 of the script.
 *
 * `replace` exists for one case: a test run against a staging table that
 * already exists with a different column list, because the mapping changed
 * since the last test. IF NOT EXISTS would leave the old shape in place and
 * the COPY would fail on a column that is not there, which reads as a file
 * problem when it is not one. The table is transient and truncated every run,
 * so replacing it loses nothing.
 */
export function buildStagingStatement(
  cfg: SyncConfig,
  opts: { replace?: boolean } = {}
): { label: string; sql: string } {
  const r = resolveSync(cfg)
  const verb = opts.replace
    ? "CREATE OR REPLACE TRANSIENT TABLE"
    : "CREATE TRANSIENT TABLE IF NOT EXISTS"
  return {
    label: `Staging table ${r.names.staging}`,
    sql: `${verb} ${r.staging} (
${r.cols.map((c) => `    ${c.target.padEnd(10)} VARCHAR`).join(",\n")},
    _FILE      VARCHAR(512)   NOT NULL,
    _LINE      NUMBER(38,0)   NOT NULL,
    _MODIFIED  TIMESTAMP_TZ(9),
    _UPDATED   TIMESTAMP_TZ(9)
);
/* TRANSIENT: no Time Travel or Fail-safe cost on a table truncated every run.
   Business columns are VARCHAR here whatever the target's types are — the file
   is text, and casting on the way in would fail the whole load for one bad
   value instead of one bad row. */`,
  }
}

/**
 * The COPY INTO, as one statement with no trailing semicolon and no indent.
 *
 * THIS IS THE POINT OF THE TEST STEP. The test route and the generated
 * procedure both call this, with `purge` as the only difference, so a test that
 * parses the file correctly is evidence about the sync rather than about a
 * second COPY that merely looks similar. There is a unit test asserting the two
 * differ in nothing but the PURGE line.
 *
 * The test passes `purge: false`: purging would delete the staged file that the
 * first real run is about to want.
 */
export function buildCopyStatement(cfg: SyncConfig, opts: { purge: boolean }): string {
  const r = resolveSync(cfg)
  const names = r.cols.map((c) => c.target)
  const selects = r.cols.map((c) => `$${c.ordinal}`)
  return `COPY INTO ${r.staging}
    (${names.join(", ")}, ${META_LIST})
FROM (
    SELECT ${selects.join(", ")},
           METADATA$FILENAME,
           METADATA$FILE_ROW_NUMBER,
           NULL::TIMESTAMP_TZ,
           CURRENT_TIMESTAMP()::TIMESTAMP_TZ
      FROM ${r.stageRef}
)
FILE_FORMAT = (TYPE = CSV
               FIELD_DELIMITER = ${delimiterLiteral(cfg.delimiter)}
               FIELD_OPTIONALLY_ENCLOSED_BY = '"'
               SKIP_HEADER = ${cfg.skipHeader ? 1 : 0}
               EMPTY_FIELD_AS_NULL = TRUE)
ON_ERROR = ${cfg.onError}
PURGE = ${opts.purge ? "TRUE" : "FALSE"}`
}

/** Indent every line of a block, so a shared fragment sits inside a procedure. */
function indentBlock(sql: string, pad: string): string {
  return sql
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n")
}

export function buildSyncScript(cfg: SyncConfig): BuildResult {
  const warnings = validate(cfg)
  const r = resolveSync(cfg)
  const { names: o, target, staging, stage, proc, task, table, cols } = r

  const statements: { label: string; sql: string }[] = []

  /* 1 — stage */
  statements.push(buildStageStatement(cfg))

  /* 2 — target table */
  if (cfg.createTable) {
    statements.push({
      label: `Target table ${table}`,
      sql: `CREATE TABLE IF NOT EXISTS ${target} (
${cols.map((c) => `    ${c.target.padEnd(10)} ${c.type}`).join(",\n")},
    _FILE      VARCHAR(512)   NOT NULL COMMENT 'Source filename (METADATA$FILENAME)',
    _LINE      NUMBER(38,0)   NOT NULL COMMENT 'Row number in file (METADATA$FILE_ROW_NUMBER)',
    _MODIFIED  TIMESTAMP_TZ(9)         COMMENT 'File mtime from the SFTP stat',
    _UPDATED   TIMESTAMP_TZ(9)         COMMENT 'When last upserted here',
    CONSTRAINT PK_${table} PRIMARY KEY (_FILE, _LINE)
);
/* That PRIMARY KEY is metadata only — Snowflake does not enforce it, so it
   prevents no duplicates. What makes a re-run safe is the MERGE below. */`,
    })
  }

  /* 3 — transient staging table, business columns all VARCHAR */
  statements.push(buildStagingStatement(cfg))

  /* 4 — control row */
  statements.push({
    label: `Control row ${o.sourceName}`,
    sql: `INSERT INTO DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
    (SOURCE_NAME, LAST_MODIFIED, LAST_SYNCED, ROW_COUNT, STATUS)
SELECT ${lit(o.sourceName)}, '1970-01-01'::TIMESTAMP_NTZ, CURRENT_TIMESTAMP(), 0, 'BASELINE_SET'
WHERE NOT EXISTS (
    SELECT 1 FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL WHERE SOURCE_NAME = ${lit(o.sourceName)}
);`,
  })

  /* 5 — the sync procedure */
  statements.push({ label: `Procedure ${o.proc}`, sql: buildProcedure(cfg, { target, staging, stage, proc, cols, sourceName: o.sourceName }) })

  /* 6 — task.
     Two SEPARATE statements, not one blob with a semicolon in the middle: the
     deploy route sends each through the Snowflake SQL API on its own, and that
     API takes a single statement per request unless MULTI_STATEMENT_COUNT is
     set, which it is not. Splitting also means a failure names which half. */
  statements.push({
    label: `Task ${o.task}`,
    sql: `CREATE OR REPLACE TASK ${task}
    WAREHOUSE = ${ident(cfg.warehouse, "Warehouse")}
    SCHEDULE  = ${scheduleClause(cfg)}
AS
    CALL ${proc}()`,
  })

  /* 7 — and left suspended. */
  statements.push({
    label: `Suspend ${o.task} until it has been reviewed`,
    sql: `/* Resuming is a deliberate act after review, per §10 of the standards
   document — never a side effect of creating the sync. */
ALTER TASK ${task} SUSPEND`,
  })

  return { statements, warnings }
}

function buildProcedure(
  cfg: SyncConfig,
  ctx: {
    target: string
    staging: string
    stage: string
    proc: string
    cols: { target: string; ordinal: number; type: string }[]
    sourceName: string
  }
): string {
  const { target, staging, stage, proc, cols, sourceName } = ctx
  const names = cols.map((c) => c.target)

  const mergeOn =
    cfg.mergeKeys.length > 0
      ? cfg.mergeKeys.map((k) => `t.${ident(k, "Merge key")} = s.${ident(k, "Merge key")}`).join("\n           AND ")
      : "t._FILE = s._FILE\n           AND t._LINE = s._LINE"

  const loadBlock =
    cfg.loadMode === "merge"
      ? `    MERGE INTO ${target} t
    USING ${staging} s
       ON ${mergeOn}
     WHEN MATCHED THEN UPDATE SET
${names.map((n) => `          t.${n} = s.${n}`).join(",\n")},
          t._FILE = s._FILE,
          t._LINE = s._LINE,
          t._MODIFIED = s._MODIFIED,
          t._UPDATED = CURRENT_TIMESTAMP()::TIMESTAMP_TZ
     WHEN NOT MATCHED THEN INSERT
          (${names.join(", ")}, ${META_LIST})
          VALUES (${names.map((n) => `s.${n}`).join(", ")},
                  s._FILE, s._LINE, s._MODIFIED, CURRENT_TIMESTAMP()::TIMESTAMP_TZ);
    n_loaded := SQLROWCOUNT;`
      : `    TRUNCATE TABLE ${target};
    INSERT INTO ${target}
        (${names.join(", ")}, ${META_LIST})
    SELECT ${names.join(", ")},
           _FILE, _LINE, _MODIFIED, CURRENT_TIMESTAMP()::TIMESTAMP_TZ
      FROM ${staging};
    n_loaded := SQLROWCOUNT;`

  /**
   * Append one row to the run log.
   *
   * WRAPPED IN ITS OWN BEGIN/EXCEPTION. Without the nested block, a failure to
   * write the log would fall through to the procedure's own handler and report
   * a load that actually succeeded as FAILED — the record of the work breaking
   * the work it records. Losing a log row is the right failure here.
   */
  const logRun = (
    statusExpr: string,
    filesExpr: string,
    rowsExpr: string,
    totalExpr: string,
    messageExpr: string,
    indent = "        "
  ) =>
    [
      `BEGIN`,
      `    INSERT INTO ${RUN_LOG_TABLE}`,
      `        (SYNC_NAME, STARTED_AT, FINISHED_AT, STATUS, FILES, ROWS_LOADED, ROWS_IN_TARGET, MESSAGE)`,
      `    SELECT ${lit(sourceName)}, :started_at, CURRENT_TIMESTAMP(), ${statusExpr},`,
      `           ${filesExpr}, ${rowsExpr}, ${totalExpr}, LEFT(${messageExpr}, 1000);`,
      `EXCEPTION`,
      `    WHEN OTHER THEN NULL;`,
      `END;`,
    ]
      .map((l) => (l.length > 0 ? indent + l : l))
      .join("\n")

  return `CREATE OR REPLACE PROCEDURE ${proc}()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
    fetched     VARIANT;
    status      VARCHAR;
    n_files     NUMBER DEFAULT 0;
    n_loaded    NUMBER DEFAULT 0;
    n_total     NUMBER DEFAULT 0;
    max_mtime   NUMBER;
    last_seen   NUMBER DEFAULT 0;
    prev_rows   NUMBER DEFAULT 0;
    reloaded    BOOLEAN DEFAULT FALSE;
    errmsg      VARCHAR;
    started_at  TIMESTAMP_LTZ;
BEGIN
    started_at := CURRENT_TIMESTAMP();
${
  cfg.onlyWhenChanged
    ? `    /* Change detection is ON for this sync: only files newer than the last
       successful run. The watermark is the max mtime the fetch reported, not
       "now" — a file that lands while this runs is picked up next time rather
       than skipped. */
    SELECT COALESCE(DATE_PART('EPOCH_SECOND', LAST_MODIFIED), 0)
      INTO :last_seen
      FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
     WHERE SOURCE_NAME = ${lit(sourceName)};`
    : `    /* EVERY RUN FETCHES AND LOADS. since_epoch stays 0, so the load mode is
       what decides what happens to the target: truncate-and-insert rebuilds it
       every run, merge merges every run. Nothing returns early because a file
       has not moved. */
    last_seen := 0;`
}

    /* All SFTP access goes through the shared downloader. This procedure holds
       no credentials and never sees the host key. */
    CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_FETCH(
        ${lit(cfg.endpoint)}, ${lit(cfg.remoteDir)}, ${lit(cfg.filePattern)},
        ${lit(stage)}, :last_seen, 200
    ) INTO :fetched;

    /* GET(), not the :variable:path form. Path syntax on a SCRIPTING variable
       is the construct I am least sure of here, and GET() is plain SQL that
       works the same way on any VARIANT. If this procedure ever fails to
       compile, this is the first place to look. */
    SELECT GET(:fetched, 'status')::VARCHAR                   INTO :status;
    SELECT COALESCE(GET(:fetched, 'files_staged')::NUMBER, 0) INTO :n_files;

    IF (status = 'FAILED') THEN
        SELECT COALESCE(GET(:fetched, 'error_message')::VARCHAR, 'fetch failed') INTO :errmsg;
        UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
           SET STATUS = 'FAILED: ' || LEFT(:errmsg, 180), LAST_SYNCED = CURRENT_TIMESTAMP()
         WHERE SOURCE_NAME = ${lit(sourceName)};
${logRun("'FAILED'", "0", "0", "NULL", ":errmsg")}
        RETURN 'FAILED: ' || :errmsg;
    END IF;

${
  cfg.onlyWhenChanged
    ? `    IF (n_files = 0) THEN
        /* Nothing newer than the watermark. Before accepting that, look at the
           target — a NO_CHANGE against an EMPTY table is not a no-op, it is a
           sync that will never deliver anything again. */
        SELECT COUNT(*) INTO :n_total FROM ${target};
        SELECT COALESCE(ROW_COUNT, 0) INTO :prev_rows
          FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
         WHERE SOURCE_NAME = ${lit(sourceName)};

        /* Repair it, but only where this sync is restoring ITS OWN work. */
        IF (n_total = 0 AND prev_rows > 0) THEN
            reloaded := TRUE;
            CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_FETCH(
                ${lit(cfg.endpoint)}, ${lit(cfg.remoteDir)}, ${lit(cfg.filePattern)},
                ${lit(stage)}, 0, 200
            ) INTO :fetched;
            SELECT GET(:fetched, 'status')::VARCHAR                   INTO :status;
            SELECT COALESCE(GET(:fetched, 'files_staged')::NUMBER, 0) INTO :n_files;

            IF (status = 'FAILED') THEN
                SELECT COALESCE(GET(:fetched, 'error_message')::VARCHAR, 'fetch failed') INTO :errmsg;
                UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
                   SET STATUS = 'FAILED: ' || LEFT(:errmsg, 180), LAST_SYNCED = CURRENT_TIMESTAMP()
                 WHERE SOURCE_NAME = ${lit(sourceName)};
${logRun("'FAILED'", "0", "0", ":n_total", ":errmsg")}
                RETURN 'FAILED: ' || :errmsg;
            END IF;
        END IF;

        IF (n_files = 0) THEN
            UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
               SET STATUS = 'NO_CHANGE', LAST_SYNCED = CURRENT_TIMESTAMP()
             WHERE SOURCE_NAME = ${lit(sourceName)};
${logRun("'NO_CHANGE'", "0", "0", ":n_total", "'Nothing newer than the last run.'")}
            RETURN 'NO_CHANGE: nothing newer than the last run.';
        END IF;
    END IF;`
    : `    IF (n_files = 0) THEN
        /* Not "nothing new" — NOTHING AT ALL. Every run fetches from scratch,
           so an empty result means the pattern matched no file in the
           directory, which is a real problem and not a quiet no-op. The target
           is left exactly as it was rather than truncated against nothing. */
        SELECT COUNT(*) INTO :n_total FROM ${target};
        UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
           SET STATUS = 'NO_FILES', LAST_SYNCED = CURRENT_TIMESTAMP()
         WHERE SOURCE_NAME = ${lit(sourceName)};
${logRun("'NO_FILES'", "0", "0", ":n_total", `'Nothing in ${cfg.remoteDir} matched ${cfg.filePattern}.'`)}
        RETURN 'NO_FILES: nothing in ${cfg.remoteDir} matched ${cfg.filePattern}.';
    END IF;`
}

    TRUNCATE TABLE ${staging};

${indentBlock(buildCopyStatement(cfg, { purge: true }), "    ")};

    /* _MODIFIED cannot come from COPY INTO — stage metadata has no SFTP mtime —
       so it is backfilled from what the fetch reported, matched per file. */
    UPDATE ${staging} s
       SET _MODIFIED = TO_TIMESTAMP_TZ(f.value:mtime_epoch::NUMBER)
      FROM TABLE(FLATTEN(INPUT => GET(:fetched, 'files'))) f
     WHERE s._FILE LIKE '%' || f.value:name::VARCHAR || '%';

${loadBlock}

    SELECT GET(:fetched, 'max_mtime_epoch')::NUMBER INTO :max_mtime;
    SELECT COUNT(*) INTO :n_total FROM ${target};

    /* CHECK OUR OWN WORK. A load that reports rows into a table that is empty a
       statement later is not a success, and reporting it as one is how a sync
       goes on looking healthy for days while delivering nothing. Whatever the
       cause — a second sync truncating the same target, a rollback, a write
       that went somewhere else — the honest answer here is FAILED. */
    IF (n_loaded > 0 AND n_total = 0) THEN
        errmsg := 'Loaded ' || n_loaded || ' row(s) but ${target} is empty immediately afterwards. '
               || 'Check whether another sync writes to the same table.';
        UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
           SET STATUS = 'FAILED: ' || LEFT(:errmsg, 180), LAST_SYNCED = CURRENT_TIMESTAMP()
         WHERE SOURCE_NAME = ${lit(sourceName)};
${logRun("'FAILED'", ":n_files", ":n_loaded", ":n_total", ":errmsg")}
        RETURN 'FAILED: ' || :errmsg;
    END IF;

    UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
       SET LAST_MODIFIED = TO_TIMESTAMP_NTZ(:max_mtime),
           LAST_SYNCED   = CURRENT_TIMESTAMP(),
           ROW_COUNT     = :n_total,
           /* A repair is not an ordinary success. It means the target was
              emptied by something outside this sync and the watermark was
              ignored to put it back — visible the morning after rather than
              hidden inside a green SUCCESS. */
           STATUS        = IFF(:reloaded, 'RELOADED_EMPTY_TARGET', 'SUCCESS')
     WHERE SOURCE_NAME = ${lit(sourceName)};

${logRun(
      "IFF(:reloaded, 'RELOADED_EMPTY_TARGET', 'SUCCESS')",
      ":n_files",
      ":n_loaded",
      ":n_total",
      `IFF(:reloaded,
                    'Target was empty and a previous run had loaded rows, so the watermark was ignored. Reloaded into ${target}',
                    'Loaded into ${target}')`,
      "    "
    )}

    RETURN 'SUCCESS: ' || n_files || ' file(s), ' || n_loaded
        || ' row(s) into ${target}, ' || n_total || ' total.';

EXCEPTION
    WHEN OTHER THEN
        /* Bound, not interpolated. The standards template builds this message
           with an f-string, so an apostrophe in an error breaks the handler
           that is meant to report it. */
        errmsg := SQLERRM;
        UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
           SET STATUS = 'FAILED: ' || LEFT(:errmsg, 180), LAST_SYNCED = CURRENT_TIMESTAMP()
         WHERE SOURCE_NAME = ${lit(sourceName)};
${logRun("'FAILED'", ":n_files", "0", "NULL", ":errmsg")}
        RETURN 'FAILED: ' || :errmsg;
END;
$$;`
}
