import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery, executeSnowflakeQueryWithMeta } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { callHint, probeProcedure } from "@/lib/distribution-steps"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Remove duplicates from the SQL Server upload staging table.
 *
 * Two actions, deliberately separate:
 *
 *   scan    Reads Upload.TempUpload through SP_SYNC_FROM_SQLSERVER and lands the
 *           duplicate rows in TEMP_UPLOAD_DUPES. Touches nothing in SQL Server.
 *   delete  Removes the duplicates from SQL Server. Irreversible.
 *
 * They are not one button. The delete has no dry-run and no undo, so it requires
 * an explicit confirmation string in the body — a stray or replayed POST cannot
 * trigger it.
 *
 * ONE THING THE COUNTS DO NOT TELL YOU
 * The scan writes at most topN rows into TEMP_UPLOAD_DUPES, so a summary
 * computed over that table is capped. The DELETE is not capped — it removes
 * every duplicate matching the filter. When the scan comes back holding exactly
 * topN rows the real figure is higher, possibly far higher, and the response
 * says so via `truncated`. Nothing here silently reconciles the two; the caller
 * is told.
 */

const SCHEMA = "DATAWAREHOUSE.DISTRIBUTION_AUTOMATION"
const DUPES_TABLE = `${SCHEMA}.TEMP_UPLOAD_DUPES`
const SYNC_PROC = `${SCHEMA}.SP_SYNC_FROM_SQLSERVER`
const SOURCE = "Upload.TempUpload"
const SF = { database: "DATAWAREHOUSE", schema: "DISTRIBUTION_AUTOMATION" } as const
/** Only for error messages — the real calls build their own argument list. */
const SYNC_PROC_REF = `${SYNC_PROC}(source, target, options, mode)`

/** The duplicate key. Fixed: changing it changes which rows are destroyed. */
const PARTITION_BY = ["CELLNUMBER", "CAMPAIGNID", "IDNUMBER"] as const
/** Only unprocessed rows are ever considered, let alone deleted. */
const FILTERS = [{ column: "PROCESSEDFAILED", operator: "=", value: 0 }] as const
const ID_COLUMN = "TEMPUPLOADID"

type StepLog = { step: string; ms: number; detail?: string }

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * The options payload the bridge expects. Built here rather than accepted from
 * the client: partition_by and the filter decide which rows are destroyed, and
 * those are not the browser's to choose.
 */
function scanOptions(topN: number, keepNewest: boolean): string {
  return JSON.stringify({
    partition_by: PARTITION_BY,
    filters: FILTERS,
    id_column: ID_COLUMN,
    order_by: `${ID_COLUMN} ${keepNewest ? "DESC" : "ASC"}`,
    include_rows: true,
    top_n: topN,
  })
}

function deleteOptions(keepNewest: boolean): string {
  return JSON.stringify({
    delete_duplicates: true,
    partition_by: PARTITION_BY,
    order_by: `${ID_COLUMN} ${keepNewest ? "DESC" : "ASC"}`,
    filters: FILTERS,
  })
}

const SUMMARY_SQL = `
  SELECT
      COUNT(DISTINCT CELLNUMBER || '|' || CAMPAIGNID || '|' || IDNUMBER) AS DUPLICATE_GROUPS,
      COUNT(*)                                                           AS ROWS_IN_DUPLICATE_GROUPS,
      COUNT(*) - COUNT(DISTINCT CELLNUMBER || '|' || CAMPAIGNID || '|' || IDNUMBER)
                                                                         AS ROWS_TO_DELETE
  FROM ${DUPES_TABLE}`

async function readDupes() {
  const { columns, rows } = await executeSnowflakeQueryWithMeta(
    `SELECT * FROM ${DUPES_TABLE}`,
    SF
  )
  return { columns: columns.map((c) => ({ name: c.name, type: c.type })), rows }
}

async function readSummary() {
  const rows = await executeSnowflakeQuery<Record<string, unknown>>(SUMMARY_SQL, SF)
  const r = rows[0] ?? {}
  const n = (v: unknown) => {
    const x = Number(v)
    return Number.isFinite(x) ? x : 0
  }
  return {
    duplicateGroups: n(r.DUPLICATE_GROUPS),
    rowsInDuplicateGroups: n(r.ROWS_IN_DUPLICATE_GROUPS),
    rowsToDelete: n(r.ROWS_TO_DELETE),
  }
}

// GET — whatever the last scan left behind. Runs nothing against SQL Server.
export async function GET(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  try {
    const [{ columns, rows }, summary] = await Promise.all([readDupes(), readSummary()])
    return NextResponse.json({ ok: true, scanned: false, columns, rows, summary, steps: [] })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[temp-upload/duplicates] GET error:", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard

  let body: { action?: string; topN?: unknown; keepNewest?: unknown; confirm?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const action = String(body.action ?? "")
  const keepNewest = body.keepNewest !== false
  const topNRaw = Number(body.topN)
  const topN = Number.isInteger(topNRaw) && topNRaw >= 1 && topNRaw <= 50000 ? topNRaw : 1000

  const steps: StepLog[] = []
  const timed = async <T,>(step: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    try {
      const out = await fn()
      steps.push({ step, ms: Date.now() - started })
      return out
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      steps.push({ step, ms: Date.now() - started, detail: message })
      throw new Error(`${step} failed: ${message}`)
    }
  }

  // ---------------------------------------------------------------- scan
  if (action === "scan") {
    try {
      await timed("Empty TEMP_UPLOAD_DUPES", () =>
        executeSnowflakeQuery(`TRUNCATE TABLE ${DUPES_TABLE}`, SF)
      )
      await timed("Find duplicates in Upload.TempUpload", () =>
        executeSnowflakeQuery(
          `CALL ${SYNC_PROC}(${sqlLit(SOURCE)}, ${sqlLit(DUPES_TABLE)}, ${sqlLit(
            scanOptions(topN, keepNewest)
          )}, ${sqlLit("duplicates")})`,
          SF
        )
      )
      const summary = await timed("Summarise", readSummary)
      const { columns, rows } = await timed("Read TEMP_UPLOAD_DUPES", readDupes)

      // Exactly topN rows means the bridge hit its cap, so every figure above is
      // a floor rather than a total — and the delete would remove more.
      const truncated = rows.length >= topN

      return NextResponse.json({
        ok: true,
        scanned: true,
        columns,
        rows,
        summary,
        truncated,
        topN,
        keepNewest,
        steps,
        ranBy: guard.email,
        ranAt: new Date().toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[temp-upload/duplicates] scan error:", message)
      return NextResponse.json(
        { error: message + callHint(message, SYNC_PROC_REF) + (await probeProcedure(message, SYNC_PROC)), steps },
        { status: 500 }
      )
    }
  }

  // -------------------------------------------------------------- delete
  if (action === "delete") {
    // Irreversible, and the bridge offers no undo. An explicit token means a
    // replayed or mistyped request cannot destroy rows.
    if (body.confirm !== "DELETE") {
      return NextResponse.json(
        { error: 'Refusing to delete without confirm: "DELETE" in the body.' },
        { status: 400 }
      )
    }
    try {
      await timed("Delete duplicates in Upload.TempUpload", () =>
        executeSnowflakeQuery(
          `CALL ${SYNC_PROC}(${sqlLit(SOURCE)}, ${sqlLit("")}, ${sqlLit(
            deleteOptions(keepNewest)
          )}, ${sqlLit("delete")})`,
          SF
        )
      )
      // Re-scan so the screen reflects reality rather than the pre-delete state.
      // Best effort: the delete has already happened and must be reported as
      // done even if the follow-up read fails.
      let summary = { duplicateGroups: 0, rowsInDuplicateGroups: 0, rowsToDelete: 0 }
      let columns: { name: string; type: string }[] = []
      let rows: unknown[][] = []
      let rescanError: string | null = null
      try {
        await executeSnowflakeQuery(`TRUNCATE TABLE ${DUPES_TABLE}`, SF)
        await executeSnowflakeQuery(
          `CALL ${SYNC_PROC}(${sqlLit(SOURCE)}, ${sqlLit(DUPES_TABLE)}, ${sqlLit(
            scanOptions(topN, keepNewest)
          )}, ${sqlLit("duplicates")})`,
          SF
        )
        summary = await readSummary()
        const read = await readDupes()
        columns = read.columns
        rows = read.rows
      } catch (e) {
        rescanError = e instanceof Error ? e.message : String(e)
        console.warn("[temp-upload/duplicates] post-delete rescan failed:", rescanError)
      }

      return NextResponse.json({
        ok: true,
        deleted: true,
        columns,
        rows,
        summary,
        rescanError,
        keepNewest,
        steps,
        ranBy: guard.email,
        ranAt: new Date().toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[temp-upload/duplicates] delete error:", message)
      return NextResponse.json(
        { error: message + callHint(message, SYNC_PROC_REF) + (await probeProcedure(message, SYNC_PROC)), steps },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({ error: `Unknown action: ${action || "(none)"}` }, { status: 400 })
}
