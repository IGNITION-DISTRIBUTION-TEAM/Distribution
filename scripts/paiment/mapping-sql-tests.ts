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
  const nasty = "X'); DELETE FROM BI.BI_BILLING_PRODUCTGROUPS; --"
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
  check("the duplicate check groups on the join key", buildDuplicateCheck().includes("HAVING COUNT(*) > 1"))
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
