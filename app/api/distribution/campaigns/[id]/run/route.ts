import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import {
  TABLE as CONFIG_TABLE,
  SF_OPTS as CONFIG_SF_OPTS,
  sqlStr,
  RUN_QUALIFIED,
  RUN_PROC_IDENT,
} from "@/app/api/campaign-config/route"
import { IDENT_COL } from "@/app/api/distribution/tasks/route"
import {
  HLL_TABLE,
  hllColumnSet,
  buildHllInsertLists,
  buildAutoExprs,
  activeAutoExprs,
  normLeadExpiryDays,
} from "@/lib/hll-insert"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

type StepResult = { step: string; status: "success" | "error" | "skipped"; message: string }

type RunConfig = {
  SOURCE_KIND: string | null
  SOURCE_OBJECT: string | null
  SOURCE_MAPPING_JSON: string | null
  UPLOAD_TARGET_TABLE: string | null
  LOAD_HISTORY_PROCEDURE: string | null
  UPDATE_HLL_PROCEDURE: string | null
  SYNC_PROCEDURE: string | null
  LEAD_EXPIRY_DAYS: number | string | null
  BATCH_NAME_TEMPLATE: string | null
  IS_ACTIVE: boolean | string | null
}

// NDJSON events streamed to the client during a run.
type RunEvent =
  | { type: "step"; step: string; phase: "start" }
  | { type: "step"; step: string; phase: "end"; status: "success" | "error" | "skipped"; message: string }
  | { type: "done"; ok: boolean; ran: number; results: StepResult[]; error?: string }

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// A proc reference may carry a call-argument list (e.g. DB.SCHEMA.SP_X(1)).
// Build the CALL statement and pull the DB/SCHEMA from the part before "(".
function buildCall(procRef: string): { sql: string; database: string; schema: string } {
  const head = procRef.split("(")[0]
  const [database, schema] = head.split(".")
  const sql = procRef.includes("(") ? `CALL ${procRef}` : `CALL ${procRef}()`
  return { sql, database, schema }
}

// POST — run the campaign's full distribution in order, stopping at the first
// failure: Step 1 initial source → HLL, then load-history, update-HLL, sync.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const campaignId = parseId(id)
  if (campaignId === null) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 })

  // Read the campaign's stored config.
  let config: RunConfig
  try {
    // SELECT * so a partial config table (missing columns the app role can't
    // add) still reads — missing fields come back undefined and are treated as
    // unset (step skipped / defaults) rather than crashing the whole run.
    const rows = await executeSnowflakeQuery<RunConfig>(
      `SELECT * FROM ${CONFIG_TABLE} WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ error: "No campaign config found for this campaign." }, { status: 400 })
    config = rows[0]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }

  // Missing IS_ACTIVE column (undefined) → treat as active; only an explicit FALSE blocks.
  const isActive = config.IS_ACTIVE == null ? true : (config.IS_ACTIVE === true || String(config.IS_ACTIVE).toUpperCase() === "TRUE")
  if (!isActive) {
    return NextResponse.json({ error: "This campaign's config is inactive. Activate it before running." }, { status: 400 })
  }

  // Stream per-step progress as NDJSON when asked (?stream=1); the client shows
  // a spinner on the running step and updates each as it completes.
  if (request.nextUrl.searchParams.get("stream") === "1") {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const ev of runStepsGen(campaignId, config)) {
            controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"))
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          controller.enqueue(encoder.encode(JSON.stringify({ type: "done", ok: false, ran: 0, results: [], error: message }) + "\n"))
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no", // ask proxies not to buffer, so events arrive live
      },
    })
  }

  // Non-streaming: run to completion and return the final summary as JSON.
  let doneEv: Extract<RunEvent, { type: "done" }> | null = null
  for await (const ev of runStepsGen(campaignId, config)) {
    if (ev.type === "done") doneEv = ev
  }
  const ok = doneEv?.ok ?? false
  return NextResponse.json({ ok, ran: doneEv?.ran ?? 0, results: doneEv?.results ?? [] }, { status: ok ? 200 : 500 })
}

// Run the steps in order, yielding a start/end event per step and a final
// done event (which also persists the run outcome). Stops at the first error.
async function* runStepsGen(campaignId: number, config: RunConfig): AsyncGenerator<RunEvent> {
  const results: StepResult[] = []
  const emitEnd = (r: StepResult): RunEvent => {
    results.push(r)
    return { type: "step", step: r.step, phase: "end", status: r.status, message: r.message }
  }

  // ── Step 1: initial source → HLL ────────────────────────────────────────
  const sourceKind = (config.SOURCE_KIND ?? "none").trim().toLowerCase()
  const expiryDays = normLeadExpiryDays(config.LEAD_EXPIRY_DAYS)
  if (sourceKind === "proc" || sourceKind === "view") {
    yield { type: "step", step: "Initial source", phase: "start" }
    const r = await runInitialSource(sourceKind, config, campaignId, expiryDays, config.BATCH_NAME_TEMPLATE)
    yield emitEnd(r)
    if (r.status === "error") { yield await done(campaignId, results); return }
  } else {
    yield emitEnd({ step: "Initial source", status: "skipped", message: "No initial source configured." })
  }

  // ── Steps 2-4: the configured procedures, in order ──────────────────────
  const procSteps: { step: string; ref: string | null }[] = [
    { step: "Load into history", ref: config.LOAD_HISTORY_PROCEDURE },
    { step: "Update HLL", ref: config.UPDATE_HLL_PROCEDURE },
    { step: "Sync", ref: config.SYNC_PROCEDURE },
  ]
  for (const { step, ref } of procSteps) {
    const proc = (ref ?? "").trim()
    if (!proc) { yield emitEnd({ step, status: "skipped", message: "Not configured." }); continue }
    if (!RUN_PROC_IDENT.test(proc)) {
      yield emitEnd({ step, status: "error", message: `Configured procedure is invalid: ${proc}` })
      yield await done(campaignId, results); return
    }
    yield { type: "step", step, phase: "start" }
    try {
      const { sql, database, schema } = buildCall(proc)
      await executeSnowflakeQuery(sql, { database, schema })
      yield emitEnd({ step, status: "success", message: `Ran ${proc}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield emitEnd({ step, status: "error", message: `Failed at ${proc}: ${message}` })
      yield await done(campaignId, results); return
    }
  }

  yield await done(campaignId, results)
}

// Run Step 1: for a proc source, CALL it to (re)populate the upload/stage table,
// then append mapped columns into HLL; for a view, append straight from the view.
async function runInitialSource(
  kind: string,
  config: {
    SOURCE_OBJECT: string | null
    SOURCE_MAPPING_JSON: string | null
    UPLOAD_TARGET_TABLE: string | null
  },
  campaignId: number,
  expiryDays: number,
  batchTemplate: string | null
): Promise<StepResult> {
  const step = "Initial source"
  const object = (config.SOURCE_OBJECT ?? "").trim()
  const stageTable = (config.UPLOAD_TARGET_TABLE ?? "").trim()

  if (!object || !RUN_PROC_IDENT.test(object)) {
    return { step, status: "error", message: `Source object is not valid: ${object || "(empty)"}` }
  }
  // What we SELECT from: the proc's upload/stage table, or the view itself.
  const readFrom = kind === "proc" ? stageTable : object
  if (kind === "proc" && (!stageTable || !RUN_QUALIFIED.test(stageTable))) {
    return { step, status: "error", message: `Upload target (for the proc's output, a table or view) must be DATABASE.SCHEMA.NAME: ${stageTable || "(empty)"}` }
  }
  if (kind === "view" && !RUN_QUALIFIED.test(object)) {
    return { step, status: "error", message: `View must be DATABASE.SCHEMA.NAME: ${object}` }
  }

  // Parse + validate the { hllColumn: sourceColumn } mapping.
  let mapping: Record<string, string>
  try {
    mapping = JSON.parse(config.SOURCE_MAPPING_JSON ?? "{}")
  } catch {
    mapping = {}
  }
  const pairs = Object.entries(mapping).filter(([h, s]) => IDENT_COL.test(h) && typeof s === "string" && IDENT_COL.test(s)) as [string, string][]

  // Resolve which reserved columns (CAMPAIGNID / CREATEDONDATE / LEADEXPIRY)
  // the HLL target actually has, so we auto-fill only those. On a metadata
  // read failure, assume all exist — the fixed HLL table is known to have them.
  let hllColumns: Set<string> | null = null
  try {
    hllColumns = await hllColumnSet()
  } catch { /* null → assume all reserved columns exist */ }
  const autos = activeAutoExprs(buildAutoExprs(campaignId, expiryDays, batchTemplate), hllColumns)
  const autoUpper = new Set(Object.keys(autos).map((c) => c.toUpperCase()))

  // Auto columns are filled by expression; still require a real source column.
  const realPairs = pairs.filter(([h]) => !autoUpper.has(h.toUpperCase()))
  if (realPairs.length === 0) {
    return { step, status: "error", message: "Map at least one source column (besides the auto-filled ones) into HLL." }
  }

  try {
    // 1. If proc, run it to (re)populate its upload/stage table.
    if (kind === "proc") {
      const { sql, database, schema } = buildCall(object)
      await executeSnowflakeQuery(sql, { database, schema })
    }
    // 2. Append mapped rows into HLL; CAMPAIGNID/CREATEDONDATE/LEADEXPIRY are
    //    auto-filled (campaign id, today, today + expiry days).
    const { hllCols, selectExprs } = buildHllInsertLists(pairs, autos)
    await executeSnowflakeQuery(
      `INSERT INTO ${HLL_TABLE} (${hllCols.join(", ")}) SELECT ${selectExprs.join(", ")} FROM ${readFrom}`,
      { database: HLL_TABLE.split(".")[0], schema: HLL_TABLE.split(".")[1] }
    )
    // 3. Best-effort row count of the source.
    let loaded = ""
    try {
      const [dbR, schR] = readFrom.split(".")
      const cnt = await executeSnowflakeQuery<{ N: number | string }>(`SELECT COUNT(*) AS N FROM ${readFrom}`, { database: dbR, schema: schR })
      loaded = ` (${Number(cnt[0]?.N ?? 0).toLocaleString()} source rows)`
    } catch { /* count is best-effort */ }
    const label = kind === "proc" ? `${object} → ${readFrom}` : object
    return { step, status: "success", message: `Loaded ${label} into HLL${loaded}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { step, status: "error", message: `Initial source → HLL failed: ${message}` }
  }
}

// Persist the run outcome on the config row and build the final done event.
async function done(campaignId: number, results: StepResult[]): Promise<RunEvent> {
  const failed = results.some((r) => r.status === "error")
  const ranCount = results.filter((r) => r.status === "success").length
  const summary = results.map((r) => `${r.step}: ${r.status}`).join(" | ")
  const status = failed ? "Error" : "Success"
  try {
    await executeSnowflakeQuery(
      `UPDATE ${CONFIG_TABLE} SET LAST_RUN_AT = CURRENT_TIMESTAMP(), LAST_RUN_STATUS = ${sqlStr(status)},
              LAST_RUN_MESSAGE = ${sqlStr(summary.slice(0, 4000))}
       WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF_OPTS
    )
  } catch (e) {
    console.error("[/api/distribution/campaigns/[id]/run] record error:", e)
  }
  return { type: "done", ok: !failed, ran: ranCount, results }
}
