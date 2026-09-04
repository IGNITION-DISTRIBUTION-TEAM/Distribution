/**
 * Generator checks that do not need Snowflake.
 *
 *   npx tsx scripts/task-automation/codegen-tests.ts
 *
 * The one that matters most is COPY IDENTITY: the test-load button and the
 * deployed procedure must run the same COPY INTO. If they could drift, a
 * successful test would be evidence about a statement nobody ever runs again.
 */
import {
  GENERATOR_VERSION,
  RUN_LOG_TABLE,
  buildSyncScript,
  buildCopyStatement,
  buildStageStatement,
  buildStagingStatement,
  type SyncConfig,
} from "../../lib/sftp-sync-codegen"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

function cfg(over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    syncName: "SPOT_FEES",
    endpoint: "SPOT",
    remoteDir: "/spot_money/fees",
    filePattern: "fees_*.csv",
    targetDb: "SPOT_DW",
    targetSchema: "SPOT_SFTP",
    targetTable: "SPOT_FEES",
    createTable: true,
    columns: [
      { source: "Date", ordinal: 1, target: "TXN_DATE", type: "VARCHAR(50)" },
      { source: "Transaction", ordinal: 2, target: "TRANSACTION", type: "VARCHAR(200)" },
      { source: "Income", ordinal: 3, target: "INCOME", type: "VARCHAR(50)" },
    ],
    loadMode: "merge",
    mergeKeys: ["TXN_DATE"],
    delimiter: ",",
    skipHeader: true,
    warehouse: "SPOT_WH",
    scheduleCron: "0 7 * * *",
    scheduleTz: "Africa/Johannesburg",
    onError: "ABORT_STATEMENT",
    ...over,
  }
}

/* ---- 1. The test COPY and the procedure's COPY differ only in PURGE ------- */

console.log("COPY identity")
for (const variant of [
  cfg(),
  cfg({ loadMode: "truncate_insert", mergeKeys: [] }),
  cfg({ delimiter: "\t", skipHeader: false, onError: "CONTINUE" }),
  cfg({ columns: [{ source: "only", ordinal: 1, target: "ONLY_COL", type: "VARCHAR" }], mergeKeys: ["ONLY_COL"] }),
]) {
  const testCopy = buildCopyStatement(variant, { purge: false })
  const realCopy = buildCopyStatement(variant, { purge: true })
  check(
    `only PURGE differs (${variant.columns.length} cols, ${variant.loadMode})`,
    testCopy.replace("PURGE = FALSE", "PURGE = TRUE") === realCopy,
    "the two COPY statements diverge in more than the PURGE line"
  )

  // And the procedure really does embed that exact text, indented by four.
  const proc = buildSyncScript(variant).statements.find((s) => s.label.startsWith("Procedure"))!.sql
  const embedded = realCopy
    .split("\n")
    .map((l) => (l.length > 0 ? "    " + l : l))
    .join("\n")
  check(
    "the procedure embeds that COPY verbatim",
    proc.includes(embedded),
    "the procedure's COPY is not the shared fragment"
  )
}

/* ---- 1b. The COPY reads a STAGE, not a table ----------------------------- */

console.log("Stage reference")
{
  const c = cfg()
  const copy = buildCopyStatement(c, { purge: false })
  // Without the @ Snowflake reads the name as a table and refuses the whole
  // transformation with "Invalid from object type used in Copy transformation".
  check(
    "COPY's FROM names the stage with @",
    /FROM @SPOT_DW\.SPOT_SFTP\.STG_SFTP_SPOT_FEES\b/.test(copy),
    copy.split("\n").find((l) => l.includes("FROM ")) ?? "no FROM line"
  )
  // The DDL takes the bare name — an @ there is a different error.
  check(
    "CREATE STAGE names it without @",
    /CREATE STAGE IF NOT EXISTS SPOT_DW\.SPOT_SFTP\.STG_SFTP_SPOT_FEES\b/.test(
      buildStageStatement(c).sql
    )
  )
  // SP_SFTP_FETCH validates DATABASE.SCHEMA.NAME against its allow-list, so the
  // procedure must hand it the bare name too.
  const proc = buildSyncScript(c).statements.find((s) => s.label.startsWith("Procedure"))!.sql
  check(
    "SP_SFTP_FETCH is passed the bare stage name",
    proc.includes("'SPOT_DW.SPOT_SFTP.STG_SFTP_SPOT_FEES'"),
    "the fetch call has an @ it should not have"
  )
}

/* ---- 2. The shared stage/staging statements are the deploy's own --------- */

console.log("Shared statements")
{
  const c = cfg()
  const script = buildSyncScript(c)
  check(
    "stage statement is statement 1",
    script.statements[0].sql === buildStageStatement(c).sql
  )
  const staging = script.statements.find((s) => s.label.startsWith("Staging table"))!
  check("staging statement is the shared one", staging.sql === buildStagingStatement(c).sql)
  check(
    "replace variant differs only in the CREATE verb",
    buildStagingStatement(c, { replace: true }).sql ===
      buildStagingStatement(c).sql.replace(
        "CREATE TRANSIENT TABLE IF NOT EXISTS",
        "CREATE OR REPLACE TRANSIENT TABLE"
      )
  )
  check(
    "stage and staging are both re-runnable",
    /IF NOT EXISTS/.test(script.statements[0].sql) && /IF NOT EXISTS/.test(staging.sql)
  )
}

/* ---- 3. The test path must never touch the control table ----------------- */

console.log("Control table")
{
  const c = cfg()
  check(
    "no COPY fragment mentions SFTP_SYNC_CONTROL",
    !buildCopyStatement(c, { purge: false }).includes("SFTP_SYNC_CONTROL") &&
      !buildStageStatement(c).sql.includes("SFTP_SYNC_CONTROL") &&
      !buildStagingStatement(c).sql.includes("SFTP_SYNC_CONTROL"),
    "a test-load statement writes the watermark; the first real run would then load nothing"
  )
}

/* ---- 4. Column list agreement across all four renderings ----------------- */

console.log("Column alignment")
for (const n of [1, 3, 60]) {
  const columns = Array.from({ length: n }, (_, i) => ({
    source: `f${i + 1}`,
    ordinal: i + 1,
    target: `COL_${i + 1}`,
    type: "VARCHAR(100)",
  }))
  const c = cfg({ columns, mergeKeys: ["COL_1"] })
  const script = buildSyncScript(c)
  const proc = script.statements.find((s) => s.label.startsWith("Procedure"))!.sql
  const create = script.statements.find((s) => s.label.startsWith("Target table"))!.sql
  const expected = columns.map((x) => x.target)
  const listRe = new RegExp(`\\(([^)]*?), _FILE, _LINE, _MODIFIED, _UPDATED\\)`, "g")
  const lists = [...proc.matchAll(listRe)].map((m) => m[1].split(",").map((x) => x.trim()))
  check(
    `${n} cols: every column list in the procedure matches, in order`,
    lists.length > 0 && lists.every((l) => l.join("|") === expected.join("|")),
    `saw ${lists.length} list(s)`
  )
  check(
    `${n} cols: CREATE TABLE has every column`,
    expected.every((e) => new RegExp(`\\n    ${e}\\s`).test(create))
  )
  // Layout: business columns first, the four metadata columns last.
  check(
    `${n} cols: metadata columns come after the business ones`,
    create.indexOf(`\n    ${expected[expected.length - 1]} `) < create.indexOf("\n    _FILE "),
    "CREATE TABLE still leads with the metadata columns"
  )
  check(
    `${n} cols: staging table has the same layout`,
    (() => {
      const stg = script.statements.find((s) => s.label.startsWith("Staging table"))!.sql
      return stg.indexOf(`\n    ${expected[expected.length - 1]} `) < stg.indexOf("\n    _FILE ")
    })()
  )
  check(
    `${n} cols: ordinals are $1..$${n} in order`,
    proc.includes(columns.map((x) => `$${x.ordinal}`).join(", "))
  )
}

/* ---- 4b. The schedule reaches DDL validated, canonical, and nothing else -- */

console.log("Schedule safety")
{
  const threw = (over: Partial<SyncConfig>) => {
    try {
      buildSyncScript(cfg(over))
      return false
    } catch {
      return true
    }
  }

  // THE REGRESSION TEST FOR THE INJECTION. scheduleTz sat immediately before
  // the generated `AS`, so a quote in it made the rest of the task body
  // caller-chosen — no semicolon needed.
  check(
    "a quote in the timezone is refused",
    threw({ scheduleTz: "UTC' AS CALL SPOT_DW.X.EVIL() --" })
  )
  for (const tz of ["UTC", "utc", "Africa/Johannesburg ", "", "africa/johannesburg"]) {
    check(`timezone ${JSON.stringify(tz)} is refused (allow-list is exact)`, threw({ scheduleTz: tz }))
  }
  check("a semicolon in the cron is refused", threw({ scheduleCron: "0 7 * * *; DROP TABLE X" }))
  check("sub-hourly is refused server-side, not only in the UI", threw({ scheduleCron: "*/5 * * * *" }))
  check("both DOM and DOW restricted is refused", threw({ scheduleCron: "0 6 1 * 1" }))
  check("an impossible date is refused", threw({ scheduleCron: "0 0 30 2 *" }))

  // Emission uses the canonical form, so what Snowflake sees is a string the
  // cron module built out of integers rather than the caller's text.
  const messy = buildSyncScript(cfg({ scheduleCron: "0  07   *  *  *" }))
  const taskSql = messy.statements.find((s) => s.label.startsWith("Task"))!.sql
  check(
    "the emitted task carries the canonical expression",
    taskSql.includes("SCHEDULE  = 'USING CRON 0 7 * * * Africa/Johannesburg'"),
    taskSql.split("\n").find((l) => l.includes("SCHEDULE")) ?? "no SCHEDULE line"
  )

  // The SQL API takes one statement per request, so CREATE TASK and the
  // SUSPEND that follows it have to be separate entries in the list.
  const script = buildSyncScript(cfg())
  const taskStatements = script.statements.filter((s) => /Task |Suspend /.test(s.label))
  check("CREATE TASK and ALTER TASK SUSPEND are separate statements", taskStatements.length === 2)
  // Strip comments and any $$-quoted body first: a procedure's body is full of
  // semicolons and is still one statement.
  const bare = (sql: string) =>
    sql
      .replace(/\$\$[\s\S]*?\$\$/g, "$$$$")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/;\s*$/, "")
  check(
    "no statement contains two SQL statements",
    script.statements.every((s) => !bare(s.sql).includes(";")),
    script.statements.filter((s) => bare(s.sql).includes(";")).map((s) => s.label).join(", ")
  )

  // Warnings, not refusals.
  check(
    "every-hour-every-day warns",
    buildSyncScript(cfg({ scheduleCron: "0 * * * *" })).warnings.some((w) => w.includes("730"))
  )
  for (const preset of ["0 7 * * *", "0 5 * * 1-5", "0 6-18 * * *", "0 6-18/2 * * *"]) {
    check(`existing preset ${preset} still builds`, !threw({ scheduleCron: preset }))
  }
}

/* ---- 4c. Every exit path records the run ---------------------------------- */

console.log("Run log")
for (const mode of ["merge", "truncate_insert"] as const) {
  const c = cfg({ loadMode: mode, mergeKeys: mode === "merge" ? ["TXN_DATE"] : [] })
  const proc = buildSyncScript(c).statements.find((s) => s.label.startsWith("Procedure"))!.sql
  const inserts = proc.match(new RegExp(`INSERT INTO ${RUN_LOG_TABLE.replace(/\./g, "\\.")}`, "g")) ?? []

  // Five ways out: fetch FAILED, NO_CHANGE, the loaded-but-empty self-check,
  // SUCCESS, and the exception handler.
  check(`${mode}: all five exit paths log`, inserts.length === 5, `found ${inserts.length}`)

  // Each write is wrapped in its own handler. Without that, a failure to write
  // the log falls through to the procedure's own handler and reports a load
  // that succeeded as FAILED — the record of the work breaking the work.
  check(
    `${mode}: every log write is guarded`,
    (proc.match(/WHEN OTHER THEN NULL;/g) ?? []).length === 5,
    "a log insert is not inside its own exception block"
  )
  check(`${mode}: the run is timed`, proc.includes("started_at := CURRENT_TIMESTAMP();"))
  // A load that reports rows into a table that is empty a statement later must
  // not be recorded as SUCCESS. This is the check that was missing when a run
  // said "605 rows" against an empty table.
  check(
    `${mode}: refuses to call an empty target a success`,
    /IF \(n_loaded > 0 AND n_total = 0\) THEN/.test(proc) &&
      proc.includes("is empty immediately afterwards"),
    "the procedure does not verify its own load"
  )
  // A double-quoted JS string where a template literal was needed put the
  // characters ${target} into the SQL, so every SUCCESS row read
  // "Loaded into ${target}" instead of naming the table.
  check(
    `${mode}: the success message names the real table`,
    proc.includes("'Loaded into SPOT_DW.SPOT_SFTP.SPOT_FEES'") && !proc.includes("Loaded into $" + "{"),
    proc.split("\n").find((l) => l.includes("Loaded into")) ?? "no message line"
  )
  check(
    `${mode}: SUCCESS records rows loaded, not just the table total`,
    /:n_loaded, :n_total/.test(proc),
    "the SUCCESS row does not distinguish rows loaded from rows in the target"
  )
}
{
  check("the generator is versioned", Number.isInteger(GENERATOR_VERSION) && GENERATOR_VERSION >= 2)
  // The run log lives with the app's own tables, not in the SFTP schema, so
  // writing to it needs no grant beyond the ones the app already has.
  check(
    "the run log is an app-owned table",
    RUN_LOG_TABLE.startsWith("DATAWAREHOUSE.LEADS_DISTRIBUTION."),
    RUN_LOG_TABLE
  )
}

/* ---- 4d. Merge semantics -------------------------------------------------- */

console.log("Merge")
{
  const procFor = (over: Partial<SyncConfig>) =>
    buildSyncScript(cfg(over)).statements.find((s) => s.label.startsWith("Procedure"))!.sql

  // Single key: no stray AND.
  const one = procFor({ loadMode: "merge", mergeKeys: ["TXN_DATE"] })
  check("single key joins on just that column", /ON t\.TXN_DATE = s\.TXN_DATE\n/.test(one), "")
  check("single key emits no stray AND", !/ON t\.TXN_DATE = s\.TXN_DATE\s+AND/.test(one))

  // Multi-column key, ANDed.
  const two = procFor({ loadMode: "merge", mergeKeys: ["TXN_DATE", "TRANSACTION"] })
  check(
    "multi-column key is ANDed",
    /ON t\.TXN_DATE = s\.TXN_DATE\s+AND t\.TRANSACTION = s\.TRANSACTION/.test(two),
    two.split("\n").find((l) => l.includes("ON t.")) ?? ""
  )

  // Every business column is carried on both branches.
  for (const col of ["TXN_DATE", "TRANSACTION", "INCOME"]) {
    check(`${col} is updated on match`, new RegExp(`t\\.${col} = s\\.${col}`).test(one))
    check(`${col} is inserted when not matched`, new RegExp(`s\\.${col}`).test(one))
  }

  // _UPDATED is stamped, never copied from staging — it means "when we last
  // wrote this row here", which is not a property of the file.
  check("_UPDATED is stamped on update", /t\._UPDATED = CURRENT_TIMESTAMP\(\)/.test(one))
  check("_UPDATED is never copied from staging", !/s\._UPDATED/.test(one))
  check("_MODIFIED IS copied from staging", /t\._MODIFIED = s\._MODIFIED/.test(one))

  // No business key falls back to the file position.
  const none = procFor({ loadMode: "merge", mergeKeys: [] })
  check(
    "no key falls back to (_FILE, _LINE)",
    /ON t\._FILE = s\._FILE\s+AND t\._LINE = s\._LINE/.test(none)
  )

  // The two modes are genuinely exclusive.
  const trunc = procFor({ loadMode: "truncate_insert", mergeKeys: [] })
  check("truncate mode emits no MERGE", !trunc.includes("MERGE INTO"))
  check("merge mode does not truncate the target", !/TRUNCATE TABLE SPOT_DW\.SPOT_SFTP\.SPOT_FEES/.test(one))

  // Hop 1 is fixed for BOTH modes: the staging table is always replaced.
  for (const [name, sql] of [["merge", one], ["truncate_insert", trunc]] as const) {
    check(
      `${name}: staging is always truncated before the COPY`,
      sql.indexOf("TRUNCATE TABLE SPOT_DW.SPOT_SFTP.STG_SPOT_FEES") > -1 &&
        sql.indexOf("TRUNCATE TABLE SPOT_DW.SPOT_SFTP.STG_SPOT_FEES") < sql.indexOf("COPY INTO"),
      "the staging table is not emptied before the file is copied in"
    )
  }
}

/* ---- 4e. A merge key proven non-unique is refused ------------------------- */

console.log("Merge key uniqueness")
{
  const threw = (over: Partial<SyncConfig>) => {
    try {
      buildSyncScript(cfg(over))
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  const msg = threw({
    loadMode: "merge",
    mergeKeys: ["TXN_DATE"],
    mergeKeyProvenNonUnique: { rows: 605, distinct: 14, suggestion: ["TXN_DATE", "TRANSACTION"] },
  })
  check("a proven non-unique key is refused", msg !== null)
  check("the message gives both counts", (msg ?? "").includes("605") && (msg ?? "").includes("14"))
  check("and names a key that would work", (msg ?? "").includes("TXN_DATE, TRANSACTION"))
  check(
    "without a suggestion it still says what to do",
    (threw({
      loadMode: "merge",
      mergeKeys: ["TXN_DATE"],
      mergeKeyProvenNonUnique: { rows: 605, distinct: 14, suggestion: null },
    }) ?? "").includes("Add columns to the key")
  )
  check(
    "a key measured as unique deploys",
    threw({ loadMode: "merge", mergeKeys: ["TXN_DATE"] }) === null
  )
  check(
    "truncate mode ignores the measurement entirely",
    threw({
      loadMode: "truncate_insert",
      mergeKeys: [],
      mergeKeyProvenNonUnique: { rows: 605, distinct: 14 },
    }) === null
  )
}

/* ---- 5. Identifiers are refused, not escaped ----------------------------- */

console.log("Identifier rejection")
for (const bad of ["a'b", "a;b", "a b", "a-b", "..", "", "SPOT.FEES"]) {
  let threw = false
  try {
    buildSyncScript(cfg({ syncName: bad }))
  } catch {
    threw = true
  }
  check(`sync name ${JSON.stringify(bad)} refused`, threw)
}
{
  let threw = false
  try {
    buildSyncScript(cfg({ targetDb: "OTHER_DB", targetSchema: "PUBLIC", createTable: true }))
  } catch {
    threw = true
  }
  check("target schema off the allow-list refused", threw)
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
