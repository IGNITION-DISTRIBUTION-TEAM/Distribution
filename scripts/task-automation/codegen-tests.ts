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
  const listRe = new RegExp(`\\(_FILE, _LINE, _MODIFIED, _UPDATED, ([^)]*)\\)`, "g")
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
  check(
    `${n} cols: ordinals are $1..$${n} in order`,
    proc.includes(columns.map((x) => `$${x.ordinal}`).join(", "))
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
