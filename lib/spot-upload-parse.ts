/**
 * Reading a Spot upload into a header row and string rows.
 *
 * Split out of the route so scripts/spot/upload-sql-tests.ts can run real file
 * bytes through the real parser. The interesting case cannot be reasoned about
 * from the outside: `Cell C,"2,50%"` is a quoted field whose value contains a
 * comma, and whether it survives depends entirely on what SheetJS does with
 * it, not on anything this repo writes.
 */
import * as XLSX from "xlsx"
import { sanitizeHeaderRow } from "@/lib/column-mapping"

export type ParsedUpload = {
  /** Raw header text, for matching a configured key header. */
  headers: string[]
  /** Sanitized, deduplicated Snowflake identifiers, positionally aligned. */
  columns: string[]
  rows: string[][]
}

/**
 * First sheet of an .xlsx/.xls, or a .csv — SheetJS reads both from the same
 * buffer, which is what lets one code path accept either.
 *
 * THE TWO `raw` FLAGS ARE DIFFERENT FLAGS AND BOTH MATTER. They were measured,
 * not guessed, and the ARPU route's settings are wrong for these files:
 *
 * - `raw: true` on **read** applies only to plain-text formats, and means "do
 *   not infer types from the text". Without it SheetJS reads the CSV cell
 *   `"2,50%"` as the NUMBER 2.5 — it takes the comma as a decimal separator
 *   and discards the percent sign. That is silent corruption of the exact
 *   value this file exists to carry, and it is what the ARPU route's
 *   `{ type: "buffer" }` alone would do here.
 * - `raw: false` on **sheet_to_json** asks for each cell's formatted text
 *   rather than its underlying value, which is what keeps a text cell textual
 *   in an .xlsx as well.
 *
 * The residual trade-off, accepted deliberately: an .xlsx cell formatted with
 * thousands separators yields "1,234,567.89", which Snowflake will refuse to
 * cast into a NUMBER column. That is a loud failure at load time. The
 * alternative — underlying values — silently rewrote 2,50% as 2.5. A load that
 * stops and complains beats one that quietly stores a different number.
 *
 * No comma stripping and no number "cleaning" anywhere: cleanNumber() in the
 * financials upload route and lib/excel-parser.ts:240 both treat commas as
 * thousands separators and would turn 2,50% into 250.
 */
export function parseWorkbook(buffer: Buffer): ParsedUpload {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: true })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error("File has no sheets")

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  })
  if (aoa.length < 1) throw new Error("File is empty")

  const rawHeaders = (aoa[0] as unknown[]).map((h) => String(h ?? "").trim())
  const keptIdx = rawHeaders.map((h, i) => (h ? i : -1)).filter((i) => i >= 0)
  if (keptIdx.length === 0) throw new Error("No column headers found in the first row")

  const headers = keptIdx.map((i) => rawHeaders[i])
  const columns = sanitizeHeaderRow(headers)

  const rows: string[][] = []
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] as unknown[]
    const values = keptIdx.map((i) => String(row[i] ?? "").trim())
    if (values.every((v) => v === "")) continue
    rows.push(values)
  }
  return { headers, columns, rows }
}
