import { NextRequest, NextResponse } from "next/server"
import { executeSnowflakeQuery } from "@/lib/snowflake"
import { requireDepartmentAccess } from "@/lib/admin-guard"
import { TABLE, SF_OPTS, sqlStr } from "../../route"
import { TABLE as CONFIG_TABLE, SF_OPTS as CONFIG_SF_OPTS } from "@/app/api/campaign-config/route"

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

// POST — run the task's campaign procedure(s) and record the outcome on the task.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireDepartmentAccess(request, "distribution")
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const taskId = parseId(id)
  if (taskId === null) return NextResponse.json({ error: "Invalid task id" }, { status: 400 })

  // Read the task's campaign + proc kind.
  let campaignId: string | null = null
  let procKind = "none"
  try {
    const rows = await executeSnowflakeQuery<{ CAMPAIGN_ID: string | null; PROC_KIND: string | null }>(
      `SELECT CAMPAIGN_ID, PROC_KIND FROM ${TABLE} WHERE ID = ${taskId}`,
      SF_OPTS
    )
    if (!rows.length) return NextResponse.json({ error: "Task not found" }, { status: 404 })
    campaignId = rows[0].CAMPAIGN_ID?.trim() || null
    procKind = (rows[0].PROC_KIND ?? "none").trim() || "none"
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (!campaignId) return NextResponse.json({ error: "This task isn't linked to a campaign. Set a campaign and procedure first." }, { status: 400 })
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

async function recordRun(taskId: number, status: string, message: string): Promise<void> {
  try {
    await executeSnowflakeQuery(
      `UPDATE ${TABLE} SET LAST_RUN_AT = CURRENT_TIMESTAMP(), LAST_RUN_STATUS = ${sqlStr(status)},
              LAST_RUN_MESSAGE = ${sqlStr(message.slice(0, 4000))}, UPDATED_AT = CURRENT_TIMESTAMP()
       WHERE ID = ${taskId}`,
      SF_OPTS
    )
  } catch (e) {
    console.error("[/api/distribution/tasks/[id]/run] recordRun error:", e)
  }
}
