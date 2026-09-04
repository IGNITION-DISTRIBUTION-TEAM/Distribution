/**
 * The Spot department's file-upload processes.
 *
 * PURE. NO REACT, NO I/O. One entry per page under the "Processes" sidebar
 * group, so the nav, the API route and the page component all read the same
 * definition instead of three hard-coded copies — the shape lib/departments.ts
 * already uses for department ids.
 *
 * ARPU File is deliberately NOT in here. It merges on a business key and has
 * its own route (app/api/spot/arpu-upload/route.ts); the processes below
 * REPLACE their target outright, which is a different enough contract that
 * sharing one code path would mean a mode flag threaded through every function.
 */

export type SpotUploadProcess = {
  /** Sidebar nav id and the URL segment of the API route. */
  id: string
  label: string
  database: string
  schema: string
  table: string
  /**
   * Raw file header(s) identifying a row, used only to seed `__HEVO_ID`.
   *
   * NOT a merge key — nothing matches on it, because the load empties the
   * table first. It exists so a reload gives the same logical row the same
   * synthesized id rather than a fresh one each time.
   */
  keyHeaders: string[]
  /**
   * Sanitized column names the file MUST provide.
   *
   * This is what identifies the file, and it is load-bearing rather than
   * belt-and-braces: both targets carry the SAME nine columns (the union of
   * both files plus the Hevo columns), so checking the file's columns against
   * the TABLE cannot tell these two files apart — AIRTIME_RATES really does
   * have a TYPE column. Without this, the rates file would load onto the
   * airtime rates page and empty it.
   */
  expectedColumns: string[]
  /**
   * A NOT NULL column the file does not supply, populated with
   * `'xls-' || MD5(<key>)`. The targets here are Hevo-managed and
   * ARPU_DASHBOARD_FEES has this column as NOT NULL with no default, so an
   * insert that omits it fails outright.
   */
  hevoIdColumn?: string
  /** Fully qualified audit log, created on first use. */
  historyTable: string
  /** Shown under the page heading. */
  description: string
}

export const SPOT_UPLOADS: SpotUploadProcess[] = [
  {
    id: "rates",
    label: "Rates",
    database: "SPOT_DW",
    schema: "SPOT_SFTP",
    table: "RATES",
    keyHeaders: ["type"],
    expectedColumns: ["TYPE", "RATE", "FLAT"],
    hevoIdColumn: "__HEVO_ID",
    historyTable: "DATAWAREHOUSE.LEADS_DISTRIBUTION.RATES_UPLOADS",
    description: "The transaction rate card — one row per transaction type.",
  },
  {
    id: "airtime-rates",
    label: "Airtime Rates",
    database: "SPOT_DW",
    schema: "SPOT_SFTP",
    table: "AIRTIME_RATES",
    keyHeaders: ["recipient_name"],
    expectedColumns: ["RECIPIENT_NAME", "AIRTIME_RATE"],
    hevoIdColumn: "__HEVO_ID",
    historyTable: "DATAWAREHOUSE.LEADS_DISTRIBUTION.AIRTIME_RATES_UPLOADS",
    description: "Airtime rates by network — one row per recipient.",
  },
]

export function getSpotUpload(id: string): SpotUploadProcess | undefined {
  return SPOT_UPLOADS.find((p) => p.id === id)
}

export function fqTable(p: SpotUploadProcess): string {
  return `${p.database}.${p.schema}.${p.table}`
}
