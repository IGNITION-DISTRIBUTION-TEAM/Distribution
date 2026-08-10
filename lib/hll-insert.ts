import { executeSnowflakeQuery } from "@/lib/snowflake"

// The fixed HLL history target and the columns we fill automatically rather
// than mapping from a source: the campaign id, the load date, and the lead
// expiry date. These names match the TM_HLL_HISTORYLEADSLOADED schema.
export const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
export const CAMPAIGN_ID_COL = "CAMPAIGNID"
export const CREATED_ON_COL = "CREATEDONDATE"
export const LEAD_EXPIRY_COL = "LEADEXPIRY"
export const BATCHNAME_COL = "BATCHNAME"

// Columns the mapper locks (auto-filled, never mapped from a source column).
export const AUTO_HLL_COLUMNS = [CAMPAIGN_ID_COL, CREATED_ON_COL, LEAD_EXPIRY_COL, BATCHNAME_COL]

export const DEFAULT_LEAD_EXPIRY_DAYS = 45
// Editable batch-name template. `{date}` expands to today's date as YYYYMMDD.
// Default reproduces CONCAT('BATCH_ONAIR_ULTRA5', REPLACE(CURRENT_DATE,'-','')).
export const DEFAULT_BATCH_TEMPLATE = "BATCH_ONAIR_ULTRA5{date}"

// Clamp/normalise a lead-expiry-days value to a safe positive integer.
export function normLeadExpiryDays(raw: unknown): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : DEFAULT_LEAD_EXPIRY_DAYS
}

// Literal segments of a batch template may only contain these characters, so
// the template can never inject SQL (the only dynamic part is the date expr).
const BATCH_SEGMENT = /^[A-Za-z0-9_.-]*$/
export const BATCH_DATE_TOKEN = "{date}"

/**
 * Turn an editable batch-name template into a safe SQL string expression.
 * `{date}` → REPLACE(TO_VARCHAR(CURRENT_DATE),'-','') (today as YYYYMMDD);
 * every other segment must be a plain identifier-ish literal. Returns null for
 * an empty or invalid template (caller then leaves BATCHNAME unmapped).
 */
export function batchNameSql(template: string | null | undefined): string | null {
  const t = (template ?? "").trim()
  if (!t || t.length > 200) return null
  const parts = t.split(BATCH_DATE_TOKEN)
  for (const seg of parts) if (!BATCH_SEGMENT.test(seg)) return null
  const dateExpr = "REPLACE(TO_VARCHAR(CURRENT_DATE), '-', '')"
  const pieces: string[] = []
  parts.forEach((seg, i) => {
    if (seg) pieces.push(`'${seg.replace(/'/g, "''")}'`)
    if (i < parts.length - 1) pieces.push(dateExpr)
  })
  if (pieces.length === 0) return null
  return pieces.length === 1 ? pieces[0] : `CONCAT(${pieces.join(", ")})`
}

// Uppercase set of the HLL table's column names (metadata only). Used to decide
// which auto columns to fill. Throws on failure — callers may default.
export async function hllColumnSet(): Promise<Set<string>> {
  const [db, schema, name] = HLL_TABLE.split(".")
  const rows = await executeSnowflakeQuery<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM ${db}.INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${name}'`,
    { database: db, schema }
  )
  return new Set(rows.map((r) => String(r.COLUMN_NAME).toUpperCase()))
}

/**
 * SQL expressions that auto-fill reserved HLL columns:
 *   CAMPAIGNID    → the known campaign id (omitted when unknown)
 *   CREATEDONDATE → today
 *   LEADEXPIRY    → today + leadExpiryDays
 * `leadExpiryDays` MUST already be a validated integer (see normLeadExpiryDays).
 */
export function buildAutoExprs(
  campaignId: number | null,
  leadExpiryDays: number,
  batchTemplate?: string | null
): Record<string, string> {
  const out: Record<string, string> = {
    [CREATED_ON_COL]: "CURRENT_DATE",
    [LEAD_EXPIRY_COL]: `DATEADD(day, ${leadExpiryDays}, CURRENT_DATE)`,
  }
  if (campaignId != null) out[CAMPAIGN_ID_COL] = String(campaignId)
  const batch = batchNameSql(batchTemplate ?? DEFAULT_BATCH_TEMPLATE)
  if (batch) out[BATCHNAME_COL] = batch
  return out
}

/**
 * Build the column list and SELECT expressions for
 *   INSERT INTO <HLL> (hllCols) SELECT selectExprs FROM <source>
 *
 * `pairs` are [hllColumn, sourceColumn] entries, already validated as safe
 * identifiers. `activeAutoExprs` maps HLL column → SQL expression for the
 * reserved columns that should be auto-filled (already filtered to columns the
 * target actually has). Any source mapping for an auto column is dropped in
 * favour of its expression.
 */
export function buildHllInsertLists(
  pairs: [string, string][],
  activeAutoExprs: Record<string, string>
): { hllCols: string[]; selectExprs: string[] } {
  const autoUpper = new Set(Object.keys(activeAutoExprs).map((c) => c.toUpperCase()))
  const hllCols: string[] = []
  const selectExprs: string[] = []
  for (const [h, s] of pairs) {
    if (autoUpper.has(h.toUpperCase())) continue // filled from an expression below
    hllCols.push(h)
    selectExprs.push(s)
  }
  for (const [col, expr] of Object.entries(activeAutoExprs)) {
    hllCols.push(col)
    selectExprs.push(expr)
  }
  return { hllCols, selectExprs }
}

/**
 * Decide which auto expressions apply given the target's columns. On a null
 * column set (metadata unreadable) assume all reserved columns exist — the
 * fixed HLL table is known to have them.
 */
export function activeAutoExprs(
  all: Record<string, string>,
  hllColumns: Set<string> | null
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [col, expr] of Object.entries(all)) {
    if (hllColumns == null || hllColumns.has(col.toUpperCase())) out[col] = expr
  }
  return out
}
