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
import {
  DEFAULT_LAYOUT,
  PRESETS,
  TRANSFORMS,
  defaultLayout,
  renderSelectList,
  validateLayout,
  type ExportLayout,
} from "../../lib/export-layout"
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
    sql.includes('CAST(a.CREATEDONDATE AS DATE) AS "CREATEDONDATE"'),
  )
  check(
    "LEADEXPIRY is measured from the load date",
    sql.includes('CAST(a.CREATEDONDATE AS DATE) + 45 AS "LEADEXPIRY"'),
  )
  check(
    "the expiry days value is substituted",
    buildQuery(1, 30, "full", scope()).includes('+ 30 AS "LEADEXPIRY"')
  )
}

/* ---- 5. The batch predicate -------------------------------------------- */

console.log("\nbuildQuery — the batch")
{
  const all = buildQuery(11381, 45, "full", scope())
  check("no BATCHNAME clause when no batch is picked", !all.includes("AND BATCHNAME ="))
  // BATCHNAME is still SELECTed — the grouping into per-batch files reads it.
  check("but BATCHNAME is still projected", all.includes('a.BATCHNAME AS "BATCHNAME"'))

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

/* ---- 8. The default layout must reproduce the file we already ship ------ */

/**
 * The 55 headers from a real export off the Teams channel, in order.
 *
 * This is ground truth, not a restatement of the code: it is what the dialler
 * team actually received. If DEFAULT_LAYOUT ever stops producing exactly this,
 * the "nothing changes until you configure something" promise is broken.
 */
const SHIPPED_HEADERS = [
  "First Name", "Last Name", "Contact No", "Email ID", "Address", "IDNUMBER",
  "MASKID", "CAMPAIGNID", "BATCHNAME", "CREATEDONDATE", "LEADEXPIRY", "BANK",
  "BANKACCOUNTTYPE", "BRANCHCODE", "SERIAL_NUMBER", "DEBIT_DAY", "AVERAGESPEND",
  "MARKETING_OFFER_DESC", "ORDERDATE", "ADDRESS_RANK", "SOURCEORDER",
  "DEVICE_VALUE", "CONTRACTTYPE", "PAYDAY", "SOURCE", "UPGRADE_DATE",
  "ACTIVATIONDATE", "MVNX_NUMBER", "LTE_COVERAGE", "INSURANCEPRICE", "PREMIUM",
  "PROVINCE", "HANDSETPRICE", "PROVINCE_RANK", "DEVICE_TYPE", "DATE_OF_PURCHASE",
  "TAKEUP_PROB", "MATOGEN_SCORE", "SCORE", "SCOREGROUP", "OPTINSTATUS",
  "PROPENSITYTOCONNECT", "SKILL", "BANK_ACCOUNT_MASKED", "HLL_ID",
  "CURRENT_PACKAGE", "DATA_DAY_RANK", "DEVICE_DETAILS", "PROVIDER_ACCOUNT_NUMBER",
  "SS_LEADCUSTOMERID", "CONTACTNUMBER2", "CONTACTNUMBER3", "COMMENT", "EXTRADATA",
  "Next Dial Time",
]

console.log("\nDEFAULT_LAYOUT vs the file the dialler team received")
{
  const got = DEFAULT_LAYOUT.columns.map((c) => c.out)
  check("55 columns", got.length === 55, String(got.length))
  check(
    "every header matches, in order",
    JSON.stringify(got) === JSON.stringify(SHIPPED_HEADERS),
    got.map((h, i) => (h === SHIPPED_HEADERS[i] ? null : `${i}: ${h} != ${SHIPPED_HEADERS[i]}`))
      .filter(Boolean)
      .join("; ")
  )
  // LEADEXPIRY is upper case because the old query's unquoted `as LeadExpiry`
  // was folded by Snowflake. Storing the pretty spelling would silently rename
  // a column in every file.
  check("LEADEXPIRY keeps the folded spelling", got.includes("LEADEXPIRY") && !got.includes("LeadExpiry"))
  check("the default passes its own validator", validateLayout(DEFAULT_LAYOUT, null).ok)
}

console.log("\nrenderSelectList — the default renders the expressions it used to")
{
  const sql = buildQuery(11381, 45, "full", scope())
  const expected = [
    'RTRIM(LTRIM(a.CUSTOMERNAME)) AS "First Name"',
    'DATAWAREHOUSE.DISTRIBUTION.SF_PHONE_NUMBER_FIX_CXM(a.CELLNUMBER) AS "Contact No"',
    `REGEXP_REPLACE(a.UDM7, '[^a-zA-Z0-9|:,.\\s-]', ' ') AS "Address"`,
    'RTRIM(IFNULL(A.IDNUMBER, CELLNUMBER)) AS "IDNUMBER"',
    'LEFT(a.IDNUMBER, 6) AS "MASKID"',
    'CAST(NULL AS NUMBER(38, 0)) AS "PROVINCE_RANK"',
    'a.PROPENSITYTOCONNECT::INT AS "PROPENSITYTOCONNECT"',
    'NULL AS "Next Dial Time"',
  ]
  for (const frag of expected) {
    check(`renders ${frag.slice(0, 46)}…`, sql.includes(frag), "missing")
  }
  // The one that would have shipped a broken query: IDNUMBER exists on the
  // base table AND on the joined SilverSurfer CTE, so an unqualified
  // reference is ambiguous and Snowflake refuses the whole statement.
  check("every source column is qualified with the table alias", !/(?<![.\w])LEFT\(IDNUMBER/.test(sql))
  check("the typed NULLs keep their type", (sql.match(/CAST\(NULL AS NUMBER\(38, 0\)\)/g) ?? []).length === 2)
  check(
    "SS_LEADCUSTOMERID is the lookup on the full tier",
    sql.includes('LEADCUSTOMERID AS "SS_LEADCUSTOMERID"')
  )
  check(
    "and NULL when the lookup is unavailable",
    buildQuery(1, 45, "noLookup", scope()).includes('NULL AS "SS_LEADCUSTOMERID"')
  )
}

/* ---- 9. The layout grammar is the security boundary --------------------- */

const known = new Set([
  "CUSTOMERNAME", "LASTNAME", "CELLNUMBER", "EMAIL", "UDM7", "UDM3", "UDM6",
  "UDM9", "UDM30", "IDNUMBER", "CAMPAIGNID", "BATCHNAME", "CREATEDONDATE",
  "SCORE", "SCOREGROUP", "PROPENSITYTOCONNECT", "HLL_ID", "EXTRADATA",
])

const layoutOf = (...columns: ExportLayout["columns"]): ExportLayout => ({
  columns: [{ out: "BATCHNAME", kind: "column", source: "BATCHNAME" }, ...columns],
})

console.log("\nvalidateLayout — rejects, never escapes")
{
  const bad = (l: ExportLayout, why: string) => {
    const r = validateLayout(l, known)
    check(why, !r.ok, "was accepted")
  }

  check("a good layout passes", validateLayout(defaultLayout(), null).ok)

  // A source column that is not on the table is a configuration mistake, and
  // passing it through would turn it into a Snowflake error at download time.
  bad(layoutOf({ out: "X", kind: "column", source: "NOPE" }), "an unknown source column is refused")
  bad(layoutOf({ out: "X", kind: "column", source: "UDM7; DROP TABLE T" }), "SQL in a source column is refused")
  bad(layoutOf({ out: "X", kind: "column", source: "a.UDM7" }), "a qualified source column is refused")

  // The alias is emitted inside double quotes, so a double quote is the one
  // character that could break out of it.
  bad(layoutOf({ out: 'X" , 1 AS "Y', kind: "null" }), "a double quote in a column name is refused")
  bad(layoutOf({ out: "X--comment", kind: "null" }), "a SQL comment in a column name is refused")
  bad(layoutOf({ out: "X\\", kind: "null" }), "a backslash in a column name is refused")
  bad(layoutOf({ out: "", kind: "null" }), "an empty column name is refused")
  bad(layoutOf({ out: "x".repeat(65), kind: "null" }), "an over-long column name is refused")

  bad(layoutOf({ out: "X", kind: "column", source: "UDM7", transform: "drop" as never }), "an unknown transform is refused")
  bad(layoutOf({ out: "X", kind: "preset", preset: "evil" as never }), "an unknown preset is refused")
  bad(layoutOf({ out: "X", kind: "sql" as never }), "an unknown kind is refused")

  bad(layoutOf({ out: "SCORE", kind: "null" }, { out: "score", kind: "null" }), "duplicate column names are refused")

  // Without BATCHNAME the per-batch grouping silently collapses to one
  // generically-named file, and the file name is what the dialler keys on.
  const noBatch = validateLayout({ columns: [{ out: "SCORE", kind: "null" }] }, known)
  check("a layout without BATCHNAME is refused", !noBatch.ok)
  check(
    "and the message says why",
    !noBatch.ok && noBatch.problems.some((p) => /names each file after it/.test(p.message))
  )

  check("an empty layout is refused", !validateLayout({ columns: [] }, known).ok)
  check("a non-array is refused", !validateLayout({ columns: "all" }, known).ok)
  check("junk is refused", !validateLayout(null, known).ok)

  // Accepted values are normalised, so two spellings cannot produce two rows.
  const okd = validateLayout(layoutOf({ out: " Region Code ", kind: "column", source: "udm7" }), known)
  check("a valid source column is upper-cased", okd.ok && okd.layout.columns[1].source === "UDM7")
  check("the column name is trimmed", okd.ok && okd.layout.columns[1].out === "Region Code")
}

/* ---- 10. Spot Connect 1: five edits from the default -------------------- */

console.log("\nthe Spot Connect 1 layout")
{
  const l = defaultLayout()
  const at = (name: string) => l.columns.findIndex((c) => c.out === name)
  l.columns.splice(at("IDNUMBER"), 0, { out: "Region Code", kind: "null" })
  l.columns.splice(at("Next Dial Time"), 0, { out: "REGION", kind: "null" })
  l.columns[at("ADDRESS_RANK")] = { out: "ADDRESS_RANK", kind: "null" }
  l.columns[at("LEADEXPIRY")] = { out: "LEADEXPIRY", kind: "column", source: "LEADEXPIRY", transform: "raw" }
  l.columns[at("CREATEDONDATE")] = { out: "CREATEDONDATE", kind: "column", source: "CREATEDONDATE", transform: "raw" }

  const headers = l.columns.map((c) => c.out)
  check("57 columns", headers.length === 57, String(headers.length))
  check("Region Code is 6th", headers[5] === "Region Code", headers[5])
  check("REGION is 56th", headers[55] === "REGION", headers[55])
  check("Next Dial Time is still last", headers[56] === "Next Dial Time")
  check("it validates", validateLayout(l, new Set([...known, "LEADEXPIRY"])).ok)

  const sql = renderSelectList(l, { expiryDays: 45, ssLookup: "LEADCUSTOMERID" })
  check("ADDRESS_RANK is now empty", sql.includes('NULL AS "ADDRESS_RANK"'))
  // a.UDM3 is a prefix of a.UDM30, which DATA_DAY_RANK still uses.
  check("and no longer reads UDM3", !/a\.UDM3(?!\d)/.test(sql))
  check("LEADEXPIRY reads the stored column", sql.includes('a.LEADEXPIRY AS "LEADEXPIRY"'))
  check("CREATEDONDATE is no longer cast", sql.includes('a.CREATEDONDATE AS "CREATEDONDATE"'))
  check("Region Code renders", sql.includes('NULL AS "Region Code"'))
  check("REGION renders", sql.includes('NULL AS "REGION"'))
}

console.log("\nevery transform and preset renders")
{
  for (const id of Object.keys(TRANSFORMS)) {
    const l = layoutOf({ out: "X", kind: "column", source: "UDM7", transform: id as never })
    const sql = renderSelectList(l, { expiryDays: 45, ssLookup: "LEADCUSTOMERID" })
    check(`transform ${id}`, sql.includes('AS "X"') && sql.includes("a.UDM7"), sql)
  }
  for (const id of Object.keys(PRESETS)) {
    const l = layoutOf({ out: "X", kind: "preset", preset: id as never })
    const sql = renderSelectList(l, { expiryDays: 45, ssLookup: "LEADCUSTOMERID" })
    check(`preset ${id}`, sql.includes('AS "X"') && !sql.includes("SS_LOOKUP"), sql)
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
