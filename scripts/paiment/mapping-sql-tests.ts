/**
 * Offline tests for the billing product mapping SQL.
 *
 *   npx tsx scripts/paiment/mapping-sql-tests.ts
 *
 * No warehouse, no writes. Every case here guards something that fails
 * SILENTLY in production — none of these would raise an error, they would just
 * report the wrong revenue against the wrong brand.
 */
import {
  PRODUCT_MAPPING,
  buildAuditInsert,
  buildDelete,
  buildDriftCheck,
  buildDuplicateCheck,
  buildGetOne,
  buildImportMerge,
  buildSearch,
  buildUpsert,
  looksAmbiguous,
  normProductName,
  normValue,
  validateMapping,
  type ProductMapping,
} from "../../lib/billing-mappings"
import { lit, litOrNull } from "../../lib/sql-literal"
import { pageInfo } from "../../lib/pagination"

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`)
  }
}

const row = (over: Partial<ProductMapping> = {}): ProductMapping => ({
  productName: "DSTV Explora Ultra Standalone @ R299 PM x24 Months",
  productGroup: "DSTV",
  vasButtonFlag: "0",
  channelOverride: "DISTRIBUTION",
  brandOverride: "ONAIR",
  ...over,
})

console.log("lit / litOrNull — the blank-override trap")
{
  check("a quote is doubled", lit("Bob's Deal") === "'Bob''s Deal'")
  check("null becomes the NULL keyword, not the string", lit(null) === "NULL")
  // THE ONE THAT MATTERS. The full-history view reads these through
  // coalesce(pg.brand_override, cc.brand). '' is not null, so coalesce returns
  // it and the brand comes out BLANK instead of falling back to the campaign.
  check("an empty override becomes NULL, not ''", litOrNull("") === "NULL")
  check("a whitespace-only override becomes NULL", litOrNull("   ") === "NULL")
  check("a real override is quoted", litOrNull(" ONAIR ") === "'ONAIR'")
}

console.log("\nnormProductName — the join is exact, so whitespace is data")
{
  // The workbook really contains this: two spaces before "(1Click)". trim()
  // does not touch internal whitespace, so the row silently maps nothing.
  check(
    "an internal double space is collapsed",
    normProductName("DSTV Streama + Showmax for 12 Months @ R179 PM x24 Months  (1Click)") ===
      "DSTV Streama + Showmax for 12 Months @ R179 PM x24 Months (1Click)"
  )
  check("outer whitespace is trimmed", normProductName("  A B  ") === "A B")
  check("a tab counts as whitespace", normProductName("A\tB") === "A B")
  check("a normal name is untouched", normProductName("DSTV Streama @ R189 PM x24 Months") === "DSTV Streama @ R189 PM x24 Months")
}

console.log("\nvalidateMapping — reject only what must be rejected")
{
  check("a good row passes", validateMapping(row()) === null)
  check("an empty name is rejected", validateMapping(row({ productName: "  " })) !== null)
  check(
    "an over-long name is rejected",
    validateMapping(row({ productName: "x".repeat(501) })) !== null
  )
  // Product names legitimately contain these. Stripping them to make escaping
  // easier would break the exact-match join this whole feature depends on.
  const punct = "10GB uConnect R350 + Free Airtime @ R349, Monthly & Capped"
  check("@ + , and & all survive validation", validateMapping(row({ productName: punct })) === null)
  check(
    "a control character is rejected",
    validateMapping(row({ productName: `A${String.fromCharCode(7)}B` })) !== null
  )
  check(
    "a control character in an override is rejected",
    validateMapping(row({ brandOverride: `ON${String.fromCharCode(0)}AIR` })) !== null
  )
}

console.log("\nlooksAmbiguous — identical on screen, different to the join")
{
  check("a plain name is fine", looksAmbiguous("DSTV Streama @ R189") === null)
  check(
    "a non-breaking space is flagged",
    looksAmbiguous(`DSTV${String.fromCharCode(0xa0)}Streama`) !== null
  )
  check(
    "a zero-width space is flagged",
    looksAmbiguous(`DSTV${String.fromCharCode(0x200b)}Streama`) !== null
  )
}

console.log("\nnormValue")
{
  check("blank becomes null", normValue("  ") === null)
  check("undefined becomes null", normValue(undefined) === null)
  check("a value is trimmed", normValue("  ONAIR ") === "ONAIR")
}

console.log("\nbuildUpsert — matched the way the billing join matches")
{
  const sql = buildUpsert(row())
  check("is a MERGE, not an INSERT", /^MERGE INTO/.test(sql), sql.slice(0, 40))
  // Looser matching would let two rows satisfy the full-history join, and a
  // duplicate there DOUBLES that product's billing rows.
  check(
    "matches on TRIM(UPPER(name)), the same expression the view joins on",
    sql.includes(`ON TRIM(UPPER(t.${PRODUCT_MAPPING.cols.name})) = TRIM(UPPER(s.N))`),
    sql
  )
  check("updates when matched", sql.includes("WHEN MATCHED THEN UPDATE SET"))
  check("inserts when not matched", sql.includes("WHEN NOT MATCHED THEN INSERT"))
  check("writes to the table, never the view", sql.includes(PRODUCT_MAPPING.table) && !sql.includes(PRODUCT_MAPPING.view))
}
{
  // Clearing an override must restore campaign-based attribution.
  const sql = buildUpsert(row({ channelOverride: "", brandOverride: null }))
  check(
    "a cleared override writes NULL so coalesce falls back to the campaign",
    sql.includes(`${PRODUCT_MAPPING.cols.channelOverride} = NULL`) &&
      sql.includes(`${PRODUCT_MAPPING.cols.brandOverride} = NULL`),
    sql
  )
}
{
  const sql = buildUpsert(row({ productName: "Bob's 10GB @ R349, Capped" }))
  check("a quote in the product name is doubled", sql.includes("Bob''s 10GB @ R349, Capped"), sql)
  check("quotes stay balanced", (sql.match(/'/g) || []).length % 2 === 0)
}
{
  // A SQL-injection shaped name is data, not code — it must be escaped, not
  // rejected, because we cannot know a product will never look like this.
  const nasty = "X'); DELETE FROM BI.BILLINGDATA_PRODUCTGROUPS; --"
  const sql = buildUpsert(row({ productName: nasty }))
  check("an injection-shaped name is escaped, not executed", sql.includes("X''); DELETE"), sql.slice(0, 160))
  // The semicolons are INSIDE the quoted literal, so counting them in the raw
  // string proves nothing. Strip every literal first; what is left is the SQL
  // the parser actually sees, and it must contain no statement separator and
  // no second verb.
  const skeleton = sql.replace(/'(?:[^']|'')*'/g, "''")
  check("no semicolon survives outside a string literal", !skeleton.includes(";"), skeleton)
  check("no second verb survives outside a string literal", !/\bDELETE\b/i.test(skeleton), skeleton)
}

console.log("\nbuildImportMerge — adds and updates, never deletes")
{
  const sql = buildImportMerge([row(), row({ productName: "DSTV Streama @ R189 PM x24 Months" })])
  check("is one statement for the whole file", sql.split(";").length === 1)
  check("has a UNION ALL per extra row", (sql.match(/UNION ALL/g) || []).length === 1)
  // A filtered export uploaded by mistake must not wipe everything absent
  // from it. An import is additive, always.
  check("has no DELETE clause", !/DELETE/i.test(sql), sql)
  check("has no WHEN NOT MATCHED BY SOURCE", !/NOT MATCHED BY SOURCE/i.test(sql))
  check("matches on TRIM(UPPER(...))", sql.includes("TRIM(UPPER(s.N))"))
}
{
  const sql = buildImportMerge([row({ productName: "  A   B  ", brandOverride: "" })])
  check("import normalises the name", sql.includes("'A B'"), sql)
  check("import writes a blank override as NULL", sql.includes("NULL AS BR"), sql)
}

console.log("\nreads")
{
  check("search with no term has no WHERE", !buildSearch("", 100, 0).includes("WHERE"))
  const sql = buildSearch("ONAIR", 50, 100)
  check("search covers the overrides, which is what people look for", sql.includes(PRODUCT_MAPPING.cols.brandOverride))
  check("search paginates", sql.includes("LIMIT 50 OFFSET 100"))
  check("search escapes the term", buildSearch("O'Brien", 10, 0).includes("O''Brien"))
  check("getOne matches like the join does", buildGetOne(" x ").includes("TRIM(UPPER("))
  check("delete targets the table", buildDelete("A").startsWith(`DELETE FROM ${PRODUCT_MAPPING.table}`))
  const dup = buildDuplicateCheck()
  check("the duplicate check groups on the join key", dup.includes("HAVING COUNT(*) > 1"))
  // It runs on EVERY page load and the live table has hundreds of duplicated
  // names — returning all of them to render a count was most of the cost of
  // opening the screen.
  check("it returns only a handful of examples", /LIMIT \d+$/.test(dup.trim()), dup)
  check("but still reports the true totals, from the same scan",
    dup.includes("COUNT(*) OVER ()") && dup.includes("SUM(ROWS_FOUND) OVER ()"), dup)
  check("only one GROUP BY — the totals do not cost a second pass",
    (dup.match(/GROUP BY/g) || []).length === 1, dup)
  // The split that decides what needs a person: exact copies collapse safely,
  // disagreements do not.
  check("it counts how many duplicates actually disagree",
    dup.includes("SUM(IFF(DISTINCT_SHAPES > 1, 1, 0)) OVER ()"), dup)
  check("shape is the four mapped columns together",
    dup.includes("COUNT(DISTINCT IFNULL("), dup)
  // NULL || anything is NULL, which would collapse every partly-empty row into
  // one shape and hide real disagreements.
  check("nulls become a sentinel so concatenation cannot swallow a difference",
    (dup.match(/IFNULL\(/g) || []).length >= 4, dup)
  check("conflicts sort first, so the examples are the ones needing a decision",
    dup.includes("ORDER BY DISTINCT_SHAPES DESC, ROWS_FOUND DESC"), dup)
}

console.log("\naudit and drift")
{
  const sql = buildAuditInsert("update", "A B", row(), row({ brandOverride: "VIVA" }), "me@x.com")
  check("records who changed it", sql.includes("'me@x.com'"))
  check("records both sides", sql.includes("BEFORE_JSON") && sql.includes("AFTER_JSON"))
  check("stores the full row so it can be replayed", sql.includes("channelOverride"))
  const created = buildAuditInsert("create", "A", null, row(), "me@x.com")
  check("a create has a null before", created.includes("NULL, '{"), created.slice(0, 200))
}
{
  const sql = buildDriftCheck()
  check("compares the audit log against the live table", sql.includes(PRODUCT_MAPPING.table))
  check("takes only the latest entry per product", sql.includes("ROW_NUMBER() OVER"))
  // Without this a deleted mapping reports as drift forever, because the row
  // is supposed to be gone.
  check("ignores deletes", sql.includes("l.ACTION <> 'delete'"), sql)
  check("is read-only", !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql.replace(/'delete'/g, "")))
}

console.log("\npageInfo — the pager boundaries")
{
  // The everyday case.
  const p = pageInfo(3412, 50, 100)
  check("page number is 1-based", p.page === 3, JSON.stringify(p))
  check("range reads 101-150", p.from === 101 && p.to === 150, JSON.stringify(p))
  check("both directions available mid-list", p.canPrev && p.canNext)
  check("last offset lands on the final page", p.lastOffset === 3400, JSON.stringify(p))
}
{
  // AN EXACT MULTIPLE. floor(100/50)+1 would say 3 pages; it is 2.
  const p = pageInfo(100, 50, 50)
  check("an exact multiple does not invent a trailing page", p.pages === 2, JSON.stringify(p))
  check("and the last page disables Next", !p.canNext && p.canPrev)
  check("the range ends exactly on the total", p.to === 100)
}
{
  // NO ROWS. "1-0 of 0" is the classic pager bug.
  const p = pageInfo(0, 50, 0)
  check("an empty result has no row 1", p.from === 0 && p.to === 0, JSON.stringify(p))
  check("still one page, so 'Page 1 of 0' cannot render", p.pages === 1 && p.page === 1)
  check("and neither direction is offered", !p.canPrev && !p.canNext)
}
{
  // A STALE OFFSET. Type in the search box while on page 8 and the result set
  // shrinks under you.
  const p = pageInfo(12, 50, 400)
  check("an offset past the end clamps to the last page", p.page === 1 && p.pages === 1, JSON.stringify(p))
  check("and reports the real range, not the stale one", p.from === 1 && p.to === 12)
  check("'Page 8 of 1' cannot happen", p.page <= p.pages)
}
{
  const p = pageInfo(3, 50, 0)
  check("a limit larger than the total is one page", p.pages === 1 && !p.canNext, JSON.stringify(p))
  check("and the range stops at the total", p.to === 3)
}
{
  // A caller passing 0 would divide by zero and report Infinity pages.
  const p = pageInfo(10, 0, 0)
  check("a zero limit is floored rather than trusted", Number.isFinite(p.pages) && p.pages === 10, JSON.stringify(p))
}
{
  const p = pageInfo(3412, 50, 3400)
  check("the last page is partial and knows it", p.from === 3401 && p.to === 3412, JSON.stringify(p))
  check("Next is disabled there", !p.canNext)
  check("Previous still works", p.canPrev && p.prevOffset === 3350)
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
