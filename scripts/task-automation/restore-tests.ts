/**
 * The test that was missing when "Open in wizard" shipped.
 *
 *   npx tsx scripts/task-automation/restore-tests.ts
 *
 * Reopening a job and redeploying it must produce the SAME Snowflake objects.
 * The first cut packed the mapped columns contiguously, so a config mapping
 * ordinals 1 and 3 reopened as one mapping only ordinal 1 — the second column
 * vanished, silently, and a redeploy wrote a sync that loaded half the file.
 *
 * The existing registry round-trip test never caught it because it exercises
 * rowToConfig and stops there; this one goes through the wizard's own state.
 */
import { restoreFromConfig, rebuildColumns } from "../../lib/sftp-sync-restore"
import { sanitizeHeaderRow, SKIP_VALUE, type TargetColumn } from "../../lib/column-mapping"
import { buildSyncScript, type SyncConfig } from "../../lib/sftp-sync-codegen"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

function cfg(over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    syncName: "ARPU_FEES",
    endpoint: "SPOT",
    remoteDir: "/spot_money",
    filePattern: "ARPU_*.csv",
    targetDb: "SPOT_DW",
    targetSchema: "SPOT_SFTP",
    targetTable: "ARPU_FEES",
    createTable: false,
    columns: [{ source: "DATE", ordinal: 1, target: "TXN_DATE", type: "VARCHAR(1000)" }],
    loadMode: "truncate_insert",
    mergeKeys: [],
    delimiter: ",",
    skipHeader: true,
    warehouse: "SPOT_WH",
    scheduleCron: "0 7 * * *",
    scheduleTz: "Africa/Johannesburg",
    onError: "ABORT_STATEMENT",
    ...over,
  }
}

/**
 * Reopen a config the way the wizard does, then rebuild the config from that
 * state the way the wizard does, and compare the generated SQL.
 */
function reopen(original: SyncConfig): SyncConfig {
  const s = restoreFromConfig(original)
  // In "new" mode the wizard derives its target columns from the headers, the
  // same way the live component does.
  const targetColumns: TargetColumn[] =
    s.destMode === "new"
      ? sanitizeHeaderRow(s.headers).map((name) => ({
          COLUMN_NAME: name,
          DATA_TYPE: s.newTypes[name] ?? "VARCHAR(1000)",
          IS_NULLABLE: "YES" as const,
          COLUMN_DEFAULT: null,
        }))
      : []
  return {
    ...original,
    createTable: s.destMode === "new",
    columns: rebuildColumns(s.headers, s.mapping, s.newTypes, s.destMode, targetColumns),
  }
}

/* ---- 1. The proven bug: a gap in the ordinals ---------------------------- */

console.log("Sparse ordinals")
{
  // Source field 2 was skipped when the job was first mapped.
  const original = cfg({
    columns: [
      { source: "DATE", ordinal: 1, target: "TXN_DATE", type: "VARCHAR(1000)" },
      { source: "INCOME", ordinal: 3, target: "INCOME", type: "VARCHAR(50)" },
    ],
  })
  const s = restoreFromConfig(original)
  check("three header slots, not two", s.headers.length === 3, JSON.stringify(s.headers))
  check("the gap gets a placeholder", s.headers[1] === "COL2", JSON.stringify(s.headers))
  check("sources sit at their ordinals", s.headers[0] === "DATE" && s.headers[2] === "INCOME")
  check("the gap is explicitly skipped", s.mapping[1] === SKIP_VALUE, JSON.stringify(s.mapping))
  check("every index has a decision", Object.keys(s.mapping).length === 3)

  const back = reopen(original)
  check(
    "no column is lost",
    back.columns.length === 2,
    `kept ${back.columns.map((c) => `$${c.ordinal}->${c.target}`).join(" ") || "(none)"}`
  )
  check(
    "ordinals are unchanged",
    JSON.stringify(back.columns.map((c) => c.ordinal)) === "[1,3]",
    JSON.stringify(back.columns.map((c) => c.ordinal))
  )
  check(
    "regenerates byte-identical SQL",
    JSON.stringify(buildSyncScript(back).statements) === JSON.stringify(buildSyncScript(original).statements)
  )
}

/* ---- 2. Shapes that could each break it differently ---------------------- */

console.log("Round trip")
const cases: [string, SyncConfig][] = [
  ["single column", cfg()],
  [
    "trailing skip",
    cfg({
      columns: [
        { source: "A", ordinal: 1, target: "A", type: "VARCHAR" },
        { source: "B", ordinal: 2, target: "B", type: "VARCHAR" },
      ],
    }),
  ],
  [
    "leading skip",
    cfg({ columns: [{ source: "C", ordinal: 3, target: "C", type: "VARCHAR" }] }),
  ],
  [
    "several gaps",
    cfg({
      columns: [
        { source: "A", ordinal: 2, target: "A", type: "VARCHAR" },
        { source: "B", ordinal: 5, target: "B", type: "VARCHAR(20)" },
        { source: "C", ordinal: 9, target: "C", type: "NUMBER(38,0)" },
      ],
    }),
  ],
  [
    "merge keys survive",
    cfg({
      loadMode: "merge",
      mergeKeys: ["B"],
      columns: [
        { source: "A", ordinal: 1, target: "A", type: "VARCHAR" },
        { source: "B", ordinal: 4, target: "B", type: "VARCHAR" },
      ],
    }),
  ],
  ["tab delimited", cfg({ delimiter: "\t", skipHeader: false })],
  [
    "create-a-new-table",
    cfg({
      createTable: true,
      targetTable: "NEW_TABLE",
      columns: [
        { source: "DATE", ordinal: 1, target: "DATE", type: "VARCHAR(1000)" },
        { source: "INCOME", ordinal: 2, target: "INCOME", type: "VARCHAR(1000)" },
      ],
    }),
  ],
  [
    "60 columns",
    cfg({
      columns: Array.from({ length: 60 }, (_, i) => ({
        source: `F${i + 1}`,
        ordinal: i + 1,
        target: `COL_${i + 1}`,
        type: "VARCHAR(100)",
      })),
    }),
  ],
]

for (const [name, original] of cases) {
  const back = reopen(original)
  check(
    `${name}: same columns`,
    JSON.stringify(back.columns) === JSON.stringify(original.columns),
    JSON.stringify(back.columns)
  )
  check(
    `${name}: same SQL`,
    JSON.stringify(buildSyncScript(back).statements) === JSON.stringify(buildSyncScript(original).statements)
  )
}

/* ---- 3. Reopening twice must not drift ----------------------------------- */

console.log("Idempotence")
{
  const original = cfg({
    columns: [
      { source: "A", ordinal: 1, target: "A", type: "VARCHAR" },
      { source: "B", ordinal: 4, target: "B", type: "VARCHAR" },
    ],
  })
  const once = reopen(original)
  const twice = reopen(once)
  check("reopening twice changes nothing", JSON.stringify(twice) === JSON.stringify(once))
}

console.log("Destination")
{
  check("an existing-table job restores as existing", restoreFromConfig(cfg()).destMode === "existing")
  check(
    "a create job restores as new",
    restoreFromConfig(cfg({ createTable: true })).destMode === "new"
  )
  check(
    "the destination is fully qualified",
    restoreFromConfig(cfg()).destTable === "SPOT_DW.SPOT_SFTP.ARPU_FEES"
  )
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
