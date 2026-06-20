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
const HISTORY_TABLE = `${DATABASE}.${SCHEMA}.ARPU_DASHBOARD_FEES_UPLOADS`

// Raw header name(s) from the ARPU file that uniquely identify a row. The MERGE
// updates matching rows and inserts new ones on these. !! Set these to the real
// column header(s) before relying on the upload. !!
const KEY_HEADERS: string[] = []

const MAX_BYTES = 50 * 1024 * 1024
const BATCH_SIZE = 500

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
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
    { database: DATABASE, schema: SCHEMA }
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
      { database: DATABASE, schema: SCHEMA }
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
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
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

    dataRows = []
    for (let r = 1; r < aoa.length; r++) {
      const row = aoa[r] as unknown[]
      const values = keptIdx.map((i) => String(row[i] ?? "").trim())
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
    const colDefs = columns.map((c) => `${c} VARCHAR`).join(", ")
    await executeSnowflakeQueryWithMeta(
      `CREATE TABLE IF NOT EXISTS ${FQ_TABLE} (${colDefs})`,
      { database: DATABASE, schema: SCHEMA }
    )

    // 2) MERGE the rows in batches.
    const onClause = keyColumns.map((c) => `t.${c} = s.${c}`).join(" AND ")
    const insertCols = columns.join(", ")
    const insertVals = columns.map((c) => `s.${c}`).join(", ")
    const updateSet = nonKeyColumns.map((c) => `t.${c} = s.${c}`).join(", ")

    let inserted = 0
    let updated = 0
    for (let i = 0; i < dataRows.length; i += BATCH_SIZE) {
      const batch = dataRows.slice(i, i + BATCH_SIZE)
      const valuesSql = batch
        .map((row) => `(${columns.map((_, ci) => sqlString(row[ci] ?? "")).join(", ")})`)
        .join(", ")

      const merge =
        `MERGE INTO ${FQ_TABLE} t ` +
        `USING (SELECT * FROM VALUES ${valuesSql} AS v(${insertCols})) s ` +
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
        { database: DATABASE, schema: SCHEMA }
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
