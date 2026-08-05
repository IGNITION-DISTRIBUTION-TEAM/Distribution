import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireSuperAdmin } from "@/lib/admin-guard"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

// Upload target for the BDM pipeline workbook (Pipeline.xlsx, sheet "retail and
// debit orde"). There's no Snowflake source for this data — it's a hand-kept
// SharePoint workbook — so an admin uploads it here and we parse it into
// Snowflake, mirroring the income-statement upload. The page then reads it live
// with an "uploaded on" stamp.
//
// The workbook's exact columns aren't known ahead of time, so the parser
// detects the STAGE column by matching the closed set of known stage names
// (below), and the CATEGORY column heuristically. The response echoes what it
// detected so the uploader can confirm the parse looks right.
const DB = "DATAWAREHOUSE"
const SCHEMA = "LEADS_DISTRIBUTION"
const TABLE = `${DB}.${SCHEMA}.SPOT_PIPELINE`
const SF_OPTS = { database: DB, schema: SCHEMA } as const
const MAX_BYTES = 25 * 1024 * 1024

// Canonical pipeline stages and their funnel order. Uploaded stage cells are
// matched to these by normalized text; unknown stages are kept with sort 90+.
const STAGE_ORDER: { canonical: string; sort: number }[] = [
  { canonical: "Initial contact made with company", sort: 1 },
  { canonical: "Initial conversation had with decision maker", sort: 2 },
  { canonical: "Initial Meeting had with decision maker", sort: 3 },
  { canonical: "Formal proposal presented", sort: 4 },
  { canonical: "Proposal accepted, awaiting implementation", sort: 5 },
  { canonical: "In implementation", sort: 6 },
  { canonical: "Not interested or deal lost", sort: 7 },
  { canonical: "Live and Trading", sort: 8 },
]
const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
const STAGE_KEYS = STAGE_ORDER.map((s) => ({ ...s, key: norm(s.canonical) }))
const CATEGORY_HEADER = /categor|brand|segment|group|division|type|retail|channel/i

function matchStage(raw: unknown): { canonical: string; sort: number } | null {
  const k = norm(raw)
  if (!k) return null
  // Exact, then contains-either-way (handles minor wording drift).
  let best = STAGE_KEYS.find((s) => s.key === k)
  if (!best) best = STAGE_KEYS.find((s) => k.includes(s.key) || s.key.includes(k))
  return best ? { canonical: best.canonical, sort: best.sort } : null
}

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

async function ensureTable(): Promise<void> {
  await executeSnowflakeQueryWithMeta(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      `STAGE VARCHAR, SORT INT, CATEGORY VARCHAR, CNT INT, ` +
      `UPLOADED_BY VARCHAR, UPLOADED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`,
    SF_OPTS
  )
}

// GET — status: row count, last upload, distinct stages/categories.
export async function GET(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard
  try {
    await ensureTable()
    const rows = await executeSnowflakeQuery<Record<string, unknown>>(
      `SELECT COUNT(*) AS ROWS, SUM(CNT) AS DEALS,
              COUNT(DISTINCT STAGE) AS STAGES, COUNT(DISTINCT CATEGORY) AS CATS,
              TO_VARCHAR(MAX(UPLOADED_AT), 'YYYY-MM-DD HH24:MI') AS LAST_AT,
              MAX(UPLOADED_BY) AS LAST_BY
       FROM ${TABLE}`,
      SF_OPTS
    )
    const r = rows[0] ?? {}
    return NextResponse.json({
      rows: Number(r.ROWS ?? 0),
      deals: Number(r.DEALS ?? 0),
      stages: Number(r.STAGES ?? 0),
      categories: Number(r.CATS ?? 0),
      lastAt: r.LAST_AT ? String(r.LAST_AT) : null,
      lastBy: r.LAST_BY ? String(r.LAST_BY) : null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/pipeline-upload] status error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// POST — parse the uploaded workbook and replace the stored pipeline.
export async function POST(request: NextRequest) {
  const guard = await requireSuperAdmin(request)
  if (guard instanceof NextResponse) return guard

  let file: File | null = null
  let sheetParam = ""
  try {
    const form = await request.formData()
    file = form.get("file") as File | null
    sheetParam = String(form.get("sheet") ?? "").trim()
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

  let detectedSheet = ""
  let stageColLabel = ""
  let categoryColLabel = ""
  const agg = new Map<string, { stage: string; sort: number; category: string; count: number }>()
  let wbNames: string[] = []
  let unmatchedStages = 0
  try {
    const buf = Buffer.from(await file.arrayBuffer())
    const wb = XLSX.read(buf, { type: "buffer" })
    wbNames = wb.SheetNames

    // Choose the sheet: explicit param, else one containing "retail", else first.
    detectedSheet =
      (sheetParam && wbNames.find((n) => n.toLowerCase() === sheetParam.toLowerCase())) ||
      wbNames.find((n) => /retail/i.test(n)) ||
      wbNames[0] ||
      ""
    const ws = detectedSheet ? wb.Sheets[detectedSheet] : undefined
    if (!ws) return NextResponse.json({ error: `Sheet not found. Sheets: ${wbNames.join(", ")}` }, { status: 400 })

    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: false })
    if (aoa.length < 2) return NextResponse.json({ error: `Sheet "${detectedSheet}" has no data rows` }, { status: 400 })

    const header = (aoa[0] as unknown[]).map((h) => String(h ?? "").trim())
    const body = aoa.slice(1) as unknown[][]
    const ncol = Math.max(...aoa.map((r) => (r as unknown[]).length))

    // STAGE column = the column whose values best match the known stage set.
    let stageCol = -1
    let bestRate = 0
    for (let c = 0; c < ncol; c++) {
      let matched = 0
      let nonEmpty = 0
      for (const row of body) {
        const v = row[c]
        if (String(v ?? "").trim() === "") continue
        nonEmpty++
        if (matchStage(v)) matched++
      }
      const rate = nonEmpty ? matched / nonEmpty : 0
      if (rate > bestRate && matched >= 3) {
        bestRate = rate
        stageCol = c
      }
    }
    if (stageCol < 0) {
      return NextResponse.json(
        { error: `Couldn't find a stage column in "${detectedSheet}". Headers: ${header.join(" | ")}` },
        { status: 400 }
      )
    }
    stageColLabel = header[stageCol] || `column ${stageCol + 1}`

    // CATEGORY column = header keyword match, else a low-cardinality text column
    // that isn't the stage column.
    let catCol = header.findIndex((h, i) => i !== stageCol && CATEGORY_HEADER.test(h))
    if (catCol < 0) {
      let bestCard = Infinity
      for (let c = 0; c < ncol; c++) {
        if (c === stageCol) continue
        const vals = new Set<string>()
        let nonEmpty = 0
        for (const row of body) {
          const s = String(row[c] ?? "").trim()
          if (!s) continue
          nonEmpty++
          vals.add(s.toLowerCase())
        }
        // A category-like column: several rows, few distinct values, not numeric.
        if (nonEmpty >= body.length * 0.5 && vals.size >= 2 && vals.size <= 12 && vals.size < bestCard) {
          const numericish = Array.from(vals).every((v) => /^-?[\d.,\s]+$/.test(v))
          if (!numericish) {
            bestCard = vals.size
            catCol = c
          }
        }
      }
    }
    categoryColLabel = catCol >= 0 ? header[catCol] || `column ${catCol + 1}` : "(none — all Unspecified)"

    for (const row of body) {
      const st = matchStage(row[stageCol])
      if (!st) {
        if (String(row[stageCol] ?? "").trim() !== "") unmatchedStages++
        continue
      }
      const category = catCol >= 0 ? String(row[catCol] ?? "").trim() || "Unspecified" : "Unspecified"
      const key = `${st.canonical}||${category}`
      const rec = agg.get(key) ?? { stage: st.canonical, sort: st.sort, category, count: 0 }
      rec.count++
      agg.set(key, rec)
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Could not parse file: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    )
  }

  const records = Array.from(agg.values())
  if (records.length === 0) {
    return NextResponse.json({ error: `No pipeline rows parsed from "${detectedSheet}".` }, { status: 400 })
  }

  try {
    await ensureTable()
    await executeSnowflakeQueryWithMeta(`DELETE FROM ${TABLE}`, SF_OPTS)
    const by = sqlString(guard.email)
    const BATCH = 500
    for (let i = 0; i < records.length; i += BATCH) {
      const values = records
        .slice(i, i + BATCH)
        .map((r) => `(${sqlString(r.stage)}, ${r.sort}, ${sqlString(r.category)}, ${r.count}, ${by}, CURRENT_TIMESTAMP())`)
        .join(", ")
      await executeSnowflakeQueryWithMeta(
        `INSERT INTO ${TABLE} (STAGE, SORT, CATEGORY, CNT, UPLOADED_BY, UPLOADED_AT) VALUES ${values}`,
        SF_OPTS
      )
    }

    // Breakdown for the uploader to sanity-check the detection.
    const byStage = STAGE_ORDER.map((s) => ({
      stage: s.canonical,
      count: records.filter((r) => r.stage === s.canonical).reduce((a, r) => a + r.count, 0),
    })).filter((s) => s.count > 0)
    const totalDeals = records.reduce((a, r) => a + r.count, 0)

    return NextResponse.json({
      success: true,
      sheet: detectedSheet,
      sheetsAvailable: wbNames,
      stageColumn: stageColLabel,
      categoryColumn: categoryColLabel,
      rows: records.length,
      deals: totalDeals,
      unmatchedStages,
      byStage,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[/api/spot-report/pipeline-upload] store error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
