import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { TABLE, SF_OPTS, sqlStr, IDENT_COL, STANDALONE_PROC_IDENT } from "../../route"
import { TABLE as CONFIG_TABLE, SF_OPTS as CONFIG_SF_OPTS } from "@/app/api/campaign-config/route"
import {
  HLL_TABLE,
  hllColumnSet,
  buildHllInsertLists,
  buildAutoExprs,
  activeAutoExprs,
  DEFAULT_LEAD_EXPIRY_DAYS,
} from "@/lib/hll-insert"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

const QUALIFIED = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

// proc kind → campaign-config column + the order they run for "full".
const PROC_COL: Record<string, string> = {
  load_history: "LOAD_HISTORY_PROCEDURE",
  update_hll: "UPDATE_HLL_PROCEDURE",
  sync: "SYNC_PROCEDURE",
}
const FULL_ORDER = ["load_history", "update_hll", "sync"]

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n >= 0 ? n : null
}

// A valid cron secret (Vercel sets Authorization: Bearer <CRON_SECRET>; we also
// accept an x-cron-secret header) lets the scheduler run a task without a user
// session.
function hasCronAuth(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get("authorization")
  return request.headers.get("x-cron-secret") === secret || auth === `Bearer ${secret}`
}

// POST — run the task's campaign procedure(s) and record the outcome on the task.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasCronAuth(request)) {
    const guard = await requireDepartmentAccess(request, "distribution")
    if (guard instanceof NextResponse) return guard
  }
  const { id } = await params
  const taskId = parseId(id)
  if (taskId === null) return NextResponse.json({ error: "Invalid task id" }, { status: 400 })

  // Read the task's source / campaign config.
  let task: { CAMPAIGN_ID: string | null; PROC_KIND: string | null; SOURCE_KIND: string | null; SOURCE_OBJECT: string | null; SOURCE_TABLE: string | null; MAPPING_JSON: string | null; STANDALONE_PROC: string | null }
  try {
    const rows = await executeSnowflakeQuery<typeof task>(
      `SELECT CAMPAIGN_ID, PROC_KIND, SOURCE_KIND, SOURCE_OBJECT, SOURCE_TABLE, MAPPING_JSON, STANDALONE_PROC FROM ${TABLE} WHERE ID = ${taskId}`,
      SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ error: "Task not found" }, { status: 404 })
    task = rows[0]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Highest priority: a standalone procedure — CALL it directly.
  const standaloneProc = (task.STANDALONE_PROC ?? "").trim()
  if (standaloneProc) {
    if (!STANDALONE_PROC_IDENT.test(standaloneProc)) {
      await recordRun(taskId, "Error", `Standalone procedure is invalid: ${standaloneProc}`)
      return NextResponse.json({ error: `Standalone procedure is invalid: ${standaloneProc}` }, { status: 400 })
    }
    const head = standaloneProc.split("(")[0]
    const [database, schema] = head.split(".")
    const callSql = standaloneProc.includes("(") ? `CALL ${standaloneProc}` : `CALL ${standaloneProc}()`
    try {
      await executeSnowflakeQuery(callSql, { database, schema })
      const msg = `Ran ${standaloneProc}`
      await recordRun(taskId, "Success", msg)
      return NextResponse.json({ ok: true, ran: [standaloneProc], message: msg })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordRun(taskId, "Error", `Failed at ${standaloneProc}: ${message}`)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Preferred path: lead-source → HLL (proc-fills-table or view), mapped.
  const sourceKind = (task.SOURCE_KIND ?? "none").trim()
  if (sourceKind === "proc" || sourceKind === "view") {
    const cid = (task.CAMPAIGN_ID ?? "").trim()
    const campaignId = /^[0-9]+$/.test(cid) ? Number(cid) : null
    return runSourceToHll(taskId, task, campaignId)
  }

  const campaignId = task.CAMPAIGN_ID?.trim() || null
  const procKind = (task.PROC_KIND ?? "none").trim() || "none"
  if (!campaignId) return NextResponse.json({ error: "This task isn't linked to a campaign or a lead source. Set one first." }, { status: 400 })
  if (procKind === "none") return NextResponse.json({ error: "This task has no procedure selected." }, { status: 400 })
  if (!/^[0-9]+$/.test(campaignId)) return NextResponse.json({ error: "Invalid campaign id on task" }, { status: 400 })

  // Read the campaign's configured procedure names.
  let config: Record<string, string | null>
  try {
    const rows = await executeSnowflakeQuery<Record<string, string | null>>(
      `SELECT LOAD_HISTORY_PROCEDURE, UPDATE_HLL_PROCEDURE, SYNC_PROCEDURE FROM ${CONFIG_TABLE} WHERE CAMPAIGNID = ${campaignId}`,
      CONFIG_SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ error: "No campaign config found for this campaign." }, { status: 400 })
    config = rows[0]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `Failed to read campaign config: ${message}` }, { status: 500 })
  }

  const kinds = procKind === "full" ? FULL_ORDER : [procKind]
  const steps: { kind: string; proc: string }[] = []
  for (const k of kinds) {
    const proc = (config[PROC_COL[k]] ?? "").trim()
    if (!proc) continue // skip unconfigured steps (esp. for "full")
    if (!QUALIFIED.test(proc)) {
      await recordRun(taskId, "Error", `Configured ${k} procedure is not a valid DATABASE.SCHEMA.PROC: ${proc}`)
      return NextResponse.json({ error: `Configured ${k} procedure is invalid: ${proc}` }, { status: 400 })
    }
    steps.push({ kind: k, proc })
  }
  if (steps.length === 0) {
    await recordRun(taskId, "Error", "No matching procedure configured on the campaign for the selected run.")
    return NextResponse.json({ error: "No matching procedure is configured on the campaign." }, { status: 400 })
  }

  // Run each proc in order; stop at the first failure.
  const done: string[] = []
  for (const step of steps) {
    const [database, schema] = step.proc.split(".")
    try {
      await executeSnowflakeQuery(`CALL ${step.proc}()`, { database, schema })
      done.push(step.proc)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const msg = `Failed at ${step.proc}: ${message}${done.length ? ` (completed: ${done.join(", ")})` : ""}`
      await recordRun(taskId, "Error", msg)
      return NextResponse.json({ error: msg, completed: done }, { status: 500 })
    }
  }

  const okMsg = `Ran ${done.length} procedure(s): ${done.join(", ")}`
  await recordRun(taskId, "Success", okMsg)
  return NextResponse.json({ ok: true, ran: done, message: okMsg })
}

// Lead source → HLL: (proc) CALL then read its table; (view) read directly;
// then INSERT the mapped columns into the fixed HLL table (append).
async function runSourceToHll(
  taskId: number,
  task: { SOURCE_KIND: string | null; SOURCE_OBJECT: string | null; SOURCE_TABLE: string | null; MAPPING_JSON: string | null },
  campaignId: number | null
): Promise<NextResponse> {
  const kind = (task.SOURCE_KIND ?? "").trim()
  const object = (task.SOURCE_OBJECT ?? "").trim()
  const sourceTable = (task.SOURCE_TABLE ?? "").trim()

  if (!object || !QUALIFIED.test(object)) {
    await recordRun(taskId, "Error", `Source object is not a valid DATABASE.SCHEMA.NAME: ${object || "(empty)"}`)
    return NextResponse.json({ error: "Source object must be DATABASE.SCHEMA.NAME." }, { status: 400 })
  }
  // What we SELECT from: the proc's output table, or the view itself.
  const readFrom = kind === "proc" ? sourceTable : object
  if (kind === "proc" && (!sourceTable || !QUALIFIED.test(sourceTable))) {
    await recordRun(taskId, "Error", `Source (for the proc's output, a table or view) must be DATABASE.SCHEMA.NAME: ${sourceTable || "(empty)"}`)
    return NextResponse.json({ error: "For a proc source, set the table or view to read from." }, { status: 400 })
  }

  // Parse + validate the mapping { hllColumn: sourceColumn }.
  let mapping: Record<string, string>
  try {
    mapping = JSON.parse(task.MAPPING_JSON ?? "{}")
  } catch {
    mapping = {}
  }
  const pairs = Object.entries(mapping).filter(([h, s]) => IDENT_COL.test(h) && typeof s === "string" && IDENT_COL.test(s)) as [string, string][]

  // Auto-fill reserved HLL columns: CAMPAIGNID (from the task's campaign when
  // known), CREATEDONDATE (today) and LEADEXPIRY (today + default days). Ad-hoc
  // tasks carry no per-campaign expiry setting, so the default is used.
  let hllColumns: Set<string> | null = null
  try {
    hllColumns = await hllColumnSet()
  } catch { /* null → assume the reserved columns exist */ }
  const autos = activeAutoExprs(buildAutoExprs(campaignId, DEFAULT_LEAD_EXPIRY_DAYS), hllColumns)
  const autoUpper = new Set(Object.keys(autos).map((c) => c.toUpperCase()))

  const realPairs = pairs.filter(([h]) => !autoUpper.has(h.toUpperCase()))
  if (realPairs.length === 0) {
    await recordRun(taskId, "Error", "No column mapping is set for this source.")
    return NextResponse.json({ error: "Map at least one source column (besides the auto-filled ones) to an HLL column first." }, { status: 400 })
  }

  try {
    // 1. If proc, run it to (re)populate its output table.
    if (kind === "proc") {
      const [db, schema] = object.split(".")
      await executeSnowflakeQuery(`CALL ${object}()`, { database: db, schema })
    }
    // 2. Append mapped rows into HLL with the reserved columns auto-filled.
    const { hllCols, selectExprs } = buildHllInsertLists(pairs, autos)
    await executeSnowflakeQuery(
      `INSERT INTO ${HLL_TABLE} (${hllCols.join(", ")}) SELECT ${selectExprs.join(", ")} FROM ${readFrom}`,
      { database: HLL_TABLE.split(".")[0], schema: HLL_TABLE.split(".")[1] }
    )
    // 3. How many rows landed (best-effort count of the source).
    let loaded = ""
    try {
      const [dbR, schR] = readFrom.split(".")
      const cnt = await executeSnowflakeQuery<{ N: number | string }>(`SELECT COUNT(*) AS N FROM ${readFrom}`, { database: dbR, schema: schR })
      loaded = ` (${Number(cnt[0]?.N ?? 0).toLocaleString()} source rows)`
    } catch { /* count is best-effort */ }
    const msg = `Loaded ${kind === "proc" ? `${object} → ${readFrom}` : object} into HLL${loaded}`
    await recordRun(taskId, "Success", msg)
    return NextResponse.json({ ok: true, message: msg })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordRun(taskId, "Error", `Source→HLL failed: ${message}`)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function recordRun(taskId: number, status: string, message: string): Promise<void> {
  try {
    await executeSnowflakeQuery(
      `UPDATE ${TABLE} SET LAST_RUN_AT = SYSDATE(), LAST_RUN_STATUS = ${sqlStr(status)},
              LAST_RUN_MESSAGE = ${sqlStr(message.slice(0, 4000))}, UPDATED_AT = SYSDATE()
       WHERE ID = ${taskId}`,
      SF_OPTS
    )
  } catch (e) {
    console.error("[/api/distribution/tasks/[id]/run] recordRun error:", e)
  }
}
