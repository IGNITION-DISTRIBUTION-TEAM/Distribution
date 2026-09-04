import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { parseWorkbook, type ParsedUpload } from "@/lib/spot-upload-parse"
import { getSpotUpload, fqTable, type SpotUploadProcess } from "@/lib/spot-uploads"
import {
  buildColumnLookup,
  buildCount,
  buildDelete,
  buildInsert,
  unknownColumns,
  wrongFileColumns,
  resolveKeyColumns,
  sqlString,
} from "@/lib/spot-upload-sql"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
// lib/snowflake.ts polls a statement for up to 280s. Without this the route is
// cut off long before that; the sibling Spot upload routes both set 120.
export const maxDuration = 120

/**
 * Honest, not aspirational. Vercel rejects a request body at ~4.5MB before the
 * route ever runs, so the ARPU page's "up to 50MB" is a claim the platform
 * does not honour (see components/distribution-dashboard.tsx:757-760). These
 * targets are rate cards of a few dozen rows.
 */
const MAX_BYTES = 4 * 1024 * 1024
const BATCH_SIZE = 500

async function ensureHistoryTable(p: SpotUploadProcess): Promise<void> {
  await executeSnowflakeQueryWithMeta(
    `CREATE TABLE IF NOT EXISTS ${p.historyTable} (` +
      `FILE_NAME VARCHAR, ROWS_PARSED NUMBER, ROWS_LOADED NUMBER, ` +
      `ROWS_REPLACED NUMBER, UPLOADED_BY VARCHAR, ` +
      `UPLOADED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())`
  )
}

async function countRows(p: SpotUploadProcess): Promise<number> {
  const { rows } = await executeSnowflakeQueryWithMeta(buildCount(p), {
    database: p.database,
    schema: p.schema,
  })
  return Number((rows[0] ?? [])[0] ?? 0) || 0
}

/** The last 10 loads, for the history panel. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ process: string }> }
) {
  const guard = await requireDepartmentAccess(request, "spot")
  if (guard instanceof NextResponse) return guard

  const { process: processId } = await params
  const p = getSpotUpload(processId)
  if (!p) return NextResponse.json({ error: `Unknown upload process "${processId}"` }, { status: 404 })

  try {
    await ensureHistoryTable(p)
    const { rows } = await executeSnowflakeQueryWithMeta(
      `SELECT FILE_NAME, ROWS_PARSED, ROWS_LOADED, ROWS_REPLACED, UPLOADED_BY, ` +
        `TO_VARCHAR(UPLOADED_AT, 'YYYY-MM-DD HH24:MI:SS') AS UPLOADED_AT ` +
        `FROM ${p.historyTable} ORDER BY UPLOADED_AT DESC LIMIT 10`
    )
    // What the table holds right now, so the page can say what a load would
    // replace BEFORE it is pressed. Best-effort and explicitly null on
    // failure: "could not check" must not render as "0 rows", which would
    // read as a table that is already empty.
    let rowsInTarget: number | null = null
    try {
      rowsInTarget = await countRows(p)
    } catch (countErr) {
      console.error(`[spot upload:${p.id}] could not count target:`, countErr)
    }

    return NextResponse.json({
      table: fqTable(p),
      rowsInTarget,
      uploads: rows.map((r) => ({
        fileName: String(r[0] ?? ""),
        rowsParsed: Number(r[1] ?? 0),
        rowsLoaded: Number(r[2] ?? 0),
        rowsReplaced: Number(r[3] ?? 0),
        uploadedBy: String(r[4] ?? ""),
        uploadedAt: String(r[5] ?? ""),
      })),
    })
  } catch (err) {
    console.error(`[spot upload:${p.id}] history error:`, err)
    return NextResponse.json(
      { error: `Could not load history: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ process: string }> }
) {
  const guard = await requireDepartmentAccess(request, "spot")
  if (guard instanceof NextResponse) return guard

  const { process: processId } = await params
  const p = getSpotUpload(processId)
  if (!p) return NextResponse.json({ error: `Unknown upload process "${processId}"` }, { status: 404 })

  let file: File | null = null
  try {
    const form = await request.formData()
    file = form.get("file") as File | null
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
  }

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    return NextResponse.json({ error: "Only .xlsx, .xls, or .csv files are accepted" }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File must be under 4MB" }, { status: 400 })
  }

  let parsed: ParsedUpload
  try {
    parsed = parseWorkbook(Buffer.from(await file.arrayBuffer()))
  } catch (err) {
    return NextResponse.json(
      { error: `Could not parse file: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    )
  }
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: "No data rows found in the file" }, { status: 400 })
  }

  // Steps 1 to 3 below are all validation, and they ALL run before the DELETE.
  // Once the target is emptied the only way back is another successful load,
  // so a wrong file, a missing table or an unknown column has to be caught
  // while the table is still intact.
  let keyColumns: string[]
  try {
    keyColumns = resolveKeyColumns(p.keyHeaders, parsed.headers, parsed.columns)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }

  const sfOpts = { database: p.database, schema: p.schema }

  try {
    // 1) The target must already exist. Deliberately NOT created here: the
    // ARPU route's CREATE TABLE IF NOT EXISTS means a mistyped name silently
    // builds a phantom all-VARCHAR table and reports success, which is
    // tolerable before a MERGE and not before a DELETE.
    const { rows: colRows } = await executeSnowflakeQueryWithMeta(buildColumnLookup(p), sfOpts)
    const targetColumns = colRows.map((r) => String(r[0] ?? ""))
    if (targetColumns.length === 0) {
      return NextResponse.json(
        {
          error:
            `${fqTable(p)} does not exist, or the app's role cannot see it. ` +
            `Nothing was changed. Create the table in Snowflake, or check the grants in scripts/spot-rates.sql.`,
        },
        { status: 400 }
      )
    }

    // 2a) Is this even the right file? This is the check that separates the
    // two rate files, because comparing against the target cannot: both
    // targets carry the same nine columns.
    const notThisFile = wrongFileColumns(p, parsed.columns)
    if (notThisFile.length > 0) {
      return NextResponse.json(
        {
          error:
            `This does not look like the ${p.label} file. It is missing ` +
            `${notThisFile.join(", ")}. Expected columns: ${p.expectedColumns.join(", ")}; ` +
            `this file has ${parsed.columns.join(", ")}. Nothing was loaded and nothing was deleted.`,
        },
        { status: 400 }
      )
    }

    // 2b) And every column it does have must exist in the target, or the
    // INSERT would fail after the DELETE had already emptied the table.
    const unknown = unknownColumns(parsed.columns, targetColumns)
    if (unknown.length > 0) {
      return NextResponse.json(
        {
          error:
            `Column(s) ${unknown.join(", ")} are not in ${fqTable(p)}, so nothing was ` +
            `loaded and nothing was deleted. Target columns: ${targetColumns.join(", ")}.`,
        },
        { status: 400 }
      )
    }

    // 3) What is about to be replaced, recorded before it goes.
    const rowsReplaced = await countRows(p)

    // 4) Empty, then refill.
    await executeSnowflakeQueryWithMeta(buildDelete(p), sfOpts)

    for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
      const batch = parsed.rows.slice(i, i + BATCH_SIZE)
      await executeSnowflakeQueryWithMeta(
        buildInsert(p, parsed.columns, keyColumns, batch),
        sfOpts
      )
    }

    // 5) Check its own work, rather than trusting the insert's own say-so.
    const rowsAfter = await countRows(p)
    if (rowsAfter === 0) {
      return NextResponse.json(
        {
          error:
            `The load reported ${parsed.rows.length} row(s) but ${fqTable(p)} is empty. ` +
            `The table previously held ${rowsReplaced} row(s). Do not re-run blindly — ` +
            `check the table in Snowflake first.`,
        },
        { status: 500 }
      )
    }

    try {
      await ensureHistoryTable(p)
      await executeSnowflakeQueryWithMeta(
        `INSERT INTO ${p.historyTable} ` +
          `(FILE_NAME, ROWS_PARSED, ROWS_LOADED, ROWS_REPLACED, UPLOADED_BY) ` +
          `VALUES (${sqlString(file.name)}, ${parsed.rows.length}, ${rowsAfter}, ` +
          `${rowsReplaced}, ${sqlString(guard.email)})`
      )
    } catch (histErr) {
      // Never fail a good load because its audit row would not write.
      console.error(`[spot upload:${p.id}] could not record history:`, histErr)
    }

    return NextResponse.json({
      success: true,
      table: fqTable(p),
      columns: parsed.columns,
      rowsParsed: parsed.rows.length,
      rowsLoaded: rowsAfter,
      rowsReplaced,
    })
  } catch (err) {
    console.error(`[spot upload:${p.id}] Snowflake error:`, err)
    return NextResponse.json(
      { error: `Load failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
