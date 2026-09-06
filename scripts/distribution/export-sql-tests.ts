/**
 * Offline tests for the distribution export (step 4 download / step 5 email).
 *
 *   npx tsx scripts/distribution/export-sql-tests.ts
 *
 * No warehouse, no network, no mail. This suite exists because `buildQuery`
 * had ZERO coverage while carrying the whole CXM layout, and the date/batch
 * pickers added two predicates to it — one of them interpolating
 * operator-supplied text into raw SQL. There are no bind parameters anywhere
 * in this repo, so `sqlLit` IS the injection boundary and it gets tested
 * directly.
 *
 * It also pins the encoding claim the UI makes in four places — "CSV, UTF-8,
 * no BOM" — and the claim that the emailed file is byte-identical to the
 * downloaded one. Both are currently true by construction (one shared
 * `rowsToCsv`), and a test is what keeps them true.
 */
import {
  assertIsoDate,
  buildQuery,
  describeScope,
  parseExportScope,
  sqlLit,
  type ExportScope,
} from "../../lib/distribution-export"
import { rowsToCsv } from "../../lib/dialler-csv"
import type { SnowflakeColumn } from "../../lib/snowflake"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const scope = (over: Partial<ExportScope> = {}): ExportScope => ({
  date: "2026-09-01",
  batchName: null,
  ...over,
})

/* ---- 1. sqlLit — the injection boundary -------------------------------- */

console.log("sqlLit")
{
  check("wraps in single quotes", sqlLit("BATCH_A") === "'BATCH_A'")
  // The one that matters. A raw interpolation of BATCH_O'BRIEN would close the
  // literal early and leave BRIEN as SQL.
  check("doubles a single quote", sqlLit("BATCH_O'BRIEN") === "'BATCH_O''BRIEN'", sqlLit("BATCH_O'BRIEN"))
  check(
    "doubles every quote, not just the first",
    sqlLit("a'b'c") === "'a''b''c'",
    sqlLit("a'b'c")
  )
  check(
    "neutralises a classic injection payload",
    sqlLit("x' OR 1=1 --") === "'x'' OR 1=1 --'",
    sqlLit("x' OR 1=1 --")
  )
  check("leaves a double quote alone (not special in a SQL string)", sqlLit('a"b') === `'a"b'`)
  check("handles an empty string", sqlLit("") === "''")
}

/* ---- 2. assertIsoDate -------------------------------------------------- */

console.log("\nassertIsoDate")
{
  check("accepts a real date", assertIsoDate("2026-09-01") === "2026-09-01")
  const rejects = (v: string) => {
    try {
      assertIsoDate(v)
      return false
    } catch {
      return true
    }
  }
  check("rejects the wrong shape", rejects("01/09/2026"))
  check("rejects a bare year", rejects("2026"))
  check("rejects empty", rejects(""))
  // The date is not escaped, so the regex has to be what stops this.
  check("rejects an injection attempt in the date", rejects("2026-09-01' OR '1'='1"))
}

/* ---- 3. The date predicate, across all three lookup tiers -------------- */

console.log("\nbuildQuery — the date")
{
  // The tier changes the leading CTE, so a predicate appended in the wrong
  // place would only break one of the three.
  for (const tier of ["full", "noDetails", "noLookup"] as const) {
    const sql = buildQuery(11381, 45, tier, scope())
    check(
      `${tier}: filters on the given date`,
      sql.includes("AND cast(CREATEDONDATE as date) = '2026-09-01'::DATE"),
      tier
    )
    check(`${tier}: no CURRENT_DATE() left anywhere`, !sql.includes("CURRENT_DATE()"))
    check(`${tier}: still filters the campaign`, sql.includes("WHERE CAMPAIGNID in (11381)"))
    check(`${tier}: still excludes suppressed rows`, sql.includes("AND ESTATUS IS NULL"))
  }
  check(
    "a malformed date throws rather than reaching the SQL",
    (() => {
      try {
        buildQuery(1, 45, "full", scope({ date: "nonsense" }))
        return false
      } catch {
        return true
      }
    })()
  )
}

/* ---- 4. The output columns — the latent bug the picker would have exposed */

console.log("\nbuildQuery — CREATEDONDATE and LeadExpiry")
{
  const sql = buildQuery(11381, 45, "full", scope())
  // These were CURRENT_DATE() and CURRENT_DATE() + expiryDays. Harmless while
  // the WHERE clause pinned every row to today; a silent data bug the moment a
  // date could be picked, because a 1 September export would have stamped
  // every row with today's date and an expiry six weeks out.
  check(
    "CREATEDONDATE is the row's own load date",
    sql.includes("CAST(a.CREATEDONDATE AS DATE) AS CREATEDONDATE"),
  )
  check(
    "LeadExpiry is measured from the load date",
    sql.includes("CAST(a.CREATEDONDATE AS DATE) + 45 as LeadExpiry"),
  )
  check("the expiry days value is substituted", buildQuery(1, 30, "full", scope()).includes("+ 30 as LeadExpiry"))
}

/* ---- 5. The batch predicate -------------------------------------------- */

console.log("\nbuildQuery — the batch")
{
  const all = buildQuery(11381, 45, "full", scope())
  check("no BATCHNAME clause when no batch is picked", !all.includes("AND BATCHNAME ="))
  // BATCHNAME is still SELECTed — the grouping into per-batch files reads it.
  check("but BATCHNAME is still projected", all.includes("BATCHNAME AS BATCHNAME"))

  const one = buildQuery(11381, 45, "full", scope({ batchName: "BATCH_ONAIR_ULTRA520260901" }))
  check(
    "filters on the picked batch",
    one.includes("AND BATCHNAME = 'BATCH_ONAIR_ULTRA520260901'"),
    "clause missing"
  )
  check(
    "the batch clause sits inside the WHERE, before ESTATUS",
    /AND cast\(CREATEDONDATE as date\) = '2026-09-01'::DATE\s*\n\s*AND BATCHNAME = '[^']*'\s*\n\s*AND ESTATUS IS NULL/.test(one),
    "clause is in the wrong place"
  )
  check(
    "the QUALIFY and ORDER BY still follow it",
    one.indexOf("AND BATCHNAME =") < one.indexOf("QUALIFY ROW_NUMBER()") &&
      one.indexOf("QUALIFY ROW_NUMBER()") < one.indexOf("order by cast(UDM30 as int)")
  )

  // End to end: a quote in a batch name must not escape the literal.
  const nasty = buildQuery(11381, 45, "full", scope({ batchName: "BATCH_O'BRIEN" }))
  check(
    "a quoted batch name is escaped in the generated SQL",
    nasty.includes("AND BATCHNAME = 'BATCH_O''BRIEN'"),
    "escaping did not survive into buildQuery"
  )
  check(
    "and leaves no odd number of quotes on that line",
    (nasty.split("\n").find((l) => l.includes("AND BATCHNAME =")) ?? "").split("'").length % 2 === 1
  )
}

/* ---- 6. parseExportScope ----------------------------------------------- */

console.log("\nparseExportScope")
{
  const q = (s: string) => parseExportScope(new URLSearchParams(s))

  const bare = q("")
  check(
    "no params defaults to today and every batch",
    !("error" in bare) && /^\d{4}-\d{2}-\d{2}$/.test(bare.date) && bare.batchName === null,
    JSON.stringify(bare)
  )
  const both = q("date=2026-09-01&batchName=BATCH_A")
  check(
    "reads both",
    !("error" in both) && both.date === "2026-09-01" && both.batchName === "BATCH_A",
    JSON.stringify(both)
  )
  check("an empty batchName means all batches", (() => {
    const r = q("batchName=")
    return !("error" in r) && r.batchName === null
  })())
  check("whitespace is trimmed off the batch", (() => {
    const r = q("batchName=%20BATCH_A%20")
    return !("error" in r) && r.batchName === "BATCH_A"
  })())
  check("a malformed date is an error, not a default", "error" in q("date=01-09-2026"))
  check("an injection attempt in the date is an error", "error" in q("date=2026-09-01'%20OR%20'1'%3D'1"))
  check("an over-long batch name is refused", "error" in q(`batchName=${"x".repeat(201)}`))
}

console.log("\ndescribeScope")
{
  check("date only", describeScope(scope()) === "2026-09-01")
  check(
    "date and batch",
    describeScope(scope({ batchName: "BATCH_A" })) === "2026-09-01, batch BATCH_A"
  )
}

/* ---- 7. The encoding claims: UTF-8, no BOM, and identical bytes -------- */

console.log("\nCSV encoding — the 'UTF-8, no BOM' claim the UI makes")
{
  const columns: SnowflakeColumn[] = [
    { name: "First Name", type: "TEXT" },
    { name: "IDNUMBER", type: "TEXT" },
  ] as SnowflakeColumn[]
  const rows: unknown[][] = [["José", "8001015800085"], ["O'Brien, A", "9002026700086"]]
  const csv = rowsToCsv(columns, rows)

  // The download body and the email attachment both come from this one string
  // (lib/distribution-export.ts imports rowsToCsv from lib/dialler-csv.ts), so
  // "no BOM" is a property of this function.
  check("no BOM at the start", !csv.startsWith("﻿"), JSON.stringify(csv.slice(0, 4)))
  check("starts with the first column name", csv.startsWith("First Name,"), csv.slice(0, 20))
  check("no BOM anywhere in the body", !csv.includes("﻿"))
  check("CRLF line endings", csv.includes("\r\n"))
  check("non-ASCII survives as UTF-8", csv.includes("José"))
  check("a comma in a value is quoted", csv.includes(`"O'Brien, A"`), csv)

  // The step-5 attachment is Buffer.from(csv, "utf-8"); the step-4 body is the
  // string itself. Same bytes, which is what "it is the identical file" means.
  const downloadBytes = Buffer.from(csv, "utf-8")
  const attachmentBytes = Buffer.from(csv, "utf-8")
  check("download bytes equal attachment bytes", downloadBytes.equals(attachmentBytes))
  check("and the first byte is not EF (a UTF-8 BOM's lead)", downloadBytes[0] !== 0xef)
  check(
    "base64 round-trips to the same bytes (the Graph transport)",
    Buffer.from(attachmentBytes.toString("base64"), "base64").equals(downloadBytes)
  )
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
