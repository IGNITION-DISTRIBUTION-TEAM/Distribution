import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { rowsToCsv, safeFilename } from "@/lib/dialler-csv"
import type { SnowflakeColumn } from "@/lib/snowflake"
import { CONFIGS_TABLE, CONFIG_SF } from "@/lib/distribution-steps"
import { normLeadExpiryDays, DEFAULT_LEAD_EXPIRY_DAYS } from "@/lib/hll-insert"
import { sastTodayIso } from "@/lib/calendar-dates"
import {
  DEFAULT_LAYOUT,
  parseLayout,
  renderSelectList,
  type ExportLayout,
} from "@/lib/export-layout"

/**
 * The distribution export, shared by the download (step 4) and the email
 * (step 5) so both produce byte-identical files. Extracted from the download
 * route rather than reimplemented — two copies of a CXM layout would drift, and
 * the version that goes to the dialler team must be the version that was
 * checked in the browser.
 */

const HLL = "DATAWAREHOUSE.DISTRIBUTION_DATA_APPLICATION.TM_HLL_HISTORYLEADSLOADED"

export type ExportFile = {
  filename: string
  csv: string
  rows: number
  batchName: string | null
  /**
   * The rows behind this file, kept so an oversized file can be split at the ROW
   * level. Splitting the CSV text is not safe: csvEscape quotes any value
   * containing a comma, quote or newline, so a field may legitimately span lines
   * and naive line-splitting would corrupt records.
   */
  rawRows: unknown[][]
}

export type ExportResult = {
  /** Which config's layout produced this, for the UI to show. */
  layoutFrom: { configName: string | null; isDefault: boolean; columnCount: number }
  files: ExportFile[]
  totalRows: number
  /** Name for a bundle when there are several batches. */
  fallbackName: string
  /** Which SILVERSURFER lookup actually ran. */
  lookupTier: LookupTier
  /** Why a tier was skipped, for surfacing to the operator. */
  lookupNotes: string[]
  /** Column metadata, needed to re-serialise a subset of rows. */
  columns: SnowflakeColumn[]
}

// Resolve the lead-expiry days configured for the campaign so the export's
// LeadExpiry matches what was loaded into the HLL. A campaign can have several
// automation configs — prefer an active one, then the most recently updated.
// Best-effort: falls back to the default (45) if nothing is configured or the
// lookup fails. Always returns a validated integer safe to interpolate.
export async function resolveLeadExpiryDays(cid: number): Promise<number> {
  try {
    const rows = await executeSnowflakeQuery<{ LEAD_EXPIRY_DAYS: unknown }>(
      `SELECT LEAD_EXPIRY_DAYS FROM ${CONFIGS_TABLE}
       WHERE CAMPAIGNID = ${cid} AND LEAD_EXPIRY_DAYS IS NOT NULL
       ORDER BY COALESCE(IS_ACTIVE, TRUE) DESC, UPDATED_AT DESC NULLS LAST
       LIMIT 1`,
      CONFIG_SF
    )
    if (rows.length > 0) return normLeadExpiryDays(rows[0].LEAD_EXPIRY_DAYS)
  } catch {
    /* best-effort — fall back to the default below */
  }
  return DEFAULT_LEAD_EXPIRY_DAYS
}

/**
 * The CXM column layout configured for this campaign.
 *
 * Returns the layout AND which config it came from, because the resolution is
 * a heuristic: a campaign can have several automation configs, and this picks
 * an active one then the most recently updated — the same rule
 * `resolveLeadExpiryDays` uses. That rule is not fully deterministic (two
 * active configs with the same UPDATED_AT, and UPDATED_AT is only set on
 * UPDATE, never on INSERT).
 *
 * Choosing the wrong expiry by a few days is a soft error. Choosing the wrong
 * LAYOUT ships a file the dialler cannot ingest, silently — so the config's
 * name comes back with it and the UI shows which one won. The ambiguity is
 * surfaced rather than hidden.
 *
 * Best-effort: any failure falls back to the default layout, which is what
 * every campaign got before this was configurable.
 */
export async function resolveExportLayout(
  cid: number
): Promise<{ layout: ExportLayout; configName: string | null; isDefault: boolean }> {
  try {
    const rows = await executeSnowflakeQuery<{ EXPORT_LAYOUT_JSON: unknown; CONFIG_NAME: unknown }>(
      `SELECT EXPORT_LAYOUT_JSON, CONFIG_NAME FROM ${CONFIGS_TABLE}
       WHERE CAMPAIGNID = ${cid} AND EXPORT_LAYOUT_JSON IS NOT NULL
       ORDER BY COALESCE(IS_ACTIVE, TRUE) DESC, UPDATED_AT DESC NULLS LAST
       LIMIT 1`,
      CONFIG_SF
    )
    if (rows.length > 0) {
      const raw = rows[0].EXPORT_LAYOUT_JSON
      const parsed = parseLayout(typeof raw === "string" ? raw : null)
      const name = rows[0].CONFIG_NAME == null ? null : String(rows[0].CONFIG_NAME)
      // parseLayout falls back to the default on unreadable JSON, so compare
      // rather than assume the stored row won.
      const isDefault = JSON.stringify(parsed) === JSON.stringify(DEFAULT_LAYOUT)
      return { layout: parsed, configName: isDefault ? null : name, isDefault }
    }
  } catch {
    /* best-effort — fall back to the default below */
  }
  return { layout: DEFAULT_LAYOUT, configName: null, isDefault: true }
}

/**
 * How much of the SILVERSURFER lookup to attempt.
 *
 * That lookup exists solely to populate SS_LEADCUSTOMERID — one column out of
 * sixty-odd — and the join to LEAD_LEADCUSTOMERDETAILS contributes no columns at
 * all, acting only as an existence filter. When the app's Snowflake role cannot
 * reach those objects the whole export used to fail, so it now steps down:
 *
 *   full      both tables, original behaviour
 *   noDetails LEAD_LEADCUSTOMER only — keeps SS_LEADCUSTOMERID, drops the
 *             existence filter. Row count is unaffected: the outer join is a LEFT
 *             join and the QUALIFY still keeps one row per IDNUMBER, so this can
 *             only populate MORE values, never add or remove export rows.
 *   noLookup  no lookup at all, SS_LEADCUSTOMERID comes out NULL
 *
 * Fifty-nine correct columns beat a failed download.
 */
export type LookupTier = "full" | "noDetails" | "noLookup"

/**
 * What slice of the history table an export covers.
 *
 * `date` is a SAST wall date, 'YYYY-MM-DD', supplied by the caller. It used to
 * be Snowflake's `CURRENT_DATE()`, which was never verifiably SAST — the SQL
 * API request in lib/snowflake.ts sends no `timezone`, so it resolved against
 * whatever the account's TIMEZONE parameter happens to be. Nobody noticed
 * because lib/hll-insert.ts writes CREATEDONDATE through the same connection,
 * so the read and the write agreed with each other. A caller-supplied wall
 * date removes the ambiguity instead of inheriting it.
 *
 * `batchName` null means every batch for the day, which is the behaviour this
 * export had before it could be narrowed.
 */
export type ExportScope = { date: string; batchName: string | null }

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A SQL string literal, escaped by doubling single quotes.
 *
 * There are no bind parameters anywhere in this repo, so for a batch name —
 * which is operator-supplied text — this function IS the injection boundary.
 * Tested directly in scripts/distribution/export-sql-tests.ts.
 */
export function sqlLit(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Read a scope off a request's query string.
 *
 * One parser for both routes, so the download and the email cannot disagree
 * about what they were asked for — the whole point of this module is that they
 * produce the same bytes.
 *
 * Both params are OPTIONAL and default to today / every batch, which is what
 * this export did before it could be narrowed. That keeps the older mount
 * points working untouched. The default day is SAST via `sastTodayIso()`, not
 * the server's UTC clock and not Snowflake's `CURRENT_DATE()` — see ExportScope.
 */
export function parseExportScope(
  params: URLSearchParams
): ExportScope | { error: string } {
  const rawDate = params.get("date")
  if (rawDate !== null && !ISO_DATE_RE.test(rawDate)) {
    return { error: "date must be a real date in YYYY-MM-DD form" }
  }
  const rawBatch = params.get("batchName")
  const batchName = rawBatch === null || rawBatch.trim() === "" ? null : rawBatch.trim()
  if (batchName !== null && batchName.length > 200) {
    return { error: "batchName must be 200 characters or fewer" }
  }
  return { date: rawDate ?? sastTodayIso(), batchName }
}

/** How a scope reads in an error message or a mail body. */
export function describeScope(scope: ExportScope): string {
  return scope.batchName ? `${scope.date}, batch ${scope.batchName}` : scope.date
}

/** Reject a date before it reaches a query rather than escaping it. */
export function assertIsoDate(date: string): string {
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  }
  return date
}

/**
 * The distribution export in the agreed CXM format.
 *
 * `cid` is a validated integer substituted into both campaign-id filters;
 * `expiryDays` is a validated integer used for the LeadExpiry column; `scope`
 * picks the day and, optionally, one batch.
 *
 * CREATEDONDATE AND LeadExpiry ARE ANCHORED TO THE ROW, NOT TO NOW. Both were
 * once `CURRENT_DATE()`, which was invisible while the WHERE clause pinned
 * every row to today — and a silent data bug the moment a date could be
 * picked, because a back-dated export would have stamped every row with
 * today's date and an expiry six weeks out. Anchoring on the row means a
 * re-pull of an old day reproduces the file that originally went out.
 */
export function buildQuery(
  cid: number,
  expiryDays: number,
  tier: LookupTier = "full",
  scope: ExportScope,
  /** Which columns to emit. Defaults to the layout every campaign had before. */
  layout: ExportLayout = DEFAULT_LAYOUT
): string {
  const date = assertIsoDate(scope.date)
  // Narrowing in SQL rather than filtering the grouped files afterwards: a
  // post-filter would still drag every row of the day out of Snowflake.
  const batchClause =
    scope.batchName == null ? "" : `  AND BATCHNAME = ${sqlLit(scope.batchName)}\n`
  const cte =
    tier === "noLookup"
      ? ""
      : tier === "noDetails"
      ? `with cte1 as (
  select a.IDNUMBER, a.LEADCUSTOMERID
  from "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMER" a
  where CAMPAIGNID in (${cid})
)
`
      : `with cte1 as (
  select a.IDNUMBER, a.LEADCUSTOMERID
  from "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMER" a
  join "DATAWAREHOUSE"."SILVERSURFER"."LEAD_LEADCUSTOMERDETAILS" b on a.LeadCustomerId = b.LeadCustomerId
  where CAMPAIGNID in (${cid})
)
`
  const ssExpr = tier === "noLookup" ? "NULL" : "LEADCUSTOMERID"
  const ssJoin = tier === "noLookup" ? "" : "left join cte1 b on a.IDNUMBER = b.IDNUMBER\n"

  const selectList = renderSelectList(layout, { expiryDays, ssLookup: ssExpr })

  return `${cte}${selectList}
FROM ${HLL} a
${ssJoin}WHERE CAMPAIGNID in (${cid})
  AND cast(CREATEDONDATE as date) = '${date}'::DATE
${batchClause}  AND ESTATUS IS NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY a.IDNUMBER ORDER BY score desc) = 1
order by cast(UDM30 as int) asc`
}

/**
 * Run the export and split it into one file per BATCHNAME.
 *
 * The file name IS the batch name — that is what the dialler team keys on — with
 * rows carrying no batch falling back to a campaign+date name. Two batch names
 * that sanitise to the same file name get a numeric suffix rather than silently
 * overwriting one another.
 */
/** A missing or ungranted object, as opposed to a real query fault. */
function isMissingObject(message: string): boolean {
  return /does not exist or not authorized|Object '[^']+' does not exist/i.test(message)
}

export async function buildExportFiles(cid: number, scope: ExportScope): Promise<ExportResult> {
  const [expiryDays, resolved] = await Promise.all([
    resolveLeadExpiryDays(cid),
    resolveExportLayout(cid),
  ])
  const layoutFrom = {
    configName: resolved.configName,
    isDefault: resolved.isDefault,
    columnCount: resolved.layout.columns.length,
  }

  // Step down only on a missing/ungranted object. Anything else is a real fault
  // and is rethrown immediately rather than retried into a worse query.
  const tiers: LookupTier[] = ["full", "noDetails", "noLookup"]
  let columns: Awaited<ReturnType<typeof executeSnowflakeQueryWithMeta>>["columns"] | null = null
  let rows: unknown[][] | null = null
  let usedTier: LookupTier = "full"
  const notes: string[] = []

  for (const tier of tiers) {
    try {
      const res = await executeSnowflakeQueryWithMeta(buildQuery(cid, expiryDays, tier, scope, resolved.layout), {
        database: "DATAWAREHOUSE",
        schema: "DISTRIBUTION_DATA_APPLICATION",
      })
      columns = res.columns
      rows = res.rows
      usedTier = tier
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isMissingObject(message) || tier === "noLookup") throw error
      notes.push(`${tier}: ${message.replace(/\s+/g, " ").slice(0, 200)}`)
      console.warn(`[distribution-export] ${tier} lookup unavailable, stepping down:`, message)
    }
  }
  if (!columns || !rows) throw new Error("Export produced no result set")

  // The exported day, not the server's clock. This used to be `new Date()` in
  // UTC while the WHERE clause used Snowflake's notion of today — two
  // different "today"s in one function.
  const stamp = scope.date.replace(/-/g, "")
  const fallbackName = `distribution_${cid}_${stamp}`

  const batchIdx = columns.findIndex((c) => c.name.toUpperCase() === "BATCHNAME")
  const groups = new Map<string, { label: string; batchName: string | null; rows: unknown[][] }>()
  if (batchIdx >= 0) {
    for (const row of rows) {
      const v = row[batchIdx]
      const hasBatch = v !== null && v !== undefined && String(v) !== ""
      const key = hasBatch ? `b:${String(v)}` : "n:"
      const label = hasBatch ? safeFilename(String(v)) : `${fallbackName}_nobatch`
      const g = groups.get(key) ?? {
        label,
        batchName: hasBatch ? String(v) : null,
        rows: [] as unknown[][],
      }
      g.rows.push(row)
      groups.set(key, g)
    }
  }

  // No batch column at all, or nothing to group: a single file.
  if (groups.size === 0) {
    return {
      files: [
        {
          filename: `${fallbackName}.csv`,
          csv: rowsToCsv(columns, rows),
          rows: rows.length,
          batchName: null,
          rawRows: rows,
        },
      ],
      layoutFrom,
      totalRows: rows.length,
      fallbackName,
      lookupTier: usedTier,
      lookupNotes: notes,
      columns,
    }
  }

  const used = new Set<string>()
  const files: ExportFile[] = []
  for (const g of groups.values()) {
    let name = `${g.label}.csv`
    for (let n = 2; used.has(name); n++) name = `${g.label}_${n}.csv`
    used.add(name)
    files.push({
      filename: name,
      csv: rowsToCsv(columns, g.rows),
      rows: g.rows.length,
      batchName: g.batchName,
      rawRows: g.rows,
    })
  }
  return {
    files,
    layoutFrom,
    totalRows: rows.length,
    fallbackName,
    lookupTier: usedTier,
    lookupNotes: notes,
    columns,
  }
}

/**
 * Split one export file into `parts` files of roughly equal row count, each with
 * its own header row.
 *
 * Splits ROWS, not CSV text — see the note on ExportFile.rawRows. Each part is
 * named "<batch>_batchN.csv" so the batch it came from stays legible and the
 * parts sort in order.
 */
export function splitExportFile(
  columns: SnowflakeColumn[],
  file: ExportFile,
  parts: number
): ExportFile[] {
  const n = Math.max(2, Math.floor(parts))
  const total = file.rawRows.length
  if (total < n) return [file]

  const base = file.filename.replace(/\.csv$/i, "")
  const per = Math.ceil(total / n)
  const out: ExportFile[] = []
  for (let i = 0; i < n; i++) {
    const slice = file.rawRows.slice(i * per, (i + 1) * per)
    if (slice.length === 0) continue
    out.push({
      filename: `${base}_batch${i + 1}.csv`,
      csv: rowsToCsv(columns, slice),
      rows: slice.length,
      batchName: file.batchName,
      rawRows: slice,
    })
  }
  return out
}
