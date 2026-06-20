import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const DATABASE = "SPOT_DW"
const SCHEMA = "SPOT_SFTP"
const TABLE = "ARPU_DASHBOARD_FEES"
const FQ_TABLE = `${DATABASE}.${SCHEMA}.${TABLE}`

// The upload audit/history table lives in a separate schema from the Hevo-managed
// data table above.
const HISTORY_DATABASE = "DATAWAREHOUSE"
const HISTORY_SCHEMA = "LEADS_DISTRIBUTION"
const HISTORY_TABLE = `${HISTORY_DATABASE}.${HISTORY_SCHEMA}.ARPU_DASHBOARD_FEES_UPLOADS`

// Raw header name(s) from the ARPU file that uniquely identify a row. The MERGE
// updates matching rows (INCOME) and inserts new ones on these. Verified unique
// across the sample file (DATE + TRANSACTION).
const KEY_HEADERS: string[] = ["DATE", "TRANSACTION"]

const MAX_BYTES = 50 * 1024 * 1024
const BATCH_SIZE = 500

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function formatDDMMYYYY(year: number, month: number, day: number): string {
  return `${pad2(day)}-${pad2(month)}-${year}`
}

// Normalize a DATE cell to DD-MM-YYYY.
// - Excel stores dates as numeric serials (we read raw values); converted here
//   deterministically in UTC to avoid timezone drift from Date parsing.
// - CSV / text cells arrive as strings. Day-first is assumed for ambiguous
//   D-M-Y vs M-D-Y input, matching the required DD-MM-YYYY output (ZA convention).
// Unrecognized values are returned trimmed and unchanged so the upload proceeds.
function normalizeDate(value: unknown): string {
  if (typeof value === "number" && isFinite(value)) {
    // 25569 = days between the Excel 1900 epoch (1899-12-30) and the Unix epoch.
    const ms = Math.round((value - 25569) * 86400000)
    const d = new Date(ms)
    if (!isNaN(d.getTime())) {
      return formatDDMMYYYY(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
    }
  }
  if (value instanceof Date && !isNaN(value.getTime())) {
    return formatDDMMYYYY(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
  }
  const s = String(value ?? "").trim()
  if (!s) return ""
  // YYYY-MM-DD / YYYY/MM/DD (optionally followed by a time component)
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/)
  if (m) return formatDDMMYYYY(+m[1], +m[2], +m[3])
  // D-M-YYYY / D/M/YYYY (day-first)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T].*)?$/)
  if (m) return formatDDMMYYYY(+m[3], +m[2], +m[1])
  // D-M-YY / D/M/YY (day-first, assume 20YY)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})(?:[ T].*)?$/)
  if (m) return formatDDMMYYYY(2000 + +m[3], +m[2], +m[1])
  return s
}

// Turn an arbitrary header into a safe, unquoted Snowflake identifier.
function toColumnName(header: string): string {
  let name = header
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!name) name = "COL"
  if (/^[0-9]/.test(name)) name = `C_${name}`
  return name
}

async function ensureHistoryTable(): Promise<void> {
  await executeSnowflakeQueryWithMeta(
    `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (` +
      `FILE_NAME VARCHAR, ROWS_PARSED NUMBER, ROWS_MERGED NUMBER, ` +
      `INSERTED NUMBER, UPDATED NUMBER, UPLOADED_BY VARCHAR, ` +
      `UPLOADED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`,
    { database: HISTORY_DATABASE, schema: HISTORY_SCHEMA }
  )
}

// Return the 10 most recent uploads for the history panel.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot")
  if (guard instanceof NextResponse) return guard

  try {
    await ensureHistoryTable()
    const { rows } = await executeSnowflakeQueryWithMeta(
      `SELECT FILE_NAME, ROWS_PARSED, ROWS_MERGED, INSERTED, UPDATED, UPLOADED_BY, ` +
        `TO_VARCHAR(UPLOADED_AT, 'YYYY-MM-DD HH24:MI:SS') AS UPLOADED_AT ` +
        `FROM ${HISTORY_TABLE} ORDER BY UPLOADED_AT DESC LIMIT 10`,
      { database: HISTORY_DATABASE, schema: HISTORY_SCHEMA }
    )
    const uploads = rows.map((r) => ({
      fileName: String(r[0] ?? ""),
      rowsParsed: Number(r[1] ?? 0),
      rowsMerged: Number(r[2] ?? 0),
      inserted: Number(r[3] ?? 0),
      updated: Number(r[4] ?? 0),
      uploadedBy: String(r[5] ?? ""),
      uploadedAt: String(r[6] ?? ""),
    }))
    return NextResponse.json({ uploads })
  } catch (err) {
    console.error("[ARPU upload] history error:", err)
    return NextResponse.json(
      { error: `Could not load history: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "spot")
  if (guard instanceof NextResponse) return guard

  if (KEY_HEADERS.length === 0) {
    return NextResponse.json(
      { error: "ARPU upload is not configured: no merge key column(s) set." },
      { status: 500 }
    )
  }

  let file: File | null = null
  try {
    const form = await request.formData()
    file = form.get("file") as File | null
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
  }

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    return NextResponse.json(
      { error: "Only .xlsx, .xls, or .csv files are accepted" },
      { status: 400 }
    )
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File must be under 50MB" }, { status: 400 })
  }

  // Parse the first sheet into a header row + data rows.
  let headers: string[]
  let columns: string[]
  let dataRows: string[][]
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const workbook = XLSX.read(buffer, { type: "buffer" })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("File has no sheets")
    // raw: true so date cells come through as Excel serials (not display text),
    // letting normalizeDate convert them deterministically to DD-MM-YYYY. Numeric
    // cells (e.g. INCOME) become clean numeric strings, which is also safer for
    // any downstream numeric casting than locale-formatted text.
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: "",
      blankrows: false,
    })
    if (aoa.length < 1) throw new Error("File is empty")

    // Keep only columns that have a non-empty header.
    const rawHeaders = (aoa[0] as unknown[]).map((h) => String(h ?? "").trim())
    const keptIdx = rawHeaders.map((h, i) => (h ? i : -1)).filter((i) => i >= 0)
    if (keptIdx.length === 0) throw new Error("No column headers found in the first row")

    headers = keptIdx.map((i) => rawHeaders[i])
    // Dedupe sanitized column names (append _2, _3, … on collision).
    const seen = new Map<string, number>()
    columns = headers.map((h) => {
      const base = toColumnName(h)
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return n === 1 ? base : `${base}_${n}`
    })

    // Columns that hold dates (sanitized name "DATE") are normalized to
    // DD-MM-YYYY; everything else is stringified and trimmed.
    const isDateCol = columns.map((c) => c === "DATE")

    dataRows = []
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r] as unknown[]
      const values = keptIdx.map((i, j) =>
        isDateCol[j] ? normalizeDate(row[i]) : String(row[i] ?? "").trim()
      )
      if (values.every((v) => v === "")) continue
      dataRows.push(values)
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Could not parse file: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    )
  }

  if (dataRows.length === 0) {
    return NextResponse.json({ error: "No data rows found in the file" }, { status: 400 })
  }

  // Map the configured key headers to actual column names.
  const keyColumns: string[] = []
  for (const kh of KEY_HEADERS) {
    const idx = headers.findIndex((h) => h.toLowerCase() === kh.trim().toLowerCase())
    if (idx === -1) {
      return NextResponse.json(
        { error: `Key column "${kh}" not found in the file headers` },
        { status: 400 }
      )
    }
    keyColumns.push(columns[idx])
  }
  const nonKeyColumns = columns.filter((c) => !keyColumns.includes(c))

  try {
    // 1) Ensure the table exists (all columns VARCHAR, derived from headers).
    // Sanitized names are uppercase [A-Z0-9_] only, so quoting them is safe and
    // guards against reserved words (e.g. DATE) while preserving the name.
    const q = (c: string) => `"${c}"`
    const colDefs = columns.map((c) => `${q(c)} VARCHAR`).join(", ")
    await executeSnowflakeQueryWithMeta(
      `CREATE TABLE IF NOT EXISTS ${FQ_TABLE} (${colDefs})`,
      { database: DATABASE, schema: SCHEMA }
    )

    // 2) MERGE the rows in batches. Source values are already trimmed by the
    // parser; TRIM the target key columns too, since the existing (Hevo-loaded)
    // data has trailing spaces — without this, dirty keys would miss the match
    // and insert duplicates instead of updating.
    const onClause = keyColumns.map((c) => `TRIM(t.${q(c)}) = s.${q(c)}`).join(" AND ")
    // Source columns come straight from the file (used for the VALUES alias).
    const sourceCols = columns.map(q).join(", ")
    // The Hevo-managed target has __HEVO_ID TEXT NOT NULL with no default, so the
    // insert path must supply it. Synthesize a deterministic id from the natural
    // key (TRIMmed, matching the ON clause) so re-inserting the same logical row
    // reuses the same id instead of creating duplicates. The 'xls-' prefix marks
    // it as app-generated and avoids clashing with Hevo's own id scheme.
    const HEVO_ID_COL = "__HEVO_ID"
    const hevoIdExpr =
      `'xls-' || MD5(${keyColumns.map((c) => `COALESCE(TRIM(s.${q(c)}), '')`).join(" || '|' || ")})`
    const insertCols = [...columns.map(q), q(HEVO_ID_COL)].join(", ")
    const insertVals = [...columns.map((c) => `s.${q(c)}`), hevoIdExpr].join(", ")
    const updateSet = nonKeyColumns.map((c) => `t.${q(c)} = s.${q(c)}`).join(", ")

    let inserted = 0
    let updated = 0
    for (let i = 0; i < dataRows.length; i += BATCH_SIZE) {
      const batch = dataRows.slice(i, i + BATCH_SIZE)
      const valuesSql = batch
        .map((row) => `(${columns.map((_, ci) => sqlString(row[ci] ?? "")).join(", ")})`)
        .join(", ")

      const merge =
        `MERGE INTO ${FQ_TABLE} t ` +
        `USING (SELECT * FROM VALUES ${valuesSql} AS v(${sourceCols})) s ` +
        `ON ${onClause} ` +
        (updateSet ? `WHEN MATCHED THEN UPDATE SET ${updateSet} ` : "") +
        `WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})`

      const { rows } = await executeSnowflakeQueryWithMeta(merge, {
        database: DATABASE,
        schema: SCHEMA,
      })
      // MERGE returns one row: [inserted, updated] (as strings).
      const counts = (rows[0] ?? []) as unknown[]
      inserted += Number(counts[0] ?? 0) || 0
      updated += Number(counts[1] ?? 0) || 0
    }

    // Record the upload in the history table (best-effort).
    try {
      await ensureHistoryTable()
      await executeSnowflakeQueryWithMeta(
        `INSERT INTO ${HISTORY_TABLE} ` +
          `(FILE_NAME, ROWS_PARSED, ROWS_MERGED, INSERTED, UPDATED, UPLOADED_BY) ` +
          `VALUES (${sqlString(file.name)}, ${dataRows.length}, ${inserted + updated}, ` +
          `${inserted}, ${updated}, ${sqlString(guard.email)})`,
        { database: HISTORY_DATABASE, schema: HISTORY_SCHEMA }
      )
    } catch (histErr) {
      console.error("[ARPU upload] could not record history:", histErr)
    }

    return NextResponse.json({
      success: true,
      table: FQ_TABLE,
      columns,
      rowsParsed: dataRows.length,
      rowsMerged: inserted + updated,
      inserted,
      updated,
    })
  } catch (err) {
    console.error("[ARPU upload] Snowflake error:", err)
    return NextResponse.json(
      { error: `Load failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
