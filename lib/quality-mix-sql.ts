/**
 * Shared SQL fragments and coercions for the Customer quality reports.
 *
 * WHY THIS IS SHARED AND NOT COPIED. The band boundaries, the rule that a score
 * of 0 means "missing" rather than zero, and the coercions around PAID_FLAG and
 * VAS_BUTTON_FLAG are BUSINESS DEFINITIONS, not formatting. Two reports sitting
 * under the same heading that band a score differently, or disagree about what
 * counts as paid, produce figures nobody can add together — and the discrepancy
 * surfaces in a meeting rather than in a diff.
 *
 * Extracted from app/api/reporting/quality-mix/route.ts when the second report
 * needed them. That route is the reference for what each one means.
 */

/** What scripts/quality-mix.sql builds, unless QUALITY_MIX_SOURCE_TABLE says otherwise. */
export const DEFAULT_SOURCE_TABLE = "DATAWAREHOUSE.LEADS_DISTRIBUTION.VW_QUALITY_MIX_BASE"

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const QUALIFIED_RE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

export function escSql(s: string): string {
  return s.replace(/'/g, "''")
}

export const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const n = typeof v === "number" ? v : Number(String(v))
  return Number.isFinite(n) ? n : 0
}

export const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null
  const n = typeof v === "number" ? v : Number(String(v))
  return Number.isFinite(n) ? n : null
}

export const rate = (a: number, b: number): number | null => (b > 0 ? a / b : null)

/**
 * The account's score as a number, with 0 and non-numeric treated as MISSING so
 * aggregates ignore them rather than letting a placeholder win.
 */
export const SCORE_NUM = `NULLIF(TRY_TO_NUMBER(TO_VARCHAR(SCORE)), 0)`

/**
 * Derived 50-point band from an already-numeric score column.
 *
 * Banding happens AFTER aggregating to the account — never as MAX() over the
 * band string, which sorts 'unknown' above '900+' and mis-buckets a scored
 * account.
 */
export const bandSql = (col: string) => `
  CASE
    WHEN ${col} IS NULL THEN 'unknown'
    WHEN ${col} < 600 THEN '<600'
    WHEN ${col} >= 900 THEN '900+'
    ELSE TO_VARCHAR(FLOOR(${col} / 50) * 50) || '-' || TO_VARCHAR(FLOOR(${col} / 50) * 50 + 49)
  END`

// PAID_FLAG / VAS_BUTTON_FLAG arrive as 0/1, sometimes as text.
export const PAID = `COALESCE(TRY_TO_NUMBER(TO_VARCHAR(PAID_FLAG)), 0)`
export const VAS = `COALESCE(TRY_TO_NUMBER(TO_VARCHAR(VAS_BUTTON_FLAG)), 0)`
export const IS_FIRST = `COALESCE(TRY_TO_NUMBER(TO_VARCHAR(ISFIRSTCOLLECTION)), 0) = 1`

/** Resolve and validate the configured source object. */
export function resolveSourceTable(): { table: string; error: string | null } {
  const table = (process.env.QUALITY_MIX_SOURCE_TABLE ?? "").trim() || DEFAULT_SOURCE_TABLE
  if (!QUALIFIED_RE.test(table)) {
    return {
      table,
      error: `QUALITY_MIX_SOURCE_TABLE must be DATABASE.SCHEMA.OBJECT (got "${table}")`,
    }
  }
  return { table, error: null }
}

/** The filter set both Customer quality reports offer. */
export type QualityFilters = {
  startDate: string
  endDate: string
  products: string[]
  campaignName: string
  brand: string
  bands: string[]
  bandMode: "derived" | "scoregroup"
}

const multi = (raw: string | null): string[] =>
  Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    )
  )

export function readFilters(searchParams: URLSearchParams): QualityFilters {
  const startDate = searchParams.get("startDate") ?? ""
  return {
    startDate,
    endDate: searchParams.get("endDate") ?? startDate,
    // `productGroup` (singular) is still accepted so an existing link keeps working.
    products: Array.from(
      new Set([...multi(searchParams.get("products")), ...multi(searchParams.get("productGroup"))])
    ),
    campaignName: (searchParams.get("campaignName") ?? "").trim(),
    brand: (searchParams.get("brand") ?? "").trim(),
    bands: multi(searchParams.get("bands")),
    bandMode: searchParams.get("bandMode") === "scoregroup" ? "scoregroup" : "derived",
  }
}

/** null when the dates are usable, otherwise the message to return. */
export function validateDates(f: QualityFilters): string | null {
  if (!DATE_RE.test(f.startDate) || !DATE_RE.test(f.endDate)) {
    return "startDate and endDate are required, format YYYY-MM-DD"
  }
  if (f.startDate > f.endDate) return "startDate must be on or before endDate"
  return null
}

/**
 * Row-level predicates, in the order the quality-mix route already applies them.
 *
 * Filters on the SALE date, so a cohort is defined by when it was written.
 * Brand is matched space-insensitively ("MOBILE TALK" vs "MOBILETALK") since the
 * source is inconsistent about spacing.
 */
export function filterClauses(f: QualityFilters): string[] {
  return [
    `TRY_TO_DATE(TO_VARCHAR(SALESDATE)) BETWEEN '${f.startDate}' AND '${f.endDate}'`,
    f.products.length > 0
      ? `PRODUCT_GROUPS IN (${f.products.map((p) => `'${escSql(p)}'`).join(",")})`
      : "",
    f.campaignName ? `CAMPAIGNNAME = '${escSql(f.campaignName)}'` : "",
    f.brand
      ? `UPPER(REPLACE(BRAND, ' ', '')) = '${escSql(f.brand.replace(/ /g, "").toUpperCase())}'`
      : "",
  ].filter(Boolean)
}

/** The band expression and its sort key for the chosen mode. */
export function bandExprs(bandMode: QualityFilters["bandMode"]): { band: string; sort: string } {
  return bandMode === "scoregroup"
    ? {
        band: `COALESCE(NULLIF(TRIM(SCOREGROUP_VAL), ''), 'unknown')`,
        // Sort by score, not alphabetically — '908+' would otherwise precede
        // '662 to 672'. Unknown sorts last.
        sort: `COALESCE(TRY_TO_NUMBER(REGEXP_SUBSTR(TRIM(SCOREGROUP_VAL), '^[0-9]+')), 99999)`,
      }
    : { band: bandSql("SCORE_NUM"), sort: `COALESCE(FLOOR(SCORE_NUM / 50) * 50, 99999)` }
}
