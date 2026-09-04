/**
 * Offline tests for the Spot replace-mode uploads.
 *
 *   npx tsx scripts/spot/upload-sql-tests.ts
 *
 * No warehouse, no network. Fixtures come from the two real files, including
 * the row that motivated most of this care: `Cell C,"2,50%"` — a quoted field
 * whose value contains a comma. A parser that split on commas, or a numeric
 * "cleaner" that strips thousands separators, would turn 2,50% into 250 and
 * nothing downstream would ever say so.
 */
import { SPOT_UPLOADS, getSpotUpload, fqTable } from "../../lib/spot-uploads"
import {
  buildCount,
  buildDelete,
  buildInsert,
  ident,
  resolveKeyColumns,
  sqlString,
  sqlValue,
  unknownColumns,
  validateProcess,
  wrongFileColumns,
} from "../../lib/spot-upload-sql"
import { sanitizeHeaderRow } from "../../lib/column-mapping"
import { parseWorkbook } from "../../lib/spot-upload-parse"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const RATES = getSpotUpload("rates")!
const AIRTIME = getSpotUpload("airtime-rates")!

/* The nine columns BOTH targets carry, per the live table definitions. */
const TARGET_COLUMNS = [
  "TYPE",
  "RATE",
  "FLAT",
  "__HEVO_ID",
  "RECIPIENT_NAME",
  "AIRTIME_RATE",
  "__HEVO__INGESTED_AT",
  "__HEVO__LOADED_AT",
  "__HEVO__SOURCE_MODIFIED_AT",
]

/* ---- 1. The registry is well formed ------------------------------------- */

console.log("Registry")
{
  check("two processes", SPOT_UPLOADS.length === 2)
  check("ids are unique", new Set(SPOT_UPLOADS.map((p) => p.id)).size === SPOT_UPLOADS.length)
  for (const p of SPOT_UPLOADS) {
    let threw = false
    try {
      validateProcess(p)
    } catch (e) {
      threw = true
      check(`${p.id}: validates`, false, String(e))
    }
    if (!threw) check(`${p.id}: validates`, true)
    check(`${p.id}: history table is distinct from the target`, p.historyTable !== fqTable(p))
    check(
      `${p.id}: every key header is an expected column`,
      p.keyHeaders.every((k) => p.expectedColumns.includes(sanitizeHeaderRow([k])[0])),
      `keys ${p.keyHeaders.join(",")} vs expected ${p.expectedColumns.join(",")}`
    )
  }
  check("rates targets RATES", fqTable(RATES) === "SPOT_DW.SPOT_SFTP.RATES")
  check("airtime targets AIRTIME_RATES", fqTable(AIRTIME) === "SPOT_DW.SPOT_SFTP.AIRTIME_RATES")
}

/* ---- 2. Literals ---------------------------------------------------------- */

console.log("Literals")
{
  check("plain value", sqlString("TOPUP") === "'TOPUP'")
  check("apostrophe is doubled", sqlString("Sam's Store") === "'Sam''s Store'", sqlString("Sam's Store"))
  check(
    "an injection attempt stays one literal",
    sqlString("x'); DROP TABLE T; --") === "'x''); DROP TABLE T; --'",
    sqlString("x'); DROP TABLE T; --")
  )
  // The whole point of the exercise.
  check("a comma decimal survives", sqlValue("2,50%") === "'2,50%'", sqlValue("2,50%"))
  check("empty becomes NULL, not ''", sqlValue("") === "NULL", sqlValue(""))
  check("whitespace-only becomes NULL", sqlValue("   ") === "NULL")
  check("a negative decimal is untouched", sqlValue("-0.00024729") === "'-0.00024729'")
}

console.log("Identifiers")
{
  check("uppercased and quoted", ident("type") === '"TYPE"')
  check("leading underscores are fine", ident("__HEVO_ID") === '"__HEVO_ID"')
  for (const bad of ['A"B', "A;B", "A B", "A-B", "A'B", "", "A.B", "A()"]) {
    let threw = false
    try {
      ident(bad)
    } catch {
      threw = true
    }
    check(`rejects ${JSON.stringify(bad)}`, threw)
  }
}

/* ---- 3. The file-identity check, which is the one that matters ----------- */

console.log("File identity")
{
  const ratesCols = sanitizeHeaderRow(["type", "rate", "flat"])
  const airtimeCols = sanitizeHeaderRow(["recipient_name", "airtime_rate"])

  check("rates headers sanitize as expected", JSON.stringify(ratesCols) === '["TYPE","RATE","FLAT"]', JSON.stringify(ratesCols))
  check(
    "airtime headers sanitize as expected",
    JSON.stringify(airtimeCols) === '["RECIPIENT_NAME","AIRTIME_RATE"]',
    JSON.stringify(airtimeCols)
  )

  check("the right file passes", wrongFileColumns(RATES, ratesCols).length === 0)
  check("the right airtime file passes", wrongFileColumns(AIRTIME, airtimeCols).length === 0)

  // The swap. This is the regression guard: the target-column check CANNOT
  // catch it, because both tables have all nine columns.
  check(
    "rates file on the airtime page is refused",
    JSON.stringify(wrongFileColumns(AIRTIME, ratesCols)) === '["RECIPIENT_NAME","AIRTIME_RATE"]',
    JSON.stringify(wrongFileColumns(AIRTIME, ratesCols))
  )
  check(
    "airtime file on the rates page is refused",
    JSON.stringify(wrongFileColumns(RATES, airtimeCols)) === '["TYPE","RATE","FLAT"]',
    JSON.stringify(wrongFileColumns(RATES, airtimeCols))
  )
  check(
    "and the target check would NOT have caught either",
    unknownColumns(ratesCols, TARGET_COLUMNS).length === 0 &&
      unknownColumns(airtimeCols, TARGET_COLUMNS).length === 0,
    "if this fails the tables no longer share all nine columns — re-read the comment in lib/spot-uploads.ts"
  )

  // A genuinely foreign file is caught by both.
  const arpuCols = sanitizeHeaderRow(["DATE", "TRANSACTION", "INCOME"])
  check("the ARPU file is refused as the wrong file", wrongFileColumns(RATES, arpuCols).length === 3)
  check(
    "and its unknown columns are named",
    JSON.stringify(unknownColumns(arpuCols, TARGET_COLUMNS)) === '["DATE","TRANSACTION","INCOME"]',
    JSON.stringify(unknownColumns(arpuCols, TARGET_COLUMNS))
  )
}

console.log("Key resolution")
{
  const headers = ["type", "rate", "flat"]
  const columns = sanitizeHeaderRow(headers)
  check(
    "raw header maps to its sanitized column",
    JSON.stringify(resolveKeyColumns(RATES.keyHeaders, headers, columns)) === '["TYPE"]'
  )
  check(
    "matching ignores case and padding",
    JSON.stringify(resolveKeyColumns(["  TYPE "], headers, columns)) === '["TYPE"]'
  )
  let threw = false
  try {
    resolveKeyColumns(AIRTIME.keyHeaders, headers, columns)
  } catch {
    threw = true
  }
  check("a key absent from the file throws", threw)
}

/* ---- 4. The statements --------------------------------------------------- */

console.log("Statements")
{
  check("count", buildCount(RATES) === "SELECT COUNT(*) FROM SPOT_DW.SPOT_SFTP.RATES")
  check("delete", buildDelete(RATES) === "DELETE FROM SPOT_DW.SPOT_SFTP.RATES")
  check("never TRUNCATE", !buildDelete(RATES).includes("TRUNCATE"))
}

console.log("Insert — rates")
{
  const headers = ["type", "rate", "flat"]
  const columns = sanitizeHeaderRow(headers)
  const keys = resolveKeyColumns(RATES.keyHeaders, headers, columns)
  const rows = [
    ["TOPUP", "0", "0"],
    ["AIRTIME_PURCHASE", "0.04", "0"],
    ["STORE (WICODE)", "0.02", "0"],
    ["DATA_USAGE", "-0.00024729", "0"],
    ["FRAUD_REPATRIATION", "0.02", "500"],
  ]
  const sql = buildInsert(RATES, columns, keys, rows)

  check("targets the right table", sql.startsWith("INSERT INTO SPOT_DW.SPOT_SFTP.RATES ("))
  check(
    "__HEVO_ID is the last inserted column",
    sql.includes('("TYPE", "RATE", "FLAT", "__HEVO_ID")'),
    sql.slice(0, 120)
  )
  check(
    "its value is derived from the key",
    sql.includes(`'xls-' || MD5(COALESCE(TRIM(s."TYPE"), ''))`),
    sql
  )
  check("the VALUES alias lists only the file's columns", sql.includes('AS v("TYPE", "RATE", "FLAT")'))
  check("a value with parentheses is a literal, not syntax", sql.includes("'STORE (WICODE)'"))
  check("the negative rate is preserved exactly", sql.includes("'-0.00024729'"))
  check("no un-expanded template placeholder", !sql.includes("${"))

  // Arity: every VALUES tuple must have as many entries as the column list.
  const tuples = sql.slice(sql.indexOf("FROM VALUES ")).match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g) ?? []
  const valueTuples = tuples.slice(0, rows.length)
  check(
    "every tuple has one entry per column",
    valueTuples.every((t) => t.split(",").length >= columns.length),
    JSON.stringify(valueTuples)
  )
  check("one tuple per row", valueTuples.length === rows.length, String(valueTuples.length))
}

console.log("Insert — airtime rates")
{
  const headers = ["recipient_name", "airtime_rate"]
  const columns = sanitizeHeaderRow(headers)
  const keys = resolveKeyColumns(AIRTIME.keyHeaders, headers, columns)
  const rows = [
    ["Cell C", "2,50%"],
    ["MTN", "4,75%"],
    ["Spot Connect", "86,96%"],
  ]
  const sql = buildInsert(AIRTIME, columns, keys, rows)

  check("targets AIRTIME_RATES", sql.startsWith("INSERT INTO SPOT_DW.SPOT_SFTP.AIRTIME_RATES ("))
  check(
    "keyed on RECIPIENT_NAME",
    sql.includes(`'xls-' || MD5(COALESCE(TRIM(s."RECIPIENT_NAME"), ''))`)
  )
  // The headline assertion of this file.
  check("2,50% reaches the SQL intact", sql.includes("'2,50%'"), sql)
  check("86,96% reaches the SQL intact", sql.includes("'86,96%'"))
  check("it was NOT stripped to 250", !sql.includes("'250'"))
  check("it was NOT split at the comma", !sql.includes("'2', '50%'"))
  check(
    "only two source columns",
    sql.includes('AS v("RECIPIENT_NAME", "AIRTIME_RATE")'),
    sql
  )
}

console.log("Insert — multi-column key")
{
  // Not used by either process today, but the seed expression is the part a
  // future entry is most likely to get wrong.
  const p = { ...RATES, keyHeaders: ["type", "flat"], expectedColumns: ["TYPE", "RATE", "FLAT"] }
  const headers = ["type", "rate", "flat"]
  const columns = sanitizeHeaderRow(headers)
  const keys = resolveKeyColumns(p.keyHeaders, headers, columns)
  const sql = buildInsert(p, columns, keys, [["A", "1", "2"]])
  check(
    "two keys are joined by a separator",
    sql.includes(`MD5(COALESCE(TRIM(s."TYPE"), '') || '|' || COALESCE(TRIM(s."FLAT"), ''))`),
    sql
  )
}

console.log("Insert — refusals")
{
  const columns = ["TYPE"]
  let threw = false
  try {
    buildInsert(RATES, columns, ["TYPE"], [])
  } catch {
    threw = true
  }
  check("no rows throws", threw)

  threw = false
  try {
    buildInsert(RATES, [], [], [["a"]])
  } catch {
    threw = true
  }
  check("no columns throws", threw)

  threw = false
  try {
    buildInsert(RATES, ['BAD"COL'], ["TYPE"], [["a"]])
  } catch {
    threw = true
  }
  check("an unsafe column name throws rather than being escaped", threw)

  threw = false
  try {
    buildInsert({ ...RATES, table: "RATES; DROP TABLE X" }, columns, ["TYPE"], [["a"]])
  } catch {
    threw = true
  }
  check("an unsafe table name throws", threw)
}

/* ---- 5. The real parser on real bytes ------------------------------------ */

/*
 * Verbatim content of the two supplied files. Inlined rather than read from
 * disk so the suite runs anywhere, but byte-for-byte what was handed over —
 * including airtime_rates' quoted decimal commas and rates' trailing newline.
 */
const AIRTIME_CSV = [
  "recipient_name,airtime_rate",
  'Cell C,"2,50%"',
  'MTN,"4,75%"',
  'Telkom,"5,50%"',
  'Vodacom,"4,50%"',
  'Spot Connect,"86,96%"',
].join("\n")

const RATES_CSV =
  [
    "type,rate,flat",
    "TOPUP,0,0",
    "AIRTIME_PURCHASE,0.04,0",
    "CASHOUT,0,5",
    "STORE (WICODE),0.02,0",
    "AIRTIME/DATA,0.04,0",
    "TILL_DEPOSIT,0,19.95",
    "ATM WITHDRAWAL,0.014,8",
    "DATA_USAGE,-0.00024729,0",
    "FRAUD_REPATRIATION,0.02,500",
  ].join("\n") + "\n"

console.log("Parsing the airtime file")
{
  const p = parseWorkbook(Buffer.from(AIRTIME_CSV, "utf8"))
  check("two columns, not three", p.columns.length === 2, JSON.stringify(p.columns))
  check(
    "columns are RECIPIENT_NAME, AIRTIME_RATE",
    JSON.stringify(p.columns) === '["RECIPIENT_NAME","AIRTIME_RATE"]',
    JSON.stringify(p.columns)
  )
  check("five data rows", p.rows.length === 5, String(p.rows.length))
  // THE assertion. If SheetJS split the quoted field this is "2" and the row
  // has three cells.
  check("the quoted comma survived", p.rows[0][1] === "2,50%", JSON.stringify(p.rows[0]))
  check("Cell C kept its space", p.rows[0][0] === "Cell C", JSON.stringify(p.rows[0]))
  check("the largest rate survived", p.rows[4][1] === "86,96%", JSON.stringify(p.rows[4]))
  check("every row has exactly two cells", p.rows.every((r) => r.length === 2))
  check("it is recognised as the airtime file", wrongFileColumns(AIRTIME, p.columns).length === 0)
  check("and refused on the rates page", wrongFileColumns(RATES, p.columns).length === 3)

  const keys = resolveKeyColumns(AIRTIME.keyHeaders, p.headers, p.columns)
  const sql = buildInsert(AIRTIME, p.columns, keys, p.rows)
  check("end to end, 2,50% reaches the SQL", sql.includes("'2,50%'"))
  check("end to end, nothing became 250", !sql.includes("'250'"))
}

console.log("Parsing the rates file")
{
  const p = parseWorkbook(Buffer.from(RATES_CSV, "utf8"))
  check(
    "columns are TYPE, RATE, FLAT",
    JSON.stringify(p.columns) === '["TYPE","RATE","FLAT"]',
    JSON.stringify(p.columns)
  )
  check("the trailing newline did not add a row", p.rows.length === 9, String(p.rows.length))
  check("a value with a space is intact", p.rows[6][0] === "ATM WITHDRAWAL", JSON.stringify(p.rows[6]))
  check("a value with parentheses is intact", p.rows[3][0] === "STORE (WICODE)", JSON.stringify(p.rows[3]))
  check("a value with a slash is intact", p.rows[4][0] === "AIRTIME/DATA", JSON.stringify(p.rows[4]))
  // raw:true gives the underlying number, and String() must not turn a small
  // decimal into exponential notation that reads as a different value.
  check("the small negative rate is not exponential", p.rows[7][1] === "-0.00024729", JSON.stringify(p.rows[7]))
  check("a decimal flat amount is intact", p.rows[5][2] === "19.95", JSON.stringify(p.rows[5]))
  check("a whole number stays plain", p.rows[8][2] === "500", JSON.stringify(p.rows[8]))
  check("zero is not dropped to empty", p.rows[0][1] === "0" && p.rows[0][2] === "0", JSON.stringify(p.rows[0]))
  check("it is recognised as the rates file", wrongFileColumns(RATES, p.columns).length === 0)
  check("and refused on the airtime page", wrongFileColumns(AIRTIME, p.columns).length === 2)
}

console.log("Parsing — refusals")
{
  let threw = false
  try {
    parseWorkbook(Buffer.from("", "utf8"))
  } catch {
    threw = true
  }
  check("an empty file throws", threw)

  const headerOnly = parseWorkbook(Buffer.from("type,rate,flat\n", "utf8"))
  check("a header-only file parses to zero rows", headerOnly.rows.length === 0)

  // Measured, not assumed: a fully blank leading row is dropped, so the NEXT
  // row becomes the header. Forgiving, and safe here only because
  // wrongFileColumns still has to recognise whatever comes out.
  const blankFirst = parseWorkbook(Buffer.from(",,\nA,B,C\n1,2,3", "utf8"))
  check(
    "a blank leading row is skipped rather than used as headers",
    JSON.stringify(blankFirst.columns) === '["A","B","C"]',
    JSON.stringify(blankFirst.columns)
  )
  check(
    "and the result is refused as the wrong file",
    wrongFileColumns(RATES, blankFirst.columns).length === 3
  )

  // A blank header drops its column AND its data without shifting the columns
  // after it. Getting this wrong would load the right values into the wrong
  // fields, which is the one failure mode nothing downstream would notice.
  const gap = parseWorkbook(Buffer.from("type,,flat\nA,B,C", "utf8"))
  check(
    "a blank header drops only that column",
    JSON.stringify(gap.columns) === '["TYPE","FLAT"]',
    JSON.stringify(gap.columns)
  )
  check(
    "and the surviving columns keep their own values",
    JSON.stringify(gap.rows) === '[["A","C"]]',
    JSON.stringify(gap.rows)
  )
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
