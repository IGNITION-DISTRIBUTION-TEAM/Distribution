import { executeSnowflakeQuery } from "@/lib/snowflake"

// The fixed HLL history target and its campaign-id column. CAMPAIGNID is always
// the known campaign id (a constant), never mapped from a source column.
export const HLL_TABLE = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"
export const CAMPAIGN_ID_COL = "CAMPAIGNID"

// Uppercase set of the HLL table's column names (metadata only). Used to decide
// whether to auto-fill CAMPAIGNID. Throws on failure — callers may default.
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
 * Build the column list and SELECT expressions for
 *   INSERT INTO <HLL> (hllCols) SELECT selectExprs FROM <source>
 *
 * `pairs` are [hllColumn, sourceColumn] entries, already validated as safe
 * identifiers. When the campaign id is known and the HLL target has a
 * CAMPAIGNID column, CAMPAIGNID is filled from the id literal (any source
 * mapping for CAMPAIGNID is ignored). When the id is unknown, a CAMPAIGNID
 * source mapping is left untouched (backwards-compatible for ad-hoc tasks).
 */
export function buildHllInsertLists(
  pairs: [string, string][],
  campaignId: number | null,
  hllHasCampaignId: boolean
): { hllCols: string[]; selectExprs: string[] } {
  const injectId = hllHasCampaignId && campaignId != null
  const hllCols: string[] = []
  const selectExprs: string[] = []
  for (const [h, s] of pairs) {
    if (injectId && h.toUpperCase() === CAMPAIGN_ID_COL) continue // filled from the id below
    hllCols.push(h)
    selectExprs.push(s)
  }
  if (injectId && !hllCols.some((c) => c.toUpperCase() === CAMPAIGN_ID_COL)) {
    hllCols.push(CAMPAIGN_ID_COL)
    selectExprs.push(String(campaignId)) // campaignId is a validated integer
  }
  return { hllCols, selectExprs }
}
