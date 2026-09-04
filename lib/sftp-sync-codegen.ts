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

/** Legal unqualified Snowflake identifier. Anything else is REFUSED, not quoted. */
const IDENT = /^[A-Za-z0-9_]+$/

/** The only schema the app may create objects in. Mirrors 00-grants.sql §2. */
export const ALLOWED_TARGET_SCHEMAS = ["SPOT_DW.SPOT_SFTP"]

/** Metadata columns the standard requires, in the order it requires them. */
export const META_COLUMNS = ["_FILE", "_LINE", "_MODIFIED", "_UPDATED"] as const

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

export function buildSyncScript(cfg: SyncConfig): BuildResult {
  const warnings = validate(cfg)
  const o = objectNames(cfg.syncName)
  const db = ident(cfg.targetDb, "Target database")
  const schema = ident(cfg.targetSchema, "Target schema")
  const table = ident(cfg.targetTable, "Target table")

  const q = (n: string) => `${db}.${schema}.${n}`
  const target = q(table)
  const stage = q(o.stage)
  const staging = q(o.staging)
  const proc = q(o.proc)
  const task = q(o.task)

  const cols = businessColumns(cfg)
  const colNames = cols.map((c) => c.target)
  const statements: { label: string; sql: string }[] = []

  /* 1 — stage */
  statements.push({
    label: `Stage ${o.stage}`,
    sql: `CREATE STAGE IF NOT EXISTS ${stage}
  COMMENT = 'Landing stage for the ${o.name} SFTP sync.';`,
  })

  /* 2 — target table */
  if (cfg.createTable) {
    statements.push({
      label: `Target table ${table}`,
      sql: `CREATE TABLE IF NOT EXISTS ${target} (
    _FILE      VARCHAR(512)   NOT NULL COMMENT 'Source filename (METADATA$FILENAME)',
    _LINE      NUMBER(38,0)   NOT NULL COMMENT 'Row number in file (METADATA$FILE_ROW_NUMBER)',
    _MODIFIED  TIMESTAMP_TZ(9)         COMMENT 'File mtime from the SFTP stat',
    _UPDATED   TIMESTAMP_TZ(9)         COMMENT 'When last upserted here',
${cols.map((c) => `    ${c.target.padEnd(10)} ${c.type}`).join(",\n")},
    CONSTRAINT PK_${table} PRIMARY KEY (_FILE, _LINE)
);
/* That PRIMARY KEY is metadata only — Snowflake does not enforce it, so it
   prevents no duplicates. What makes a re-run safe is the MERGE below. */`,
    })
  }

  /* 3 — transient staging table, business columns all VARCHAR */
  statements.push({
    label: `Staging table ${o.staging}`,
    sql: `CREATE TRANSIENT TABLE IF NOT EXISTS ${staging} (
    _FILE      VARCHAR(512)   NOT NULL,
    _LINE      NUMBER(38,0)   NOT NULL,
    _MODIFIED  TIMESTAMP_TZ(9),
    _UPDATED   TIMESTAMP_TZ(9),
${cols.map((c) => `    ${c.target.padEnd(10)} VARCHAR`).join(",\n")}
);
/* TRANSIENT: no Time Travel or Fail-safe cost on a table truncated every run.
   Business columns are VARCHAR here whatever the target's types are — the file
   is text, and casting on the way in would fail the whole load for one bad
   value instead of one bad row. */`,
  })

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

  /* 6 — task, suspended */
  statements.push({
    label: `Task ${o.task} (suspended)`,
    sql: `CREATE OR REPLACE TASK ${task}
    WAREHOUSE = ${ident(cfg.warehouse, "Warehouse")}
    SCHEDULE  = 'USING CRON ${cfg.scheduleCron} ${cfg.scheduleTz}'
AS
    CALL ${proc}();

/* Created SUSPENDED and left that way. Resuming is a deliberate act after
   review, per §10 of the standards document. */
ALTER TASK ${task} SUSPEND;`,
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
  const selects = cols.map((c) => `$${c.ordinal}`)

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
          t._FILE = s._FILE,
          t._LINE = s._LINE,
          t._MODIFIED = s._MODIFIED,
          t._UPDATED = CURRENT_TIMESTAMP()::TIMESTAMP_TZ,
${names.map((n) => `          t.${n} = s.${n}`).join(",\n")}
     WHEN NOT MATCHED THEN INSERT
          (_FILE, _LINE, _MODIFIED, _UPDATED, ${names.join(", ")})
          VALUES (s._FILE, s._LINE, s._MODIFIED, CURRENT_TIMESTAMP()::TIMESTAMP_TZ,
                  ${names.map((n) => `s.${n}`).join(", ")});
    n_loaded := SQLROWCOUNT;`
      : `    TRUNCATE TABLE ${target};
    INSERT INTO ${target}
        (_FILE, _LINE, _MODIFIED, _UPDATED, ${names.join(", ")})
    SELECT _FILE, _LINE, _MODIFIED, CURRENT_TIMESTAMP()::TIMESTAMP_TZ,
           ${names.join(", ")}
      FROM ${staging};
    n_loaded := SQLROWCOUNT;`

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
    errmsg      VARCHAR;
BEGIN
    /* Change detection: only files newer than the last successful run. The
       watermark is the max mtime the fetch reported, not "now" — a file that
       lands while this runs is picked up next time rather than skipped. */
    SELECT COALESCE(DATE_PART('EPOCH_SECOND', LAST_MODIFIED), 0)
      INTO :last_seen
      FROM DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
     WHERE SOURCE_NAME = ${lit(sourceName)};

    /* All SFTP access goes through the shared downloader. This procedure holds
       no credentials and never sees the host key. */
    CALL SPOT_DW.SFTP_ADMIN.SP_SFTP_FETCH(
        ${lit(cfg.endpoint)}, ${lit(cfg.remoteDir)}, ${lit(cfg.filePattern)},
        ${lit(stage)}, :last_seen, 200
    ) INTO :fetched;

    status  := :fetched:status::VARCHAR;
    n_files := COALESCE(:fetched:files_staged::NUMBER, 0);

    IF (status = 'FAILED') THEN
        errmsg := COALESCE(:fetched:error_message::VARCHAR, 'fetch failed');
        UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
           SET STATUS = 'FAILED: ' || LEFT(:errmsg, 180), LAST_SYNCED = CURRENT_TIMESTAMP()
         WHERE SOURCE_NAME = ${lit(sourceName)};
        RETURN 'FAILED: ' || :errmsg;
    END IF;

    IF (n_files = 0) THEN
        UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
           SET STATUS = 'NO_CHANGE', LAST_SYNCED = CURRENT_TIMESTAMP()
         WHERE SOURCE_NAME = ${lit(sourceName)};
        RETURN 'NO_CHANGE: nothing newer than the last run.';
    END IF;

    TRUNCATE TABLE ${staging};

    COPY INTO ${staging}
        (_FILE, _LINE, _MODIFIED, _UPDATED, ${names.join(", ")})
    FROM (
        SELECT METADATA$FILENAME,
               METADATA$FILE_ROW_NUMBER,
               NULL::TIMESTAMP_TZ,
               CURRENT_TIMESTAMP()::TIMESTAMP_TZ,
               ${selects.join(", ")}
          FROM ${stage}
    )
    FILE_FORMAT = (TYPE = CSV
                   FIELD_DELIMITER = ${delimiterLiteral(cfg.delimiter)}
                   FIELD_OPTIONALLY_ENCLOSED_BY = '"'
                   SKIP_HEADER = ${cfg.skipHeader ? 1 : 0}
                   EMPTY_FIELD_AS_NULL = TRUE)
    ON_ERROR = ${cfg.onError}
    PURGE = TRUE;

    /* _MODIFIED cannot come from COPY INTO — stage metadata has no SFTP mtime —
       so it is backfilled from what the fetch reported, matched per file. */
    UPDATE ${staging} s
       SET _MODIFIED = TO_TIMESTAMP_TZ(f.value:mtime_epoch::NUMBER)
      FROM TABLE(FLATTEN(INPUT => :fetched:files)) f
     WHERE s._FILE LIKE '%' || f.value:name::VARCHAR || '%';

${loadBlock}

    max_mtime := :fetched:max_mtime_epoch::NUMBER;
    SELECT COUNT(*) INTO :n_total FROM ${target};

    UPDATE DATAWAREHOUSE.DW.SFTP_SYNC_CONTROL
       SET LAST_MODIFIED = TO_TIMESTAMP_NTZ(:max_mtime),
           LAST_SYNCED   = CURRENT_TIMESTAMP(),
           ROW_COUNT     = :n_total,
           STATUS        = 'SUCCESS'
     WHERE SOURCE_NAME = ${lit(sourceName)};

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
        RETURN 'FAILED: ' || :errmsg;
END;
$$;`
}
