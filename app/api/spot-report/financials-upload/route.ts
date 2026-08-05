import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

// Income-statement uploads land here. The "Format Is" sheet is the income
// statement (Headers / Sub Headers / Sub Headers 2 / Detail, then one column
// per month); we melt it to long rows and store them in Snowflake.
const DB = "DATAWAREHOUSE"
const SCHEMA = "LEADS_DISTRIBUTION"
const TABLE = `${DB}.${SCHEMA}.SPOT_TELCO_FINANCIALS`
const SF_OPTS = { database: DB, schema: SCHEMA } as const
const MAX_BYTES = 25 * 1024 * 1024

// Sheets to import. Each has a different number of label columns before the
// month columns; `labels` maps the first columns to HEADER/SUB_HEADER/
// SUB_HEADER2/DETAIL and `dateStart` is the first month column.
type SheetCfg = { name: string; dateStart: number; get: (r: unknown[]) => { header: string; sub: string; sub2: string; detail: string } }
const str = (v: unknown) => String(v ?? "").trim()
const SHEETS: SheetCfg[] = [
  { name: "Format Is", dateStart: 4, get: (r) => ({ header: str(r[0]), sub: str(r[1]), sub2: str(r[2]), detail: str(r[3]) }) },
  { name: "Telco fin", dateStart: 3, get: (r) => ({ header: str(r[0]), sub: str(r[1]), sub2: "", detail: str(r[2]) }) },
  // Goal sheet: [Headers, Sub Headers, months…] — the metric name is in Sub Headers.
  { name: "Goal sheet", dateStart: 2, get: (r) => ({ header: str(r[0]), sub: str(r[1]), sub2: "", detail: str(r[1]) }) },
]
const STATUS_SHEET = "Format Is"

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

// "R9,239,550" / "1 169 745" / "-297,598" / "1242889.00" -> number | null
function cleanNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (!s) return null
  s = s.replace(/[Rr]\s*/g, "").replace(/[,\s]/g, "").replace(/[^0-9.\-]/g, "")
  if (s === "" || s === "-" || s === ".") return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Header cells like "3/31/23" (M/D/YY) -> "YYYY-MM-DD". Excel may also parse
// them to serials; handle both.
function parsePeriod(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const mm = Number(m[1])
    const dd = Number(m[2])
    let yy = Number(m[3])
    if (yy < 100) yy += 2000
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`
    }
  }
  return null
}

async function ensureTable(): Promise<void> {
  await executeSnowflakeQueryWithMeta(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      `SHEET VARCHAR, HEADER VARCHAR, SUB_HEADER VARCHAR, SUB_HEADER2 VARCHAR, ` +
      `DETAIL VARCHAR, PERIOD DATE, VALUE FLOAT, ` +
      `UPLOADED_BY VARCHAR, UPLOADED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`,
    SF_OPTS
  )
}

// GET — quick status: row count, distinct periods, last upload.
export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard
  try {
    await ensureTable()
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT COUNT(*) AS ROWS, COUNT(DISTINCT PERIOD) AS PERIODS,
              TO_VARCHAR(MAX(UPLOADED_AT), 'YYYY-MM-DD HH24:MI') AS LAST_AT,
              MAX(UPLOADED_BY) AS LAST_BY,
              TO_VARCHAR(MIN(PERIOD), 'YYYY-MM') AS FROM_P,
              TO_VARCHAR(MAX(PERIOD), 'YYYY-MM') AS TO_P
       FROM ${TABLE} WHERE SHEET = ${sqlString(STATUS_SHEET)}`,
      SF_OPTS
    )
    const r = rows[0] ?? {}
    return NextResponse.json({
      rows: Number(r.ROWS ?? 0),
      periods: Number(r.PERIODS ?? 0),
      lastAt: r.LAST_AT ? String(r.LAST_AT) : null,
      lastBy: r.LAST_BY ? String(r.LAST_BY) : null,
      range: r.FROM_P && r.TO_P ? `${r.FROM_P} → ${r.TO_P}` : null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/financials-upload] status error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST — parse the uploaded workbook's "Format Is" sheet and replace the stored
// rows for that sheet.
export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let file: File | null = null
  try {
    const form = await request.formData()
    file = form.get("file") as File | null
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
  }
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    return NextResponse.json({ error: "Only .xlsx/.xls files are accepted" }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File must be under 25MB" }, { status: 400 })
  }

  // Parse every configured sheet into long rows, tagged by SHEET.
  type Rec = { sheet: string; header: string; sub: string; sub2: string; detail: string; period: string; value: number }
  const records: Rec[] = []
  const perSheet: Record<string, number> = {}
  let wbNames: string[] = []
  try {
    const buf = Buffer.from(await file.arrayBuffer())
    const wb = XLSX.read(buf, { type: "buffer" })
    wbNames = wb.SheetNames
    for (const cfg of SHEETS) {
      const ws = wb.Sheets[cfg.name]
      if (!ws) continue // sheet optional — skip if absent
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: false })
      if (aoa.length < 2) continue
      const head = aoa[0] as unknown[]
      const periods: { col: number; period: string }[] = []
      for (let c = cfg.dateStart; c < head.length; c++) {
        const p = parsePeriod(head[c])
        if (p) periods.push({ col: c, period: p })
      }
      if (periods.length === 0) continue
      let count = 0
      for (let r = 1; r < aoa.length; r++) {
        const row = aoa[r] as unknown[]
        const { header, sub, sub2, detail } = cfg.get(row)
        if (!header && !sub && !detail) continue
        for (const { col, period } of periods) {
          const value = cleanNumber(row[col])
          if (value === null) continue
          records.push({ sheet: cfg.name, header, sub, sub2, detail, period, value })
          count++
        }
      }
      perSheet[cfg.name] = count
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Could not parse file: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    )
  }

  // At minimum the income statement must be present.
  if (!perSheet["Format Is"]) {
    return NextResponse.json(
      { error: `No values parsed from the "Format Is" sheet. Sheets present: ${wbNames.join(", ")}` },
      { status: 400 }
    )
  }

  try {
    await ensureTable()
    const importedSheets = SHEETS.map((s) => s.name).filter((n) => perSheet[n] !== undefined)
    // Replace rows for the sheets we imported.
    await executeSnowflakeQueryWithMeta(
      `DELETE FROM ${TABLE} WHERE SHEET IN (${importedSheets.map(sqlString).join(", ")})`,
      SF_OPTS
    )

    const by = sqlString(guard.email)
    const BATCH = 500
    for (let i = 0; i < records.length; i += BATCH) {
      const values = records
        .slice(i, i + BATCH)
        .map(
          (r) =>
            `(${sqlString(r.sheet)}, ${sqlString(r.header)}, ${sqlString(r.sub)}, ${sqlString(r.sub2)}, ` +
            `${sqlString(r.detail)}, DATE ${sqlString(r.period)}, ${r.value}, ${by}, CURRENT_TIMESTAMP())`
        )
        .join(", ")
      await executeSnowflakeQueryWithMeta(
        `INSERT INTO ${TABLE}
           (SHEET, HEADER, SUB_HEADER, SUB_HEADER2, DETAIL, PERIOD, VALUE, UPLOADED_BY, UPLOADED_AT)
         VALUES ${values}`,
        SF_OPTS
      )
    }

    return NextResponse.json({ success: true, rows: records.length, perSheet })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/financials-upload] store error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
