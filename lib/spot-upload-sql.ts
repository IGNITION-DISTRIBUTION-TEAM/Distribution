/**
 * SQL for the Spot replace-mode file uploads.
 *
 * PURE. NO I/O, so scripts/spot/upload-sql-tests.ts can assert the exact
 * statements without a warehouse — the same reason lib/sftp-sync-codegen.ts is
 * shaped this way. The route below it only decides WHEN to run these, never
 * what they say.
 *
 * Every identifier is validated and REJECTED if it fails, never escaped into
 * something legal. That is the boundary that stops a registry entry or a file
 * header becoming arbitrary DDL.
 */
import type { SpotUploadProcess } from "@/lib/spot-uploads"
import { fqTable } from "@/lib/spot-uploads"

const SAFE_IDENT = /^[A-Z0-9_]+$/

/**
 * A validated, double-quoted identifier.
 *
 * Quoting matters beyond safety: `TYPE`, `RATE` and `DATE` all read as
 * keywords in some positions, and the sanitized names are already
 * `[A-Z0-9_]`-only, so quoting them preserves the name without risking a
 * parse error.
 */
export function ident(name: string, label = "identifier"): string {
  const up = String(name ?? "").toUpperCase()
  if (!SAFE_IDENT.test(up)) {
    throw new Error(`Invalid ${label} "${name}": only A-Z, 0-9 and _ are allowed`)
  }
  return `"${up}"`
}

/** A single-quoted SQL literal with embedded quotes doubled. */
export function sqlString(value: string): string {
  return `'${String(value ?? "").replace(/'/g, "''")}'`
}

/**
 * A cell as it goes into VALUES.
 *
 * An empty cell becomes NULL, not `''`. The targets have NUMBER columns, and
 * `''` cast to NUMBER is an error, so the empty string would turn one blank
 * cell into a failed load. Same choice as app/api/upload/load/route.ts:88-96.
 */
export function sqlValue(value: string): string {
  const s = String(value ?? "").trim()
  return s === "" ? "NULL" : sqlString(s)
}

/** Assert the registry entry names only legal identifiers. */
export function validateProcess(p: SpotUploadProcess): void {
  ident(p.database, "database")
  ident(p.schema, "schema")
  ident(p.table, "table")
  if (p.hevoIdColumn) ident(p.hevoIdColumn, "hevo id column")
  if (p.keyHeaders.length === 0) {
    throw new Error(`Process "${p.id}" has no keyHeaders, so __HEVO_ID cannot be derived`)
  }
}

export function buildCount(p: SpotUploadProcess): string {
  validateProcess(p)
  return `SELECT COUNT(*) FROM ${fqTable(p)}`
}

/**
 * Empty the target.
 *
 * DELETE, not TRUNCATE. Snowflake has no grantable TRUNCATE privilege — it
 * needs OWNERSHIP — and these tables are Hevo-owned, so TRUNCATE would fail
 * with an insufficient-privileges error. app/api/upload/load/route.ts:103-136
 * hit this already and falls back to exactly this statement.
 */
export function buildDelete(p: SpotUploadProcess): string {
  validateProcess(p)
  return `DELETE FROM ${fqTable(p)}`
}

/** The columns the target must expose for this file to load. */
export function buildColumnLookup(p: SpotUploadProcess): string {
  validateProcess(p)
  return (
    `SELECT COLUMN_NAME FROM ${p.database}.INFORMATION_SCHEMA.COLUMNS ` +
    `WHERE TABLE_SCHEMA = ${sqlString(p.schema.toUpperCase())} ` +
    `AND TABLE_NAME = ${sqlString(p.table.toUpperCase())} ` +
    `ORDER BY ORDINAL_POSITION`
  )
}

/**
 * Names in `wanted` that `have` does not contain, compared case-insensitively.
 *
 * Case-insensitive because INFORMATION_SCHEMA and the sanitizer both yield
 * uppercase, but the SHOW COLUMNS fallback path need not.
 */
export function missingFrom(wanted: string[], have: string[]): string[] {
  const set = new Set(have.map((c) => String(c ?? "").toUpperCase()))
  return wanted.filter((c) => !set.has(String(c ?? "").toUpperCase()))
}

/**
 * Columns the file failed to provide — i.e. "this is not that file".
 *
 * The check that actually distinguishes the two Spot rate files. Comparing the
 * file against the TARGET cannot do it: both targets carry the same nine
 * columns, so AIRTIME_RATES really does have TYPE, RATE and FLAT, and the
 * rates file would sail through and empty it.
 */
export function wrongFileColumns(p: SpotUploadProcess, fileColumns: string[]): string[] {
  return missingFrom(p.expectedColumns, fileColumns)
}

/** File columns the target does not have, which would fail the INSERT. */
export function unknownColumns(fileColumns: string[], targetColumns: string[]): string[] {
  return missingFrom(fileColumns, targetColumns)
}

/**
 * Map the configured key headers onto sanitized column names.
 *
 * `keyHeaders` are RAW file headers ("recipient_name"), matched against the
 * file's own header row, so a registry entry stays readable next to the file
 * it describes rather than pre-sanitized.
 */
export function resolveKeyColumns(
  keyHeaders: string[],
  headers: string[],
  columns: string[]
): string[] {
  return keyHeaders.map((kh) => {
    const i = headers.findIndex((h) => h.trim().toLowerCase() === kh.trim().toLowerCase())
    if (i === -1) {
      throw new Error(`Column "${kh}" is not in the file's header row`)
    }
    return columns[i]
  })
}

/**
 * One batch of rows into the target.
 *
 * `SELECT … FROM (SELECT * FROM VALUES … AS v(…)) s` rather than a bare
 * `INSERT … VALUES`, because the synthesized `__HEVO_ID` is an expression over
 * the row's own key columns and needs them addressable. Same construction the
 * ARPU route's MERGE already uses.
 */
export function buildInsert(
  p: SpotUploadProcess,
  columns: string[],
  keyColumns: string[],
  rows: string[][]
): string {
  validateProcess(p)
  if (columns.length === 0) throw new Error("No columns to insert")
  if (rows.length === 0) throw new Error("No rows to insert")

  const cols = columns.map((c) => ident(c, "column"))
  const keys = keyColumns.map((c) => ident(c, "key column"))

  const insertCols = [...cols]
  const selectCols = cols.map((c) => `s.${c}`)
  if (p.hevoIdColumn) {
    insertCols.push(ident(p.hevoIdColumn, "hevo id column"))
    const seed = keys.map((k) => `COALESCE(TRIM(s.${k}), '')`).join(" || '|' || ")
    selectCols.push(`'xls-' || MD5(${seed})`)
  }

  const values = rows
    .map((row) => `(${columns.map((_, i) => sqlValue(row[i] ?? "")).join(", ")})`)
    .join(", ")

  return (
    `INSERT INTO ${fqTable(p)} (${insertCols.join(", ")}) ` +
    `SELECT ${selectCols.join(", ")} ` +
    `FROM (SELECT * FROM VALUES ${values} AS v(${cols.join(", ")})) s`
  )
}
