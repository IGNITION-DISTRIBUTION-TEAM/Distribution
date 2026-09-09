/**
 * One SQL string literal escaper.
 *
 * `lib/snowflake.ts` sends raw SQL with no bind parameters, so every value has
 * to be escaped by hand. `replace(/'/g, "''")` is currently reimplemented about
 * forty-five times across this repo, under five different names — `sqlLit`,
 * `lit`, `sqlString`, `sqlValue`, `escapeSqlString` — and two of them have
 * already drifted (one trims, one does not).
 *
 * This is not a refactor of those. Rewriting forty-five call sites on
 * production paths to save a one-liner is churn, and the existing copies are
 * each correct where they sit. This exists so NEW code has somewhere to import
 * from instead of adding the forty-sixth, and so the next module does not have
 * to choose between importing `lit` from a batch-reconciliation module or from
 * a calendar module, neither of which it has anything to do with.
 */

/**
 * A value as a quoted SQL string literal.
 *
 * Doubling the single quote is the whole mechanism, and it is sufficient
 * because Snowflake does not honour backslash escapes inside a standard string
 * literal — so `\'` cannot be used to break out. `null` and `undefined` become
 * the SQL keyword NULL rather than the four-character string "null", which is
 * the mistake `String(v)` quietly makes.
 */
export function lit(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL"
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The same, but an empty or whitespace-only value becomes NULL.
 *
 * Which matters more here than it looks. The billing full-history view reads
 * these columns through `coalesce(pg.brand_override, cc.brand)` — so a blank
 * override written as `''` is NOT null, coalesce returns it, and the brand
 * comes out EMPTY rather than falling back to the campaign classification.
 * "Cleared" and "blank" have to be the same thing on the way in, or clearing an
 * override silently blanks a column in executive reporting.
 */
export function litOrNull(value: string | null | undefined): string {
  const s = (value ?? "").trim()
  return s === "" ? "NULL" : lit(s)
}
