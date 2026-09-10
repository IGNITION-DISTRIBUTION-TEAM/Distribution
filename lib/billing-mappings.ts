/**
 * The billing product mapping — the thing that decides a deal's channel and
 * brand in executive reporting.
 *
 * PURE SQL BUILDERS, NO I/O. The routes execute; this module only says what to
 * execute, so the statements are testable from literals
 * (scripts/paiment/mapping-sql-tests.ts). Modelled on lib/calendar-store.ts.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS FEEDS, AND WHY IT MATTERS
 *
 * DATAWAREHOUSE.BI_SANCTION.VW_BI_SANCTION_BILLINGDATA_FULL_HISTORY resolves
 * channel and brand as:
 *
 *     , coalesce(pg.brand_override,   cc.brand)   as brand
 *     , coalesce(pg.channel_override, cc.channel) as channel
 *     ...
 *     LEFT JOIN ...VW_BI_BILLING_PRODUCTGROUPS PG
 *            ON trim(upper(PG.PRODUCT)) = trim(upper(fs.PRODUCTNAME))
 *
 * Historically channel and brand came from the CAMPAIGN. One campaign can carry
 * products belonging to different channels, so the attribution was wrong. The
 * override columns let a PRODUCT decide instead, and the business now maintains
 * them here rather than raising a ticket with Data Engineering.
 *
 * Two consequences follow from that join, and both are load bearing:
 *
 * 1. A BLANK OVERRIDE MUST BE NULL, NEVER ''. coalesce returns '' happily — it
 *    is not null — so an override written as an empty string does not fall back
 *    to the campaign classification, it reports the brand as blank. Every write
 *    below goes through litOrNull for exactly this reason.
 *
 * 2. TWO ROWS FOR ONE PRODUCT NAME FAN OUT THE FACT TABLE. It is a LEFT JOIN
 *    from billing rows to this mapping, so a duplicate does not merely confuse —
 *    it DOUBLES those billing rows in the full-history table, inflating reported
 *    revenue. Uniqueness is enforced here on trim(upper(name)), matching the
 *    join, because the BI table has no constraint that would stop it.
 *
 * -----------------------------------------------------------------------------
 * THE JOIN IS EXACT, SO WHITESPACE IS DATA
 *
 * `trim(upper())` normalises case and OUTER whitespace and nothing else. An
 * internal double space does not match. The workbook this was seeded from
 * contains exactly that — "DSTV Streama + Showmax for 12 Months @ R179 PM x24
 * Months  (1Click)", two spaces before "(1Click)" — and that row silently maps
 * nothing.
 *
 * So `normProductName` collapses internal runs of whitespace on the way IN, and
 * `looksAmbiguous` flags a name that would still not join. What it deliberately
 * does NOT do is strip punctuation: product names legitimately contain @, +, ,
 * and &, and removing those to make escaping easier would break the exact match
 * this whole mechanism depends on. Escape, never strip.
 */
import { lit, litOrNull } from "@/lib/sql-literal"

/**
 * WHERE THE MAPPING ACTUALLY LIVES.
 *
 * The app writes to the BI table itself rather than keeping its own copy. That
 * was a deliberate choice; the risk it carries is that a file-driven reload of
 * this table would destroy business edits with no error, which is what the
 * audit table below exists to make detectable.
 *
 * VW_BI_BILLING_PRODUCTGROUPS is a VIEW and cannot be written to, so `table` is
 * the one underneath it. The name is NOT derivable from the view's — the view
 * is VW_BI_BILLING_PRODUCTGROUPS, the table is BILLINGDATA_PRODUCTGROUPS — and
 * it was confirmed against the warehouse rather than inferred. If BI ever
 * renames it, scripts/paiment/00-resolve-and-diagnose.sql section 1 resolves
 * the real one from GET_DDL and this block is the only place to change.
 *
 * THE COLUMN NAMES ARE STILL INFERRED, from the mapping workbook's own headers
 * (PRODUCTNAME, PRODUCT_GROUP, VAS_BUTTON_FLAG, channel_override,
 * brand_override — Snowflake folds the unquoted ones to upper case). That fits
 * the view exposing the name column as PRODUCT, which means the view aliases
 * it. Section 1c of the same script lists the real ones; a mismatch is the same
 * one-place change, and the API turns the resulting error into a message naming
 * this constant rather than a raw Snowflake fault.
 */
export const PRODUCT_MAPPING = {
  table: "DATAWAREHOUSE.BI.BILLINGDATA_PRODUCTGROUPS",
  /** The view the full-history query joins to. Read-only; used for drift checks. */
  view: "DATAWAREHOUSE.BI.VW_BI_BILLING_PRODUCTGROUPS",
  cols: {
    name: "PRODUCTNAME",
    group: "PRODUCT_GROUP",
    vasFlag: "VAS_BUTTON_FLAG",
    channelOverride: "CHANNEL_OVERRIDE",
    brandOverride: "BRAND_OVERRIDE",
  },
} as const

export const SF_OPTS = { database: "DATAWAREHOUSE", schema: "BI" } as const

/**
 * The audit log — in the APP's schema, not BI, and that is the point.
 *
 * If a file load ever overwrites the BI table, it cannot touch this. So "our
 * edits vanished" becomes provable rather than an argument, and because the log
 * holds the full intended state per product it is also replayable.
 */
export const AUDIT_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.TSK_BILLING_MAPPING_AUDIT"
export const AUDIT_SF_OPTS = { database: "DATAWAREHOUSE", schema: "LEADS_DISTRIBUTION" } as const

export type MappingAction =
  | "create"
  | "update"
  | "delete"
  | "import"
  /** Bulk removal of identical duplicate rows. */
  | "collapse"
  /** One conflicted product: a winning row chosen, the rest discarded. */
  | "resolve"

export type ProductMapping = {
  productName: string
  productGroup: string | null
  vasButtonFlag: string | null
  channelOverride: string | null
  brandOverride: string | null
}

/** Longest value we will store. The BI columns are wide; this is a sanity cap. */
export const MAX_VALUE_LEN = 500
/** One import must not be able to rewrite the whole mapping by accident. */
export const MAX_IMPORT_ROWS = 2000

/**
 * Trim, and collapse internal whitespace runs to a single space.
 *
 * The collapse is the part that matters — see the header. It changes the stored
 * name, so it is applied on the way in and reported in the import preview
 * rather than done silently at query time.
 */
export function normProductName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim()
}

/** Trim only. Overrides are matched by humans, not by a join. */
export function normValue(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\s+/g, " ").trim()
  return s === "" ? null : s
}

/**
 * Reasons a row cannot be stored, or null when it is fine.
 *
 * Rejects only what must be rejected — empty, over-length, and control
 * characters, which cannot survive a round trip through a CSV export anyway.
 * Everything else is escaped on the way out.
 */
export function validateMapping(row: ProductMapping): string | null {
  const name = normProductName(row.productName ?? "")
  if (!name) return "Product name is required"
  if (name.length > MAX_VALUE_LEN) return `Product name is longer than ${MAX_VALUE_LEN} characters`
  if (/[\u0000-\u001f\u007f]/.test(name)) return "Product name contains control characters"

  for (const [label, value] of [
    ["Product group", row.productGroup],
    ["VAS flag", row.vasButtonFlag],
    ["Channel override", row.channelOverride],
    ["Brand override", row.brandOverride],
  ] as const) {
    const v = normValue(value)
    if (v && v.length > MAX_VALUE_LEN) return `${label} is longer than ${MAX_VALUE_LEN} characters`
    if (v && /[\u0000-\u001f\u007f]/.test(v)) return `${label} contains control characters`
  }
  return null
}

/**
 * Would this name fail the full-history join even after normalising?
 *
 * Only leading/trailing whitespace and internal runs are fixable here. A
 * non-breaking space looks identical on screen and is a different character to
 * `upper()`, so it is reported rather than silently rewritten — the mapping and
 * the transaction both have to carry the same one, and we only control this
 * side.
 */
export function looksAmbiguous(name: string): string | null {
  if (/\u00a0/.test(name)) return "contains a non-breaking space"
  if (/[\u200b-\u200d\ufeff]/.test(name)) return "contains an invisible character"
  return null
}

/** The SELECT list, aliased to stable names the API returns. */
function selectList(): string {
  const c = PRODUCT_MAPPING.cols
  return [
    `${c.name} AS PRODUCT_NAME`,
    `${c.group} AS PRODUCT_GROUP`,
    `${c.vasFlag} AS VAS_BUTTON_FLAG`,
    `${c.channelOverride} AS CHANNEL_OVERRIDE`,
    `${c.brandOverride} AS BRAND_OVERRIDE`,
  ].join(", ")
}

/**
 * A page of mappings, optionally filtered.
 *
 * `search` matches the name, the group and both overrides, so "ONAIR" finds
 * every row already overridden — which is the question people actually ask of
 * this screen. `limit` and `offset` are numbers the caller has already
 * validated as integers.
 */
export function buildSearch(search: string, limit: number, offset: number): string {
  const c = PRODUCT_MAPPING.cols
  const q = normValue(search)
  const where = q
    ? `\n WHERE UPPER(${c.name}) LIKE UPPER(${lit(`%${q}%`)})
    OR UPPER(IFNULL(${c.group}, '')) LIKE UPPER(${lit(`%${q}%`)})
    OR UPPER(IFNULL(${c.channelOverride}, '')) LIKE UPPER(${lit(`%${q}%`)})
    OR UPPER(IFNULL(${c.brandOverride}, '')) LIKE UPPER(${lit(`%${q}%`)})`
    : ""
  return (
    `SELECT ${selectList()}\n  FROM ${PRODUCT_MAPPING.table}${where}\n` +
    ` ORDER BY ${c.name}\n LIMIT ${limit} OFFSET ${offset}`
  )
}

/** Total rows matching the same filter, for the pager. */
export function buildCount(search: string): string {
  const c = PRODUCT_MAPPING.cols
  const q = normValue(search)
  const where = q
    ? `\n WHERE UPPER(${c.name}) LIKE UPPER(${lit(`%${q}%`)})
    OR UPPER(IFNULL(${c.group}, '')) LIKE UPPER(${lit(`%${q}%`)})
    OR UPPER(IFNULL(${c.channelOverride}, '')) LIKE UPPER(${lit(`%${q}%`)})
    OR UPPER(IFNULL(${c.brandOverride}, '')) LIKE UPPER(${lit(`%${q}%`)})`
    : ""
  return `SELECT COUNT(*) AS CNT FROM ${PRODUCT_MAPPING.table}${where}`
}

/** One row by exact name, matched the way the full-history join matches. */
export function buildGetOne(productName: string): string {
  const c = PRODUCT_MAPPING.cols
  const name = normProductName(productName)
  return (
    `SELECT ${selectList()}\n  FROM ${PRODUCT_MAPPING.table}\n` +
    ` WHERE TRIM(UPPER(${c.name})) = TRIM(UPPER(${lit(name)}))`
  )
}

/**
 * Insert or update one mapping.
 *
 * MERGE rather than INSERT, matched on `TRIM(UPPER(name))` — the same
 * expression the full-history view joins on. Matching any more loosely would
 * let two rows exist that both satisfy that join, and a duplicate here doubles
 * billing rows rather than merely confusing the screen.
 *
 * The overrides go through litOrNull, so clearing a field writes NULL and the
 * campaign classification takes over again. Writing '' would report a blank
 * brand instead — see the header.
 */
export function buildUpsert(row: ProductMapping): string {
  const c = PRODUCT_MAPPING.cols
  const name = normProductName(row.productName)
  return (
    `MERGE INTO ${PRODUCT_MAPPING.table} t\n` +
    `USING (SELECT ${lit(name)} AS N) s\n` +
    `   ON TRIM(UPPER(t.${c.name})) = TRIM(UPPER(s.N))\n` +
    ` WHEN MATCHED THEN UPDATE SET\n` +
    `        ${c.group} = ${litOrNull(row.productGroup)},\n` +
    `        ${c.vasFlag} = ${litOrNull(row.vasButtonFlag)},\n` +
    `        ${c.channelOverride} = ${litOrNull(row.channelOverride)},\n` +
    `        ${c.brandOverride} = ${litOrNull(row.brandOverride)}\n` +
    ` WHEN NOT MATCHED THEN INSERT\n` +
    `        (${c.name}, ${c.group}, ${c.vasFlag}, ${c.channelOverride}, ${c.brandOverride})\n` +
    ` VALUES (${lit(name)}, ${litOrNull(row.productGroup)}, ${litOrNull(row.vasButtonFlag)}, ` +
    `${litOrNull(row.channelOverride)}, ${litOrNull(row.brandOverride)})`
  )
}

/**
 * Many mappings in one statement, for a spreadsheet import.
 *
 * One MERGE rather than N round trips, and one transaction rather than a
 * half-applied import. Rows absent from the file are deliberately left ALONE —
 * an import adds and updates, it never deletes, because a partial export
 * uploaded by mistake would otherwise wipe the mapping and take reporting with
 * it.
 */
export function buildImportMerge(rows: ProductMapping[]): string {
  const c = PRODUCT_MAPPING.cols
  const values = rows
    .map(
      (r) =>
        `  SELECT ${lit(normProductName(r.productName))} AS N, ${litOrNull(r.productGroup)} AS G, ` +
        `${litOrNull(r.vasButtonFlag)} AS V, ${litOrNull(r.channelOverride)} AS CH, ` +
        `${litOrNull(r.brandOverride)} AS BR`
    )
    .join("\n  UNION ALL\n")
  return (
    `MERGE INTO ${PRODUCT_MAPPING.table} t\n` +
    `USING (\n${values}\n) s\n` +
    `   ON TRIM(UPPER(t.${c.name})) = TRIM(UPPER(s.N))\n` +
    ` WHEN MATCHED THEN UPDATE SET\n` +
    `        ${c.group} = s.G,\n        ${c.vasFlag} = s.V,\n` +
    `        ${c.channelOverride} = s.CH,\n        ${c.brandOverride} = s.BR\n` +
    ` WHEN NOT MATCHED THEN INSERT\n` +
    `        (${c.name}, ${c.group}, ${c.vasFlag}, ${c.channelOverride}, ${c.brandOverride})\n` +
    ` VALUES (s.N, s.G, s.V, s.CH, s.BR)`
  )
}

/** Remove one mapping. Matched exactly as the upsert matches. */
export function buildDelete(productName: string): string {
  const c = PRODUCT_MAPPING.cols
  return (
    `DELETE FROM ${PRODUCT_MAPPING.table}\n` +
    ` WHERE TRIM(UPPER(${c.name})) = TRIM(UPPER(${lit(normProductName(productName))}))`
  )
}

/** How many duplicated names the screen names before saying "and N more". */
export const DUPLICATE_EXAMPLES = 5

/**
 * Product names that appear more than once under the join's own comparison,
 * split by whether the duplicate rows AGREE with each other.
 *
 * Not a tidiness check. The billing fact table LEFT JOINs to this mapping on
 * the product name alone, so a surplus row does not merely confuse the screen —
 * it multiplies that product's billing rows. Not by one row: by one COPY of
 * every sale that product has ever had.
 *
 * THE SPLIT IS THE POINT, because the two halves need different things:
 *
 *   DISTINCT_SHAPES = 1   exact copies. A distinct view collapses them safely
 *                         and nobody has to decide anything.
 *   DISTINCT_SHAPES > 1   the rows disagree about group, VAS flag or an
 *                         override. Something has to PICK, and picking is a
 *                         business decision. These are the ones worth a
 *                         person's afternoon.
 *
 * TOP-N PLUS TOTALS, FROM ONE PASS. This runs on every page load and the live
 * table has hundreds of duplicated names — returning all of them to render a
 * count was most of the cost of opening the screen. The window functions run
 * over the already-grouped set, so the totals cost nothing extra:
 *
 *   DUPLICATE_KEYS     how many distinct names repeat
 *   DUPLICATE_ROWS     how many rows those names occupy in total
 *   CONFLICTING_KEYS   how many of them disagree
 *
 * DUPLICATE_ROWS - DUPLICATE_KEYS is the SURPLUS: the extra rows, and so the
 * multiplier the join is applying.
 *
 * CONFLICTS SORT FIRST, so the handful of examples the banner shows are names
 * somebody has to decide rather than whichever exact copies happened to sort
 * first. That is the difference between a banner that prompts an action and one
 * people learn to scroll past.
 */
export function buildDuplicateCheck(): string {
  const c = PRODUCT_MAPPING.cols
  // The four mapped columns as one string, so COUNT(DISTINCT) over it answers
  // "do these rows say the same thing?". IFNULL to a sentinel because
  // NULL || anything is NULL, which would collapse every partly-empty row into
  // one shape and hide real disagreements.
  const shape =
    `IFNULL(${c.group}, '~') || '|' || IFNULL(${c.vasFlag}, '~') || '|' || ` +
    `IFNULL(${c.channelOverride}, '~') || '|' || IFNULL(${c.brandOverride}, '~')`
  return (
    `WITH D AS (\n` +
    `  SELECT TRIM(UPPER(${c.name})) AS PRODUCT_KEY,\n` +
    `         COUNT(*) AS ROWS_FOUND,\n` +
    `         COUNT(DISTINCT ${shape}) AS DISTINCT_SHAPES\n` +
    `    FROM ${PRODUCT_MAPPING.table}\n` +
    `   GROUP BY 1 HAVING COUNT(*) > 1\n)\n` +
    `SELECT PRODUCT_KEY,\n` +
    `       ROWS_FOUND,\n` +
    `       DISTINCT_SHAPES,\n` +
    `       COUNT(*) OVER ()                            AS DUPLICATE_KEYS,\n` +
    `       SUM(ROWS_FOUND) OVER ()                     AS DUPLICATE_ROWS,\n` +
    `       SUM(IFF(DISTINCT_SHAPES > 1, 1, 0)) OVER () AS CONFLICTING_KEYS\n` +
    `  FROM D\n ORDER BY DISTINCT_SHAPES DESC, ROWS_FOUND DESC, PRODUCT_KEY\n` +
    ` LIMIT ${DUPLICATE_EXAMPLES}`
  )
}

// ------------------------------------------------------- resolving duplicates

/**
 * Duplicate groups, paged, split by whether the rows agree.
 *
 * `mode` decides which half you get:
 *   conflicts  the rows disagree — a person has to pick a winner
 *   copies     the rows are identical — collapsing is lossless
 *   all        both, conflicts first
 *
 * Conflicts always sort first within a page, because they are the work.
 */
export type DuplicateMode = "conflicts" | "copies" | "all"

/** The four mapped columns as one comparable string. */
function shapeExpr(): string {
  const c = PRODUCT_MAPPING.cols
  return (
    `IFNULL(${c.group}, '~') || '|' || IFNULL(${c.vasFlag}, '~') || '|' || ` +
    `IFNULL(${c.channelOverride}, '~') || '|' || IFNULL(${c.brandOverride}, '~')`
  )
}

/**
 * IFNULL to a sentinel before concatenating, always. `NULL || 'x'` is NULL in
 * Snowflake, so without it every partly-empty row collapses to the same shape
 * and a real disagreement is reported as an exact copy — which would send it
 * through the lossless bulk collapse and silently pick a winner.
 */
function duplicateGroupsCte(mode: DuplicateMode): string {
  const c = PRODUCT_MAPPING.cols
  const having =
    mode === "conflicts"
      ? " AND COUNT(DISTINCT " + shapeExpr() + ") > 1"
      : mode === "copies"
        ? " AND COUNT(DISTINCT " + shapeExpr() + ") = 1"
        : ""
  return (
    `WITH D AS (\n` +
    `  SELECT TRIM(UPPER(${c.name})) AS PRODUCT_KEY,\n` +
    `         COUNT(*) AS ROWS_FOUND,\n` +
    `         COUNT(DISTINCT ${shapeExpr()}) AS DISTINCT_SHAPES\n` +
    `    FROM ${PRODUCT_MAPPING.table}\n` +
    `   GROUP BY 1 HAVING COUNT(*) > 1${having}\n)`
  )
}

export function buildDuplicateGroups(mode: DuplicateMode, limit: number, offset: number): string {
  return (
    `${duplicateGroupsCte(mode)}\n` +
    `SELECT PRODUCT_KEY, ROWS_FOUND, DISTINCT_SHAPES\n  FROM D\n` +
    ` ORDER BY DISTINCT_SHAPES DESC, ROWS_FOUND DESC, PRODUCT_KEY\n` +
    ` LIMIT ${limit} OFFSET ${offset}`
  )
}

export function buildDuplicateGroupCount(mode: DuplicateMode): string {
  return `${duplicateGroupsCte(mode)}\nSELECT COUNT(*) AS CNT FROM D`
}

/** Every row belonging to the given keys, so the UI can show the competitors. */
export function buildRowsForKeys(keys: string[]): string {
  const c = PRODUCT_MAPPING.cols
  const list = keys.map((k) => lit(k.trim().toUpperCase())).join(", ")
  return (
    `SELECT ${c.name} AS PRODUCT_NAME, ${c.group} AS PRODUCT_GROUP,\n` +
    `       ${c.vasFlag} AS VAS_BUTTON_FLAG, ${c.channelOverride} AS CHANNEL_OVERRIDE,\n` +
    `       ${c.brandOverride} AS BRAND_OVERRIDE\n` +
    `  FROM ${PRODUCT_MAPPING.table}\n WHERE TRIM(UPPER(${c.name})) IN (${list})\n` +
    ` ORDER BY ${c.name}`
  )
}

/** How many keys the bulk collapse would touch, and how many rows it removes. */
export function buildExactCopyImpact(): string {
  return (
    `${duplicateGroupsCte("copies")}\n` +
    `SELECT COUNT(*) AS KEYS_AFFECTED, IFNULL(SUM(ROWS_FOUND) - COUNT(*), 0) AS ROWS_REMOVED\n` +
    `  FROM D`
  )
}

/**
 * Collapse every group whose rows are identical, to one row each.
 *
 * WHY THIS IS DELETE-AND-REINSERT RATHER THAN A DELETE. Identical rows are
 * indistinguishable: the table has no key and no row id, so there is no
 * predicate that matches one copy and not the other. `DELETE ... WHERE name =
 * 'X'` removes all of them. The only way to keep exactly one is to remove them
 * all and put one back.
 *
 * WHICH MAKES THE TRANSACTION LOAD BEARING, not hygiene. If the INSERT failed
 * after the DELETE this would delete mappings outright, so the whole thing is
 * one scripting block with an explicit BEGIN/COMMIT and a handler that ROLLBACKs
 * and re-raises. It is sent as ONE statement, so it cannot be half-applied by a
 * dropped connection either.
 *
 * ONLY GROUPS WHERE EVERY ROW AGREES. Anything with a disagreement is excluded
 * by the CTE, so this can never resolve a conflict by accident — those need a
 * person, and buildResolveOne is how they say so.
 *
 * The QUALIFY picks a canonical row per key. Within an exact-copy group the
 * four mapped columns are identical by definition, so the only thing it is
 * really choosing is the spelling of the name when copies differ in case.
 */
export function buildCollapseExactCopies(): string {
  const c = PRODUCT_MAPPING.cols
  const cols = `${c.name}, ${c.group}, ${c.vasFlag}, ${c.channelOverride}, ${c.brandOverride}`
  const keys =
    `SELECT TRIM(UPPER(${c.name})) FROM ${PRODUCT_MAPPING.table}\n` +
    `        GROUP BY 1 HAVING COUNT(*) > 1 AND COUNT(DISTINCT ${shapeExpr()}) = 1`
  return (
    `EXECUTE IMMEDIATE $$\nBEGIN\n` +
    `  CREATE OR REPLACE TEMPORARY TABLE TMP_MAPPING_KEEP AS\n` +
    `    SELECT ${cols}\n      FROM ${PRODUCT_MAPPING.table}\n` +
    `     WHERE TRIM(UPPER(${c.name})) IN (${keys})\n` +
    `    QUALIFY ROW_NUMBER() OVER (PARTITION BY TRIM(UPPER(${c.name}))\n` +
    `                               ORDER BY ${c.name}) = 1;\n` +
    `  BEGIN TRANSACTION;\n` +
    `  DELETE FROM ${PRODUCT_MAPPING.table}\n` +
    `   WHERE TRIM(UPPER(${c.name})) IN (SELECT TRIM(UPPER(${c.name})) FROM TMP_MAPPING_KEEP);\n` +
    `  INSERT INTO ${PRODUCT_MAPPING.table} (${cols})\n` +
    `  SELECT ${cols} FROM TMP_MAPPING_KEEP;\n` +
    `  COMMIT;\n` +
    `  RETURN 'collapsed';\n` +
    `EXCEPTION\n  WHEN OTHER THEN\n    ROLLBACK;\n    RAISE;\nEND\n$$`
  )
}

/**
 * Resolve one conflicted product: keep the chosen row, drop the rest.
 *
 * Same delete-and-reinsert for the same reason, scoped to one key, in one
 * transactional block. `keep` has already been validated by the caller.
 */
export function buildResolveOne(productKey: string, keep: ProductMapping): string {
  const c = PRODUCT_MAPPING.cols
  const cols = `${c.name}, ${c.group}, ${c.vasFlag}, ${c.channelOverride}, ${c.brandOverride}`
  const key = lit(productKey.trim().toUpperCase())
  const values =
    `${lit(normProductName(keep.productName))}, ${litOrNull(keep.productGroup)}, ` +
    `${litOrNull(keep.vasButtonFlag)}, ${litOrNull(keep.channelOverride)}, ` +
    `${litOrNull(keep.brandOverride)}`
  return (
    `EXECUTE IMMEDIATE $$\nBEGIN\n  BEGIN TRANSACTION;\n` +
    `  DELETE FROM ${PRODUCT_MAPPING.table} WHERE TRIM(UPPER(${c.name})) = ${key};\n` +
    `  INSERT INTO ${PRODUCT_MAPPING.table} (${cols}) VALUES (${values});\n` +
    `  COMMIT;\n  RETURN 'resolved';\n` +
    `EXCEPTION\n  WHEN OTHER THEN\n    ROLLBACK;\n    RAISE;\nEND\n$$`
  )
}

// ---------------------------------------------------------------- audit trail

export function buildEnsureAuditTable(): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (\n` +
    `  AUDIT_ID      NUMBER AUTOINCREMENT START 1 INCREMENT 1,\n` +
    `  ACTION        VARCHAR NOT NULL,\n` +
    `  PRODUCT_NAME  VARCHAR NOT NULL,\n` +
    `  BEFORE_JSON   VARCHAR,\n` +
    `  AFTER_JSON    VARCHAR,\n` +
    `  CHANGED_BY    VARCHAR NOT NULL,\n` +
    `  CHANGED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()\n)`
  )
}

/**
 * Record one change.
 *
 * `before` is null for a create, `after` is null for a delete. The JSON is the
 * whole row both sides, so the log alone is enough to rebuild the mapping if
 * the BI table is ever overwritten from a file.
 */
export function buildAuditInsert(
  action: MappingAction,
  productName: string,
  before: ProductMapping | null,
  after: ProductMapping | null,
  actor: string
): string {
  return (
    `INSERT INTO ${AUDIT_TABLE} (ACTION, PRODUCT_NAME, BEFORE_JSON, AFTER_JSON, CHANGED_BY)\n` +
    `SELECT ${lit(action)}, ${lit(normProductName(productName))}, ` +
    `${before ? lit(JSON.stringify(before)) : "NULL"}, ` +
    `${after ? lit(JSON.stringify(after)) : "NULL"}, ${lit(actor)}`
  )
}

/**
 * Where the live table disagrees with the last change the app recorded.
 *
 * The clobber detector. A non-empty result means something outside this app
 * changed the mapping since the app last wrote it — most likely a reload of the
 * BI table from a file, which is the known risk of writing to BI directly
 * rather than keeping our own copy.
 *
 * Deletes are excluded: a row the app deleted is SUPPOSED to be absent, and
 * treating that as drift would report every deletion as a clobber forever.
 */
export function buildDriftCheck(): string {
  const c = PRODUCT_MAPPING.cols
  return (
    `WITH LAST AS (\n` +
    `  SELECT PRODUCT_NAME, ACTION, AFTER_JSON,\n` +
    `         ROW_NUMBER() OVER (PARTITION BY TRIM(UPPER(PRODUCT_NAME))\n` +
    `                            ORDER BY CHANGED_AT DESC, AUDIT_ID DESC) AS RN\n` +
    `    FROM ${AUDIT_TABLE}\n` +
    `)\n` +
    `SELECT l.PRODUCT_NAME,\n` +
    `       PARSE_JSON(l.AFTER_JSON):channelOverride::VARCHAR AS EXPECTED_CHANNEL,\n` +
    `       t.${c.channelOverride}                            AS ACTUAL_CHANNEL,\n` +
    `       PARSE_JSON(l.AFTER_JSON):brandOverride::VARCHAR   AS EXPECTED_BRAND,\n` +
    `       t.${c.brandOverride}                              AS ACTUAL_BRAND\n` +
    `  FROM LAST l\n` +
    `  LEFT JOIN ${PRODUCT_MAPPING.table} t\n` +
    `    ON TRIM(UPPER(t.${c.name})) = TRIM(UPPER(l.PRODUCT_NAME))\n` +
    ` WHERE l.RN = 1\n   AND l.ACTION <> 'delete'\n` +
    `   AND (IFNULL(PARSE_JSON(l.AFTER_JSON):channelOverride::VARCHAR, '~') ` +
    `<> IFNULL(t.${c.channelOverride}, '~')\n` +
    `    OR IFNULL(PARSE_JSON(l.AFTER_JSON):brandOverride::VARCHAR, '~') ` +
    `<> IFNULL(t.${c.brandOverride}, '~'))\n` +
    ` ORDER BY l.PRODUCT_NAME`
  )
}
